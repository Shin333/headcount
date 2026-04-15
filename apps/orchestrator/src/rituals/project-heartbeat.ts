// ============================================================================
// rituals/project-heartbeat.ts - Day 21 + Day 25 combined
// ----------------------------------------------------------------------------
// TWO features in one file:
//
// 1. PROACTIVE WORK DETECTION (Day 21)
//    When an artifact lands in a project channel, scan other project members
//    for pending commitments or roles that suggest they're waiting on this
//    type of work. Auto-DM them with a targeted "your dependency just landed"
//    trigger so they start working without CEO intervention.
//
// 2. PERSISTENT PROJECT HEARTBEAT (Day 25)
//    A slow background tick (every 5 wall minutes) per active project.
//    On each heartbeat, find ONE agent with pending/overdue commitments
//    who hasn't had a turn recently, and give them a proactive channel turn.
//    This makes agents work even when the channel is quiet.
//
// Cost considerations:
//   - Heartbeat runs at most 1 agent per project per cycle (5 min)
//   - Uses the agent's normal model tier (Sonnet for managers, Opus for execs)
//   - ~$0.02-$0.05 per heartbeat turn
//   - At 12 heartbeats/hour × $0.03 average = ~$0.36/hour when active
// ============================================================================

import { db } from "../db.js";
import { config } from "../config.js";
import { isOverHourlyCap, runAgentTurn } from "../agents/runner.js";
import { getToolsForAgent } from "../tools/registry.js";
import { getChannelHistory, getPinnedMessages, formatChannelHistory, loadAgentNames, postToChannel } from "../comms/channel.js";
import { getPendingCommitmentsForAgent, formatCommitmentsBlock } from "../commitments/store.js";
import { AgentSchema } from "@headcount/shared";
import type { Agent } from "@headcount/shared";
import type { WorldClock } from "../world/clock.js";

// ----------------------------------------------------------------------------
// Configuration
// ----------------------------------------------------------------------------

// How often the heartbeat fires (wall time)
// Day 22: increased from 5 to 15 minutes. 5 min was too aggressive —
// agents kept getting nudged before they had time to process the previous turn.
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000; // 15 wall minutes

// Track last heartbeat per project to avoid double-firing
const lastHeartbeatByProject = new Map<string, number>();

// Track last heartbeat globally
let lastGlobalHeartbeat = 0;

// Day 22: Track agents who SKIPped on heartbeat — don't re-nudge for 30 min
const heartbeatSkipCooldown = new Map<string, number>(); // agentId+commitmentDesc → timestamp
const HEARTBEAT_SKIP_COOLDOWN_MS = 30 * 60 * 1000; // 30 wall minutes

// CEO sentinel ID
const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";

// ----------------------------------------------------------------------------
// Part 1: Proactive Work Detection (Day 21)
// ----------------------------------------------------------------------------
// Called from artifacts.ts when an artifact is created and posted to a
// project channel. Checks if any other project member should be triggered.

/**
 * Keyword-based dependency matching. Maps artifact content keywords to
 * agent roles/departments that are likely waiting for that work.
 */
const DEPENDENCY_MAP: Array<{
  artifactKeywords: string[];
  dependentRoles: string[];
  triggerMessage: string;
}> = [
  {
    artifactKeywords: ["portrait", "headshot", "image", "photo"],
    dependentRoles: ["UI Designer", "Brand Guardian", "UX Architect", "Marketing Manager"],
    triggerMessage: "New visual assets have been posted to the project channel. Check if this unblocks your workstream.",
  },
  {
    artifactKeywords: ["bio", "bios", "copy", "content", "writing"],
    dependentRoles: ["Brand Guardian", "UI Designer", "Frontend"],
    triggerMessage: "New content/copy has been posted to the project channel. Check if this is the content you were waiting on.",
  },
  {
    artifactKeywords: ["scaffold", "repo", "setup", "architecture", "package.json"],
    dependentRoles: ["UI Designer", "Frontend", "Brand Guardian", "UX Architect"],
    triggerMessage: "The repo scaffold has been posted. You can now start building against real code. Check the channel.",
  },
  {
    artifactKeywords: ["design token", "@theme", "color", "typography", "spacing"],
    dependentRoles: ["Frontend", "Brand Guardian", "Engineering"],
    triggerMessage: "Design tokens have been posted. Check the channel and integrate them into your workstream.",
  },
  {
    artifactKeywords: ["component", "card", "layout", "spec", "team-page", "team page", "agentcard", "teamgrid", "agent-card"],
    dependentRoles: ["Frontend", "Engineering Manager", "Senior Project Manager", "Brand Guardian", "UX Architect"],
    triggerMessage: "A component spec has been posted. Review it against your workstream requirements.",
  },
];

/**
 * Check if an artifact notification should proactively trigger other agents.
 * Called after an artifact is posted to a project channel.
 */
export async function checkDependencyTriggers(
  projectId: string,
  creatorAgentId: string,
  artifactTitle: string,
  artifactSummary: string
): Promise<void> {
  try {
    const combinedText = `${artifactTitle} ${artifactSummary}`.toLowerCase();

    // Find matching dependency rules
    const matchedRules = DEPENDENCY_MAP.filter((rule) =>
      rule.artifactKeywords.some((kw) => combinedText.includes(kw))
    );

    if (matchedRules.length === 0) return;

    // Get all project members (excluding the creator and CEO)
    const { data: members } = await db
      .from("project_members")
      .select("agent_id")
      .eq("project_id", projectId)
      .neq("agent_id", creatorAgentId)
      .neq("agent_id", CEO_SENTINEL_ID);

    if (!members || members.length === 0) return;

    const memberIds = members.map((m: any) => m.agent_id);

    // Load agent details
    const { data: agents } = await db
      .from("agents")
      .select("*")
      .in("id", memberIds)
      .eq("status", "active");

    if (!agents || agents.length === 0) return;

    // For each matched rule, find agents whose role matches
    const triggeredAgentIds = new Set<string>();

    for (const rule of matchedRules) {
      for (const agentRow of agents) {
        if (triggeredAgentIds.has(agentRow.id)) continue;

        const roleMatch = rule.dependentRoles.some((depRole) => {
          const roleLower = (agentRow.role ?? "").toLowerCase();
          const deptLower = (agentRow.department ?? "").toLowerCase();
          const depLower = depRole.toLowerCase();
          return roleLower.includes(depLower) || deptLower.includes(depLower);
        });

        if (roleMatch) {
          // Check if this agent has pending commitments (they're actively waiting)
          const pendingCommitments = await getPendingCommitmentsForAgent(agentRow.id);
          
          // Only trigger if they have pending work or their role suggests dependency
          triggeredAgentIds.add(agentRow.id);

          console.log(
            `[heartbeat] dependency trigger: "${artifactTitle}" → ${agentRow.name} (${agentRow.role}), ${pendingCommitments.length} pending commitment(s)`
          );

          // Post a targeted notification to the channel
          await postToChannel({
            projectId,
            agentId: CEO_SENTINEL_ID, // System-generated, shows as from CEO
            body: `@${agentRow.name} — a dependency for your workstream just landed: **${artifactTitle}**. ${rule.triggerMessage}`,
            messageType: "system",
          });
        }
      }
    }

    if (triggeredAgentIds.size > 0) {
      console.log(
        `[heartbeat] triggered ${triggeredAgentIds.size} agent(s) on dependency from "${artifactTitle}"`
      );
    }
  } catch (err) {
    // Never let dependency detection break artifact creation
    console.warn(
      `[heartbeat] dependency check failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ----------------------------------------------------------------------------
// Part 2: Persistent Project Heartbeat (Day 25)
// ----------------------------------------------------------------------------
// Called from the tick loop. Fires at most once per HEARTBEAT_INTERVAL_MS.
// Picks ONE agent per active project who has pending/overdue work and
// gives them a proactive turn.

export async function maybeRunProjectHeartbeat(clock: WorldClock): Promise<void> {
  const now = Date.now();
  if (now - lastGlobalHeartbeat < HEARTBEAT_INTERVAL_MS) return;
  lastGlobalHeartbeat = now;

  if (await isOverHourlyCap()) return;

  // Find all active projects
  const { data: projects } = await db
    .from("projects")
    .select("id, title")
    .eq("tenant_id", config.tenantId)
    .eq("status", "active");

  if (!projects || projects.length === 0) return;

  // Process at most ONE project per heartbeat to spread the cost
  for (const project of projects) {
    const projectLastBeat = lastHeartbeatByProject.get(project.id) ?? 0;
    if (now - projectLastBeat < HEARTBEAT_INTERVAL_MS) continue;

    lastHeartbeatByProject.set(project.id, now);

    await heartbeatOneProject(project.id, project.title, clock);
    break; // Only one project per tick
  }
}

async function heartbeatOneProject(
  projectId: string,
  projectTitle: string,
  clock: WorldClock
): Promise<void> {
  // Find project members with overdue or pending commitments
  const { data: members } = await db
    .from("project_members")
    .select("agent_id")
    .eq("project_id", projectId)
    .neq("agent_id", CEO_SENTINEL_ID);

  if (!members || members.length === 0) return;

  const memberIds = members.map((m: any) => m.agent_id);

  // Find the best candidate: agent with oldest overdue commitment
  let bestCandidate: { agentId: string; commitmentDesc: string; minutesOverdue: number } | null = null;

  for (const memberId of memberIds) {
    const commitments = await getPendingCommitmentsForAgent(memberId);
    if (commitments.length === 0) continue;

    // Find the most overdue commitment
    for (const c of commitments) {
      if (!c.deadline_at) continue;
      const minutesOverdue = (Date.now() - new Date(c.deadline_at).getTime()) / 60000;
      if (minutesOverdue <= 0) continue; // Not overdue yet

      // Day 22: skip if this agent+commitment was recently SKIPped
      const cooldownKey = `${memberId}:${c.description}`;
      const lastSkip = heartbeatSkipCooldown.get(cooldownKey);
      if (lastSkip && (Date.now() - lastSkip) < HEARTBEAT_SKIP_COOLDOWN_MS) continue;

      if (!bestCandidate || minutesOverdue > bestCandidate.minutesOverdue) {
        bestCandidate = {
          agentId: memberId,
          commitmentDesc: c.description,
          minutesOverdue: Math.round(minutesOverdue),
        };
      }
    }
  }

  if (!bestCandidate) return; // No overdue commitments in this project

  // Load the agent
  const { data: agentRow } = await db
    .from("agents")
    .select("*")
    .eq("id", bestCandidate.agentId)
    .maybeSingle();

  if (!agentRow) return;

  const parsed = AgentSchema.safeParse(agentRow);
  if (!parsed.success) return;
  const agent: Agent = parsed.data;

  if (agent.status !== "active") return;
  if (agent.tokens_used_today >= agent.daily_token_budget) {
    console.log(`[heartbeat] ${agent.name} over budget, skipping heartbeat`);
    return;
  }

  console.log(
    `[heartbeat] proactive turn for ${agent.name} on "${projectTitle}" — commitment "${bestCandidate.commitmentDesc}" is ${bestCandidate.minutesOverdue}min overdue`
  );

  // Build context
  const history = await getChannelHistory(projectId, 40);
  const pinned = await getPinnedMessages(projectId);

  const allAgentIds = [
    ...history.map((m) => m.agent_id),
    ...(pinned ?? []).map((m) => m.agent_id),
  ];
  const agentNames = await loadAgentNames(allAgentIds);

  const channelBlock = formatChannelHistory(projectTitle, history, agentNames, pinned);

  const pendingCommitments = await getPendingCommitmentsForAgent(agent.id);
  const commitmentsBlock = formatCommitmentsBlock(pendingCommitments);

  const contextLines: string[] = [];
  if (channelBlock) contextLines.push(channelBlock);
  if (commitmentsBlock) {
    contextLines.push("");
    contextLines.push(commitmentsBlock);
  }

  // Day 22: inject agent's completed work so they remember what they've done
  try {
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
      contextLines.push(`YOUR RECENT WORK (do NOT claim you haven't done this):\n${workLines.join("\n")}`);
    }
  } catch { /* non-critical */ }

  const trigger = `This is a proactive work check. Nobody posted a new message — the system is checking on your pending work.

You have an overdue commitment: "${bestCandidate.commitmentDesc}" (${bestCandidate.minutesOverdue} minutes past deadline).

PRODUCE THE DELIVERABLE NOW. Do not write a status update. Do not ask for clarification. Use your tools to create the artifact or output you committed to.

If you are genuinely blocked on a specific missing input, state the exact input you need in one sentence and respond with SKIP. Otherwise, produce the work.`;

  const agentTools = getToolsForAgent(agent.tool_access ?? []);

  // Extract images from context for agent vision
  const { extractAndLoadImages } = await import("../agents/vision.js");
  const allText = [trigger, channelBlock ?? ""].join("\n");
  const imageBlocks = await extractAndLoadImages(allText);

  const result = await runAgentTurn({
    agent,
    trigger,
    contextBlock: contextLines.join("\n"),
    maxTokens: agentTools.length > 0 ? 1500 : 800,
    tools: agentTools.length > 0 ? agentTools : undefined,
    imageBlocks: imageBlocks.length > 0 ? imageBlocks : undefined,
  });

  if (result.skipped) {
    console.log(`[heartbeat] ${agent.name} skipped: ${result.skipped}`);
    return;
  }

  const text = result.text.trim();

  // Don't post SKIP responses to channel
  const firstLine = text.split("\n")[0]?.trim().toUpperCase() ?? "";
  if (
    !text ||
    firstLine === "SKIP" ||
    firstLine.startsWith("SKIP —") ||
    firstLine.startsWith("SKIP –") ||
    firstLine.startsWith("SKIP -") ||
    firstLine.startsWith("SKIP ")
  ) {
    // Day 22: record cooldown so we don't re-nudge this agent on the same commitment
    const cooldownKey = `${agent.id}:${bestCandidate.commitmentDesc}`;
    heartbeatSkipCooldown.set(cooldownKey, Date.now());
    console.log(`[heartbeat] ${agent.name} SKIPped on heartbeat — cooldown 30min`);
    return;
  }

  // Check if agent already posted via project_post tool
  const usedProjectPost = result.toolStructuredPayloads?.some(
    (p) => p.toolName === "project_post"
  );

  if (!usedProjectPost && text.length > 0) {
    // Don't auto-post if it's still a SKIP-like response
    const bodyStart = text.slice(0, 50).toUpperCase();
    if (!bodyStart.includes("SKIP")) {
      await postToChannel({
        projectId,
        agentId: agent.id,
        body: text,
        messageType: "message",
      });
      console.log(`[heartbeat] auto-posted ${agent.name}'s proactive output to channel`);
    }
  }

  console.log(
    `[heartbeat] ${agent.name} heartbeat complete — $${result.costUsd.toFixed(4)}`
  );
}
