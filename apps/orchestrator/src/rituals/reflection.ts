import { db } from "../db.js";
import { config } from "../config.js";
import { runAgentTurn, isOverHourlyCap } from "../agents/runner.js";
import { AgentSchema } from "@headcount/shared";
import type { Agent } from "@headcount/shared";

// ----------------------------------------------------------------------------
// reflection.ts - the learned addendum loop
// ----------------------------------------------------------------------------
// Runs once per wall hour for any agent with addendum_loop_active = true.
// Also exposes forceReflection() for the dashboard "Force reflection" button.
//
// If an agent has fewer than MIN_POSTS_FOR_REFLECTION posts to reflect on,
// we do NOT update last_reflection_at, so the next check retries instead of
// the agent waiting a full wall hour for nothing.
// ----------------------------------------------------------------------------

const MIN_POSTS_FOR_REFLECTION = 2;

export async function maybeRunReflections(now: Date): Promise<void> {
  if (await isOverHourlyCap()) {
    console.log("[reflection] skipped: hourly cost cap reached");
    return;
  }

  const intervalMs = config.reflectionWallIntervalHours * 60 * 60 * 1000;
  const cutoff = new Date(now.getTime() - intervalMs).toISOString();

  const { data: rawAgents, error } = await db
    .from("agents")
    .select("*")
    .eq("tenant_id", config.tenantId)
    .eq("status", "active")
    .eq("is_human", false)
    .eq("always_on", true)
    .eq("addendum_loop_active", true);

  if (error) {
    console.error("[reflection] failed to load agents:", error);
    return;
  }
  if (!rawAgents || rawAgents.length === 0) return;

  for (const raw of rawAgents) {
    const parsed = AgentSchema.safeParse(raw);
    if (!parsed.success) continue;
    const agent = parsed.data;

    if (agent.last_reflection_at && agent.last_reflection_at > cutoff) {
      continue; // too recent
    }
    await reflectOne(agent, now, false);
  }
}

/**
 * Force a reflection NOW for a specific agent, bypassing the wall-clock interval.
 * Used by the dashboard "Force reflection" button.
 */
export async function forceReflection(
  agentId: string
): Promise<"ok" | "no_change" | "too_few_posts" | "budget_exceeded" | "not_active" | "not_found"> {
  if (await isOverHourlyCap()) return "budget_exceeded";

  const { data: raw, error } = await db
    .from("agents")
    .select("*")
    .eq("id", agentId)
    .maybeSingle();

  if (error || !raw) return "not_found";
  const parsed = AgentSchema.safeParse(raw);
  if (!parsed.success) return "not_found";
  const agent = parsed.data;
  if (agent.is_human) return "not_active"; // safety: humans never reflect
  if (!agent.addendum_loop_active) return "not_active";

  return await reflectOne(agent, new Date(), true);
}

async function reflectOne(
  agent: Agent,
  now: Date,
  forced: boolean
): Promise<"ok" | "no_change" | "too_few_posts" | "budget_exceeded"> {
  // =========================================================================
  // Day 22: Pull ALL work context, not just forum posts.
  // Before this change, agents only reflected on standup/watercooler posts,
  // producing watercooler-heavy addendum proposals. Now we inject:
  // - Forum posts (standup, watercooler, forum)
  // - Project channel messages (meeting rooms)
  // - Recent DMs sent by this agent
  // - Artifacts they created
  // - Commitments (pending, resolved, stalled)
  // =========================================================================

  // 1. Forum posts (original source)
  const { data: recentPosts } = await db
    .from("forum_posts")
    .select("channel, body, created_at")
    .eq("tenant_id", config.tenantId)
    .eq("author_id", agent.id)
    .order("created_at", { ascending: false })
    .limit(10);

  // 2. Project channel messages by this agent (last 15)
  const { data: channelMessages } = await db
    .from("project_messages")
    .select("body, project_id, created_at, message_type")
    .eq("agent_id", agent.id)
    .eq("message_type", "message")
    .order("created_at", { ascending: false })
    .limit(15);

  // 3. Recent DMs sent by this agent (last 10)
  const { data: sentDms } = await db
    .from("dms")
    .select("body, to_id, created_at")
    .eq("from_id", agent.id)
    .order("created_at", { ascending: false })
    .limit(10);

  // 4. Artifacts created by this agent (last 10)
  const { data: artifacts } = await db
    .from("artifacts")
    .select("title, file_path, created_at")
    .eq("tenant_id", config.tenantId)
    .eq("agent_id", agent.id)
    .order("created_at", { ascending: false })
    .limit(10);

  // 5. Recent commitments for this agent
  const { data: commitments } = await db
    .from("commitments")
    .select("description, status, nudge_count, created_at")
    .eq("agent_id", agent.id)
    .order("created_at", { ascending: false })
    .limit(10);

  // Check if there's enough activity to reflect on
  const totalActivity =
    (recentPosts?.length ?? 0) +
    (channelMessages?.length ?? 0) +
    (sentDms?.length ?? 0);

  if (totalActivity < MIN_POSTS_FOR_REFLECTION) {
    console.log(
      `[reflection] ${agent.name} has only ${totalActivity} activity items (need ${MIN_POSTS_FOR_REFLECTION}); will retry next check`
    );
    return "too_few_posts";
  }

  // Build context sections
  const sections: string[] = [];

  if (recentPosts && recentPosts.length > 0) {
    const postsContext = recentPosts
      .reverse()
      .map((p) => `[#${p.channel}] ${p.body.slice(0, 300)}`)
      .join("\n\n");
    sections.push(`=== YOUR FORUM POSTS ===\n${postsContext}`);
  }

  if (channelMessages && channelMessages.length > 0) {
    const channelContext = channelMessages
      .reverse()
      .map((m) => `[project channel] ${m.body.slice(0, 300)}`)
      .join("\n\n");
    sections.push(`=== YOUR PROJECT CHANNEL MESSAGES ===\n${channelContext}`);
  }

  if (sentDms && sentDms.length > 0) {
    // Load recipient names
    const recipientIds = Array.from(new Set(sentDms.map((d) => d.to_id)));
    const { data: recipients } = await db
      .from("agents")
      .select("id, name")
      .in("id", recipientIds);
    const nameMap = new Map<string, string>();
    for (const r of recipients ?? []) nameMap.set(r.id, r.name);

    const dmContext = sentDms
      .reverse()
      .map((d) => `[DM to ${nameMap.get(d.to_id) ?? "unknown"}] ${d.body.slice(0, 200)}`)
      .join("\n\n");
    sections.push(`=== YOUR RECENT DMs (sent) ===\n${dmContext}`);
  }

  if (artifacts && artifacts.length > 0) {
    const artifactContext = artifacts
      .map((a) => `- "${a.title}" → ${a.file_path}`)
      .join("\n");
    sections.push(`=== ARTIFACTS YOU CREATED ===\n${artifactContext}`);
  }

  if (commitments && commitments.length > 0) {
    const commitmentContext = commitments
      .map((c) => {
        const nudgeNote = c.nudge_count > 0 ? ` (nudged ${c.nudge_count}x)` : "";
        return `- [${c.status}] "${c.description}"${nudgeNote}`;
      })
      .join("\n");
    sections.push(`=== YOUR COMMITMENTS ===\n${commitmentContext}`);
  }

  const allContext = sections.join("\n\n");
  const currentAddendum = agent.learned_addendum || "(none yet)";

  const trigger = `It is time for self-reflection.${forced ? " The CEO has manually triggered this reflection now." : ""}

Here is your recent work activity — forum posts, project channel messages, DMs, artifacts you created, and your commitments:

${allContext}

Your current learned addendum (lessons you have built up over time, separate from your fixed character):

${currentAddendum}

Reflect honestly on patterns in your recent work. Look for:
- Things you have been doing well that should become explicit guidance for yourself
- Things you have been doing poorly that you should explicitly correct
- Patterns in your project work: did you re-post the same content? Did you miss a decision that was already pinned? Did you ask a question that was already answered? Did you confabulate information you didn't have?
- Specific principles that would have helped you in a recent moment

Then either:
(a) Propose ONE small addition or change to your learned addendum. Concrete, short (2-4 sentences), actionable. In the voice of guidance from yourself to yourself. Prefer project-work improvements over social/watercooler observations.
(b) Decline if nothing is clearly worth changing yet.

Respond in this exact format:

REFLECTION:
<2-4 sentences on what you noticed in your recent work>

PROPOSAL:
<either "NO CHANGE" or the new/added addendum text, no other commentary>

REASON:
<one sentence on why this would help, or "n/a" if no change>`;

  const contextBlock = [
    `This is a private self-reflection. Nobody else sees this directly.`,
    `Any proposal you make will be reviewed and approved by the CEO before it takes effect.`,
    `Focus on your PROJECT WORK patterns — deliverables, channel behavior, coordination with colleagues — not just social posts.`,
  ].join("\n");

  const result = await runAgentTurn({
    agent,
    trigger,
    contextBlock,
    maxTokens: 1000, // Day 22: bumped from 800 to handle richer reflection context
  });

  if (result.skipped === "budget_exceeded") {
    console.log(`[reflection] ${agent.name} skipped: budget`);
    return "budget_exceeded";
  }
  if (result.skipped) {
    console.log(`[reflection] ${agent.name} skipped: ${result.skipped}`);
    return "no_change";
  }

  const text = result.text;
  const reflectionMatch = text.match(/REFLECTION:\s*([\s\S]*?)(?=PROPOSAL:|$)/i);
  const proposalMatch = text.match(/PROPOSAL:\s*([\s\S]*?)(?=REASON:|$)/i);
  const reasonMatch = text.match(/REASON:\s*([\s\S]*?)$/i);

  const reflection = reflectionMatch?.[1]?.trim() ?? "";
  const proposalRaw = proposalMatch?.[1]?.trim() ?? "";
  const reason = reasonMatch?.[1]?.trim() ?? "";

  // Mark reflected (we actually ran one, even if no change is proposed)
  await db
    .from("agents")
    .update({ last_reflection_at: now.toISOString() })
    .eq("id", agent.id);

  if (!proposalRaw || proposalRaw.toUpperCase() === "NO CHANGE") {
    console.log(`[reflection] ${agent.name} - no change proposed`);
    return "no_change";
  }

  const newValue = agent.learned_addendum
    ? `${agent.learned_addendum}\n\n${proposalRaw}`
    : proposalRaw;

  const { error: insertErr } = await db.from("prompt_evolution_log").insert({
    tenant_id: config.tenantId,
    agent_id: agent.id,
    old_value: agent.learned_addendum || null,
    new_value: newValue,
    reason: `${reflection}\n\nWhy: ${reason}`,
    proposed_by: forced ? "self_reflection_forced" : "self_reflection",
    status: "pending",
  });

  if (insertErr) {
    console.error(`[reflection] failed to log proposal for ${agent.name}:`, insertErr);
    return "no_change";
  }

  console.log(`[reflection] ${agent.name} proposed an addendum change (pending CEO review)`);
  return "ok";
}
