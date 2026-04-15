// ============================================================================
// components/views/HealthView.tsx - Day 22c
// ----------------------------------------------------------------------------
// Operator panel for debugging the orchestrator. Six sections:
//   1. Agent budget bars (who's throttled?)
//   2. Ritual heartbeats (when did each ritual last fire?)
//   3. Wall-hour spend (last 24h cost chart)
//   4. Runner errors (max_tokens hits, empty responses)
//   5. Stuck commitments (pending, nudge_count >= 2)
//   6. Tool-access drift (agents referencing unknown tools)
// ============================================================================

"use client";

import { useEffect, useState } from "react";

interface AgentRow {
  id: string;
  name: string;
  role: string;
  tier: string;
  model_tier: string;
  status: string;
  always_on: boolean;
  tokens_used_today: number;
  daily_token_budget: number;
  budget_pct: number;
  tool_access: string[];
  unknown_tools: string[];
  fallback_agent_id: string | null;
  last_reflection_at: string | null;
}

interface SpendRow {
  wall_hour: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  estimated_cost_usd: number;
  call_count: number;
}

interface StuckCommitment {
  id: string;
  agent_name: string;
  project_title: string | null;
  description: string;
  deadline_at: string | null;
  nudge_count: number;
  last_nudge_at: string | null;
}

interface RunnerErrorByAgent {
  agent_id: string;
  name: string;
  max_tokens: number;
  empty: number;
}

interface HealthResponse {
  generated_at: string;
  agents: AgentRow[];
  rituals: {
    state: Record<string, unknown> | null;
    reports: Array<{ ritual_name: string; last_run_at: string | null; next_run_at: string }>;
  };
  wall_hour_spend: SpendRow[];
  runner_errors: {
    by_agent: RunnerErrorByAgent[];
    recent: Array<{ agent_name: string; kind: string; created_at: string }>;
  };
  stuck_commitments: StuckCommitment[];
  tool_registry: { known: readonly string[]; agents_with_drift: number };
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (diff < 0) return "soon";
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

function shortHour(iso: string): string {
  const d = new Date(iso);
  const h = String(d.getUTCHours()).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${dd} ${h}:00`;
}

export function HealthView() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    async function load() {
      try {
        const res = await fetch("/api/health/status");
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          return;
        }
        const json = (await res.json()) as HealthResponse;
        if (!cancel) {
          setData(json);
          setError(null);
        }
      } catch (err) {
        if (!cancel) setError(String(err));
      }
    }
    load();
    const t = setInterval(load, 30_000);
    return () => {
      cancel = true;
      clearInterval(t);
    };
  }, []);

  if (error) {
    return <div className="rounded border border-red-200 bg-red-50 p-4 text-sm text-red-800">Failed to load health: {error}</div>;
  }
  if (!data) {
    return <div className="rounded border border-ink-200 bg-white p-6 text-sm text-ink-400">Loading health...</div>;
  }

  const throttled = data.agents.filter((a) => a.budget_pct >= 80 && a.status === "active");
  const recentSpend = data.wall_hour_spend.slice(0, 24);
  const totalDaySpend = recentSpend.reduce((s, r) => s + Number(r.estimated_cost_usd), 0);
  const maxHourSpend = recentSpend.reduce((m, r) => Math.max(m, Number(r.estimated_cost_usd)), 0.0001);
  const fallbackById = new Map(data.agents.map((a) => [a.id, a.name]));

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between">
        <p className="text-xs text-ink-400">Generated {relTime(data.generated_at)} · refreshes every 30s</p>
        <p className="text-xs text-ink-400">
          24h spend: <span className="font-mono text-ink-700">${totalDaySpend.toFixed(2)}</span>
        </p>
      </div>

      {/* =============== Ritual heartbeat =============== */}
      <section>
        <h2 className="mb-3 font-mono text-xs uppercase tracking-wider text-ink-400">// ritual heartbeat</h2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {[
            ["morning greeting", data.rituals.state?.last_morning_greeting_date as string | null],
            ["standup", data.rituals.state?.last_standup_date as string | null],
            ["ceo brief", data.rituals.state?.last_ceo_brief_date as string | null],
            ["token reset", data.rituals.state?.last_token_reset_company_date as string | null],
            ["chatter (hr)", data.rituals.state?.last_chatter_company_hour as string | null],
          ].map(([label, v]) => (
            <div key={label} className="rounded border border-ink-200 bg-white p-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-ink-400">{label}</div>
              <div className="mt-1 font-mono text-sm text-ink-900">{v ?? "never"}</div>
            </div>
          ))}
        </div>
        {data.rituals.reports.length > 0 && (
          <div className="mt-3 rounded border border-ink-200 bg-white p-3">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-400">scheduled reports</div>
            <table className="w-full text-xs">
              <thead className="text-left font-mono text-[10px] uppercase text-ink-400">
                <tr>
                  <th className="py-1">ritual</th>
                  <th>last run</th>
                  <th>next run</th>
                </tr>
              </thead>
              <tbody>
                {data.rituals.reports.map((r) => {
                  const due = new Date(r.next_run_at).getTime() < Date.now();
                  return (
                    <tr key={r.ritual_name} className="border-t border-ink-100">
                      <td className="py-1 font-mono text-ink-700">{r.ritual_name}</td>
                      <td className="font-mono text-ink-500">{relTime(r.last_run_at)}</td>
                      <td className={`font-mono ${due ? "text-amber-700" : "text-ink-500"}`}>
                        {due ? "due now" : relTime(r.next_run_at)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* =============== Wall-hour spend =============== */}
      <section>
        <h2 className="mb-3 font-mono text-xs uppercase tracking-wider text-ink-400">// hourly spend (last 24h)</h2>
        <div className="rounded border border-ink-200 bg-white p-3">
          {recentSpend.length === 0 ? (
            <div className="text-xs text-ink-400">No spend recorded in the last 24h.</div>
          ) : (
            <div className="space-y-1">
              {recentSpend.map((r) => {
                const cost = Number(r.estimated_cost_usd);
                const width = Math.max(2, Math.round((cost / maxHourSpend) * 100));
                return (
                  <div key={r.wall_hour} className="flex items-center gap-2 text-xs">
                    <span className="w-16 font-mono text-ink-400">{shortHour(r.wall_hour)}</span>
                    <div className="flex-1">
                      <div className="h-2 bg-ink-100 rounded">
                        <div className="h-2 bg-ink-900 rounded" style={{ width: `${width}%` }} />
                      </div>
                    </div>
                    <span className="w-16 text-right font-mono text-ink-700">${cost.toFixed(3)}</span>
                    <span className="w-10 text-right font-mono text-ink-400">{r.call_count}x</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* =============== Agent budgets =============== */}
      <section>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-mono text-xs uppercase tracking-wider text-ink-400">// agent budgets</h2>
          <p className="text-xs text-ink-400">
            {throttled.length > 0 ? (
              <span className="text-amber-700">{throttled.length} agent(s) at ≥80%</span>
            ) : (
              <span>all under 80%</span>
            )}
          </p>
        </div>
        <div className="rounded border border-ink-200 bg-white overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-ink-50 text-left font-mono text-[10px] uppercase text-ink-400">
              <tr>
                <th className="px-3 py-2">agent</th>
                <th>tier</th>
                <th>model</th>
                <th>budget</th>
                <th>fallback</th>
                <th>last reflection</th>
              </tr>
            </thead>
            <tbody>
              {data.agents
                .filter((a) => a.always_on || a.budget_pct > 0)
                .sort((a, b) => b.budget_pct - a.budget_pct)
                .map((a) => {
                  const bar = Math.min(100, a.budget_pct);
                  const barColor =
                    a.budget_pct >= 100
                      ? "bg-red-500"
                      : a.budget_pct >= 80
                        ? "bg-amber-500"
                        : "bg-emerald-500";
                  return (
                    <tr key={a.id} className="border-t border-ink-100">
                      <td className="px-3 py-1.5">
                        <div className="font-medium text-ink-900">{a.name}</div>
                        <div className="text-[10px] text-ink-400">{a.role}</div>
                      </td>
                      <td className="font-mono text-[10px] text-ink-500">{a.tier}</td>
                      <td className="font-mono text-[10px] text-ink-500">{a.model_tier}</td>
                      <td className="w-48">
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 bg-ink-100 rounded">
                            <div className={`h-1.5 rounded ${barColor}`} style={{ width: `${bar}%` }} />
                          </div>
                          <span className="font-mono text-[10px] text-ink-500 w-24 text-right">
                            {a.tokens_used_today.toLocaleString()}/{a.daily_token_budget.toLocaleString()}
                          </span>
                        </div>
                      </td>
                      <td className="font-mono text-[10px] text-ink-500">
                        {a.fallback_agent_id ? fallbackById.get(a.fallback_agent_id) ?? "—" : "—"}
                      </td>
                      <td className="font-mono text-[10px] text-ink-500">{relTime(a.last_reflection_at)}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </section>

      {/* =============== Runner errors =============== */}
      <section>
        <h2 className="mb-3 font-mono text-xs uppercase tracking-wider text-ink-400">// runner errors (last 24h)</h2>
        {data.runner_errors.by_agent.length === 0 ? (
          <div className="rounded border border-ink-200 bg-white p-3 text-xs text-ink-400">
            No max_tokens hits or empty responses in the last 24h.
          </div>
        ) : (
          <div className="rounded border border-ink-200 bg-white p-3">
            <table className="w-full text-xs">
              <thead className="text-left font-mono text-[10px] uppercase text-ink-400">
                <tr>
                  <th className="py-1">agent</th>
                  <th>max_tokens hits</th>
                  <th>empty responses</th>
                </tr>
              </thead>
              <tbody>
                {data.runner_errors.by_agent.map((r) => (
                  <tr key={r.agent_id} className="border-t border-ink-100">
                    <td className="py-1 font-medium text-ink-900">{r.name}</td>
                    <td className={`font-mono ${r.max_tokens > 0 ? "text-amber-700" : "text-ink-400"}`}>
                      {r.max_tokens}
                    </td>
                    <td className={`font-mono ${r.empty > 0 ? "text-amber-700" : "text-ink-400"}`}>
                      {r.empty}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* =============== Stuck commitments =============== */}
      <section>
        <h2 className="mb-3 font-mono text-xs uppercase tracking-wider text-ink-400">// stuck commitments</h2>
        {data.stuck_commitments.length === 0 ? (
          <div className="rounded border border-ink-200 bg-white p-3 text-xs text-ink-400">
            No commitments with 2+ nudges. All pending work is healthy.
          </div>
        ) : (
          <div className="rounded border border-ink-200 bg-white overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-ink-50 text-left font-mono text-[10px] uppercase text-ink-400">
                <tr>
                  <th className="px-3 py-2">agent</th>
                  <th>project</th>
                  <th>description</th>
                  <th>deadline</th>
                  <th>nudges</th>
                </tr>
              </thead>
              <tbody>
                {data.stuck_commitments.map((c) => (
                  <tr key={c.id} className="border-t border-ink-100">
                    <td className="px-3 py-1.5 font-medium text-ink-900">{c.agent_name}</td>
                    <td className="text-ink-500">{c.project_title ?? "—"}</td>
                    <td className="text-ink-700 max-w-md">{c.description}</td>
                    <td className="font-mono text-[10px] text-amber-700">
                      {c.deadline_at ? relTime(c.deadline_at) : "—"}
                    </td>
                    <td className={`font-mono ${c.nudge_count >= 3 ? "text-red-700" : "text-amber-700"}`}>
                      {c.nudge_count}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* =============== Tool-access drift =============== */}
      <section>
        <h2 className="mb-3 font-mono text-xs uppercase tracking-wider text-ink-400">// tool-access drift</h2>
        {data.tool_registry.agents_with_drift === 0 ? (
          <div className="rounded border border-ink-200 bg-white p-3 text-xs text-ink-400">
            All {data.agents.length} agents reference only registered tools.
            {" "}({data.tool_registry.known.length} tools in registry.)
          </div>
        ) : (
          <div className="rounded border border-amber-200 bg-amber-50 p-3">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-amber-800">
              {data.tool_registry.agents_with_drift} agent(s) reference unknown tools
            </div>
            <table className="w-full text-xs">
              <thead className="text-left font-mono text-[10px] uppercase text-amber-700">
                <tr>
                  <th className="py-1">agent</th>
                  <th>unknown tools</th>
                </tr>
              </thead>
              <tbody>
                {data.agents
                  .filter((a) => a.unknown_tools.length > 0)
                  .map((a) => (
                    <tr key={a.id} className="border-t border-amber-200">
                      <td className="py-1 font-medium text-ink-900">{a.name}</td>
                      <td className="font-mono text-amber-900">{a.unknown_tools.join(", ")}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
