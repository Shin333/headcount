import { db } from "../db.js";
import { config } from "../config.js";
import { runAgentTurn, isOverHourlyCap } from "../agents/runner.js";
import {
  sendDm,
  getOldestUnreadDmActionable,
  markDmReadVerified,
} from "../comms/dm.js";
import { AgentSchema } from "@headcount/shared";
import type { Agent } from "@headcount/shared";
import type { WorldClock } from "../world/clock.js";
import { getToolsForAgent } from "../tools/registry.js";
import { buildProjectContextBlock } from "../projects/members.js";
import { getPendingCommitmentsForAgent, formatCommitmentsBlock } from "../commitments/store.js";
import { wrapUntrusted } from "../util/untrusted.js";

const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";

// ----------------------------------------------------------------------------
// rituals/dm-responder.ts - always-on DM response (Day 4.5)
// ----------------------------------------------------------------------------
// Runs on every tick. Picks the OLDEST unread DM whose recipient is not the
// CEO sentinel, runs the recipient agent with the DM as the trigger, and
// sends back a reply DM.
//
// Volume cap: 1 DM processed per tick (rate-limited by tick interval).
// Cost cap: defers to existing isOverHourlyCap() guard.
// Schedule: ALWAYS-ON. Fires regardless of company time.
//
// Transactional safety: the original DM is only marked read AFTER the reply
// has been successfully sent. If anything fails mid-flight, the next tick
// retries the same DM.
//
// Reply loop prevention: the responder skips DMs whose recipient is the CEO
// sentinel (paused). Agents can DM the CEO; the CEO replies via dashboard,
// not via the runner. This breaks the loop architecturally.
//
// Day 15.5: thread context injection. Before building the trigger prompt,
// loads the last N messages in this specific 1:1 thread so the agent can
// see their own prior messages and the sender's. Without this, agents
// forget what they said 30 seconds ago and either repeat themselves,
// contradict themselves, or claim "I don't have a record of sending you
// anything" when they literally just did.
// ----------------------------------------------------------------------------

// Max number of prior messages to inject as thread history. 10 is enough
// for a multi-turn exchange without bloating the context window. Each DM
// body averages ~200-500 tokens, so 10 prior messages adds ~2000-5000
// tokens to the prompt — well within budget.
const THREAD_HISTORY_LIMIT = 10;

// Max characters per message body in the thread history. Keeps the context
// window bounded when an agent wrote a 3000-word brief in a prior turn.
const THREAD_MSG_PREVIEW_CHARS = 800;

/**
 * Load the most recent messages in the 1:1 thread between two agents,
 * EXCLUDING the current DM being processed (which is already in the
 * trigger prompt). Returns messages in chronological order (oldest first).
 */
async function getThreadHistory(
  agentA: string,
  agentB: string,
  excludeDmId: string
): Promise<Array<{ from_id: string; body: string; created_at: string }>> {
  const { data, error } = await db
    .from("dms")
    .select("from_id, body, created_at")
    .or(
      `and(from_id.eq.${agentA},to_id.eq.${agentB}),and(from_id.eq.${agentB},to_id.eq.${agentA})`
    )
    .neq("id", excludeDmId)
    .order("created_at", { ascending: false })
    .limit(THREAD_HISTORY_LIMIT);

  if (error) {
    console.warn(`[dm-responder] thread history query failed: ${error.message}`);
    return [];
  }
  if (!data || data.length === 0) return [];

  // Reverse to chronological order (oldest first)
  return (data as Array<{ from_id: string; body: string; created_at: string }>).reverse();
}

/**
 * Format thread history as a readable conversation block for the trigger
 * prompt. Each message shows who sent it and a preview of the body.
 * Returns null if there's no prior history.
 */
function formatThreadHistory(
  history: Array<{ from_id: string; body: string; created_at: string }>,
  senderName: string,
  senderId: string,
  recipientName: string
): string | null {
  if (history.length === 0) return null;

  const lines: string[] = [];
  lines.push(`## Recent conversation with ${senderName}`);
  lines.push(`(${history.length} prior message${history.length === 1 ? "" : "s"}, most recent first becomes oldest first below)`);
  lines.push("");

  for (const msg of history) {
    const who = msg.from_id === senderId ? senderName : recipientName;
    let body = msg.body ?? "";

    // Strip <artifacts> blocks from history — they're noisy in context
    const artifactIdx = body.lastIndexOf("<artifacts>");
    if (artifactIdx !== -1) {
      body = body.slice(0, artifactIdx).trimEnd();
    }

    // Truncate long messages
    if (body.length > THREAD_MSG_PREVIEW_CHARS) {
      body = body.slice(0, THREAD_MSG_PREVIEW_CHARS).trimEnd() + "… [truncated]";
    }

    lines.push(`**${who}:** ${wrapUntrusted("thread_msg", body, { from: who })}`);
    lines.push("");
  }

  lines.push("---");
  lines.push("The message below is the NEW message you are responding to.");
  lines.push("");

  return lines.join("\n");
}

export async function maybeRunDmResponder(clock: WorldClock): Promise<void> {
  if (await isOverHourlyCap()) {
    // Silently skip - no log spam, this fires every tick
    return;
  }

  const dm = await getOldestUnreadDmActionable();
  if (!dm) return;

  // Day 22: check budget backoff — if this DM was recently skipped due to
  // budget_exceeded, don't retry until the backoff period expires.
  // This prevents the "Tessa skipped 50 times" log spam.
  const { data: dmFull } = await db
    .from("dms")
    .select("metadata")
    .eq("id", dm.id)
    .maybeSingle();

  const backoffUntil = (dmFull?.metadata as any)?.budget_backoff_until;
  if (backoffUntil && new Date(backoffUntil) > new Date()) {
    // Still in backoff period — skip silently (no log spam)
    return;
  }

  // Load the recipient agent
  const { data: recipientRow, error: loadErr } = await db
    .from("agents")
    .select("*")
    .eq("id", dm.to_id)
    .eq("tenant_id", config.tenantId)
    .maybeSingle();

  if (loadErr || !recipientRow) {
    console.error(`[dm-responder] DM ${dm.id} recipient ${dm.to_id} not found - marking read with skipped metadata`);
    await markDmReadVerified(dm.id);
    return;
  }

  const parsed = AgentSchema.safeParse(recipientRow);
  if (!parsed.success) {
    console.error(`[dm-responder] DM ${dm.id} recipient failed schema validation - marking read`);
    await markDmReadVerified(dm.id);
    return;
  }
  const recipient: Agent = parsed.data;

  if (recipient.status !== "active") {
    // Recipient is paused or terminated. Mark read so we don't loop on it.
    await markDmReadVerified(dm.id);
    return;
  }

  // Load the sender for context
  const { data: senderRow } = await db
    .from("agents")
    .select("id, name, role")
    .eq("id", dm.from_id)
    .maybeSingle();

  const senderName = senderRow?.name ?? "Unknown sender";
  const senderRole = senderRow?.role ?? "Unknown role";

  console.log(`[dm-responder] processing DM from ${senderName} to ${recipient.name}`);

  // Day 15.5: load thread history so the agent sees their own prior messages.
  // Without this, agents forget what they said 30 seconds ago in multi-turn
  // exchanges. The history is injected into the trigger prompt above the
  // new incoming message, giving the agent a full conversational view.
  const threadHistory = await getThreadHistory(
    dm.from_id,
    dm.to_id,
    dm.id // exclude the current DM — it's already in the trigger
  );
  const threadBlock = formatThreadHistory(
    threadHistory,
    senderName,
    dm.from_id,
    recipient.name
  );

  // Build the trigger - this prompt asks the agent to respond directly to one DM
  const historySection = threadBlock
    ? `${threadBlock}`
    : "";

  const trigger = `A direct message has arrived for you. Read it carefully and respond.

Sender: ${senderName} (${senderRole})
${historySection}
Message:
${wrapUntrusted("dm_body", dm.body, { from: senderName, role: senderRole })}

Respond as you would to a real direct message from this person. Keep it conversational - a few sentences, not an essay. Stay in your voice. Be specific to what they actually said. Do not preface your response with "Here's my reply:" or similar - respond directly as if typing in a chat window.

You should reply unless the message is genuinely just an FYI that needs no response (a one-line acknowledgment, a "thanks" with nothing to add, a notification). In those rare cases respond with the single word: SKIP

Default to replying. The CEO and your colleagues need to know they have been heard.`;

  const contextLines = [
    `You are reading a private direct message.`,
    `This is a 1-on-1 conversation. The reply you write will be sent only to ${senderName}, not posted publicly.`,
    `Current company time: ${formatCompanyTime(clock.company_time)}`,
  ];

  // Day 15: inject the recipient's active project context so the agent has
  // grounded memory of what they're working on. Without this block, agents
  // pattern-match on ambiguous phrases ("the intake calls", "the flow map")
  // and confabulate context that sounds plausible but doesn't exist.
  //
  // See workspace/engineering/day15-runbook.md for the Day 14 failure mode
  // this fix targets (Eleanor + Rina inventing a company-wide org study
  // when Rina asked a clarifying question about the website project).
  const projectContext = await buildProjectContextBlock(recipient.id);
  if (projectContext) {
    contextLines.push("");
    contextLines.push(projectContext);
  }

  // Day 18: inject pending commitments so the agent knows what they promised.
  // If any are overdue, the formatCommitmentsBlock includes a warning.
  const pendingCommitments = await getPendingCommitmentsForAgent(recipient.id);
  const commitmentsBlock = formatCommitmentsBlock(pendingCommitments);
  if (commitmentsBlock) {
    contextLines.push("");
    contextLines.push(commitmentsBlock);
  }

  const contextBlock = contextLines.join("\n");

  // Day 5: resolve the agent's allowed tools (empty for most agents, ['web_search'] for Ayaka)
  const agentTools = getToolsForAgent(recipient.tool_access ?? []);
  if (agentTools.length > 0) {
    console.log(`[dm-responder] ${recipient.name} has ${agentTools.length} tool(s) available: ${agentTools.map((t) => t.definition.name).join(", ")}`);
  }

  // Day 5.3: mark the DM as in-flight so the dashboard can show "X is thinking..."
  await db.from("dms").update({ in_flight_since: new Date().toISOString() }).eq("id", dm.id);

  // ---- Day 22: Haiku pre-filter for DM SKIPs ----
  // Before running a full Sonnet/Opus turn ($0.02+), ask Haiku ($0.0002)
  // whether this DM needs a response at all. Most "thanks", "noted",
  // and FYI messages don't need a reply — catching those with Haiku
  // saves ~99% of the cost per SKIP.
  //
  // Bypass the pre-filter if:
  //   - The sender is the CEO (always respond to the boss)
  //   - The DM mentions the recipient by name (direct address)
  //   - The DM contains a question mark (likely needs a reply)
  const isCeoMessage = dm.from_id === CEO_SENTINEL_ID;
  const mentionsRecipient = dm.body.toLowerCase().includes(recipient.name.split(" ")[0]?.toLowerCase() ?? "");
  const hasQuestion = dm.body.includes("?");
  const isShort = dm.body.length < 30; // Very short messages like "thanks" or "noted"

  let shouldRespond = true;
  if (!isCeoMessage && !mentionsRecipient && !hasQuestion && isShort) {
    // Run Haiku pre-filter
    try {
      const { anthropic: anth } = await import("../claude.js");
      const preFilterResponse = await anth.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 10,
        messages: [{
          role: "user",
          content: `You are ${recipient.name} (${recipient.role}). You received this DM from ${senderName}:

"${dm.body.slice(0, 200)}"

Does this DM require a reply from you? Answer YES or NO only.
- YES if they asked a question, made a request, shared work you should acknowledge, or said something you should respond to
- NO if it's just "thanks", "noted", "ok", "got it", an FYI with nothing to add, or a notification

Answer YES or NO:`
        }],
      });

      const answer = preFilterResponse.content
        .filter((b) => b.type === "text")
        .map((b) => ("text" in b ? b.text : ""))
        .join("")
        .trim()
        .toUpperCase();

      const preFilterCost = (
        (preFilterResponse.usage.input_tokens * 1 + preFilterResponse.usage.output_tokens * 5) / 1_000_000
      );

      if (answer.startsWith("NO")) {
        console.log(`[dm-responder] pre-filter ${recipient.name}: SKIP ($${preFilterCost.toFixed(4)})`);
        shouldRespond = false;
      } else {
        console.log(`[dm-responder] pre-filter ${recipient.name}: YES ($${preFilterCost.toFixed(4)})`);
      }
    } catch (err) {
      // If pre-filter fails, fall through to full turn (safe default)
      console.warn(`[dm-responder] pre-filter failed, proceeding with full turn: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (!shouldRespond) {
    // Mark as read without responding — the DM was triaged as not needing a reply
    await db.from("dms").update({ in_flight_since: null }).eq("id", dm.id);
    await markDmReadVerified(dm.id);
    console.log(`[dm-responder] ${recipient.name} auto-skipped DM from ${senderName} (Haiku pre-filter)`);
    return;
  }

  // Day 5.3: research-tier agents need more room for triangulated answers
  const dmMaxTokens = agentTools.length > 0 ? 1500 : 600;

  // Day 19: Agent Vision — extract workspace images from the DM body
  // and context so agents can see visual assets shared in conversation.
  const { extractAndLoadImages } = await import("../agents/vision.js");
  const allDmText = [dm.body, contextBlock].join("\n");
  const imageBlocks = await extractAndLoadImages(allDmText);

  let result = await runAgentTurn({
    agent: recipient,
    trigger,
    contextBlock,
    maxTokens: dmMaxTokens,
    tools: agentTools.length > 0 ? agentTools : undefined,
    imageBlocks: imageBlocks.length > 0 ? imageBlocks : undefined,
  });

  // Day 5.3: clear in-flight regardless of success/skip - the dashboard
  // shouldn't show "thinking" forever if the responder bailed.
  // Best-effort, doesn't block the rest of the flow.
  await db.from("dms").update({ in_flight_since: null }).eq("id", dm.id);

  // Day 22b: budget-exceeded failover. If the primary recipient is over
  // their daily budget AND this DM is CEO-bound AND they have a fallback
  // agent, retry with the fallback. The fallback responds AS THEMSELVES,
  // explicitly noting they're stepping in.
  let actingAgent = recipient;
  if (
    result.skipped === "budget_exceeded" &&
    dm.from_id === CEO_SENTINEL_ID &&
    recipient.fallback_agent_id
  ) {
    const { data: fallbackRow } = await db
      .from("agents")
      .select("*")
      .eq("id", recipient.fallback_agent_id)
      .eq("tenant_id", config.tenantId)
      .maybeSingle();

    const fallbackParsed = fallbackRow ? AgentSchema.safeParse(fallbackRow) : null;
    if (
      fallbackParsed?.success &&
      fallbackParsed.data.status === "active" &&
      fallbackParsed.data.tokens_used_today < fallbackParsed.data.daily_token_budget
    ) {
      const fallback = fallbackParsed.data;
      console.log(
        `[dm-responder] failover: ${recipient.name} over budget, routing CEO DM to ${fallback.name}`
      );
      const failoverTrigger =
        `[FAILOVER NOTICE — read this carefully before responding]\n` +
        `${recipient.name} is over their daily token budget and cannot respond today. ` +
        `You are stepping in as their backup. Respond AS YOURSELF in your own voice. ` +
        `Briefly acknowledge that ${recipient.name} is out for the day, then handle the ` +
        `CEO's message to the best of your ability or commit to following up tomorrow ` +
        `once ${recipient.name}'s budget resets.\n\n---\n\n${trigger}`;

      const fallbackTools = getToolsForAgent(fallback.tool_access ?? []);
      result = await runAgentTurn({
        agent: fallback,
        trigger: failoverTrigger,
        contextBlock,
        maxTokens: dmMaxTokens,
        tools: fallbackTools.length > 0 ? fallbackTools : undefined,
        imageBlocks: imageBlocks.length > 0 ? imageBlocks : undefined,
      });
      if (!result.skipped) {
        actingAgent = fallback;
      }
    }
  }

  if (result.skipped) {
    if (result.skipped === "budget_exceeded") {
      // Day 22: backoff on budget exceeded instead of retrying every tick.
      // Mark a 5-minute backoff timestamp so the DM responder skips this
      // DM until the backoff expires. This prevents the log spam of
      // "X skipped: budget_exceeded" 50+ times per minute.
      await db.from("dms").update({
        in_flight_since: null,
        metadata: { budget_backoff_until: new Date(Date.now() + 5 * 60 * 1000).toISOString() },
      }).eq("id", dm.id);
      console.log(`[dm-responder] ${actingAgent.name} skipped: budget_exceeded - backing off 5min`);
    } else {
      console.log(`[dm-responder] ${actingAgent.name} skipped: ${result.skipped} - DM stays unread for retry`);
    }
    // Don't mark read - if it's a budget skip, next tick (or next hour) retries
    return;
  }

  const text = result.text.trim();
  if (!text) {
    console.log(`[dm-responder] ${recipient.name} returned empty - marking read with no reply`);
    await markDmReadVerified(dm.id);
    return;
  }

  if (text.toUpperCase() === "SKIP") {
    console.log(`[dm-responder] ${actingAgent.name} declined to reply (SKIP)`);
    await markDmReadVerified(dm.id);
    return;
  }

  // Day 9b: append an <artifacts> block to the body when the agent created
  // any artifact tools during this turn. The dashboard parses this block
  // and renders cards. The block is intentionally simple XML-like syntax
  // (not strict XML) so it survives JSON encoding and round-trips through
  // Supabase without escaping issues.
  let bodyWithArtifacts = text;
  if (result.toolStructuredPayloads && result.toolStructuredPayloads.length > 0) {
    const artifactPayloads = result.toolStructuredPayloads.filter(
      (p) => p.toolName === "code_artifact_create" || p.toolName === "markdown_artifact_create"
    );
    if (artifactPayloads.length > 0) {
      const artifactLines = artifactPayloads
        .map((p) => {
          const payload = p.payload;
          const id = String(payload.artifact_id ?? "");
          const path = String(payload.file_path ?? "");
          const lang = String(payload.language ?? "");
          const ct = String(payload.content_type ?? "");
          const ver = String(payload.version ?? "1");
          const title = String(payload.title ?? "").replace(/"/g, "&quot;");
          const summary = String(payload.summary ?? "").replace(/"/g, "&quot;");
          const sizeBytes = String(payload.size_bytes ?? "0");
          return `  <artifact id="${id}" path="${path}" type="${ct}" lang="${lang}" version="${ver}" size="${sizeBytes}" title="${title}" summary="${summary}" />`;
        })
        .join("\n");
      bodyWithArtifacts = `${text}\n\n<artifacts>\n${artifactLines}\n</artifacts>`;
    }
  }

  // Send the reply DM FIRST, then mark the original read.
  // If sendDm throws, we don't mark read, and the next tick retries.
  // Day 22b: actingAgent is the failover agent if Eleanor was over budget,
  // otherwise it's the original recipient.
  try {
    const sent = await sendDm({
      fromId: actingAgent.id,
      toId: dm.from_id,
      body: bodyWithArtifacts,
    });
    console.log(`[dm-responder] ${actingAgent.name} replied to ${senderName} (DM ${sent.id})`);
  } catch (sendErr) {
    console.error(`[dm-responder] FAILED to send reply from ${actingAgent.name}: ${sendErr}. Original DM stays unread for retry.`);
    return;
  }

  // Reply sent successfully - now mark original as read
  const marked = await markDmReadVerified(dm.id);
  if (!marked) {
    console.error(`[dm-responder] WARNING: reply was sent but failed to mark original DM ${dm.id} read. May result in duplicate reply on next tick.`);
  }
}

function formatCompanyTime(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
