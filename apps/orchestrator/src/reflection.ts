import { db } from "./db.js";
import { config } from "./config.js";
import { run, isOverHourlyCap } from "./runner.js";
import { Channels } from "@headcount/shared";
import type { Agent } from "@headcount/shared";

// ----------------------------------------------------------------------------
// reflection.ts - the learned addendum loop (wall-clock scheduled)
// ----------------------------------------------------------------------------
// Runs once per wall hour for any agent with addendum_loop_active = true.
// Each reflection cycle:
//   1. Loads the agent's recent posts (last ~10) and their current addendum
//   2. Asks the agent to reflect on patterns: what's working, what's drifting
//   3. Asks the agent to propose ONE small addendum change OR no change
//   4. Writes the proposal to prompt_evolution_log with status='pending'
//   5. CEO reviews in dashboard, manually approves/rejects
//
// Nothing auto-applies. Drift is impossible without explicit human approval.
// ----------------------------------------------------------------------------

export async function maybeRunReflections(now: Date): Promise<void> {
  if (await isOverHourlyCap()) {
    console.log("[reflection] skipped: hourly cost cap reached");
    return;
  }

  const intervalMs = config.reflectionWallIntervalHours * 60 * 60 * 1000;
  const cutoff = new Date(now.getTime() - intervalMs).toISOString();

  // Find active agents whose last reflection was more than INTERVAL hours ago
  // OR who have never reflected
  const { data: agents, error } = await db
    .from("agents")
    .select("*")
    .eq("tenant_id", config.tenantId)
    .eq("status", "active")
    .eq("addendum_loop_active", true);

  if (error) {
    console.error("[reflection] failed to load agents:", error);
    return;
  }

  if (!agents || agents.length === 0) return;

  for (const agent of agents as Agent[]) {
    const lastReflection = agent.last_reflection_at;
    if (lastReflection && lastReflection > cutoff) {
      continue; // too recent
    }

    await reflectOne(agent, now);
  }
}

async function reflectOne(agent: Agent, now: Date): Promise<void> {
  // Load recent posts BY this agent (forum + DMs)
  const { data: recentPosts } = await db
    .from("forum_posts")
    .select("channel, body, created_at")
    .eq("tenant_id", config.tenantId)
    .eq("author_id", agent.id)
    .order("created_at", { ascending: false })
    .limit(10);

  if (!recentPosts || recentPosts.length < 2) {
    // Not enough material to reflect on
    await db
      .from("agents")
      .update({ last_reflection_at: now.toISOString() })
      .eq("id", agent.id);
    return;
  }

  const postsContext = recentPosts
    .reverse()
    .map((p) => `[#${p.channel}] ${p.body}`)
    .join("\n\n");

  const currentAddendum = agent.learned_addendum || "(none yet)";

  const userPrompt = `It is time for your weekly self-reflection. (You are doing this on a wall-clock schedule, separate from company time.)

Here are your most recent posts:

${postsContext}

Your current learned addendum (the part of your prompt that captures lessons you have learned over time, separate from your fixed character):

${currentAddendum}

Reflect honestly on patterns in your recent work. Look for:
- Things you have been doing well that should become explicit guidance for yourself
- Things you have been doing poorly that you should explicitly correct
- Specific principles or reminders that would have helped you in a recent moment

Then either:
(a) Propose ONE small addition or change to your learned addendum. Keep it concrete, short (2-4 sentences max), and actionable. It should be in the voice of guidance from yourself to yourself.
(b) Decline to propose a change if nothing is clearly worth changing yet.

Respond in this exact format:

REFLECTION:
<2-4 sentences of honest reflection on what you noticed in your recent work>

PROPOSAL:
<either "NO CHANGE" or the new/added addendum text, no other commentary>

REASON:
<one sentence explaining why this change would help, or "n/a" if no change>`;

  const result = await run({
    agent,
    userPrompt,
    maxTokens: 800,
    context: "self_reflection",
  });

  if (result.skipped) {
    console.log(`[reflection] ${agent.name} skipped: ${result.skipped}`);
    return;
  }

  // Parse the response
  const text = result.text;
  const reflectionMatch = text.match(/REFLECTION:\s*([\s\S]*?)(?=PROPOSAL:|$)/i);
  const proposalMatch = text.match(/PROPOSAL:\s*([\s\S]*?)(?=REASON:|$)/i);
  const reasonMatch = text.match(/REASON:\s*([\s\S]*?)$/i);

  const reflection = reflectionMatch?.[1]?.trim() ?? "";
  const proposalRaw = proposalMatch?.[1]?.trim() ?? "";
  const reason = reasonMatch?.[1]?.trim() ?? "";

  await db
    .from("agents")
    .update({ last_reflection_at: now.toISOString() })
    .eq("id", agent.id);

  if (!proposalRaw || proposalRaw.toUpperCase() === "NO CHANGE") {
    console.log(`[reflection] ${agent.name} - no change proposed`);
    return;
  }

  // Build the new value: existing addendum + new chunk (or replace if empty)
  const newValue = agent.learned_addendum
    ? `${agent.learned_addendum}\n\n${proposalRaw}`
    : proposalRaw;

  const { error: insertErr } = await db.from("prompt_evolution_log").insert({
    tenant_id: config.tenantId,
    agent_id: agent.id,
    old_value: agent.learned_addendum || null,
    new_value: newValue,
    reason: `${reflection}\n\nWhy: ${reason}`,
    proposed_by: "self_reflection",
    status: "pending",
  });

  if (insertErr) {
    console.error(`[reflection] failed to log proposal for ${agent.name}:`, insertErr);
    return;
  }

  console.log(`[reflection] ${agent.name} proposed an addendum change (pending CEO review)`);
}
