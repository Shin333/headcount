// ============================================================================
// GET /api/health/status (Day 22c)
// ----------------------------------------------------------------------------
// Operator health view backend. Returns everything needed to debug a "nothing
// is happening" stall from the dashboard alone: per-agent budget, ritual
// heartbeats, wall-hour spend, runner errors, stuck commitments, tool-access
// drift. Read-only.
// ============================================================================
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { KNOWN_TOOL_NAMES } from "@headcount/shared";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY not set");
  return createClient(url, serviceKey);
}

export async function GET() {
  const db = adminClient();
  const nowIso = new Date().toISOString();
  const dayAgoIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const knownSet = new Set<string>(KNOWN_TOOL_NAMES);

  // ----- Agents (budget + tool drift) -----
  const { data: agents } = await db
    .from("agents")
    .select(
      "id, name, role, tier, model_tier, status, always_on, daily_token_budget, tokens_used_today, tool_access, fallback_agent_id, last_reflection_at"
    )
    .eq("tenant_id", TENANT_ID)
    .eq("is_human", false)
    .order("name", { ascending: true });

  const agentRows = (agents ?? []).map((a) => {
    const access = (a.tool_access ?? []) as string[];
    const unknownTools = access.filter((t) => !knownSet.has(t));
    const pct =
      a.daily_token_budget > 0
        ? Math.round((a.tokens_used_today / a.daily_token_budget) * 100)
        : 0;
    return {
      id: a.id,
      name: a.name,
      role: a.role,
      tier: a.tier,
      model_tier: a.model_tier,
      status: a.status,
      always_on: a.always_on,
      tokens_used_today: a.tokens_used_today,
      daily_token_budget: a.daily_token_budget,
      budget_pct: pct,
      tool_access: access,
      unknown_tools: unknownTools,
      fallback_agent_id: a.fallback_agent_id,
      last_reflection_at: a.last_reflection_at,
    };
  });

  // ----- Ritual heartbeats -----
  const { data: ritualState } = await db
    .from("ritual_state")
    .select("*")
    .eq("id", 1)
    .maybeSingle();

  const { data: reportRuns } = await db
    .from("report_runs")
    .select("ritual_name, last_run_at, next_run_at")
    .eq("tenant_id", TENANT_ID)
    .order("last_run_at", { ascending: false });

  // ----- Wall-hour spend (last 24h) -----
  const { data: spend } = await db
    .from("wall_token_spend")
    .select("wall_hour, input_tokens, output_tokens, cached_input_tokens, estimated_cost_usd, call_count")
    .eq("tenant_id", TENANT_ID)
    .gte("wall_hour", dayAgoIso)
    .order("wall_hour", { ascending: false });

  // ----- Runner errors (24h) -----
  // max_tokens hits and degraded wrap-ups surface via metadata.stop_reason.
  const { data: actions } = await db
    .from("agent_actions")
    .select("id, agent_id, metadata, created_at, response, tool_calls")
    .eq("tenant_id", TENANT_ID)
    .eq("action_type", "claude_call")
    .gte("created_at", dayAgoIso)
    .order("created_at", { ascending: false })
    .limit(500);

  const errorCountByAgent = new Map<string, { max_tokens: number; empty: number; name: string }>();
  const recentErrors: Array<{
    agent_id: string;
    agent_name: string;
    kind: string;
    created_at: string;
  }> = [];

  const agentNameById = new Map<string, string>();
  for (const a of agentRows) agentNameById.set(a.id, a.name);

  for (const row of actions ?? []) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    const stop = String(meta.stop_reason ?? "");
    const isMaxTokens = stop === "max_tokens";
    const isEmpty = (row.response ?? "").trim().length === 0 && !row.tool_calls;
    if (!isMaxTokens && !isEmpty) continue;
    const name = agentNameById.get(row.agent_id) ?? row.agent_id.slice(0, 8);
    const bucket = errorCountByAgent.get(row.agent_id) ?? {
      max_tokens: 0,
      empty: 0,
      name,
    };
    if (isMaxTokens) bucket.max_tokens++;
    if (isEmpty) bucket.empty++;
    errorCountByAgent.set(row.agent_id, bucket);
    if (recentErrors.length < 20) {
      recentErrors.push({
        agent_id: row.agent_id,
        agent_name: name,
        kind: isMaxTokens ? "max_tokens" : "empty",
        created_at: row.created_at,
      });
    }
  }

  // ----- Stuck commitments (status=pending, nudge_count >= 2) -----
  const { data: commitments } = await db
    .from("commitments")
    .select("id, agent_id, project_id, description, deadline_at, status, nudge_count, last_nudge_at, created_at")
    .eq("tenant_id", TENANT_ID)
    .eq("status", "pending")
    .gte("nudge_count", 2)
    .order("nudge_count", { ascending: false })
    .limit(50);

  const projectIds = Array.from(new Set((commitments ?? []).map((c) => c.project_id).filter(Boolean) as string[]));
  let projectTitles = new Map<string, string>();
  if (projectIds.length > 0) {
    const { data: projects } = await db
      .from("projects")
      .select("id, title")
      .in("id", projectIds);
    for (const p of projects ?? []) projectTitles.set(p.id, p.title);
  }

  const stuckCommitments = (commitments ?? []).map((c) => ({
    id: c.id,
    agent_name: agentNameById.get(c.agent_id) ?? c.agent_id.slice(0, 8),
    project_title: c.project_id ? projectTitles.get(c.project_id) ?? null : null,
    description: c.description,
    deadline_at: c.deadline_at,
    nudge_count: c.nudge_count,
    last_nudge_at: c.last_nudge_at,
  }));

  // ----- Tool registry summary -----
  const registryDriftAgents = agentRows.filter((a) => a.unknown_tools.length > 0).length;

  // ----- Cost circuit breaker -----
  const today = new Date().toISOString().slice(0, 10);
  const { data: costAlerts } = await db
    .from("cost_alerts")
    .select("level, spend_at_trip, cap_usd, message, created_at")
    .eq("tenant_id", TENANT_ID)
    .eq("day", today)
    .order("created_at", { ascending: false });

  const todaysSpend = (spend ?? [])
    .filter((r) => r.wall_hour >= new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .reduce((s, r) => s + Number(r.estimated_cost_usd ?? 0), 0);
  const circuitOpen = (costAlerts ?? []).some((a) => a.level === "circuit_open");

  // ----- Dead-letter queue -----
  const { data: dlqRows } = await db
    .from("commitments")
    .select("id, agent_id, project_id, description, deadline_at, nudge_count, last_nudge_at")
    .eq("tenant_id", TENANT_ID)
    .eq("status", "stalled")
    .is("dlq_resolved_at", null)
    .order("last_nudge_at", { ascending: true, nullsFirst: true })
    .limit(50);

  const dlqProjectIds = Array.from(new Set((dlqRows ?? []).map((r) => r.project_id).filter(Boolean) as string[]));
  const dlqProjectTitles = new Map<string, string>();
  if (dlqProjectIds.length > 0) {
    const { data: dlqProjects } = await db.from("projects").select("id, title").in("id", dlqProjectIds);
    for (const p of dlqProjects ?? []) dlqProjectTitles.set(p.id, p.title);
  }
  const dlq = (dlqRows ?? []).map((r) => ({
    id: r.id,
    agent_name: agentNameById.get(r.agent_id) ?? r.agent_id.slice(0, 8),
    project_title: r.project_id ? dlqProjectTitles.get(r.project_id) ?? null : null,
    description: r.description,
    deadline_at: r.deadline_at,
    nudge_count: r.nudge_count,
    last_nudge_at: r.last_nudge_at,
  }));

  return NextResponse.json({
    generated_at: nowIso,
    agents: agentRows,
    rituals: {
      state: ritualState ?? null,
      reports: reportRuns ?? [],
    },
    wall_hour_spend: spend ?? [],
    runner_errors: {
      by_agent: Array.from(errorCountByAgent.entries()).map(([agent_id, v]) => ({
        agent_id,
        name: v.name,
        max_tokens: v.max_tokens,
        empty: v.empty,
      })).sort((a, b) => b.max_tokens + b.empty - (a.max_tokens + a.empty)),
      recent: recentErrors,
    },
    stuck_commitments: stuckCommitments,
    tool_registry: {
      known: KNOWN_TOOL_NAMES,
      agents_with_drift: registryDriftAgents,
    },
    cost_breaker: {
      rolling_24h_spend: todaysSpend,
      today_alerts: costAlerts ?? [],
      circuit_open: circuitOpen,
    },
    dlq: dlq,
  });
}
