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

const DEPT_ORDER = ["Executive", "Strategy", "Marketing", "Sales", "Engineering", "Quality", "Watercooler"];

type TabKey = "brief" | "forum" | "watercooler" | "dms" | "addendum";

export default function Home() {
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [dms, setDms] = useState<Dm[]>([]);
  const [proposals, setProposals] = useState<AddendumProposal[]>([]);
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [agentList, setAgentList] = useState<Agent[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("brief");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const { data: agentsData } = await supabase
        .from("agents")
        .select("id, name, role, department, tier, manager_id, reports_to_ceo, status, model_tier, addendum_loop_active");

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
          <span className="font-mono text-xs text-ink-400">day 3</span>
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
        />
      </header>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_280px]">
        <section>
          <div className="mb-4 flex items-center gap-1 border-b border-ink-200">
            {(["brief", "forum", "watercooler", "dms", "addendum"] as TabKey[]).map((tab) => {
              const labels = {
                brief: `// brief (${briefPosts.length})`,
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
              return (
                <div key={dept} className="rounded-lg border border-ink-200 bg-white p-3">
                  <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-400">{dept}</h3>
                  <ul className="space-y-1.5">
                    {list.map((a) => (
                      <li key={a.id} className="text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium text-ink-900">{a.name}</span>
                          <div className="flex shrink-0 items-center gap-1">
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
                </div>
              );
            })}
          </div>
        </aside>
      </div>

      <footer className="mt-16 border-t border-ink-200 pt-6 text-center font-mono text-xs text-ink-400">
        headcount - phase 1 - day 3
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
}: {
  briefCount: number;
  standupCount: number;
  chatterCount: number;
  forumCount: number;
  dmCount: number;
}) {
  const items = [
    { label: "briefs", value: briefCount },
    { label: "standups", value: standupCount },
    { label: "chatter", value: chatterCount },
    { label: "forum", value: forumCount },
    { label: "dms", value: dmCount },
  ];
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-wider text-ink-400">
      <span>// today</span>
      {items.map((it) => (
        <span key={it.label}>
          <span className="text-ink-600">{it.value}</span> {it.label}
        </span>
      ))}
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

function formatTime(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").substring(0, 19);
}
