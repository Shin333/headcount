import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ============================================================================
// GET /api/projects/detail — Day 22
// ============================================================================
// Rich project data for the ProjectsView dashboard tab.
// Returns: projects with members (names, roles, pending/overdue counts),
// recent artifacts, commitments summary, and message counts.
// ============================================================================

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return createClient(url, serviceKey);
}

export async function GET() {
  const db = adminClient();

  const { data: projects, error } = await db
    .from("projects")
    .select("id, title, description, status, created_at")
    .eq("tenant_id", TENANT_ID)
    .eq("status", "active")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const enriched = [];

  for (const p of projects ?? []) {
    // Members with agent info
    const { data: members } = await db
      .from("project_members")
      .select("agent_id")
      .eq("project_id", p.id);

    const memberIds = (members ?? []).map((m: any) => m.agent_id);

    const { data: memberAgents } = await db
      .from("agents")
      .select("id, name, role, department, tier")
      .in("id", memberIds.length > 0 ? memberIds : ["__none__"]);

    // Commitments
    const { data: commitments } = await db
      .from("commitments")
      .select("id, description, agent_id, status, deadline_at, nudge_count, created_at")
      .eq("project_id", p.id)
      .order("created_at", { ascending: false })
      .limit(20);

    const pending = (commitments ?? []).filter((c: any) => c.status === "pending");
    const overdue = pending.filter(
      (c: any) => c.deadline_at && new Date(c.deadline_at) < new Date()
    );
    const stalled = (commitments ?? []).filter((c: any) => c.status === "stalled");
    const resolved = (commitments ?? []).filter((c: any) => c.status === "resolved");

    // Recent artifacts
    const { data: artifacts } = await db
      .from("artifacts")
      .select("id, title, file_path, agent_id, created_at")
      .eq("project_id", p.id)
      .order("created_at", { ascending: false })
      .limit(10);

    // Message count (last 24h)
    const { count: messageCount } = await db
      .from("project_messages")
      .select("*", { count: "exact", head: true })
      .eq("project_id", p.id)
      .gte("created_at", yesterday);

    // Pinned count
    const { count: pinnedCount } = await db
      .from("project_messages")
      .select("*", { count: "exact", head: true })
      .eq("project_id", p.id)
      .eq("is_pinned", true);

    // Build agent name lookup
    const nameMap: Record<string, string> = {};
    for (const a of memberAgents ?? []) {
      nameMap[a.id] = a.name;
    }

    enriched.push({
      ...p,
      members: (memberAgents ?? []).map((a: any) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        department: a.department,
        tier: a.tier,
      })),
      commitments: {
        pending: pending.length,
        overdue: overdue.length,
        stalled: stalled.length,
        resolved: resolved.length,
        items: (commitments ?? []).slice(0, 10).map((c: any) => ({
          ...c,
          agentName: nameMap[c.agent_id] ?? "unknown",
        })),
      },
      artifacts: (artifacts ?? []).map((a: any) => ({
        ...a,
        createdByName: nameMap[a.agent_id] ?? "unknown",
      })),
      messageCount: messageCount ?? 0,
      pinnedCount: pinnedCount ?? 0,
    });
  }

  return NextResponse.json({ projects: enriched });
}
