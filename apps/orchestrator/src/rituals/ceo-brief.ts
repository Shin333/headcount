import { db } from "../db.js";
import { config } from "../config.js";
import { runAgentTurn, isOverHourlyCap } from "../agents/runner.js";
import { postToForum } from "../comms/forum.js";
import { sendDm, getUnreadDmContextFor, getCompanyDmsSnapshot } from "../comms/dm.js";
import { Channels, AgentSchema } from "@headcount/shared";
import type { Agent } from "@headcount/shared";
import { buildTimeGrounding } from "./standup.js";

// ============================================================================
// rituals/ceo-brief.ts - the daily CEO Brief (Day 3 + Day 22 upgrade)
// ============================================================================
// Day 22 upgrade: added project status, overnight artifacts, commitment
// summary, and channel activity so the CEO wakes up knowing what happened.
// ============================================================================

export const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";

interface BriefContext {
  company_time: Date;
  company_date: string;
}

export async function maybeRunCeoBrief(ctx: BriefContext): Promise<void> {
  if (await isOverHourlyCap()) {
    console.log("[brief] skipped: hourly cost cap reached");
    return;
  }

  const { data: ritualState } = await db
    .from("ritual_state")
    .select("last_ceo_brief_date, last_standup_date")
    .eq("id", 1)
    .maybeSingle();

  if (ritualState?.last_ceo_brief_date === ctx.company_date) {
    return;
  }

  if (ritualState?.last_standup_date !== ctx.company_date) {
    console.log(`[brief] waiting for standup to complete first`);
    return;
  }

  // Load Eleanor
  const { data: eleanorRow } = await db
    .from("agents")
    .select("*")
    .eq("tenant_id", config.tenantId)
    .eq("role", "Chief of Staff")
    .eq("status", "active")
    .maybeSingle();

  if (!eleanorRow) {
    console.warn("[brief] Chief of Staff not found, skipping");
    return;
  }
  const parsedEleanor = AgentSchema.safeParse(eleanorRow);
  if (!parsedEleanor.success) {
    console.warn("[brief] Chief of Staff schema validation failed");
    return;
  }
  const eleanor: Agent = parsedEleanor.data;

  // Load today's standup posts
  const startOfCompanyDay = new Date(ctx.company_date + "T00:00:00Z").toISOString();
  const { data: standupPosts } = await db
    .from("forum_posts")
    .select("author_id, body, created_at")
    .eq("tenant_id", config.tenantId)
    .eq("channel", Channels.STANDUP)
    .gte("created_at", startOfCompanyDay)
    .order("created_at", { ascending: true })
    .limit(20);

  // Build name lookup
  const authorIds = Array.from(new Set((standupPosts ?? []).map((p) => p.author_id)));
  const { data: allAuthors } = await db
    .from("agents")
    .select("id, name, role")
    .in("id", authorIds.length > 0 ? authorIds : ["__none__"]);
  const agentInfo = new Map<string, { name: string; role: string }>();
  for (const a of allAuthors ?? []) {
    agentInfo.set(a.id, { name: a.name, role: a.role });
  }

  const standupContent = standupPosts && standupPosts.length > 0
    ? standupPosts.map((p) => {
        const info = agentInfo.get(p.author_id);
        return `**${info?.name ?? "Unknown"}** (${info?.role ?? "Unknown"}):\n${p.body}`;
      }).join("\n\n---\n\n")
    : "(No standup posts today)";

  // =========================================================================
  // Day 22: Pull project intelligence
  // =========================================================================

  const { data: projects } = await db
    .from("projects")
    .select("id, title, status")
    .eq("tenant_id", config.tenantId)
    .eq("status", "active");

  let projectStatusBlock = "";

  if (projects && projects.length > 0) {
    const projectLines: string[] = [];

    for (const project of projects) {
      const { count: memberCount } = await db
        .from("project_members")
        .select("*", { count: "exact", head: true })
        .eq("project_id", project.id);

      const { data: pendingCommitments } = await db
        .from("commitments")
        .select("description, agent_id, deadline_at, nudge_count, status")
        .eq("project_id", project.id)
        .eq("status", "pending")
        .order("deadline_at", { ascending: true })
        .limit(10);

      const { data: stalledCommitments } = await db
        .from("commitments")
        .select("description, agent_id, status")
        .eq("project_id", project.id)
        .eq("status", "stalled")
        .gte("updated_at", startOfCompanyDay)
        .limit(5);

      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: recentArtifacts } = await db
        .from("artifacts")
        .select("title, agent_id, created_at")
        .eq("project_id", project.id)
        .gte("created_at", yesterday)
        .order("created_at", { ascending: false })
        .limit(10);

      const { count: messageCount } = await db
        .from("project_messages")
        .select("*", { count: "exact", head: true })
        .eq("project_id", project.id)
        .gte("created_at", yesterday);

      const { data: pinnedMessages } = await db
        .from("project_messages")
        .select("body, agent_id")
        .eq("project_id", project.id)
        .eq("is_pinned", true)
        .order("created_at", { ascending: false })
        .limit(5);

      // Agent name lookup for this project
      const allAgentIds = new Set<string>();
      (pendingCommitments ?? []).forEach((c) => allAgentIds.add(c.agent_id));
      (stalledCommitments ?? []).forEach((c) => allAgentIds.add(c.agent_id));
      (recentArtifacts ?? []).forEach((a) => allAgentIds.add(a.agent_id));
      (pinnedMessages ?? []).forEach((m) => allAgentIds.add(m.agent_id));

      const { data: projectAgents } = await db
        .from("agents")
        .select("id, name")
        .in("id", allAgentIds.size > 0 ? Array.from(allAgentIds) : ["__none__"]);
      const nameMap = new Map<string, string>();
      for (const a of projectAgents ?? []) nameMap.set(a.id, a.name);

      let section = `### ${project.title} (${memberCount ?? 0} members, ${messageCount ?? 0} messages last 24h)`;

      if (recentArtifacts && recentArtifacts.length > 0) {
        section += `\n**Delivered overnight:**`;
        for (const a of recentArtifacts) {
          section += `\n- "${a.title}" by ${nameMap.get(a.agent_id) ?? "unknown"}`;
        }
      }

      if (pendingCommitments && pendingCommitments.length > 0) {
        section += `\n**Pending commitments (${pendingCommitments.length}):**`;
        for (const c of pendingCommitments.slice(0, 5)) {
          const overdue = c.deadline_at && new Date(c.deadline_at) < new Date();
          section += `\n- ${overdue ? "⏰ OVERDUE: " : ""}${nameMap.get(c.agent_id) ?? "unknown"}: "${c.description}"`;
        }
      }

      if (stalledCommitments && stalledCommitments.length > 0) {
        section += `\n**Stalled (${stalledCommitments.length}):**`;
        for (const c of stalledCommitments) {
          section += `\n- ${nameMap.get(c.agent_id) ?? "unknown"}: "${c.description}"`;
        }
      }

      const ceoPins = (pinnedMessages ?? []).filter((m) => m.agent_id === CEO_SENTINEL_ID);
      if (ceoPins.length > 0) {
        section += `\n**CEO decisions (pinned):**`;
        for (const p of ceoPins.slice(0, 3)) {
          const preview = p.body.length > 120 ? p.body.slice(0, 120) + "..." : p.body;
          section += `\n- ${preview}`;
        }
      }

      projectLines.push(section);
    }

    projectStatusBlock = projectLines.join("\n\n");
  }

  // Overnight artifacts across all projects
  const yesterday24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: allRecentArtifacts } = await db
    .from("artifacts")
    .select("title, agent_id, created_at, file_path")
    .eq("tenant_id", config.tenantId)
    .gte("created_at", yesterday24h)
    .order("created_at", { ascending: false })
    .limit(20);

  let artifactSummary = "";
  if (allRecentArtifacts && allRecentArtifacts.length > 0) {
    const artAgentIds = Array.from(new Set(allRecentArtifacts.map((a) => a.agent_id)));
    const { data: artAgents } = await db
      .from("agents")
      .select("id, name")
      .in("id", artAgentIds);
    const artNameMap = new Map<string, string>();
    for (const a of artAgents ?? []) artNameMap.set(a.id, a.name);

    artifactSummary = `Total artifacts created in last 24h: ${allRecentArtifacts.length}\n` +
      allRecentArtifacts
        .map((a) => `- "${a.title}" by ${artNameMap.get(a.agent_id) ?? "unknown"} → ${a.file_path}`)
        .join("\n");
  }

  // =========================================================================
  // Build trigger
  // =========================================================================

  const trigger = `Read the standup posts, project status, and overnight activity below. Synthesize them into a CEO Brief - a one-pager the CEO can read in 60 seconds and know the state of the company.

Structure your brief in exactly this format:

# CEO Brief - ${ctx.company_date}

## The shape of the day
(2-3 sentences. What happened overnight, what's the energy, what should Shin know first.)

## Overnight deliverables
(List the key artifacts that shipped since yesterday. Name the agent and what they delivered. If nothing shipped, say so.)

## Active projects
(For each active project: one-line status, key blocker if any, next milestone.)

## Escalations
(Anything that needs Shin's direct attention RIGHT NOW. Be specific. If nothing, say "Nothing needs you today.")

## Risks I am watching
(2-3 bullets max. Things that aren't urgent yet but could become so.)

Stay in your voice - dry, observant, edited. Do not invent drama. Do not confabulate — only report what you see in the data below.`;

  const eleanorUnreadDms = await getUnreadDmContextFor(eleanor.id);
  const startOfCompanyDayIso = new Date(ctx.company_date + "T00:00:00Z").toISOString();
  const dmSnapshot = await getCompanyDmsSnapshot(startOfCompanyDayIso);

  const dmActivityLine = dmSnapshot.totalCount > 0
    ? `DM activity today: ${dmSnapshot.totalCount} messages (${dmSnapshot.fromCeoCount} from CEO, ${dmSnapshot.toCeoCount} to CEO)`
    : `DM activity today: none`;

  const contextBlock = [
    eleanorUnreadDms,
    `You are writing the CEO Brief for ${ctx.company_date}.`,
    `Current company time: ${formatCompanyTime(ctx.company_time)}`,
    buildTimeGrounding(ctx.company_time),
    dmActivityLine,
    ``,
    `=== STANDUP POSTS ===`,
    standupContent,
    ``,
    `=== PROJECT STATUS ===`,
    projectStatusBlock || "(No active projects)",
    ``,
    `=== OVERNIGHT ARTIFACTS (last 24h) ===`,
    artifactSummary || "(No artifacts created in last 24h)",
  ].filter(Boolean).join("\n");

  const result = await runAgentTurn({
    agent: eleanor,
    trigger,
    contextBlock,
    maxTokens: 1500,
  });

  if (result.skipped) {
    console.log(`[brief] Eleanor skipped: ${result.skipped}`);
    return;
  }

  const briefText = result.text.trim();
  if (!briefText) {
    console.log("[brief] Eleanor returned empty - skipping");
    return;
  }

  await postToForum({
    channel: Channels.CEO_BRIEF,
    authorId: eleanor.id,
    body: briefText,
    metadata: {
      ritual: "ceo_brief",
      company_date: ctx.company_date,
      standup_post_count: standupPosts?.length ?? 0,
      project_count: projects?.length ?? 0,
      artifact_count: allRecentArtifacts?.length ?? 0,
    },
  });

  console.log(`[brief] Eleanor posted CEO Brief to #ceo-brief (with project data)`);

  try {
    await sendDm({
      fromId: eleanor.id,
      toId: CEO_SENTINEL_ID,
      body: briefText,
    });
    console.log(`[brief] Eleanor DM'd CEO Brief to CEO`);
  } catch (err) {
    console.error(`[brief] failed to DM brief to CEO:`, err);
  }

  const { error: markErr } = await db
    .from("ritual_state")
    .update({
      last_ceo_brief_date: ctx.company_date,
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  if (markErr) {
    console.error(`[brief] FAILED to mark complete: ${markErr.message}`);
    return;
  }

  const { data: verify } = await db
    .from("ritual_state")
    .select("last_ceo_brief_date")
    .eq("id", 1)
    .maybeSingle();

  if (verify?.last_ceo_brief_date !== ctx.company_date) {
    console.error(`[brief] FAILED to verify. Expected ${ctx.company_date}, got ${verify?.last_ceo_brief_date}`);
    return;
  }

  console.log(`[brief] complete for ${ctx.company_date}`);
}

function formatCompanyTime(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
}
