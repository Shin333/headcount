// ============================================================================
// GET /api/dlq/commitments  -  list dead-letter commitments
// ----------------------------------------------------------------------------
// Returns commitments that have been stalled with no operator resolution.
// Criteria:
//   - status = 'stalled'
//   - dlq_resolved_at IS NULL
// Ordered oldest-stalled-first.
// ============================================================================

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return createClient(url, serviceKey);
}

export async function GET() {
  const db = adminClient();

  const { data: rows, error } = await db
    .from("commitments")
    .select("id, agent_id, project_id, description, committed_at, deadline_at, nudge_count, last_nudge_at")
    .eq("tenant_id", TENANT_ID)
    .eq("status", "stalled")
    .is("dlq_resolved_at", null)
    .order("last_nudge_at", { ascending: true, nullsFirst: true })
    .limit(200);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Resolve agent + project names once
  const agentIds = Array.from(new Set((rows ?? []).map((r) => r.agent_id)));
  const projectIds = Array.from(new Set((rows ?? []).map((r) => r.project_id).filter(Boolean) as string[]));

  const [{ data: agents }, { data: projects }] = await Promise.all([
    agentIds.length
      ? db.from("agents").select("id, name").in("id", agentIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    projectIds.length
      ? db.from("projects").select("id, title").in("id", projectIds)
      : Promise.resolve({ data: [] as { id: string; title: string }[] }),
  ]);

  const agentName = new Map((agents ?? []).map((a) => [a.id, a.name]));
  const projectTitle = new Map((projects ?? []).map((p) => [p.id, p.title]));

  return NextResponse.json({
    items: (rows ?? []).map((r) => ({
      id: r.id,
      agent_id: r.agent_id,
      agent_name: agentName.get(r.agent_id) ?? null,
      project_id: r.project_id,
      project_title: r.project_id ? projectTitle.get(r.project_id) ?? null : null,
      description: r.description,
      committed_at: r.committed_at,
      deadline_at: r.deadline_at,
      nudge_count: r.nudge_count,
      last_nudge_at: r.last_nudge_at,
    })),
  });
}
