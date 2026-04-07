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
// ----------------------------------------------------------------------------

export async function maybeRunDmResponder(clock: WorldClock): Promise<void> {
  if (await isOverHourlyCap()) {
    // Silently skip - no log spam, this fires every tick
    return;
  }

  const dm = await getOldestUnreadDmActionable();
  if (!dm) return;

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

  // Build the trigger - this prompt asks the agent to respond directly to one DM
  const trigger = `A direct message has arrived for you. Read it carefully and respond.

Sender: ${senderName} (${senderRole})

Message:
"${dm.body}"

Respond as you would to a real direct message from this person. Keep it conversational - a few sentences, not an essay. Stay in your voice. Be specific to what they actually said. Do not preface your response with "Here's my reply:" or similar - respond directly as if typing in a chat window.

You should reply unless the message is genuinely just an FYI that needs no response (a one-line acknowledgment, a "thanks" with nothing to add, a notification). In those rare cases respond with the single word: SKIP

Default to replying. The CEO and your colleagues need to know they have been heard.`;

  const contextBlock = [
    `You are reading a private direct message.`,
    `This is a 1-on-1 conversation. The reply you write will be sent only to ${senderName}, not posted publicly.`,
    `Current company time: ${formatCompanyTime(clock.company_time)}`,
  ].join("\n");

  // Day 5: resolve the agent's allowed tools (empty for most agents, ['web_search'] for Ayaka)
  const agentTools = getToolsForAgent(recipient.tool_access ?? []);
  if (agentTools.length > 0) {
    console.log(`[dm-responder] ${recipient.name} has ${agentTools.length} tool(s) available: ${agentTools.map((t) => t.definition.name).join(", ")}`);
  }

  // Day 5.3: mark the DM as in-flight so the dashboard can show "X is thinking..."
  // Best-effort - if this fails we still process the DM. The dashboard polls
  // this column to render the in-flight indicator.
  await db.from("dms").update({ in_flight_since: new Date().toISOString() }).eq("id", dm.id);

  // Day 5.3: research-tier agents need more room for triangulated answers
  // (Jae-won got truncated mid-sentence at 600 tokens in Day 5.2 testing)
  const dmMaxTokens = agentTools.length > 0 ? 1500 : 600;

  const result = await runAgentTurn({
    agent: recipient,
    trigger,
    contextBlock,
    maxTokens: dmMaxTokens,
    tools: agentTools.length > 0 ? agentTools : undefined,
  });

  // Day 5.3: clear in-flight regardless of success/skip - the dashboard
  // shouldn't show "thinking" forever if the responder bailed.
  // Best-effort, doesn't block the rest of the flow.
  await db.from("dms").update({ in_flight_since: null }).eq("id", dm.id);

  if (result.skipped) {
    console.log(`[dm-responder] ${recipient.name} skipped: ${result.skipped} - DM stays unread for retry`);
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
    console.log(`[dm-responder] ${recipient.name} declined to reply (SKIP)`);
    await markDmReadVerified(dm.id);
    return;
  }

  // Send the reply DM FIRST, then mark the original read.
  // If sendDm throws, we don't mark read, and the next tick retries.
  try {
    const sent = await sendDm({
      fromId: recipient.id,
      toId: dm.from_id,
      body: text,
    });
    console.log(`[dm-responder] ${recipient.name} replied to ${senderName} (DM ${sent.id})`);
  } catch (sendErr) {
    console.error(`[dm-responder] FAILED to send reply from ${recipient.name}: ${sendErr}. Original DM stays unread for retry.`);
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
