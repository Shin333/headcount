// ============================================================================
// rituals/project-responder.ts - Day 17 - the "meeting room" loop
// ----------------------------------------------------------------------------
// When a new message lands in a project channel, this responder decides
// which project members should react and runs their turns.
//
// The flow for each new channel message:
//   1. Load the project, its members, and recent channel history
//   2. For each member who DIDN'T send the message, run a cheap Haiku
//      pre-filter: "Should you respond to this?"
//   3. For agents that answered YES, run their full turn (Sonnet/Opus)
//      with channel history as context. They can post back to the channel,
//      create artifacts, or dm_send for private side-conversations.
//   4. Agents that answered NO stay quiet.
//
// The Haiku pre-filter prevents the cost explosion of 7× Sonnet calls
// per channel message. At ~$0.001 per Haiku call, filtering 7 agents
// costs $0.007. Only agents whose work is affected by the message pay
// the full Sonnet/Opus price.
//
// This responder is triggered by Supabase realtime INSERT events on
// project_messages (wired up in tick.ts alongside the DM subscription).
// ============================================================================

import { db } from "../db.js";
import { config } from "../config.js";
import { runAgentTurn, isOverHourlyCap } from "../agents/runner.js";
import { AgentSchema } from "@headcount/shared";
import type { Agent } from "@headcount/shared";
import type { WorldClock } from "../world/clock.js";
import { getToolsForAgent } from "../tools/registry.js";
import { getChannelHistory, formatChannelHistory, loadAgentNames, getPinnedMessages } from "../comms/channel.js";
import { buildProjectContextBlock } from "../projects/members.js";
import { getPendingCommitmentsForAgent, formatCommitmentsBlock } from "../commitments/store.js";
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic();

// CEO sentinel — don't try to run a turn for the CEO
const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";

// Max agents that can respond to a single channel message. Prevents
// runaway cost if a project has 20+ members.
const MAX_RESPONDERS_PER_MESSAGE = 5;

// Haiku model for the cheap pre-filter
const PREFILTER_MODEL = "claude-haiku-4-5-20251001";

// Mutex to prevent concurrent project-responder runs
let projectResponderRunning = false;

/**
 * Process a new project channel message. Called by the realtime
 * subscription handler in tick.ts.
 */
export async function handleProjectMessage(
  messageId: string,
  projectId: string,
  senderId: string,
  clock: WorldClock
): Promise<void> {
  if (projectResponderRunning) {
    // Another message is being processed. The tick fallback will catch it.
    return;
  }
  if (await isOverHourlyCap()) return;

  projectResponderRunning = true;
  try {
    await processProjectMessage(messageId, projectId, senderId, clock);
  } catch (err) {
    console.error(`[project-responder] error processing message ${messageId}:`, err);
  } finally {
    projectResponderRunning = false;
  }
}

async function processProjectMessage(
  messageId: string,
  projectId: string,
  senderId: string,
  clock: WorldClock
): Promise<void> {
  // Load the project
  const { data: project, error: projectErr } = await db
    .from("projects")
    .select("id, title, description, status")
    .eq("id", projectId)
    .eq("tenant_id", config.tenantId)
    .maybeSingle();

  if (projectErr || !project) {
    console.warn(`[project-responder] project ${projectId} not found`);
    return;
  }
  if (project.status !== "active") return;

  // Load project members (excluding the sender and the CEO)
  const { data: members, error: membersErr } = await db
    .from("project_members")
    .select("agent_id")
    .eq("project_id", projectId)
    .neq("agent_id", senderId)
    .neq("agent_id", CEO_SENTINEL_ID);

  if (membersErr || !members || members.length === 0) return;

  const memberIds = (members as Array<{ agent_id: string }>).map((m) => m.agent_id);

  // Load agent rows for all members
  const { data: agentRows, error: agentsErr } = await db
    .from("agents")
    .select("*")
    .in("id", memberIds)
    .eq("status", "active");

  if (agentsErr || !agentRows || agentRows.length === 0) return;

  const agents: Agent[] = [];
  for (const row of agentRows) {
    const parsed = AgentSchema.safeParse(row);
    if (parsed.success) agents.push(parsed.data);
  }

  if (agents.length === 0) return;

  // Load the channel history (last 40 messages) + pinned messages
  const history = await getChannelHistory(projectId, 40, messageId);
  const pinned = await getPinnedMessages(projectId);

  // Load the triggering message itself
  const { data: triggerMsg } = await db
    .from("project_messages")
    .select("body, agent_id, message_type")
    .eq("id", messageId)
    .maybeSingle();

  if (!triggerMsg) return;

  // Load agent names for formatting
  const allIds = [...memberIds, senderId, CEO_SENTINEL_ID];
  const agentNames = await loadAgentNames(allIds);
  const senderName = agentNames.get(senderId) ?? `Agent ${senderId.slice(0, 8)}`;

  const channelBlock = formatChannelHistory(project.title, history, agentNames, pinned);

  console.log(
    `[project-responder] new message in "${project.title}" from ${senderName} — checking ${agents.length} member(s)`
  );

  // ---- Haiku pre-filter: who should respond? ----
  const respondingAgents: Agent[] = [];

  for (const agent of agents) {
    // Budget check per agent
    if (agent.tokens_used_today >= agent.daily_token_budget) continue;

    const shouldRespond = await runPreFilter(
      agent,
      project.title,
      senderName,
      triggerMsg.body,
      triggerMsg.message_type
    );

    if (shouldRespond) {
      respondingAgents.push(agent);
      if (respondingAgents.length >= MAX_RESPONDERS_PER_MESSAGE) break;
    }
  }

  if (respondingAgents.length === 0) {
    console.log(`[project-responder] no agents need to respond to this message`);
    return;
  }

  console.log(
    `[project-responder] ${respondingAgents.length} agent(s) responding: ${respondingAgents.map((a) => a.name).join(", ")}`
  );

  // ---- Run each responding agent's turn ----
  // Sequential, highest-tier first (opus > sonnet > haiku)
  const tierOrder = { exec: 0, director: 1, manager: 2, associate: 3, intern: 4, bot: 5 };
  respondingAgents.sort(
    (a, b) => (tierOrder[a.tier] ?? 99) - (tierOrder[b.tier] ?? 99)
  );

  for (const agent of respondingAgents) {
    if (await isOverHourlyCap()) {
      console.log(`[project-responder] hourly cap reached, stopping`);
      break;
    }

    await runProjectTurn(agent, project, triggerMsg, senderName, channelBlock, clock);
  }
}

// ----------------------------------------------------------------------------
// Haiku pre-filter
// ----------------------------------------------------------------------------

async function runPreFilter(
  agent: Agent,
  projectTitle: string,
  senderName: string,
  messageBody: string,
  messageType: string
): Promise<boolean> {
  // Artifact notifications always trigger relevant agents — skip the LLM call
  // for a cheaper heuristic: does the agent have tools that suggest they care?
  if (messageType === "artifact") {
    // Directors and managers always see artifacts
    if (agent.tier === "exec" || agent.tier === "director" || agent.tier === "manager") {
      return true;
    }
  }

  // System messages don't need agent responses
  if (messageType === "system") return false;

  // Day 19 fix: if the message mentions this agent by name, they ALWAYS respond.
  // This prevents the pre-filter from incorrectly saying NO when the CEO
  // explicitly addresses someone ("Heng — generate now", "Eleanor — pull the roster").
  const bodyLower = messageBody.toLowerCase();
  const fullNameLower = agent.name.toLowerCase();
  
  // Full name match — always reliable
  if (bodyLower.includes(fullNameLower)) {
    console.log(
      `[project-responder] pre-filter ${agent.name}: YES (named directly — bypassing Haiku)`
    );
    return true;
  }

  // First name match with word boundary — avoids "Park" in "Shin Park" triggering Park So-yeon
  const nameParts = agent.name.split(" ");
  const firstName = nameParts[0] ?? "";
  if (firstName.length >= 3) {
    const firstNamePattern = new RegExp(`\\b${firstName.toLowerCase()}\\b`);
    if (firstNamePattern.test(bodyLower)) {
      console.log(
        `[project-responder] pre-filter ${agent.name}: YES (first name match — bypassing Haiku)`
      );
      return true;
    }
  }

  const truncatedBody =
    messageBody.length > 400 ? messageBody.slice(0, 400) + "..." : messageBody;

  try {
    const response = await anthropic.messages.create({
      model: PREFILTER_MODEL,
      max_tokens: 50,
      messages: [
        {
          role: "user",
          content: `You are ${agent.name} (${agent.role}) on the project "${projectTitle}". A team member just posted this in the project channel:

From: ${senderName}
"${truncatedBody}"

Should you respond to this message? Consider: does it directly affect YOUR work, does it ask you a question, does it require your expertise, or does it change something you're responsible for?

Answer only YES or NO. Nothing else.`,
        },
      ],
    });

    const answer = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim()
      .toUpperCase();

    const shouldRespond = answer.startsWith("YES");

    // Log cost for tracking
    const inputTokens = response.usage.input_tokens ?? 0;
    const outputTokens = response.usage.output_tokens ?? 0;
    const cost = (inputTokens / 1_000_000) * 1 + (outputTokens / 1_000_000) * 5; // Haiku pricing

    console.log(
      `[project-responder] pre-filter ${agent.name}: ${shouldRespond ? "YES" : "NO"} ($${cost.toFixed(4)})`
    );

    return shouldRespond;
  } catch (err) {
    console.warn(
      `[project-responder] pre-filter failed for ${agent.name}: ${err instanceof Error ? err.message : String(err)}`
    );
    // On error, default to not responding (fail closed to save cost)
    return false;
  }
}

// ----------------------------------------------------------------------------
// Full agent turn in the project context
// ----------------------------------------------------------------------------

async function runProjectTurn(
  agent: Agent,
  project: { id: string; title: string; description: string },
  triggerMsg: { body: string; agent_id: string; message_type: string },
  senderName: string,
  channelBlock: string | null,
  clock: WorldClock
): Promise<void> {
  const formatTime = (d: Date) => {
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const hh = String(d.getUTCHours()).padStart(2, "0");
    const min = String(d.getUTCMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
  };

  // Build context with channel history + project context
  const contextLines = [
    `You are in a project channel — a shared meeting room for project "${project.title}".`,
    `Everything you write will be posted to the channel and visible to all team members.`,
    `Current company time: ${formatTime(clock.company_time)}`,
  ];

  // Inject project context (Day 15)
  const projectContext = await buildProjectContextBlock(agent.id);
  if (projectContext) {
    contextLines.push("");
    contextLines.push(projectContext);
  }

  // Inject channel history
  if (channelBlock) {
    contextLines.push("");
    contextLines.push(channelBlock);
  }

  // Day 18: inject pending commitments
  const pendingCommitments = await getPendingCommitmentsForAgent(agent.id);
  const commitmentsBlock = formatCommitmentsBlock(pendingCommitments);
  if (commitmentsBlock) {
    contextLines.push("");
    contextLines.push(commitmentsBlock);
  }

  // Day 22: inject agent's completed work so they don't confabulate
  try {
    const { db } = await import("../db.js");
    const { data: recentArtifacts } = await db
      .from("artifacts")
      .select("title, file_path, created_at")
      .eq("tenant_id", config.tenantId)
      .eq("agent_id", agent.id)
      .order("created_at", { ascending: false })
      .limit(10);

    if (recentArtifacts && recentArtifacts.length > 0) {
      const workLines = recentArtifacts.map((a: any) => {
        const time = new Date(a.created_at).toLocaleTimeString("en-US", {
          hour: "2-digit", minute: "2-digit", timeZone: "Asia/Taipei",
        });
        return `- [${time}] "${a.title}" → ${a.file_path}`;
      });
      contextLines.push("");
      contextLines.push(`YOUR RECENT WORK (artifacts you created — do NOT claim you haven't done this):\n${workLines.join("\n")}`);
    }
  } catch { /* non-critical */ }

  const contextBlock = contextLines.join("\n");

  // Build trigger
  const trigger = `A new message was posted in your project channel "${project.title}".

From: ${senderName}
"${triggerMsg.body}"

You are responding in the shared project channel — everyone on the team will see what you write. Be specific, concise, and useful. Reference your own workstream and how this message affects it.

If you have deliverables to share, use markdown_artifact_create to create them and reference the filename in your channel post.

If you want to post your response to the channel, use the project_post tool with project_id "${project.id}".

If this message doesn't require a visible response from you (just an internal note), respond with: SKIP`;

  const agentTools = getToolsForAgent(agent.tool_access ?? []);

  // Day 19: Agent Vision — extract workspace images from the trigger message
  // and channel history, load them as base64, and inject into the agent's context.
  // This lets agents SEE portraits, mockups, and other visual artifacts.
  const { extractAndLoadImages } = await import("../agents/vision.js");
  const allText = [triggerMsg.body, channelBlock ?? ""].join("\n");
  const imageBlocks = await extractAndLoadImages(allText);

  console.log(`[project-responder] running turn for ${agent.name} on "${project.title}"`);

  const result = await runAgentTurn({
    agent,
    trigger,
    contextBlock,
    maxTokens: agentTools.length > 0 ? 1500 : 600,
    tools: agentTools.length > 0 ? agentTools : undefined,
    imageBlocks: imageBlocks.length > 0 ? imageBlocks : undefined,
  });

  if (result.skipped) {
    console.log(`[project-responder] ${agent.name} skipped: ${result.skipped}`);
    return;
  }

  const text = result.text.trim();
  if (!text || text.toUpperCase() === "SKIP") {
    console.log(`[project-responder] ${agent.name} declined to respond (SKIP)`);
    return;
  }

  // Day 20: catch verbose SKIPs — agents often write "SKIP\n\nReason why..."
  // or "SKIP — not my workstream" instead of a bare "SKIP". These should NOT
  // be auto-posted to the channel. They create a feedback loop where each
  // SKIP message triggers another round of pre-filters.
  const firstLine = text.split("\n")[0]?.trim().toUpperCase() ?? "";
  if (firstLine === "SKIP" || firstLine.startsWith("SKIP —") || firstLine.startsWith("SKIP –") || firstLine.startsWith("SKIP -") || firstLine.startsWith("SKIP ")) {
    console.log(`[project-responder] ${agent.name} declined to respond (verbose SKIP)`);
    return;
  }

  // If the agent didn't use project_post tool themselves, auto-post their
  // text response to the channel. This handles agents that write a response
  // but forget to call project_post.
  const usedProjectPost = result.toolStructuredPayloads?.some(
    (p) => p.toolName === "project_post"
  );

  if (!usedProjectPost) {
    try {
      // Strip artifacts block before posting to channel
      let channelBody = text;
      const artifactIdx = channelBody.lastIndexOf("<artifacts>");
      if (artifactIdx !== -1) {
        channelBody = channelBody.slice(0, artifactIdx).trimEnd();
      }

      // Day 20: final SKIP check — if the cleaned body is mostly a SKIP
      // explanation, don't post it. Look for SKIP anywhere in first 50 chars.
      const bodyStart = channelBody.slice(0, 50).toUpperCase();
      if (bodyStart.includes("SKIP")) {
        console.log(`[project-responder] ${agent.name} declined to respond (SKIP in body)`);
        return;
      }

      if (channelBody.length > 0) {
        const { postToChannel: post } = await import("../comms/channel.js");
        await post({
          projectId: project.id,
          agentId: agent.id,
          body: channelBody,
          messageType: "message",
        });
        console.log(`[project-responder] auto-posted ${agent.name}'s response to channel`);
      }
    } catch (err) {
      console.warn(
        `[project-responder] failed to auto-post ${agent.name}'s response: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}
