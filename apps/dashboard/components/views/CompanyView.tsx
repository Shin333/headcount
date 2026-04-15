// ============================================================================
// components/views/CompanyView.tsx - Day 22
// ----------------------------------------------------------------------------
// Shows company-wide activity: CEO Briefs, Standups, Forum, Watercooler.
// Fetches its own data from Supabase directly.
// ============================================================================

"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

interface ForumPost {
  id: string;
  channel: string;
  author_id: string;
  body: string;
  created_at: string;
}

interface AgentInfo {
  id: string;
  name: string;
  role: string;
}

type ChannelTab = "briefs" | "standups" | "forum" | "watercooler";

export function CompanyView() {
  const [posts, setPosts] = useState<ForumPost[]>([]);
  const [agents, setAgents] = useState<Map<string, AgentInfo>>(new Map());
  const [activeTab, setActiveTab] = useState<ChannelTab>("briefs");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function load() {
      const [postsRes, agentsRes] = await Promise.all([
        supabase
          .from("forum_posts")
          .select("id, channel, author_id, body, created_at")
          .order("created_at", { ascending: false })
          .limit(100),
        supabase
          .from("agents")
          .select("id, name, role")
          .eq("is_human", false),
      ]);

      if (mounted) {
        if (postsRes.data) setPosts(postsRes.data);
        if (agentsRes.data) {
          const map = new Map<string, AgentInfo>();
          for (const a of agentsRes.data) map.set(a.id, a);
          setAgents(map);
        }
        setLoading(false);
      }
    }

    load();

    // Realtime subscription for new posts
    const channel = supabase
      .channel("company-posts")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "forum_posts" },
        (payload) => {
          setPosts((prev) => [payload.new as ForumPost, ...prev].slice(0, 100));
        }
      )
      .subscribe();

    return () => {
      mounted = false;
      supabase.removeChannel(channel);
    };
  }, []);

  const briefs = posts.filter((p) => p.channel === "ceo-brief");
  const standups = posts.filter((p) => p.channel === "standup");
  const forum = posts.filter(
    (p) =>
      p.channel !== "ceo-brief" &&
      p.channel !== "standup" &&
      p.channel !== "watercooler"
  );
  const watercooler = posts.filter((p) => p.channel === "watercooler");

  const tabs: { key: ChannelTab; label: string; count: number }[] = [
    { key: "briefs", label: "CEO Briefs", count: briefs.length },
    { key: "standups", label: "Standups", count: standups.length },
    { key: "forum", label: "Forum", count: forum.length },
    { key: "watercooler", label: "Watercooler", count: watercooler.length },
  ];

  const activePosts =
    activeTab === "briefs"
      ? briefs
      : activeTab === "standups"
      ? standups
      : activeTab === "forum"
      ? forum
      : watercooler;

  if (loading) {
    return (
      <div className="rounded-lg border border-ink-200 bg-white p-8 text-center text-sm text-ink-400">
        Loading company activity...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Channel tabs */}
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
            <span
              className={`text-[9px] ${
                activeTab === tab.key ? "text-ink-300" : "text-ink-300"
              }`}
            >
              {tab.count}
            </span>
          </button>
        ))}
      </div>

      {/* Posts list */}
      {activePosts.length === 0 ? (
        <div className="rounded-lg border border-dashed border-ink-200 bg-white p-8 text-center">
          <p className="font-mono text-sm text-ink-400">
            No {activeTab} posts yet
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {activePosts.map((post) => {
            const agent = agents.get(post.author_id);
            return (
              <div
                key={post.id}
                className="rounded-lg border border-ink-200 bg-white px-4 py-3"
              >
                {/* Header */}
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-ink-900">
                      {agent?.name ?? "Unknown"}
                    </span>
                    <span className="text-[10px] text-ink-400">
                      {agent?.role ?? ""}
                    </span>
                  </div>
                  <span className="font-mono text-[10px] text-ink-300">
                    {new Date(post.created_at).toLocaleString("en-US", {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>

                {/* Body */}
                <div className="text-xs text-ink-700 leading-relaxed whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
                  {post.body.length > 1500
                    ? post.body.slice(0, 1500) + "\n\n[... truncated]"
                    : post.body}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
