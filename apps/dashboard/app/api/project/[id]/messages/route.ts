import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ----------------------------------------------------------------------------
// GET /api/project/[id]/messages (Day 17.5)
// ----------------------------------------------------------------------------
// Fetch recent messages from a project channel, with agent names resolved.
// Query params: limit (default 50, max 200)
// ----------------------------------------------------------------------------

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return createClient(url, serviceKey);
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const projectId = params.id;
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = Math.min(Math.max(parseInt(limitParam ?? "50", 10) || 50, 1), 200);

  const db = adminClient();

  // Verify project exists
  const { data: project, error: projectErr } = await db
    .from("projects")
    .select("id, title, status")
    .eq("id", projectId)
    .eq("tenant_id", TENANT_ID)
    .maybeSingle();

  if (projectErr || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Fetch messages (newest first for display, client can reverse).
  // 0024 renamed agent_id→sender_id, message_type→kind, dropped is_pinned.
  // Response shape preserved below for stable UI consumption (Plan 5.1 α).
  const { data: messages, error: msgErr } = await db
    .from("project_messages")
    .select("id, sender_id, body, kind, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (msgErr) {
    return NextResponse.json({ error: msgErr.message }, { status: 500 });
  }

  // Resolve agent names
  const agentIds = Array.from(new Set((messages ?? []).map((m: any) => m.sender_id)));
  const agentNames = new Map<string, string>();
  agentNames.set(CEO_SENTINEL_ID, "Shin Park");

  if (agentIds.length > 0) {
    const { data: agents } = await db
      .from("agents")
      .select("id, name, role")
      .in("id", agentIds);

    for (const a of agents ?? []) {
      agentNames.set(a.id, a.name);
    }
  }

  // Enrich messages with names. Response keys (agentId, messageType,
  // isPinned) preserved for stable UI consumption — `messageType` is now
  // sourced from `kind` (no value translation; consumer just renders),
  // `isPinned` is hardcoded false (column dropped in 0024; Plan 3 rebuild).
  const enriched = (messages ?? []).map((m: any) => ({
    id: m.id,
    agentId: m.sender_id,
    agentName: agentNames.get(m.sender_id) ?? `Agent ${m.sender_id.slice(0, 8)}`,
    body: m.body,
    messageType: m.kind,
    createdAt: m.created_at,
    isPinned: false,
  }));

  return NextResponse.json({
    project: { id: project.id, title: project.title, status: project.status },
    messages: enriched,
    count: enriched.length,
  });
}
