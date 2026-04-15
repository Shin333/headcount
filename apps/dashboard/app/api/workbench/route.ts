import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

// ============================================================================
// GET /api/workbench — Day 22
// ============================================================================
// Returns: recent artifacts, agent roster with budget info, cost estimates.
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

  // Recent artifacts (last 50)
  const { data: artifacts } = await db
    .from("artifacts")
    .select("id, title, file_path, content_type, agent_id, created_at, version, project_id")
    .eq("tenant_id", TENANT_ID)
    .order("created_at", { ascending: false })
    .limit(50);

  // Agent roster with budget info (active named cast only)
  const { data: agents } = await db
    .from("agents")
    .select("id, name, role, department, tier, model_tier, daily_token_budget, tokens_used_today, always_on, status, tool_access")
    .eq("tenant_id", TENANT_ID)
    .eq("is_human", false)
    .eq("always_on", true)
    .order("department", { ascending: true });

  // Build agent name map for artifacts
  const allAgentIds = new Set<string>();
  (artifacts ?? []).forEach((a: any) => allAgentIds.add(a.agent_id));
  const { data: artifactAgents } = await db
    .from("agents")
    .select("id, name")
    .in("id", allAgentIds.size > 0 ? Array.from(allAgentIds) : ["__none__"]);
  const nameMap: Record<string, string> = {};
  for (const a of artifactAgents ?? []) nameMap[a.id] = a.name;

  // Project name map for artifacts
  const projectIds = new Set<string>();
  (artifacts ?? []).forEach((a: any) => { if (a.project_id) projectIds.add(a.project_id); });
  const { data: projectNames } = await db
    .from("projects")
    .select("id, title")
    .in("id", projectIds.size > 0 ? Array.from(projectIds) : ["__none__"]);
  const projectMap: Record<string, string> = {};
  for (const p of projectNames ?? []) projectMap[p.id] = p.title;

  // Cost estimate — count API calls from DMs and forum posts today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  const { count: dmCount } = await db
    .from("dms")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT_ID)
    .gte("created_at", todayIso);

  const { count: forumCount } = await db
    .from("forum_posts")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", TENANT_ID)
    .gte("created_at", todayIso);

  const { count: channelCount } = await db
    .from("project_messages")
    .select("*", { count: "exact", head: true })
    .gte("created_at", todayIso);

  return NextResponse.json({
    artifacts: (artifacts ?? []).map((a: any) => ({
      ...a,
      createdByName: nameMap[a.agent_id] ?? "unknown",
      projectTitle: a.project_id ? (projectMap[a.project_id] ?? "unknown project") : null,
    })),
    agents: agents ?? [],
    activity: {
      dmsToday: dmCount ?? 0,
      forumPostsToday: forumCount ?? 0,
      channelMessagesToday: channelCount ?? 0,
    },
  });
}
