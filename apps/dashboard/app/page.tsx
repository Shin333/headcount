// ============================================================================
// app/page.tsx - Day 12a.1
// ----------------------------------------------------------------------------
// 4-view nav: TODAY / COMPANY / WORKBENCH / MESSAGES
//
// Day 12a shipped TODAY. Day 12a.1 adds MESSAGES as a Slack-style messaging
// surface and removes the Inbox section from TODAY (since it now lives in
// its own view).
// ============================================================================

"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

import {
  type ForumPost,
  type Dm,
  type Agent,
  type AddendumProposal,
  type Report,
  TIER_ORDER,
  TIER_LABEL,
  DEPT_ORDER,
  DEPT_DISPLAY,
} from "@/components/lib/types";
import { formatLastActivity } from "@/components/lib/formatLastActivity";
import { TodayStrip } from "@/components/primitives/TodayStrip";
import { TodayView } from "@/components/views/TodayView";
import { CompanyView } from "@/components/views/CompanyView";
import { WorkbenchView } from "@/components/views/WorkbenchView";
import { MessagesView } from "@/components/views/MessagesView";
import { ChannelView } from "@/components/views/ChannelView";
import { ProjectsView } from "@/components/views/ProjectsView";

type ViewKey = "today" | "company" | "projects" | "workbench" | "messages";
type MessagesSubView = "dms" | "channels";

interface TavilyQuota {
  live_today: number;
  cache_hits_today: number;
  remaining: number;
  free_tier_daily: number;
}

export default function Home() {
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [dms, setDms] = useState<Dm[]>([]);
  const [proposals, setProposals] = useState<AddendumProposal[]>([]);
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [agentList, setAgentList] = useState<Agent[]>([]);
  const [activeView, setActiveView] = useState<ViewKey>("today");
  const [messagesSubView, setMessagesSubView] = useState<MessagesSubView>("channels");
  const [loading, setLoading] = useState(true);
  const [quota, setQuota] = useState<TavilyQuota | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set());

  useEffect(() => {
    let mounted = true;

    async function load() {
      const { data: agentsData } = await supabase
        .from("agents")
        .select(
          "id, name, role, department, tier, manager_id, reports_to_ceo, status, model_tier, addendum_loop_active, is_human, in_standup, always_on"
        )
        .eq("is_human", false);

      if (mounted && agentsData) {
        const map = new Map<string, Agent>();
        for (const a of agentsData) map.set(a.id, a as Agent);
        setAgents(map);
        setAgentList(agentsData as Agent[]);
      }

      const [postsRes, dmsRes, propRes] = await Promise.all([
        supabase.from("forum_posts").select("*").order("created_at", { ascending: false }).limit(80),
        supabase.from("dms").select("*").order("created_at", { ascending: false }).limit(200),
        supabase
          .from("prompt_evolution_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(20),
      ]);

      if (mounted) {
        if (postsRes.data) setPosts(postsRes.data as ForumPost[]);
        if (dmsRes.data) setDms(dmsRes.data as Dm[]);
        if (propRes.data) setProposals(propRes.data as AddendumProposal[]);
        setLoading(false);
      }
    }

    load();

    async function loadQuota() {
      try {
        const res = await fetch("/api/tools/quota");
        if (!res.ok) return;
        const data = await res.json();
        if (mounted && data?.web_search) setQuota(data.web_search);
      } catch {
        // silent
      }
    }
    loadQuota();
    const quotaInterval = setInterval(loadQuota, 30_000);

    async function loadReports() {
      try {
        const res = await fetch("/api/reports?limit=30");
        if (!res.ok) return;
        const data = await res.json();
        if (mounted && Array.isArray(data?.reports)) setReports(data.reports);
      } catch {
        // silent
      }
    }
    loadReports();
    const reportsInterval = setInterval(loadReports, 30_000);

    const postsChannel = supabase
      .channel("posts-feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "forum_posts" },
        (payload) => {
          setPosts((prev) => [payload.new as ForumPost, ...prev].slice(0, 80));
        }
      )
      .subscribe();

    const dmsChannel = supabase
      .channel("dms-feed")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "dms" }, (payload) => {
        setDms((prev) => [payload.new as Dm, ...prev].slice(0, 40));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "dms" }, (payload) => {
        setDms((prev) =>
          prev.map((d) => (d.id === (payload.new as Dm).id ? (payload.new as Dm) : d))
        );
      })
      .subscribe();

    const proposalsChannel = supabase
      .channel("proposals-feed")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "prompt_evolution_log" },
        () => {
          supabase
            .from("prompt_evolution_log")
            .select("*")
            .order("created_at", { ascending: false })
            .limit(20)
            .then(({ data }) => {
              if (mounted && data) setProposals(data as AddendumProposal[]);
            });
        }
      )
      .subscribe();

    return () => {
      mounted = false;
      clearInterval(quotaInterval);
      clearInterval(reportsInterval);
      supabase.removeChannel(postsChannel);
      supabase.removeChannel(dmsChannel);
      supabase.removeChannel(proposalsChannel);
    };
  }, []);

  // ----- Derived data -----

  const agentsByDept = new Map<string, Agent[]>();
  for (const a of agentList) {
    const dept = a.department ?? "Other";
    if (!agentsByDept.has(dept)) agentsByDept.set(dept, []);
    agentsByDept.get(dept)!.push(a);
  }
  for (const list of agentsByDept.values()) {
    list.sort((a, b) => (TIER_ORDER[a.tier] ?? 99) - (TIER_ORDER[b.tier] ?? 99));
  }
  const sortedDepts = Array.from(agentsByDept.keys()).sort((a, b) => {
    const ai = DEPT_ORDER.indexOf(a);
    const bi = DEPT_ORDER.indexOf(b);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  const generalPosts = posts.filter(
    (p) => p.channel !== "watercooler" && p.channel !== "ceo-brief" && p.channel !== "standup"
  );
  const briefPosts = posts.filter((p) => p.channel === "ceo-brief");
  const standupPosts = posts.filter((p) => p.channel === "standup");
  const watercoolerPosts = posts.filter((p) => p.channel === "watercooler");
  const pendingProposals = proposals.filter((p) => p.status === "pending");

  const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";
  const inboxDms = dms.filter((d) => d.to_id === CEO_SENTINEL_ID);
  const unreadInboxCount = inboxDms.filter((d) => !d.read_at).length;

  // ----- Action handlers -----

  async function handleSendDm(
    toId: string,
    body: string
  ): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch("/api/dm/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toId, body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: data.error ?? `HTTP ${res.status}` };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  async function handleProposal(id: string, action: "approve" | "reject") {
    const res = await fetch(`/api/addendum/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`Failed: ${err.error ?? res.status}`);
    }
  }

  // ----- Render -----

  // Header counts shown in nav buttons
  const todayCount = briefPosts.length + standupPosts.length + pendingProposals.length;
  const companyCount = generalPosts.length + watercoolerPosts.length + reports.length;
  const workbenchCount = pendingProposals.length;
  const messagesCount = dms.length;

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <header className="mb-8 border-b border-ink-200 pb-6">
        <div className="flex items-baseline justify-between">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            headcount<span className="text-ink-400">/</span>ceo
          </h1>
          <span className="font-mono text-xs text-ink-400">day 12</span>
        </div>
        <p className="mt-2 text-sm text-ink-600">
          {agentList.length} employees · {pendingProposals.length} pending addendum proposals
        </p>
        <p className="mt-1 font-mono text-xs text-ink-400">
          last activity: {formatLastActivity(posts, dms, reports)}
        </p>
        <TodayStrip
          briefCount={briefPosts.length}
          standupCount={standupPosts.length}
          chatterCount={watercoolerPosts.length}
          forumCount={generalPosts.length}
          dmCount={dms.length}
          quota={quota}
        />
      </header>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_280px]">
        <section>
          {/* ---- 4-view nav ---- */}
          <div className="mb-6 flex flex-wrap items-center gap-2 border-b border-ink-200 pb-2">
            {(
              [
                { key: "today", label: "TODAY", count: todayCount, badge: 0 },
                { key: "company", label: "COMPANY", count: companyCount, badge: 0 },
                { key: "projects", label: "PROJECTS", count: 0, badge: 0 },
                { key: "workbench", label: "WORKBENCH", count: workbenchCount, badge: 0 },
                { key: "messages", label: "MESSAGES", count: messagesCount, badge: unreadInboxCount },
              ] as const
            ).map((view) => {
              const isActive = activeView === view.key;
              return (
                <button
                  key={view.key}
                  onClick={() => setActiveView(view.key)}
                  className={`group relative flex items-baseline gap-2 px-4 py-2 font-mono text-xs uppercase tracking-wider transition ${
                    isActive
                      ? "text-ink-900"
                      : "text-ink-400 hover:text-ink-700"
                  }`}
                >
                  <span>{view.label}</span>
                  <span className="font-mono text-[10px] text-ink-400">
                    {view.count}
                  </span>
                  {view.badge > 0 && (
                    <span className="inline-flex items-center rounded-full bg-amber-100 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-amber-800">
                      {view.badge}
                    </span>
                  )}
                  {isActive && (
                    <span className="absolute -bottom-2 left-0 right-0 h-0.5 bg-ink-900" />
                  )}
                </button>
              );
            })}
          </div>

          {loading && (
            <div className="rounded-lg border border-ink-200 bg-white p-6 text-sm text-ink-400">
              Loading...
            </div>
          )}

          {!loading && activeView === "today" && (
            <TodayView
              briefPosts={briefPosts}
              standupPosts={standupPosts}
              proposals={proposals}
              allDms={dms}
              agents={agents}
              onProposalAction={handleProposal}
            />
          )}

          {!loading && activeView === "company" && <CompanyView />}

          {!loading && activeView === "projects" && <ProjectsView />}

          {!loading && activeView === "workbench" && <WorkbenchView />}

          {!loading && activeView === "messages" && (
            <div>
              {/* Sub-tabs: DMs | Meeting Rooms */}
              <div className="mb-4 flex items-center gap-1 border-b border-ink-100 pb-2">
                {(
                  [
                    { key: "channels" as const, label: "Meeting Rooms" },
                    { key: "dms" as const, label: "DMs" },
                  ] as const
                ).map((sub) => (
                  <button
                    key={sub.key}
                    onClick={() => setMessagesSubView(sub.key)}
                    className={`rounded-t px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition ${
                      messagesSubView === sub.key
                        ? "bg-ink-900 text-white"
                        : "text-ink-400 hover:text-ink-700"
                    }`}
                  >
                    {sub.label}
                  </button>
                ))}
              </div>

              {messagesSubView === "channels" && <ChannelView />}

              {messagesSubView === "dms" && (
                <MessagesView
                  dms={dms}
                  agents={agents}
                  agentList={agentList}
                  ceoSentinelId={CEO_SENTINEL_ID}
                  onSendDm={handleSendDm}
                />
              )}
            </div>
          )}
        </section>

        <aside className="lg:sticky lg:top-10 lg:self-start">
          <div className="mb-4">
            <h2 className="font-mono text-xs uppercase tracking-wider text-ink-400">// org chart</h2>
          </div>
          <div className="space-y-4">
            {sortedDepts.map((dept) => {
              const list = agentsByDept.get(dept) ?? [];
              const activeMembers = list.filter((a) => a.always_on === true);
              const dormantMembers = list.filter((a) => a.always_on !== true);
              const isExpanded = expandedDepts.has(dept);
              const toggleExpanded = () => {
                setExpandedDepts((prev) => {
                  const next = new Set(prev);
                  if (next.has(dept)) next.delete(dept);
                  else next.add(dept);
                  return next;
                });
              };
              return (
                <div key={dept} className="rounded-lg border border-ink-200 bg-white p-3">
                  <h3 className="mb-2 flex items-baseline justify-between font-mono text-[10px] uppercase tracking-wider text-ink-400">
                    <span>{DEPT_DISPLAY[dept] ?? dept}</span>
                    <span className="font-mono text-[9px] text-ink-400">{list.length}</span>
                  </h3>
                  <ul className="space-y-1.5">
                    {activeMembers.map((a) => (
                      <li key={a.id} className="text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium text-ink-900">{a.name}</span>
                          <div className="flex shrink-0 items-center gap-1">
                            {a.in_standup && (
                              <span className="font-mono text-[8px] text-blue-600" title="in standup">
                                ◆
                              </span>
                            )}
                            {a.addendum_loop_active && (
                              <span
                                className="font-mono text-[8px] text-emerald-600"
                                title="addendum loop active"
                              >
                                ●
                              </span>
                            )}
                            <span className="font-mono text-[9px] text-ink-400">
                              {TIER_LABEL[a.tier] ?? a.tier}
                            </span>
                          </div>
                        </div>
                        <div className="truncate text-[10px] text-ink-400">{a.role}</div>
                      </li>
                    ))}
                  </ul>
                  {dormantMembers.length > 0 && (
                    <>
                      <button
                        type="button"
                        onClick={toggleExpanded}
                        className="mt-2 w-full rounded border border-dashed border-ink-200 px-2 py-1 text-left font-mono text-[10px] text-ink-400 transition hover:border-ink-400 hover:text-ink-600"
                      >
                        {isExpanded ? "▼" : "▶"} {dormantMembers.length} dormant specialist
                        {dormantMembers.length === 1 ? "" : "s"}
                      </button>
                      {isExpanded && (
                        <ul className="mt-2 space-y-1.5 border-l border-ink-100 pl-2">
                          {dormantMembers.map((a) => (
                            <li key={a.id} className="text-xs opacity-70">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-ink-800">{a.name}</span>
                                <span className="font-mono text-[9px] text-ink-400">
                                  {TIER_LABEL[a.tier] ?? a.tier}
                                </span>
                              </div>
                              <div className="truncate text-[10px] text-ink-400">{a.role}</div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </aside>
      </div>

      <footer className="mt-16 border-t border-ink-200 pt-6 text-center font-mono text-xs text-ink-400">
        headcount - phase 1 - day 12
      </footer>
    </main>
  );
}
