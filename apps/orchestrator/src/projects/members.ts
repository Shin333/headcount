// ============================================================================
// projects/members.ts - Day 15 - project membership helpers
// ----------------------------------------------------------------------------
// Three operations used by the rest of the Day 15 code:
//
//   1. addMember(projectId, agentId, addedBy) — insert a membership row
//      (idempotent via upsert). Used by project_create and dm_send.
//
//   2. getActiveProjectsForAgent(agentId) — return the list of active
//      projects an agent is a member of, ordered by most recently created
//      first, capped at MAX_PROJECT_CONTEXT (5). Used by the dm-responder
//      to build the project context block in the system prompt.
//
//   3. isAgentInProject(projectId, agentId) — lightweight check. Used by
//      dm_send to decide whether the sender is allowed to propagate
//      membership to a recipient (only project members can add others).
//
// v1 intentionally omits:
//   - removeMember (no use case yet)
//   - role/permissions (not needed)
//   - project count per agent (not needed yet; cap is in the context
//     injection layer, not here)
// ============================================================================

import { db } from "../db.js";
import { config } from "../config.js";
import type { Project } from "@headcount/shared";

// Hard cap on how many projects we inject into a single agent's system
// prompt. Five is a reasonable upper bound for "what's this person working
// on right now" without bloating the context window. If an agent legitimately
// needs more, we can revisit.
export const MAX_PROJECT_CONTEXT = 5;

// Description preview length per project in the injected context block.
// Long enough to ground the agent; short enough to keep the system prompt
// from bloating when they're on multiple projects.
export const PROJECT_DESCRIPTION_PREVIEW_CHARS = 500;

// ----------------------------------------------------------------------------
// addMember
// ----------------------------------------------------------------------------

export interface AddMemberResult {
  inserted: boolean; // true if this was a new membership row
  error: string | null;
}

/**
 * Insert a (project_id, agent_id) membership row. Idempotent via composite
 * primary key — re-adds return `inserted: false` rather than erroring.
 *
 * addedBy should be the agent who triggered the add (Eleanor when project_create
 * fires, the dm_send sender when auto-propagation fires). Pass null for seed
 * or backfill scripts.
 */
export async function addMember(
  projectId: string,
  agentId: string,
  addedBy: string | null
): Promise<AddMemberResult> {
  const { error } = await db.from("project_members").insert({
    project_id: projectId,
    agent_id: agentId,
    added_by: addedBy,
  });

  if (!error) {
    // Day 20: auto-bump token budget for agents joining a project.
    // Specialists often have the default budget (50k-100k) which isn't
    // enough for active project work. When they join a project, ensure
    // their budget is at least PROJECT_MIN_BUDGET. This prevents the
    // recurring "agent hit budget, CEO manually resets via SQL" pattern.
    await ensureProjectBudget(agentId);
    return { inserted: true, error: null };
  }

  // PostgreSQL unique_violation — already a member, not an error
  if (error.code === "23505") {
    return { inserted: false, error: null };
  }

  return { inserted: false, error: error.message };
}

// Day 20: minimum daily token budget for any agent participating in a project.
// 200k is enough for ~10-15 Sonnet turns or ~5-8 Opus turns per day.
const PROJECT_MIN_BUDGET = 200000;

/**
 * Ensure an agent's daily_token_budget is at least PROJECT_MIN_BUDGET.
 * If it's already higher, don't lower it. Also resets tokens_used_today
 * if the agent was previously over budget (common when specialists get
 * pulled into projects mid-day after burning their small default budget
 * on reflections).
 */
async function ensureProjectBudget(agentId: string): Promise<void> {
  try {
    const { data: agent } = await db
      .from("agents")
      .select("id, name, daily_token_budget, tokens_used_today")
      .eq("id", agentId)
      .maybeSingle();

    if (!agent) return;

    const currentBudget = agent.daily_token_budget ?? 0;
    const needsBump = currentBudget < PROJECT_MIN_BUDGET;
    const isOverBudget = (agent.tokens_used_today ?? 0) >= currentBudget;

    if (needsBump || isOverBudget) {
      const updates: Record<string, unknown> = {};
      if (needsBump) updates.daily_token_budget = PROJECT_MIN_BUDGET;
      if (isOverBudget) updates.tokens_used_today = 0;

      await db.from("agents").update(updates).eq("id", agentId);

      if (needsBump) {
        console.log(
          `[project-members] bumped ${agent.name}'s budget: ${currentBudget} → ${PROJECT_MIN_BUDGET}`
        );
      }
      if (isOverBudget) {
        console.log(
          `[project-members] reset ${agent.name}'s tokens_used_today (was over budget)`
        );
      }
    }
  } catch (err) {
    // Never let budget bump failure break project membership
    console.warn(
      `[project-members] budget bump failed for ${agentId}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ----------------------------------------------------------------------------
// getActiveProjectsForAgent
// ----------------------------------------------------------------------------

/**
 * Return the list of active projects this agent is a member of, ordered by
 * project creation time descending (newest first), capped at
 * MAX_PROJECT_CONTEXT rows.
 *
 * Used on the hot path (every DM responder turn), so it's designed to do a
 * single join and return quickly. If the agent has no project memberships,
 * returns an empty array without error.
 */
export async function getActiveProjectsForAgent(agentId: string): Promise<Project[]> {
  // Supabase's nested select does the join in one round trip. We select
  // every column from projects via the FK relationship.
  const { data, error } = await db
    .from("project_members")
    .select(
      "project_id, projects!inner(id, tenant_id, title, description, status, created_by, created_at)"
    )
    .eq("agent_id", agentId)
    .eq("projects.tenant_id", config.tenantId)
    .eq("projects.status", "active")
    .order("added_at", { ascending: false })
    .limit(MAX_PROJECT_CONTEXT);

  if (error) {
    console.warn(`[project-members] getActiveProjectsForAgent ${agentId} error: ${error.message}`);
    return [];
  }
  if (!data) return [];

  // Flatten: each row has a nested `projects` field with the full project row.
  // Supabase types return this as an array or object depending on relationship
  // cardinality; the !inner hint makes it object-shaped but we defensively
  // handle both.
  const projects: Project[] = [];
  for (const row of data as Array<{ projects: Project | Project[] | null }>) {
    const p = row.projects;
    if (!p) continue;
    if (Array.isArray(p)) {
      if (p[0]) projects.push(p[0]);
    } else {
      projects.push(p);
    }
  }
  return projects;
}

// ----------------------------------------------------------------------------
// isAgentInProject
// ----------------------------------------------------------------------------

/**
 * Lightweight existence check. Returns true if (project_id, agent_id) is in
 * project_members. Used by dm_send to decide if the sender is allowed to
 * propagate membership to a recipient.
 */
export async function isAgentInProject(projectId: string, agentId: string): Promise<boolean> {
  const { count, error } = await db
    .from("project_members")
    .select("project_id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("agent_id", agentId);

  if (error) {
    console.warn(`[project-members] isAgentInProject error: ${error.message}`);
    return false; // fail closed — safer to skip propagation than to over-add
  }
  return (count ?? 0) > 0;
}

// ----------------------------------------------------------------------------
// Project ID detection in DM bodies
// ----------------------------------------------------------------------------

// UUID v4 pattern. Matches canonical 8-4-4-4-12 hex groups with optional
// lowercase/uppercase. We do NOT require the "4" version digit — any valid
// UUID shape is acceptable, because gen_random_uuid() produces v4 but we
// shouldn't care about format.
const UUID_REGEX =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Scan a DM body for UUID strings that match active projects the sender is
 * a member of. Returns the distinct set of matching project IDs.
 *
 * This is how auto-propagation works: if Eleanor's DM body to Rina contains
 * "Project ID: 1806c510-7cd0-4452-bc14-6b4d760cdf1b" and Eleanor is a member
 * of that project, the sender's project_id will be returned here so dm_send
 * can auto-add Rina.
 *
 * Only projects the sender is already a member of are returned — a malicious
 * or confused agent can't auto-add people to projects they don't belong to
 * by pasting random UUIDs in their message.
 */
export async function findSenderProjectsInBody(
  senderId: string,
  body: string
): Promise<Project[]> {
  const matches = body.match(UUID_REGEX);
  if (!matches || matches.length === 0) return [];

  const distinctIds = Array.from(new Set(matches.map((m) => m.toLowerCase())));

  // Look up which of these IDs are projects the sender is actually on
  const { data, error } = await db
    .from("project_members")
    .select(
      "project_id, projects!inner(id, tenant_id, title, description, status, created_by, created_at)"
    )
    .eq("agent_id", senderId)
    .eq("projects.tenant_id", config.tenantId)
    .eq("projects.status", "active")
    .in("project_id", distinctIds);

  if (error) {
    console.warn(`[project-members] findSenderProjectsInBody error: ${error.message}`);
    return [];
  }
  if (!data) return [];

  const projects: Project[] = [];
  for (const row of data as Array<{ projects: Project | Project[] | null }>) {
    const p = row.projects;
    if (!p) continue;
    if (Array.isArray(p)) {
      if (p[0]) projects.push(p[0]);
    } else {
      projects.push(p);
    }
  }
  return projects;
}

// ----------------------------------------------------------------------------
// Context block builder (used by dm-responder)
// ----------------------------------------------------------------------------

/**
 * Render the "Active projects you're working on" context block for injection
 * into an agent's system prompt. Returns null if the agent has no active
 * projects (caller should omit the block entirely in that case).
 *
 * The block is deliberately written as a direct instruction, not a data
 * dump — it ends with an "ask, don't invent" norm to discourage the exact
 * confabulation pattern observed on Day 14.
 */
export async function buildProjectContextBlock(agentId: string): Promise<string | null> {
  const projects = await getActiveProjectsForAgent(agentId);
  if (projects.length === 0) return null;

  const lines: string[] = [];
  lines.push("## Active projects you're working on");
  lines.push("");

  for (const p of projects) {
    const shortId = p.id.slice(0, 8);
    const fullId = p.id;
    const descPreview =
      p.description.length > PROJECT_DESCRIPTION_PREVIEW_CHARS
        ? p.description.slice(0, PROJECT_DESCRIPTION_PREVIEW_CHARS).trimEnd() + "…"
        : p.description;

    lines.push(`### ${p.title}`);
    lines.push(`Project ID: \`${fullId}\` (short: ${shortId})`);
    lines.push(`Status: ${p.status}`);
    lines.push("");
    lines.push(descPreview);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  lines.push(
    "**When responding to DMs about any of these projects, stay grounded in the project description above.** " +
      "If a message references context you don't fully remember — a ticket, a decision, a deliverable, a prior conversation — **ask the sender to clarify which project and which piece of context they mean**. " +
      "Do NOT fabricate project details that sound plausible. Confabulating context that sounds right is worse than saying 'I don't have that in front of me, can you resend or point me at it?'. " +
      "Agents playing along with each other's invented context is how small misunderstandings become entire phantom workstreams."
  );

  return lines.join("\n");
}
