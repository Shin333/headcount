import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";

// ============================================================================
// /api/agents/by-department
// ----------------------------------------------------------------------------
// Returns the workforce grouped by department, sorted by department
// display_order then by tier. Excludes is_human=true (the Shin Park CEO row).
//
// Used by external tools and scripts. The dashboard page loads agents
// directly via Supabase Realtime, so this route is not on the critical
// rendering path — it's a clean read API for everything else.
// ============================================================================

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const TIER_ORDER: Record<string, number> = {
  exec: 0, director: 1, manager: 2, associate: 3, intern: 4, bot: 5,
};

interface AgentRow {
  id: string;
  name: string;
  role: string;
  department: string | null;
  tier: string;
  manager_id: string | null;
  status: string;
  always_on: boolean | null;
  in_standup: boolean | null;
  is_human: boolean | null;
  model_tier: string;
}

interface DepartmentRow {
  slug: string;
  display_name: string;
  display_order: number;
}

interface AgentSummary {
  id: string;
  name: string;
  role: string;
  tier: string;
  manager_id: string | null;
  status: string;
  always_on: boolean;
  in_standup: boolean;
  model_tier: string;
}

interface DepartmentGroup {
  slug: string;
  display_name: string;
  display_order: number;
  agents: AgentSummary[];
}

export async function GET(): Promise<NextResponse> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return NextResponse.json(
      { error: "Supabase env not configured on the server" },
      { status: 500 }
    );
  }

  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Pull departments and agents in parallel
  const [deptRes, agentRes] = await Promise.all([
    db.from("departments").select("slug, display_name, display_order"),
    db
      .from("agents")
      .select("id, name, role, department, tier, manager_id, status, always_on, in_standup, is_human, model_tier")
      .eq("is_human", false)
      .eq("status", "active"),
  ]);

  if (deptRes.error) {
    return NextResponse.json({ error: `departments: ${deptRes.error.message}` }, { status: 500 });
  }
  if (agentRes.error) {
    return NextResponse.json({ error: `agents: ${agentRes.error.message}` }, { status: 500 });
  }

  const departments = (deptRes.data ?? []) as DepartmentRow[];
  const agents = (agentRes.data ?? []) as AgentRow[];

  // Build department lookup
  const deptBySlug = new Map<string, DepartmentRow>();
  for (const d of departments) deptBySlug.set(d.slug, d);

  // Group agents by department slug
  const groups = new Map<string, AgentSummary[]>();
  const orphans: AgentSummary[] = [];

  for (const a of agents) {
    const summary: AgentSummary = {
      id: a.id,
      name: a.name,
      role: a.role,
      tier: a.tier,
      manager_id: a.manager_id,
      status: a.status,
      always_on: a.always_on === true,
      in_standup: a.in_standup === true,
      model_tier: a.model_tier,
    };

    const slug = a.department;
    if (!slug || !deptBySlug.has(slug)) {
      orphans.push(summary);
      continue;
    }
    if (!groups.has(slug)) groups.set(slug, []);
    groups.get(slug)!.push(summary);
  }

  // Sort each group's agents by tier, then by name
  for (const list of groups.values()) {
    list.sort((a, b) => {
      const at = TIER_ORDER[a.tier] ?? 99;
      const bt = TIER_ORDER[b.tier] ?? 99;
      if (at !== bt) return at - bt;
      return a.name.localeCompare(b.name);
    });
  }

  // Assemble output sorted by department display_order
  const result: DepartmentGroup[] = [];
  for (const dept of departments.sort((a, b) => a.display_order - b.display_order)) {
    const list = groups.get(dept.slug) ?? [];
    result.push({
      slug: dept.slug,
      display_name: dept.display_name,
      display_order: dept.display_order,
      agents: list,
    });
  }

  return NextResponse.json({
    departments: result,
    orphans,
    total_agents: agents.length,
    total_departments: result.length,
  });
}
