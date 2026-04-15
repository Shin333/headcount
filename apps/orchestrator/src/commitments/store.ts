// ============================================================================
// commitments/store.ts - Day 18 - commitment CRUD helpers
// ============================================================================

import { db } from "../db.js";
import { config } from "../config.js";

export interface Commitment {
  id: string;
  agent_id: string;
  project_id: string | null;
  description: string;
  committed_at: string;
  deadline_at: string | null;
  status: "pending" | "resolved" | "stalled" | "cancelled";
  resolution_type: string | null;
  resolved_artifact_id: string | null;
  resolved_at: string | null;
  nudge_count: number;
  last_nudge_at: string | null;
}

// ----------------------------------------------------------------------------
// Create
// ----------------------------------------------------------------------------

export async function createCommitment(args: {
  agentId: string;
  projectId?: string | null;
  description: string;
  deadlineAt?: string | null;
}): Promise<{ id: string }> {
  const { data, error } = await db
    .from("commitments")
    .insert({
      tenant_id: config.tenantId,
      agent_id: args.agentId,
      project_id: args.projectId ?? null,
      description: args.description,
      deadline_at: args.deadlineAt ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`Failed to create commitment: ${error?.message}`);
  }
  return { id: data.id };
}

// ----------------------------------------------------------------------------
// Query
// ----------------------------------------------------------------------------

export async function getPendingCommitmentsForAgent(
  agentId: string
): Promise<Commitment[]> {
  const { data, error } = await db
    .from("commitments")
    .select("*")
    .eq("agent_id", agentId)
    .eq("status", "pending")
    .order("deadline_at", { ascending: true, nullsFirst: false });

  if (error || !data) return [];
  return data as Commitment[];
}

export async function getPendingCommitmentsForProject(
  projectId: string
): Promise<Commitment[]> {
  const { data, error } = await db
    .from("commitments")
    .select("*")
    .eq("project_id", projectId)
    .eq("status", "pending")
    .order("deadline_at", { ascending: true, nullsFirst: false });

  if (error || !data) return [];
  return data as Commitment[];
}

/**
 * Get all overdue pending commitments across all agents.
 * A commitment is overdue if:
 *   - status is 'pending'
 *   - deadline_at is not null
 *   - deadline_at < now()
 *   - nudge_count < MAX_NUDGES (don't nudge forever)
 */
export async function getOverdueCommitments(
  maxNudges: number = 3
): Promise<Commitment[]> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("commitments")
    .select("*")
    .eq("tenant_id", config.tenantId)
    .eq("status", "pending")
    .not("deadline_at", "is", null)
    .lt("deadline_at", now)
    .lt("nudge_count", maxNudges)
    .order("deadline_at", { ascending: true });

  if (error || !data) return [];
  return data as Commitment[];
}

// ----------------------------------------------------------------------------
// Resolve
// ----------------------------------------------------------------------------

export async function resolveCommitment(
  commitmentId: string,
  resolutionType: "artifact" | "manual" | "nudge_produced",
  artifactId?: string
): Promise<boolean> {
  const { error } = await db
    .from("commitments")
    .update({
      status: "resolved",
      resolution_type: resolutionType,
      resolved_artifact_id: artifactId ?? null,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", commitmentId);

  if (error) {
    console.error(`[commitments] failed to resolve ${commitmentId}: ${error.message}`);
    return false;
  }
  return true;
}

export async function markStalled(commitmentId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const { error } = await db
    .from("commitments")
    .update({
      status: "stalled",
      resolved_at: now,
    })
    .eq("id", commitmentId);

  if (error) {
    console.error(`[commitments] failed to mark stalled ${commitmentId}: ${error.message}`);
    return false;
  }
  return true;
}

export async function incrementNudgeCount(commitmentId: string): Promise<boolean> {
  const now = new Date().toISOString();

  // Supabase doesn't support increment directly, so read-then-write
  const { data: current } = await db
    .from("commitments")
    .select("nudge_count")
    .eq("id", commitmentId)
    .maybeSingle();

  const newCount = (current?.nudge_count ?? 0) + 1;

  const { error } = await db
    .from("commitments")
    .update({
      nudge_count: newCount,
      last_nudge_at: now,
    })
    .eq("id", commitmentId);

  if (error) {
    console.error(`[commitments] failed to increment nudge for ${commitmentId}: ${error.message}`);
    return false;
  }
  return true;
}

// ----------------------------------------------------------------------------
// Format for context injection
// ----------------------------------------------------------------------------

export function formatCommitmentsBlock(
  commitments: Commitment[]
): string | null {
  if (commitments.length === 0) return null;

  const lines: string[] = [];
  lines.push("## Your pending commitments");
  lines.push("You made the following promises. If any are overdue, PRODUCE THE DELIVERABLE NOW — do not write another status update about it.");
  lines.push("");

  for (const c of commitments) {
    const deadline = c.deadline_at
      ? new Date(c.deadline_at).toLocaleString("en-SG", { timeZone: "Asia/Taipei" })
      : "no deadline";
    const overdue = c.deadline_at && new Date(c.deadline_at) < new Date()
      ? " ⚠️ OVERDUE"
      : "";
    const nudges = c.nudge_count > 0
      ? ` (nudged ${c.nudge_count}x)`
      : "";

    lines.push(`- **${c.description}** — deadline: ${deadline}${overdue}${nudges}`);
  }

  lines.push("");
  return lines.join("\n");
}
