import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ----------------------------------------------------------------------------
// GET /api/projects (Day 17.5)
// ----------------------------------------------------------------------------
// List active projects so the dashboard can show a project picker.
// ----------------------------------------------------------------------------

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

  // Get member counts
  const enriched = [];
  for (const p of projects ?? []) {
    const { count } = await db
      .from("project_members")
      .select("agent_id", { count: "exact", head: true })
      .eq("project_id", p.id);

    enriched.push({
      ...p,
      memberCount: count ?? 0,
    });
  }

  return NextResponse.json({ projects: enriched });
}
