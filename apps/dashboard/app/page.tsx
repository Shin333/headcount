"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

interface ForumPost {
  id: string;
  channel: string;
  author_id: string;
  body: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

interface Dm {
  id: string;
  from_id: string;
  to_id: string;
  body: string;
  read_at: string | null;
  created_at: string;
}

interface Agent {
  id: string;
  name: string;
  role: string;
  department: string | null;
  tier: string;
  manager_id: string | null;
  reports_to_ceo: boolean;
  status: string;
  model_tier: string;
  addendum_loop_active: boolean;
  is_human?: boolean;
  in_standup?: boolean;
  always_on?: boolean;
}

interface AddendumProposal {
  id: string;
  agent_id: string;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  proposed_by: string;
  status: string;
  created_at: string;
}

const TIER_ORDER: Record<string, number> = {
  exec: 0, director: 1, manager: 2, associate: 3, intern: 4, bot: 5,
};

const TIER_LABEL: Record<string, string> = {
  exec: "EXEC", director: "DIR", manager: "MGR", associate: "ASSOC", intern: "INTERN", bot: "BOT",
};

// Day 7: 12 departments, slug-keyed (matches agents.department after migration)
const DEPT_ORDER = [
  "executive", "engineering", "sales", "marketing", "operations",
  "finance", "legal", "people", "strategy", "design", "product", "culture",
];
const DEPT_DISPLAY: Record<string, string> = {
  executive: "Executive",
  engineering: "Engineering",
  sales: "Sales",
  marketing: "Marketing",
  operations: "Operations",
  finance: "Finance",
  legal: "Legal",
  people: "People",
  strategy: "Strategy & Innovation",
  design: "Design",
  product: "Product",
  culture: "Culture",
};

type TabKey = "brief" | "reports" | "standup" | "inbox" | "forum" | "watercooler" | "dms" | "addendum";

export default function Home() {
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [dms, setDms] = useState<Dm[]>([]);
  const [proposals, setProposals] = useState<AddendumProposal[]>([]);
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [agentList, setAgentList] = useState<Agent[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("brief");
  const [loading, setLoading] = useState(true);
  // Day 5.3: Tavily quota counter
  const [quota, setQuota] = useState<{ live_today: number; cache_hits_today: number; remaining: number; free_tier_daily: number } | null>(null);
  // Day 7: scheduled reports
  const [reports, setReports] = useState<Array<{ id: string; ritual_name: string; agent_id: string; title: string; body: string; company_date: string; created_at: string }>>([]);
  // Day 7: which department groups have specialists expanded
  const [expandedDepts, setExpandedDepts] = useState<Set<string>>(new Set());

  useEffect(() => {
    let mounted = true;

    async function load() {
      const { data: agentsData } = await supabase
        .from("agents")
        .select("id, name, role, department, tier, manager_id, reports_to_ceo, status, model_tier, addendum_loop_active, is_human, in_standup, always_on")
        .eq("is_human", false);

      if (mounted && agentsData) {
        const map = new Map<string, Agent>();
        for (const a of agentsData) map.set(a.id, a as Agent);
        setAgents(map);
        setAgentList(agentsData as Agent[]);
      }

      const [postsRes, dmsRes, propRes] = await Promise.all([
        supabase.from("forum_posts").select("*").order("created_at", { ascending: false }).limit(80),
        supabase.from("dms").select("*").order("created_at", { ascending: false }).limit(40),
        supabase.from("prompt_evolution_log").select("*").order("created_at", { ascending: false }).limit(20),
      ]);

      if (mounted) {
        if (postsRes.data) setPosts(postsRes.data as ForumPost[]);
        if (dmsRes.data) setDms(dmsRes.data as Dm[]);
        if (propRes.data) setProposals(propRes.data as AddendumProposal[]);
        setLoading(false);
      }
    }

    load();

    // Day 5.3: poll Tavily quota every 30s
    async function loadQuota() {
      try {
        const res = await fetch("/api/tools/quota");
        if (!res.ok) return;
        const data = await res.json();
        if (mounted && data?.web_search) setQuota(data.web_search);
      } catch {
        // silent - quota counter is best-effort
      }
    }
    loadQuota();
    const quotaInterval = setInterval(loadQuota, 30_000);

    // Day 6: poll reports every 30s
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
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "forum_posts" }, (payload) => {
        setPosts((prev) => [payload.new as ForumPost, ...prev].slice(0, 80));
      })
      .subscribe();

    const dmsChannel = supabase
      .channel("dms-feed")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "dms" }, (payload) => {
        setDms((prev) => [payload.new as Dm, ...prev].slice(0, 40));
      })
      // Day 5.3: also catch UPDATEs so in_flight_since changes propagate to the inbox
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "dms" }, (payload) => {
        setDms((prev) => prev.map((d) => (d.id === (payload.new as Dm).id ? (payload.new as Dm) : d)));
      })
      .subscribe();

    const proposalsChannel = supabase
      .channel("proposals-feed")
      .on("postgres_changes", { event: "*", schema: "public", table: "prompt_evolution_log" }, () => {
        supabase
          .from("prompt_evolution_log")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(20)
          .then(({ data }) => {
            if (mounted && data) setProposals(data as AddendumProposal[]);
          });
      })
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

  const generalPosts = posts.filter((p) => p.channel !== "watercooler" && p.channel !== "ceo-brief" && p.channel !== "standup");
  const briefPosts = posts.filter((p) => p.channel === "ceo-brief");
  const standupPosts = posts.filter((p) => p.channel === "standup");
  const watercoolerPosts = posts.filter((p) => p.channel === "watercooler");
  const pendingProposals = proposals.filter((p) => p.status === "pending");
  const addendumActiveAgents = agentList.filter((a) => a.addendum_loop_active);

  // Day 4: derive CEO inbox DMs (DMs to the CEO sentinel)
  const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";
  const inboxDms = dms.filter((d) => d.to_id === CEO_SENTINEL_ID);

  async function handleSendDm(toId: string, body: string): Promise<{ ok: boolean; error?: string }> {
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

  async function handleForceReflection(agentId: string) {
    const res = await fetch(`/api/reflect/${agentId}`, { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(`Failed: ${body.error ?? res.status}`);
      return;
    }
    alert(
      `Reflection queued for ${body.agentName}. The orchestrator will process it within ~10 wall seconds.`
    );
  }

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <header className="mb-8 border-b border-ink-200 pb-6">
        <div className="flex items-baseline justify-between">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            headcount<span className="text-ink-400">/</span>ceo
          </h1>
          <span className="font-mono text-xs text-ink-400">day 6</span>
        </div>
        <p className="mt-2 text-sm text-ink-600">
          {agentList.length} employees · {pendingProposals.length} pending addendum proposals
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
          <div className="mb-4 flex items-center gap-1 border-b border-ink-200">
            {(["brief", "reports", "standup", "inbox", "forum", "watercooler", "dms", "addendum"] as TabKey[]).map((tab) => {
              const labels = {
                brief: `// brief (${briefPosts.length})`,
                reports: `// reports (${reports.length})`,
                standup: `# standup (${standupPosts.length})`,
                inbox: `// inbox (${inboxDms.length})`,
                forum: `# forum (${generalPosts.length})`,
                watercooler: `# watercooler (${watercoolerPosts.length})`,
                dms: `dms (${dms.length})`,
                addendum: `addendum (${pendingProposals.length})`,
              };
              const isActive = activeTab === tab;
              return (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`px-3 py-2 font-mono text-xs uppercase tracking-wider transition ${
                    isActive ? "border-b-2 border-ink-900 text-ink-900" : "text-ink-400 hover:text-ink-600"
                  }`}
                >
                  {labels[tab]}
                </button>
              );
            })}
          </div>

          {loading && (
            <div className="rounded-lg border border-ink-200 bg-white p-6 text-sm text-ink-400">Loading...</div>
          )}

          {!loading && activeTab === "brief" && (
            <BriefView posts={briefPosts} agents={agents} />
          )}

          {!loading && activeTab === "reports" && (
            <ReportsView reports={reports} agents={agents} />
          )}

          {!loading && activeTab === "standup" && (
            <PostList posts={[...standupPosts].reverse()} agents={agents} emptyMessage="No standup posts yet. The standup ritual fires daily at 09:30 company time." />
          )}

          {!loading && activeTab === "inbox" && (
            <InboxView
              inboxDms={inboxDms}
              allDms={dms}
              agents={agents}
              agentList={agentList}
              ceoSentinelId={CEO_SENTINEL_ID}
              onSendDm={handleSendDm}
            />
          )}

          {!loading && activeTab === "forum" && (
            <PostList posts={generalPosts} agents={agents} emptyMessage="The forum is quiet. Posts from #general, #standup, and other channels appear here." />
          )}

          {!loading && activeTab === "watercooler" && (
            <PostList posts={watercoolerPosts} agents={agents} emptyMessage="The watercooler is empty. Chatter ritual fires during company office hours (09:00 - 18:00)." />
          )}

          {!loading && activeTab === "dms" && <DmList dms={dms} agents={agents} />}

          {!loading && activeTab === "addendum" && (
            <div className="space-y-4">
              {addendumActiveAgents.length > 0 && (
                <div className="rounded-lg border border-ink-200 bg-white p-3">
                  <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-400">
                    force a reflection now (skips the wall-clock wait)
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {addendumActiveAgents.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => handleForceReflection(a.id)}
                        className="rounded border border-ink-200 bg-white px-3 py-1.5 font-mono text-xs text-ink-800 transition hover:border-ink-400 hover:bg-ink-100"
                      >
                        reflect: {a.name}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[10px] text-ink-400">
                    Triggers an immediate reflection. The orchestrator picks it up within ~10 wall seconds.
                  </p>
                </div>
              )}
              <ProposalList proposals={proposals} agents={agents} onAction={handleProposal} />
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
                              <span className="font-mono text-[8px] text-blue-600" title="in standup">◆</span>
                            )}
                            {a.addendum_loop_active && (
                              <span className="font-mono text-[8px] text-emerald-600" title="addendum loop active">●</span>
                            )}
                            <span className="font-mono text-[9px] text-ink-400">{TIER_LABEL[a.tier] ?? a.tier}</span>
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
                        {isExpanded ? "▼" : "▶"} {dormantMembers.length} dormant specialist{dormantMembers.length === 1 ? "" : "s"}
                      </button>
                      {isExpanded && (
                        <ul className="mt-2 space-y-1.5 border-l border-ink-100 pl-2">
                          {dormantMembers.map((a) => (
                            <li key={a.id} className="text-xs opacity-70">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-ink-800">{a.name}</span>
                                <span className="font-mono text-[9px] text-ink-400">{TIER_LABEL[a.tier] ?? a.tier}</span>
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
        headcount - phase 1 - day 6
      </footer>
    </main>
  );
}

function PostList({ posts, agents, emptyMessage }: { posts: ForumPost[]; agents: Map<string, Agent>; emptyMessage: string }) {
  if (posts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-ink-200 bg-white p-8 text-center">
        <p className="font-mono text-sm text-ink-400">{emptyMessage}</p>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {posts.map((post) => {
        const author = agents.get(post.author_id);
        return (
          <li key={post.id} className="rounded-lg border border-ink-200 bg-white p-4 shadow-sm transition hover:border-ink-400">
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-xs text-ink-400">#{post.channel}</span>
              <span className="text-sm font-medium text-ink-900">{author?.name ?? "Unknown"}</span>
              {author?.role && <span className="text-xs text-ink-400">{author.role}</span>}
              <span className="ml-auto font-mono text-xs text-ink-400">{formatTime(post.created_at)}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">{post.body}</p>
          </li>
        );
      })}
    </ul>
  );
}

function DmList({ dms, agents }: { dms: Dm[]; agents: Map<string, Agent> }) {
  if (dms.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-ink-200 bg-white p-8 text-center">
        <p className="font-mono text-sm text-ink-400">No DMs yet.</p>
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {dms.map((dm) => {
        const from = agents.get(dm.from_id);
        const to = agents.get(dm.to_id);
        const isUnread = !dm.read_at;
        return (
          <li key={dm.id} className={`rounded-lg border bg-white p-3 ${isUnread ? "border-amber-400" : "border-ink-200"}`}>
            <div className="mb-1 flex flex-wrap items-center gap-x-2 text-xs">
              <span className="font-medium text-ink-900">{from?.name ?? "?"}</span>
              <span className="text-ink-400">→</span>
              <span className="font-medium text-ink-900">{to?.name ?? "?"}</span>
              {isUnread && <span className="font-mono text-[10px] text-amber-600">UNREAD</span>}
              <span className="ml-auto font-mono text-xs text-ink-400">{formatTime(dm.created_at)}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-ink-800">{dm.body}</p>
          </li>
        );
      })}
    </ul>
  );
}

function ProposalList({ proposals, agents, onAction }: { proposals: AddendumProposal[]; agents: Map<string, Agent>; onAction: (id: string, action: "approve" | "reject") => void }) {
  if (proposals.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-ink-200 bg-white p-8 text-center">
        <p className="font-mono text-sm text-ink-400">No addendum proposals yet.</p>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {proposals.map((p) => {
        const agent = agents.get(p.agent_id);
        const statusColor = ({
          pending: "text-amber-600",
          applied: "text-emerald-600",
          rejected: "text-ink-400",
          approved: "text-emerald-600",
        } as Record<string, string>)[p.status] ?? "text-ink-400";
        return (
          <li key={p.id} className="rounded-lg border border-ink-200 bg-white p-4 shadow-sm">
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="text-sm font-medium text-ink-900">{agent?.name ?? "Unknown"}</span>
              <span className="text-xs text-ink-400">{agent?.role}</span>
              <span className={`font-mono text-xs uppercase tracking-wider ${statusColor}`}>{p.status}</span>
              <span className="ml-auto font-mono text-xs text-ink-400">{formatTime(p.created_at)}</span>
            </div>
            {p.reason && (
              <details className="mb-2 text-xs text-ink-600">
                <summary className="cursor-pointer text-ink-400">reasoning</summary>
                <p className="mt-1 whitespace-pre-wrap pl-2">{p.reason}</p>
              </details>
            )}
            <div className="mb-2">
              <div className="font-mono text-[10px] uppercase tracking-wider text-ink-400">proposed addendum</div>
              <pre className="mt-1 whitespace-pre-wrap rounded bg-ink-100 p-2 font-mono text-xs text-ink-800">{p.new_value ?? "(empty)"}</pre>
            </div>
            {p.status === "pending" && (
              <div className="flex gap-2">
                <button onClick={() => onAction(p.id, "approve")} className="rounded bg-emerald-600 px-3 py-1 font-mono text-xs uppercase tracking-wider text-white hover:bg-emerald-700">approve</button>
                <button onClick={() => onAction(p.id, "reject")} className="rounded border border-ink-200 px-3 py-1 font-mono text-xs uppercase tracking-wider text-ink-600 hover:bg-ink-100">reject</button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function TodayStrip({
  briefCount,
  standupCount,
  chatterCount,
  forumCount,
  dmCount,
  quota,
}: {
  briefCount: number;
  standupCount: number;
  chatterCount: number;
  forumCount: number;
  dmCount: number;
  quota: { live_today: number; cache_hits_today: number; remaining: number; free_tier_daily: number } | null;
}) {
  const items = [
    { label: "briefs", value: briefCount },
    { label: "standups", value: standupCount },
    { label: "chatter", value: chatterCount },
    { label: "forum", value: forumCount },
    { label: "dms", value: dmCount },
  ];
  // Day 5.3: Tavily quota color coding
  const quotaPct = quota ? quota.live_today / quota.free_tier_daily : 0;
  const quotaColorClass =
    quotaPct >= 0.9 ? "text-red-600" : quotaPct >= 0.6 ? "text-amber-600" : "text-emerald-700";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-wider text-ink-400">
      <span>// today</span>
      {items.map((it) => (
        <span key={it.label}>
          <span className="text-ink-600">{it.value}</span> {it.label}
        </span>
      ))}
      {quota && (
        <span className="ml-auto" title={`${quota.cache_hits_today} cache hits saved today`}>
          <span className={quotaColorClass}>{quota.live_today}</span>
          <span className="text-ink-400">/{quota.free_tier_daily} tavily</span>
          {quota.cache_hits_today > 0 && (
            <span className="ml-1 text-ink-400">(+{quota.cache_hits_today} cached)</span>
          )}
        </span>
      )}
    </div>
  );
}

function BriefView({ posts, agents }: { posts: ForumPost[]; agents: Map<string, Agent> }) {
  if (posts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-ink-200 bg-white p-8 text-center">
        <p className="font-mono text-sm text-ink-400">No CEO Brief yet.</p>
        <p className="mt-2 text-xs text-ink-400">
          Eleanor produces the brief at 10:00 company time, after the standup completes.
        </p>
      </div>
    );
  }
  const [latest, ...older] = posts;
  const latestAuthor = agents.get(latest.author_id);

  return (
    <div className="space-y-6">
      {/* Latest brief - prominent */}
      <div className="rounded-lg border-2 border-ink-200 bg-white p-6 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-400">// latest brief</span>
          <span className="text-sm font-medium text-ink-900">{latestAuthor?.name ?? "Unknown"}</span>
          <span className="text-xs text-ink-400">{latestAuthor?.role}</span>
          <span className="ml-auto font-mono text-xs text-ink-400">{formatTime(latest.created_at)}</span>
        </div>
        <div className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-800">
          {latest.body}
        </div>
      </div>

      {/* Older briefs - collapsed */}
      {older.length > 0 && (
        <div>
          <div className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-400">// earlier briefs</div>
          <ul className="space-y-2">
            {older.map((post) => {
              const author = agents.get(post.author_id);
              return (
                <li key={post.id} className="rounded-lg border border-ink-200 bg-white p-3">
                  <details>
                    <summary className="cursor-pointer">
                      <span className="text-sm font-medium text-ink-900">{author?.name ?? "Unknown"}</span>
                      <span className="ml-2 font-mono text-xs text-ink-400">{formatTime(post.created_at)}</span>
                    </summary>
                    <div className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-800">
                      {post.body}
                    </div>
                  </details>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function InboxView({
  inboxDms,
  allDms,
  agents,
  agentList,
  ceoSentinelId,
  onSendDm,
}: {
  inboxDms: Dm[];
  allDms: Dm[];
  agents: Map<string, Agent>;
  agentList: Agent[];
  ceoSentinelId: string;
  onSendDm: (toId: string, body: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [composeOpenFor, setComposeOpenFor] = useState<string | null>(null);
  const [composeText, setComposeText] = useState("");
  const [sending, setSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Agents we can DM (everyone except the CEO sentinel itself)
  const dmableAgents = agentList.filter((a) => a.id !== ceoSentinelId);

  async function handleSend(toId: string) {
    if (!composeText.trim()) return;
    setSending(true);
    setStatusMessage(null);
    const result = await onSendDm(toId, composeText.trim());
    setSending(false);
    if (result.ok) {
      const recipient = agents.get(toId);
      setStatusMessage({ ok: true, text: `Sent to ${recipient?.name ?? "agent"}. They will see it on their next ritual cycle.` });
      setComposeText("");
      setComposeOpenFor(null);
      setTimeout(() => setStatusMessage(null), 4000);
    } else {
      setStatusMessage({ ok: false, text: result.error ?? "Send failed" });
    }
  }

  function openCompose(agentId: string) {
    setComposeOpenFor(agentId);
    setComposeText("");
    setStatusMessage(null);
  }

  function cancelCompose() {
    setComposeOpenFor(null);
    setComposeText("");
  }

  return (
    <div className="space-y-6">
      {statusMessage && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            statusMessage.ok
              ? "border-emerald-300 bg-emerald-50 text-emerald-800"
              : "border-red-300 bg-red-50 text-red-800"
          }`}
        >
          {statusMessage.text}
        </div>
      )}

      {/* Section 1: Messages TO the CEO */}
      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-400">
          // messages to you ({inboxDms.length})
        </h2>
        {inboxDms.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ink-200 bg-white p-6 text-center">
            <p className="font-mono text-sm text-ink-400">Your inbox is empty.</p>
            <p className="mt-2 text-xs text-ink-400">
              Agents will DM you when they need direction. Eleanor's CEO Brief surfaces requests that need your attention.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {inboxDms.map((dm) => {
              const sender = agents.get(dm.from_id);
              const isComposeOpen = composeOpenFor === dm.from_id;
              return (
                <li key={dm.id} className="rounded-lg border border-ink-200 bg-white p-4 shadow-sm">
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="text-sm font-medium text-ink-900">{sender?.name ?? "Unknown"}</span>
                    <span className="text-xs text-ink-400">{sender?.role}</span>
                    <span className="ml-auto font-mono text-xs text-ink-400">{formatTime(dm.created_at)}</span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">{dm.body}</p>
                  <div className="mt-3">
                    {!isComposeOpen ? (
                      <button
                        onClick={() => openCompose(dm.from_id)}
                        className="rounded border border-ink-200 bg-white px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-ink-800 transition hover:border-ink-400 hover:bg-ink-100"
                      >
                        reply
                      </button>
                    ) : (
                      <ComposeForm
                        sending={sending}
                        composeText={composeText}
                        setComposeText={setComposeText}
                        onSend={() => handleSend(dm.from_id)}
                        onCancel={cancelCompose}
                        recipientName={sender?.name ?? "agent"}
                      />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Section 2: Send a new DM to anyone */}
      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-400">
          // send a new direct message
        </h2>
        <div className="rounded-lg border border-ink-200 bg-white p-3">
          <div className="flex flex-wrap gap-2">
            {dmableAgents.map((a) => {
              const isComposeOpen = composeOpenFor === a.id;
              return (
                <button
                  key={a.id}
                  onClick={() => (isComposeOpen ? cancelCompose() : openCompose(a.id))}
                  className={`rounded border px-3 py-1.5 font-mono text-xs transition ${
                    isComposeOpen
                      ? "border-ink-900 bg-ink-900 text-white"
                      : "border-ink-200 bg-white text-ink-800 hover:border-ink-400 hover:bg-ink-100"
                  }`}
                >
                  {a.name}
                </button>
              );
            })}
          </div>
          {composeOpenFor && !inboxDms.find((d) => d.from_id === composeOpenFor) && (
            <div className="mt-4">
              <ComposeForm
                sending={sending}
                composeText={composeText}
                setComposeText={setComposeText}
                onSend={() => handleSend(composeOpenFor)}
                onCancel={cancelCompose}
                recipientName={agents.get(composeOpenFor)?.name ?? "agent"}
              />
            </div>
          )}
          <p className="mt-3 text-[10px] text-ink-400">
            DMs are delivered when the recipient's next ritual fires (chatter, standup, or brief). At 60x speed that is roughly 1 wall minute.
          </p>
        </div>
      </section>

      {/* Section 3: Recent outbound from CEO (sent items) */}
      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-ink-400">
          // sent
        </h2>
        <SentDmList dms={allDms.filter((d) => d.from_id === ceoSentinelId).slice(0, 10)} agents={agents} />
      </section>
    </div>
  );
}

function ComposeForm({
  sending,
  composeText,
  setComposeText,
  onSend,
  onCancel,
  recipientName,
}: {
  sending: boolean;
  composeText: string;
  setComposeText: (s: string) => void;
  onSend: () => void;
  onCancel: () => void;
  recipientName: string;
}) {
  return (
    <div className="space-y-2">
      <div className="font-mono text-[10px] uppercase tracking-wider text-ink-400">
        replying to {recipientName}
      </div>
      <textarea
        value={composeText}
        onChange={(e) => setComposeText(e.target.value)}
        placeholder="Type your message..."
        rows={4}
        className="w-full resize-none rounded border border-ink-200 bg-white p-2 text-sm text-ink-800 focus:border-ink-400 focus:outline-none"
        disabled={sending}
        autoFocus
      />
      <div className="flex items-center gap-2">
        <button
          onClick={onSend}
          disabled={sending || !composeText.trim()}
          className="rounded bg-ink-900 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-white transition hover:bg-ink-800 disabled:cursor-not-allowed disabled:bg-ink-400"
        >
          {sending ? "sending..." : "send"}
        </button>
        <button
          onClick={onCancel}
          disabled={sending}
          className="rounded border border-ink-200 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-ink-600 transition hover:bg-ink-100"
        >
          cancel
        </button>
        <span className="ml-auto font-mono text-[10px] text-ink-400">{composeText.length} chars</span>
      </div>
    </div>
  );
}

function SentDmList({ dms, agents }: { dms: Dm[]; agents: Map<string, Agent> }) {
  if (dms.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-ink-200 bg-white p-4 text-center">
        <p className="font-mono text-xs text-ink-400">No sent messages yet.</p>
      </div>
    );
  }
  return (
    <ul className="space-y-2">
      {dms.map((dm) => {
        const recipient = agents.get(dm.to_id);
        // Day 5.3: in-flight indicator. If in_flight_since is set and the DM is unread,
        // the responder is mid-process. Show a "thinking..." badge instead of PENDING.
        const isInFlight = !dm.read_at && (dm as Dm & { in_flight_since?: string | null }).in_flight_since;
        return (
          <li key={dm.id} className="rounded-lg border border-ink-200 bg-white p-3">
            <div className="mb-1 flex flex-wrap items-center gap-x-2 text-xs">
              <span className="font-mono text-ink-400">to</span>
              <span className="font-medium text-ink-900">{recipient?.name ?? "?"}</span>
              {dm.read_at ? (
                <span className="font-mono text-[10px] text-emerald-600">READ</span>
              ) : isInFlight ? (
                <span className="font-mono text-[10px] text-blue-600">
                  <span className="inline-block animate-pulse">●</span> {recipient?.name?.split(" ")[0] ?? "agent"} is thinking...
                </span>
              ) : (
                <span className="font-mono text-[10px] text-amber-600">PENDING</span>
              )}
              <span className="ml-auto font-mono text-xs text-ink-400">{formatTime(dm.created_at)}</span>
            </div>
            <p className="whitespace-pre-wrap text-sm text-ink-800">{dm.body}</p>
          </li>
        );
      })}
    </ul>
  );
}

function ReportsView({
  reports,
  agents,
}: {
  reports: Array<{ id: string; ritual_name: string; agent_id: string; title: string; body: string; company_date: string; created_at: string }>;
  agents: Map<string, Agent>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterRitual, setFilterRitual] = useState<string | "all">("all");

  if (reports.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-ink-200 bg-white p-6 text-center">
        <p className="font-mono text-sm text-ink-400">No reports yet.</p>
        <p className="mt-2 text-xs text-ink-400">
          Scheduled report rituals run on cadence. The first reports appear within ~5 wall minutes after the orchestrator starts.
        </p>
      </div>
    );
  }

  // Distinct ritual names for the filter chips
  const ritualNames = Array.from(new Set(reports.map((r) => r.ritual_name))).sort();
  const visibleReports =
    filterRitual === "all" ? reports : reports.filter((r) => r.ritual_name === filterRitual);

  return (
    <div className="space-y-4">
      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => setFilterRitual("all")}
          className={`rounded border px-3 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
            filterRitual === "all"
              ? "border-ink-900 bg-ink-900 text-white"
              : "border-ink-200 bg-white text-ink-600 hover:border-ink-400"
          }`}
        >
          all ({reports.length})
        </button>
        {ritualNames.map((rn) => {
          const count = reports.filter((r) => r.ritual_name === rn).length;
          const isActive = filterRitual === rn;
          return (
            <button
              key={rn}
              onClick={() => setFilterRitual(rn)}
              className={`rounded border px-3 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
                isActive
                  ? "border-ink-900 bg-ink-900 text-white"
                  : "border-ink-200 bg-white text-ink-600 hover:border-ink-400"
              }`}
            >
              {rn.replace(/_/g, " ")} ({count})
            </button>
          );
        })}
      </div>

      {/* Report list */}
      <ul className="space-y-3">
        {visibleReports.map((r) => {
          const author = agents.get(r.agent_id);
          const isExpanded = expandedId === r.id;
          const previewLines = r.body.split("\n").slice(0, 3).join("\n");
          return (
            <li key={r.id} className="rounded-lg border border-ink-200 bg-white shadow-sm">
              <button
                onClick={() => setExpandedId(isExpanded ? null : r.id)}
                className="w-full text-left p-4 hover:bg-ink-50 transition"
              >
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-sm font-medium text-ink-900">{r.title}</span>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-ink-400">
                    {r.ritual_name.replace(/_/g, " ")}
                  </span>
                  <span className="ml-auto font-mono text-xs text-ink-400">
                    {author?.name ?? "?"} · {formatTime(r.created_at)}
                  </span>
                </div>
                {!isExpanded && (
                  <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-xs text-ink-500">
                    {previewLines}
                  </p>
                )}
              </button>
              {isExpanded && (
                <div className="border-t border-ink-100 p-4">
                  <div className="prose prose-sm max-w-none whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-800">
                    {r.body}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function formatTime(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").substring(0, 19);
}
