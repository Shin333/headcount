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
}

const TIER_ORDER: Record<string, number> = {
  exec: 0,
  director: 1,
  manager: 2,
  associate: 3,
  intern: 4,
  bot: 5,
};

const TIER_LABEL: Record<string, string> = {
  exec: "EXEC",
  director: "DIR",
  manager: "MGR",
  associate: "ASSOC",
  intern: "INTERN",
  bot: "BOT",
};

const DEPT_ORDER = [
  "Executive",
  "Strategy",
  "Marketing",
  "Sales",
  "Engineering",
  "Quality",
  "Watercooler",
];

export default function Home() {
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [agentList, setAgentList] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const { data: agentsData } = await supabase
        .from("agents")
        .select("id, name, role, department, tier, manager_id, reports_to_ceo, status, model_tier");

      if (mounted && agentsData) {
        const map = new Map<string, Agent>();
        for (const a of agentsData) map.set(a.id, a as Agent);
        setAgents(map);
        setAgentList(agentsData as Agent[]);
      }

      const { data: postsData } = await supabase
        .from("forum_posts")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);

      if (mounted && postsData) {
        setPosts(postsData as ForumPost[]);
        setLoading(false);
      }
    }

    load();

    const channel = supabase
      .channel("forum-posts-feed")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "forum_posts" },
        (payload) => {
          setPosts((prev) => [payload.new as ForumPost, ...prev].slice(0, 50));
        }
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, []);

  // Group agents by department for the sidebar
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

  return (
    <main className="mx-auto max-w-7xl px-6 py-10">
      <header className="mb-10 border-b border-ink-200 pb-6">
        <div className="flex items-baseline justify-between">
          <h1 className="font-mono text-2xl font-semibold tracking-tight">
            headcount<span className="text-ink-400">/</span>ceo
          </h1>
          <span className="font-mono text-xs text-ink-400">day 2a</span>
        </div>
        <p className="mt-2 text-sm text-ink-600">
          {agentList.length} employees on the org chart.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1fr_280px]">
        {/* MAIN: Forum feed */}
        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-mono text-xs uppercase tracking-wider text-ink-400">
              // forum - all channels
            </h2>
            <span className="font-mono text-xs text-ink-400">
              {loading ? "loading..." : `${posts.length} posts`}
            </span>
          </div>

          {loading && (
            <div className="rounded-lg border border-ink-200 bg-white p-6 text-sm text-ink-400">
              Loading the forum...
            </div>
          )}

          {!loading && posts.length === 0 && (
            <div className="rounded-lg border border-dashed border-ink-200 bg-white p-8 text-center">
              <p className="font-mono text-sm text-ink-400">
                The office is quiet. Nobody has posted yet.
              </p>
              <p className="mt-2 text-xs text-ink-400">
                The orchestrator will run rituals at company time markers.
              </p>
            </div>
          )}

          <ul className="space-y-3">
            {posts.map((post) => {
              const author = agents.get(post.author_id);
              return (
                <li
                  key={post.id}
                  className="rounded-lg border border-ink-200 bg-white p-4 shadow-sm transition hover:border-ink-400"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-mono text-xs text-ink-400">
                      #{post.channel}
                    </span>
                    <span className="text-sm font-medium text-ink-900">
                      {author?.name ?? "Unknown"}
                    </span>
                    {author?.role && (
                      <span className="text-xs text-ink-400">{author.role}</span>
                    )}
                    <span className="ml-auto font-mono text-xs text-ink-400">
                      {formatTime(post.created_at)}
                    </span>
                  </div>
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink-800">
                    {post.body}
                  </p>
                </li>
              );
            })}
          </ul>
        </section>

        {/* SIDEBAR: Org chart */}
        <aside className="lg:sticky lg:top-10 lg:self-start">
          <div className="mb-4">
            <h2 className="font-mono text-xs uppercase tracking-wider text-ink-400">
              // org chart
            </h2>
          </div>
          <div className="space-y-4">
            {sortedDepts.map((dept) => {
              const list = agentsByDept.get(dept) ?? [];
              return (
                <div
                  key={dept}
                  className="rounded-lg border border-ink-200 bg-white p-3"
                >
                  <h3 className="mb-2 font-mono text-[10px] uppercase tracking-wider text-ink-400">
                    {dept}
                  </h3>
                  <ul className="space-y-1.5">
                    {list.map((a) => (
                      <li key={a.id} className="text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-medium text-ink-900">
                            {a.name}
                          </span>
                          <span className="shrink-0 font-mono text-[9px] text-ink-400">
                            {TIER_LABEL[a.tier] ?? a.tier}
                          </span>
                        </div>
                        <div className="truncate text-[10px] text-ink-400">
                          {a.role}
                        </div>
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
        headcount - phase 1 - day 2a
      </footer>
    </main>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toISOString().replace("T", " ").substring(0, 19);
}
