// ============================================================================
// POST /api/dlq/commitments/[id]  -  resolve a dead-letter commitment
// ----------------------------------------------------------------------------
// Three resolution actions:
//
//   { action: 'kill' }
//     status -> 'cancelled', dlq_action='killed'. Agent is not re-nudged.
//
//   { action: 'requeue', deadline_minutes: N }
//     status -> 'pending', nudge_count -> 0, deadline_at -> now + N min,
//     dlq_action='requeued'. Stall detector will nudge again if still overdue.
//
//   { action: 'reassign', new_agent_id: <uuid>, deadline_minutes: N? }
//     status -> 'pending', agent_id -> new_agent_id, nudge_count -> 0,
//     optional new deadline, dlq_action='reassigned'. Useful when the
//     original agent is the wrong owner.
//
// All actions stamp dlq_resolved_at = now() and dlq_resolved_by = 'ceo'.
// Once resolved, the commitment disappears from the DLQ list.
// ============================================================================

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return createClient(url, serviceKey);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = body?.action as "kill" | "requeue" | "reassign" | undefined;
  if (!action || !["kill", "requeue", "reassign"].includes(action)) {
    return NextResponse.json({ error: "action must be 'kill' | 'requeue' | 'reassign'" }, { status: 400 });
  }

  const db = adminClient();
  const { data: existing, error: readErr } = await db
    .from("commitments")
    .select("id, status, agent_id, tenant_id")
    .eq("id", id)
    .eq("tenant_id", TENANT_ID)
    .maybeSingle();
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });
  if (!existing) return NextResponse.json({ error: "commitment not found" }, { status: 404 });

  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = {
    dlq_resolved_at: nowIso,
    dlq_resolved_by: "ceo",
  };

  if (action === "kill") {
    patch.status = "cancelled";
    patch.resolved_at = nowIso;
    patch.dlq_action = "killed";
  } else if (action === "requeue") {
    const minutes = typeof body?.deadline_minutes === "number" ? body.deadline_minutes : 60;
    patch.status = "pending";
    patch.nudge_count = 0;
    patch.last_nudge_at = null;
    patch.deadline_at = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    patch.dlq_action = "requeued";
  } else if (action === "reassign") {
    const newAgent = typeof body?.new_agent_id === "string" ? body.new_agent_id : null;
    if (!newAgent) return NextResponse.json({ error: "reassign requires new_agent_id" }, { status: 400 });
    const { data: ag } = await db.from("agents").select("id").eq("id", newAgent).eq("tenant_id", TENANT_ID).maybeSingle();
    if (!ag) return NextResponse.json({ error: "new_agent_id not found in this tenant" }, { status: 400 });
    const minutes = typeof body?.deadline_minutes === "number" ? body.deadline_minutes : 60;
    patch.status = "pending";
    patch.agent_id = newAgent;
    patch.nudge_count = 0;
    patch.last_nudge_at = null;
    patch.deadline_at = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    patch.dlq_action = "reassigned";
  }

  const { error: uErr } = await db.from("commitments").update(patch).eq("id", id);
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 });
  return NextResponse.json({ ok: true, action, id });
}
