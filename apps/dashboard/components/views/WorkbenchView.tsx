// ============================================================================
// components/views/WorkbenchView.tsx - Day 22
// ----------------------------------------------------------------------------
// Artifacts browser, agent roster with budget bars, daily activity stats.
// ============================================================================

"use client";

import { useEffect, useState } from "react";

interface Artifact {
  id: string;
  title: string;
  file_path: string;
  content_type: string;
  created_by: string;
  createdByName: string;
  created_at: string;
  version: number;
  project_id: string | null;
  projectTitle: string | null;
}

interface AgentBudget {
  id: string;
  name: string;
  role: string;
  department: string | null;
  tier: string;
  model_tier: string;
  daily_token_budget: number;
  tokens_used_today: number;
  always_on: boolean;
  status: string;
  tool_access: string[] | null;
}

interface Activity {
  dmsToday: number;
  forumPostsToday: number;
  channelMessagesToday: number;
}

interface Proposal {
  id: string;
  agent_id: string;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  proposed_by: string;
  status: string;
  created_at: string;
}

type WorkbenchTab = "artifacts" | "agents" | "addendums" | "activity";

export function WorkbenchView() {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [agents, setAgents] = useState<AgentBudget[]>([]);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [activeTab, setActiveTab] = useState<WorkbenchTab>("artifacts");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const [wbRes, propRes] = await Promise.all([
          fetch("/api/workbench"),
          fetch("/api/workbench/proposals"),
        ]);
        if (wbRes.ok) {
          const data = await wbRes.json();
          if (mounted) {
            setArtifacts(data.artifacts ?? []);
            setAgents(data.agents ?? []);
            setActivity(data.activity ?? null);
          }
        }
        if (propRes.ok) {
          const propData = await propRes.json();
          if (mounted) setProposals(propData.proposals ?? []);
        }
      } catch {
        // silent
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, 30_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const pendingProposals = proposals.filter((p) => p.status === "pending");

  const tabs: { key: WorkbenchTab; label: string; count: number }[] = [
    { key: "artifacts", label: "Artifacts", count: artifacts.length },
    { key: "agents", label: "Agent Roster", count: agents.length },
    { key: "addendums", label: "Addendums", count: pendingProposals.length },
    { key: "activity", label: "Activity", count: 0 },
  ];

  async function handleProposal(id: string, action: "approve" | "reject") {
    try {
      const res = await fetch(`/api/addendum/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        setProposals((prev) =>
          prev.map((p) =>
            p.id === id ? { ...p, status: action === "approve" ? "approved" : "rejected" } : p
          )
        );
      }
    } catch { /* silent */ }
  }

  if (loading) {
    return (
      <div className="rounded-lg border border-ink-200 bg-white p-8 text-center text-sm text-ink-400">
        Loading workbench...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-ink-100 pb-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 rounded-t px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition ${
              activeTab === tab.key
                ? "bg-ink-900 text-white"
                : "text-ink-400 hover:text-ink-700"
            }`}
          >
            <span>{tab.label}</span>
            {tab.count > 0 && (
              <span className={`text-[9px] ${activeTab === tab.key ? "text-ink-300" : "text-ink-300"}`}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Artifacts tab */}
      {activeTab === "artifacts" && (
        <div className="space-y-2">
          {artifacts.length === 0 ? (
            <div className="rounded-lg border border-dashed border-ink-200 bg-white p-8 text-center">
              <p className="font-mono text-sm text-ink-400">No artifacts yet</p>
            </div>
          ) : (
            artifacts.map((a) => (
              <div
                key={a.id}
                className="flex items-start gap-3 rounded-lg border border-ink-200 bg-white px-4 py-3"
              >
                <span className="mt-0.5 text-ink-300">
                  {a.content_type === "code" ? "💻" : "📄"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-ink-900 truncate">
                      {a.title}
                    </span>
                    {a.version > 1 && (
                      <span className="shrink-0 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[9px] text-ink-500">
                        v{a.version}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-ink-400">
                    <span>by {a.createdByName}</span>
                    {a.projectTitle && <span>in {a.projectTitle}</span>}
                    <span className="font-mono">{a.file_path}</span>
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-ink-300">
                  {new Date(a.created_at).toLocaleString("en-US", {
                    month: "short",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Agent Roster tab */}
      {activeTab === "agents" && (
        <div className="space-y-2">
          {agents.map((agent) => {
            const pct =
              agent.daily_token_budget > 0
                ? Math.min(
                    100,
                    Math.round(
                      (agent.tokens_used_today / agent.daily_token_budget) * 100
                    )
                  )
                : 0;
            const isOver = pct >= 90;
            const isWarning = pct >= 70 && pct < 90;

            return (
              <div
                key={agent.id}
                className="rounded-lg border border-ink-200 bg-white px-4 py-3"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-sm text-ink-900 truncate">
                      {agent.name}
                    </span>
                    <span className="text-[10px] text-ink-400 truncate">
                      {agent.role}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="font-mono text-[10px] text-ink-400">
                      {agent.model_tier}
                    </span>
                    <span
                      className={`font-mono text-[10px] ${
                        isOver
                          ? "text-red-600"
                          : isWarning
                          ? "text-amber-600"
                          : "text-ink-400"
                      }`}
                    >
                      {(agent.tokens_used_today / 1000).toFixed(0)}k /{" "}
                      {(agent.daily_token_budget / 1000).toFixed(0)}k
                    </span>
                  </div>
                </div>

                {/* Budget bar */}
                <div className="h-1.5 w-full rounded-full bg-ink-100 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      isOver
                        ? "bg-red-400"
                        : isWarning
                        ? "bg-amber-400"
                        : "bg-emerald-400"
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>

                {/* Tools */}
                {agent.tool_access && agent.tool_access.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {agent.tool_access.map((tool) => (
                      <span
                        key={tool}
                        className="rounded bg-ink-50 px-1.5 py-0.5 font-mono text-[9px] text-ink-400"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Addendums tab */}
      {activeTab === "addendums" && (
        <div className="space-y-2">
          {proposals.length === 0 ? (
            <div className="rounded-lg border border-dashed border-ink-200 bg-white p-8 text-center">
              <p className="font-mono text-sm text-ink-400">
                No addendum proposals. Agents submit self-improvement requests
                here during the reflection ritual.
              </p>
            </div>
          ) : (
            <>
              {pendingProposals.length > 0 && (
                <div className="mb-3">
                  <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-amber-600">
                    Pending review ({pendingProposals.length})
                  </h4>
                  {pendingProposals.map((p) => {
                    const agent = agents.find((a) => a.id === p.agent_id);
                    return (
                      <div
                        key={p.id}
                        className="mb-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-medium text-sm text-ink-900">
                            {agent?.name ?? p.proposed_by ?? "Unknown"}
                          </span>
                          <span className="font-mono text-[10px] text-ink-300">
                            {new Date(p.created_at).toLocaleString("en-US", {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                        {p.reason && (
                          <p className="text-xs text-ink-600 mb-2">
                            {p.reason}
                          </p>
                        )}
                        {p.new_value && (
                          <div className="rounded bg-white border border-ink-100 px-3 py-2 mb-2 text-xs text-ink-700 whitespace-pre-wrap max-h-32 overflow-y-auto">
                            {p.new_value.length > 500
                              ? p.new_value.slice(0, 500) + "..."
                              : p.new_value}
                          </div>
                        )}
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleProposal(p.id, "approve")}
                            className="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-700 transition"
                          >
                            Approve
                          </button>
                          <button
                            onClick={() => handleProposal(p.id, "reject")}
                            className="rounded bg-ink-200 px-3 py-1 text-xs font-medium text-ink-700 hover:bg-ink-300 transition"
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {proposals.filter((p) => p.status !== "pending").length > 0 && (
                <div>
                  <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-400">
                    Resolved
                  </h4>
                  {proposals
                    .filter((p) => p.status !== "pending")
                    .slice(0, 20)
                    .map((p) => {
                      const agent = agents.find((a) => a.id === p.agent_id);
                      return (
                        <div
                          key={p.id}
                          className={`mb-1.5 rounded-lg border px-4 py-2.5 text-xs ${
                            p.status === "approved"
                              ? "border-emerald-100 bg-emerald-50"
                              : "border-ink-100 bg-ink-50"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-ink-700">
                              <span className="font-medium">
                                {agent?.name ?? "Unknown"}
                              </span>
                              {p.reason && ` — ${p.reason.slice(0, 80)}${p.reason.length > 80 ? "..." : ""}`}
                            </span>
                            <span
                              className={`font-mono text-[9px] uppercase ${
                                p.status === "approved"
                                  ? "text-emerald-600"
                                  : "text-ink-400"
                              }`}
                            >
                              {p.status}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Activity tab */}
      {activeTab === "activity" && activity && (
        <div className="rounded-lg border border-ink-200 bg-white p-5">
          <h3 className="mb-4 font-mono text-[10px] uppercase tracking-wider text-ink-400">
            Today&apos;s Activity
          </h3>
          <div className="grid grid-cols-3 gap-4">
            <ActivityCard
              label="DMs"
              value={activity.dmsToday}
              icon="💬"
            />
            <ActivityCard
              label="Forum Posts"
              value={activity.forumPostsToday}
              icon="📢"
            />
            <ActivityCard
              label="Channel Messages"
              value={activity.channelMessagesToday}
              icon="🏢"
            />
          </div>

          <div className="mt-4 pt-4 border-t border-ink-100">
            <h4 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-400">
              Agent Budget Summary
            </h4>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded bg-ink-50 p-3">
                <span className="block font-mono text-lg font-semibold text-ink-800">
                  {agents.length}
                </span>
                <span className="font-mono text-[9px] uppercase tracking-wider text-ink-400">
                  Active agents
                </span>
              </div>
              <div className="rounded bg-ink-50 p-3">
                <span className="block font-mono text-lg font-semibold text-ink-800">
                  {agents.filter((a) => a.tokens_used_today / a.daily_token_budget >= 0.9).length}
                </span>
                <span className="font-mono text-[9px] uppercase tracking-wider text-ink-400">
                  Near budget cap
                </span>
              </div>
              <div className="rounded bg-ink-50 p-3">
                <span className="block font-mono text-lg font-semibold text-ink-800">
                  {(agents.reduce((sum, a) => sum + a.tokens_used_today, 0) / 1000).toFixed(0)}k
                </span>
                <span className="font-mono text-[9px] uppercase tracking-wider text-ink-400">
                  Total tokens used
                </span>
              </div>
              <div className="rounded bg-ink-50 p-3">
                <span className="block font-mono text-lg font-semibold text-ink-800">
                  {artifacts.length}
                </span>
                <span className="font-mono text-[9px] uppercase tracking-wider text-ink-400">
                  Artifacts (all time)
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActivityCard({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: string;
}) {
  return (
    <div className="flex flex-col items-center rounded-lg bg-ink-50 p-4">
      <span className="text-2xl mb-1">{icon}</span>
      <span className="font-mono text-xl font-semibold text-ink-800">
        {value}
      </span>
      <span className="font-mono text-[9px] uppercase tracking-wider text-ink-400 mt-0.5">
        {label}
      </span>
    </div>
  );
}
