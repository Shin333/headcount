// ============================================================================
// rituals/stall-detector.ts - Day 18 - nudge agents on overdue commitments
// ----------------------------------------------------------------------------
// Runs on a throttled schedule (every ~5 wall minutes). Finds commitments
// where:
//   - status = 'pending'
//   - deadline_at < now()
//   - nudge_count < 3
//
// For each overdue commitment, triggers the agent with an urgent prompt:
// "You committed to X and the deadline has passed. Produce the deliverable
// NOW." This replaces the CEO having to manually poke agents who stalled.
//
// After 3 nudges without resolution, the commitment is marked 'stalled'
// and flagged to the CEO. At that point, human intervention is needed.
//
// The nudge fires as a project channel message (if the commitment has a
// project_id) or as a DM to the agent (if no project). This ensures the
// rest of the team sees that the agent is being nudged, creating social
// pressure.
// ============================================================================

import { db } from "../db.js";
import { config } from "../config.js";
import { runAgentTurn, isOverHourlyCap } from "../agents/runner.js";
import { AgentSchema } from "@headcount/shared";
import type { Agent } from "@headcount/shared";
import type { WorldClock } from "../world/clock.js";
import { getToolsForAgent } from "../tools/registry.js";
import {
  getOverdueCommitments,
  incrementNudgeCount,
  markStalled,
  formatCommitmentsBlock,
  getPendingCommitmentsForAgent,
} from "../commitments/store.js";
import { postToChannel } from "../comms/channel.js";
import { buildProjectContextBlock } from "../projects/members.js";

// Throttle: only run stall detection every 5 wall minutes
// Day 22: increased from 5 to 10 minutes. Frequent nudges create cascades
// of repeat content as agents respond to nudges with status updates that
// trigger other agents. 10 min gives agents time to process between nudges.
const STALL_CHECK_INTERVAL_MS = 10 * 60 * 1000;
let lastStallCheck = 0;

// Max nudges before marking as stalled and giving up
const MAX_NUDGES = 3;

// Max commitments to process per check (prevent runaway costs)
const MAX_PER_CHECK = 3;

export async function maybeRunStallDetector(clock: WorldClock): Promise<void> {
  const now = Date.now();
  if (now - lastStallCheck < STALL_CHECK_INTERVAL_MS) return;
  lastStallCheck = now;

  if (await isOverHourlyCap()) return;

  const overdue = await getOverdueCommitments(MAX_NUDGES);
  if (overdue.length === 0) return;

  console.log(`[stall-detector] found ${overdue.length} overdue commitment(s)`);

  let processed = 0;
  for (const commitment of overdue) {
    if (processed >= MAX_PER_CHECK) break;
    if (await isOverHourlyCap()) break;

    // Check if this commitment has already been nudged too many times
    if (commitment.nudge_count >= MAX_NUDGES) {
      // Day 22: silently mark as stalled instead of posting to channel.
      // The old behavior posted "Escalating to CEO" which triggered more
      // agent responses and created a feedback loop. The CEO already sees
      // stalled commitments in the Projects dashboard tab.
      console.log(`[stall-detector] marking stalled: ${commitment.id.slice(0, 8)} (${MAX_NUDGES} nudges exhausted)`);
      await markStalled(commitment.id);
      continue;
    }

    // Load the agent
    const { data: agentRow } = await db
      .from("agents")
      .select("*")
      .eq("id", commitment.agent_id)
      .eq("tenant_id", config.tenantId)
      .maybeSingle();

    if (!agentRow) continue;
    const parsed = AgentSchema.safeParse(agentRow);
    if (!parsed.success) continue;
    const agent: Agent = parsed.data;
    if (agent.status !== "active") continue;

    // Check token budget
    if (agent.tokens_used_today >= agent.daily_token_budget) {
      console.log(`[stall-detector] ${agent.name} over budget, skipping nudge`);
      continue;
    }

    // Day 22: duplicate response detection.
    // Check if this agent already posted substantive content to the channel
    // in the last 10 messages. If they did, the nudge is redundant — they
    // already delivered or explained the blocker. Skip the nudge.
    if (commitment.project_id) {
      try {
        const { getChannelHistory } = await import("../comms/channel.js");
        const recent = await getChannelHistory(commitment.project_id, 10);
        const agentRecentPosts = recent.filter(
          (m: any) => m.agent_id === agent.id && m.message_type === "message" && m.body.length > 50
        );
        if (agentRecentPosts.length > 0) {
          console.log(
            `[stall-detector] ${agent.name} already posted ${agentRecentPosts.length} substantive message(s) in last 10 — skipping nudge`
          );
          // Still increment nudge count so it eventually auto-resolves
          await incrementNudgeCount(commitment.id);
          processed++;
          continue;
        }
      } catch { /* non-critical, proceed with nudge */ }
    }

    // Build the nudge
    const minutesOverdue = Math.round(
      (Date.now() - new Date(commitment.deadline_at!).getTime()) / 60000
    );

    console.log(
      `[stall-detector] nudging ${agent.name}: "${commitment.description}" (${minutesOverdue}min overdue, nudge #${commitment.nudge_count + 1})`
    );

    // Post nudge to project channel so team sees it
    if (commitment.project_id) {
      try {
        await postToChannel({
          projectId: commitment.project_id,
          agentId: commitment.agent_id,
          body: `⏰ **Overdue commitment reminder (nudge ${commitment.nudge_count + 1}/${MAX_NUDGES}):** "${commitment.description}" — ${minutesOverdue} minutes past deadline. Producing the deliverable now.`,
          messageType: "system",
        });
      } catch { /* best effort */ }
    }

    // Build context with commitments
    const allCommitments = await getPendingCommitmentsForAgent(agent.id);
    const commitmentsBlock = formatCommitmentsBlock(allCommitments);

    const contextLines = [
      `You have an OVERDUE commitment. The deadline has passed.`,
      `Current time: ${new Date().toLocaleString("en-SG", { timeZone: "Asia/Taipei" })}`,
    ];

    const projectContext = await buildProjectContextBlock(agent.id);
    if (projectContext) contextLines.push("", projectContext);
    if (commitmentsBlock) contextLines.push("", commitmentsBlock);

    const trigger = `URGENT: You committed to "${commitment.description}" and the deadline has passed (${minutesOverdue} minutes ago). This is nudge ${commitment.nudge_count + 1} of ${MAX_NUDGES}.

DO NOT write a status update or an explanation. DO NOT say "I'll get to it shortly." PRODUCE THE DELIVERABLE RIGHT NOW using markdown_artifact_create or code_artifact_create.

If the deliverable is text content (bios, copy, specs), use markdown_artifact_create.
If the deliverable is code, use code_artifact_create.
If the deliverable is a message to the team, use project_post.

After producing the deliverable, post it to the project channel so the team knows it's done.

If you genuinely cannot produce the deliverable (missing inputs, blocked by someone else), explain the SPECIFIC blocker in one sentence and respond with SKIP. Do not pad. Do not elaborate.`;

    const agentTools = getToolsForAgent(agent.tool_access ?? []);

    const result = await runAgentTurn({
      agent,
      trigger,
      contextBlock: contextLines.join("\n"),
      maxTokens: agentTools.length > 0 ? 2000 : 800,
      tools: agentTools.length > 0 ? agentTools : undefined,
    });

    // Increment nudge count regardless of outcome
    await incrementNudgeCount(commitment.id);

    if (result.skipped) {
      console.log(`[stall-detector] ${agent.name} skipped nudge: ${result.skipped}`);
    } else {
      const text = result.text.trim();
      const producedArtifact = result.toolStructuredPayloads?.some(
        (p) => p.toolName === "markdown_artifact_create" || p.toolName === "code_artifact_create"
      );

      if (producedArtifact) {
        console.log(`[stall-detector] ${agent.name} produced an artifact after nudge — checking for auto-resolve`);
        // Auto-resolve will be handled by the artifact creation hook (artifacts.ts)
      } else if (text.toUpperCase().startsWith("SKIP")) {
        console.log(`[stall-detector] ${agent.name} claims blocked`);
      } else {
        // Day 22: don't auto-post non-artifact responses to the channel.
        // This was the #1 cause of the feedback loop — agents responding
        // to nudges with status updates that trigger other agents to respond.
        // Only artifact deliverables get posted. Status text is just logged.
        console.log(`[stall-detector] ${agent.name} responded but no artifact produced. Text: ${text.slice(0, 100)}`);
      }
    }

    processed++;
  }
}
