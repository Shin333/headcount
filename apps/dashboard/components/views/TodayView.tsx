// ============================================================================
// components/views/TodayView.tsx - Day 12a.1
// ----------------------------------------------------------------------------
// The TODAY view shows everything that needs the CEO's attention or is fresh
// from today, in a single scrollable column.
//
// Day 12a.1 change: Inbox section removed - DMs now live in their own
// MESSAGES view. TodayView is now: CEO Brief / Standup / Pending Decisions /
// Latest Artifacts.
// ============================================================================

"use client";

import { useEffect, useMemo } from "react";
import type { ForumPost, Dm, Agent, AddendumProposal } from "../lib/types";
import { useLastVisited, countNewSince } from "../lib/useLastVisited";
import { parseArtifactsBlock, type ParsedArtifact } from "../lib/parseArtifactsBlock";
import { formatTime } from "../lib/formatTime";
import { SectionHeader } from "../primitives/SectionHeader";
import { ArtifactCard } from "../primitives/ArtifactCard";

export function TodayView({
  briefPosts,
  standupPosts,
  proposals,
  allDms,
  agents,
  onProposalAction,
}: {
  briefPosts: ForumPost[];
  standupPosts: ForumPost[];
  proposals: AddendumProposal[];
  allDms: Dm[];
  agents: Map<string, Agent>;
  onProposalAction: (id: string, action: "approve" | "reject") => void;
}) {
  const { lastVisitedAt, markVisited } = useLastVisited("today");

  useEffect(() => {
    markVisited();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingProposals = proposals.filter((p) => p.status === "pending");

  // Latest artifact references parsed out of recent DMs
  const latestArtifacts = useMemo(() => {
    const seen = new Set<string>();
    const out: { artifact: ParsedArtifact; created_at: string; senderName: string }[] = [];
    for (const dm of allDms) {
      const parsed = parseArtifactsBlock(dm.body);
      for (const a of parsed.artifacts) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        out.push({
          artifact: a,
          created_at: dm.created_at,
          senderName: agents.get(dm.from_id)?.name ?? "Unknown",
        });
        if (out.length >= 5) break;
      }
      if (out.length >= 5) break;
    }
    return out;
  }, [allDms, agents]);

  const briefNewCount = countNewSince(briefPosts, lastVisitedAt);
  const standupNewCount = countNewSince(standupPosts, lastVisitedAt);
  const proposalsNewCount = countNewSince(pendingProposals, lastVisitedAt);
  const artifactsNewCount = countNewSince(
    latestArtifacts.map((a) => ({ created_at: a.created_at })),
    lastVisitedAt
  );

  return (
    <div className="space-y-10">
      {/* ---- CEO Brief ---- */}
      <section>
        <SectionHeader
          title="CEO Brief"
          newCount={briefNewCount}
          accent="amber"
          trailing={
            <span className="font-mono text-[10px] text-ink-400">
              {briefPosts.length} total
            </span>
          }
        />
        {briefPosts.length === 0 ? (
          <EmptyState message="No CEO brief yet. Eleanor produces one daily at 10:00 Taipei after standup." />
        ) : (
          <BriefCard post={briefPosts[0]!} agents={agents} />
        )}
      </section>

      {/* ---- Standup ---- */}
      <section>
        <SectionHeader
          title="Standup"
          newCount={standupNewCount}
          accent="ink"
          trailing={
            <span className="font-mono text-[10px] text-ink-400">
              {standupPosts.length} post{standupPosts.length === 1 ? "" : "s"}
            </span>
          }
        />
        {standupPosts.length === 0 ? (
          <EmptyState message="No standup posts today. The standup ritual fires at 09:30 Taipei." />
        ) : (
          <StandupSummary posts={standupPosts.slice(0, 6)} agents={agents} />
        )}
      </section>

      {/* ---- Pending Decisions ---- */}
      <section>
        <SectionHeader
          title="Pending Decisions"
          newCount={proposalsNewCount}
          accent="amber"
          trailing={
            <span className="font-mono text-[10px] text-ink-400">
              {pendingProposals.length} pending
            </span>
          }
        />
        {pendingProposals.length === 0 ? (
          <EmptyState message="No pending decisions. Addendum proposals from the reflection ritual will appear here." />
        ) : (
          <ul className="space-y-2">
            {pendingProposals.slice(0, 5).map((p) => {
              const agent = agents.get(p.agent_id);
              return (
                <li
                  key={p.id}
                  className="rounded-lg border border-ink-200 bg-white p-4 shadow-sm"
                >
                  <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="text-sm font-medium text-ink-900">
                      {agent?.name ?? "Unknown"}
                    </span>
                    <span className="text-xs text-ink-400">{agent?.role}</span>
                    <span className="ml-auto font-mono text-xs text-ink-400">
                      {formatTime(p.created_at)}
                    </span>
                  </div>
                  {p.reason && (
                    <p className="mb-2 text-xs text-ink-600">{p.reason}</p>
                  )}
                  <pre className="mb-3 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-ink-100 p-2 font-mono text-xs text-ink-800">
                    {p.new_value ?? "(empty)"}
                  </pre>
                  <div className="flex gap-2">
                    <button
                      onClick={() => onProposalAction(p.id, "approve")}
                      className="rounded bg-emerald-600 px-3 py-1 font-mono text-xs uppercase tracking-wider text-white hover:bg-emerald-700"
                    >
                      approve
                    </button>
                    <button
                      onClick={() => onProposalAction(p.id, "reject")}
                      className="rounded border border-ink-200 px-3 py-1 font-mono text-xs uppercase tracking-wider text-ink-600 hover:bg-ink-100"
                    >
                      reject
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ---- Latest Artifacts ---- */}
      <section>
        <SectionHeader
          title="Latest Artifacts"
          newCount={artifactsNewCount}
          accent="blue"
          trailing={
            <span className="font-mono text-[10px] text-ink-400">
              {latestArtifacts.length} shown
            </span>
          }
        />
        {latestArtifacts.length === 0 ? (
          <EmptyState message="No artifacts yet. Wei-Ming and other agents with code/markdown tools will produce them as they work." />
        ) : (
          <ul className="space-y-2">
            {latestArtifacts.map(({ artifact, created_at, senderName }) => (
              <li key={artifact.id} className="rounded-lg border border-ink-200 bg-white p-3">
                <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs text-ink-500">
                  <span className="font-medium text-ink-700">{senderName}</span>
                  <span className="font-mono text-[10px] text-ink-400">
                    {formatTime(created_at)}
                  </span>
                </div>
                <ArtifactCard artifact={artifact} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Internal helpers
// ----------------------------------------------------------------------------

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-200 bg-white p-6 text-center">
      <p className="font-mono text-xs text-ink-400">{message}</p>
    </div>
  );
}

function BriefCard({ post, agents }: { post: ForumPost; agents: Map<string, Agent> }) {
  const author = agents.get(post.author_id);
  return (
    <div className="rounded-lg border border-ink-200 bg-white p-6 shadow-sm">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-ink-900">{author?.name ?? "Unknown"}</span>
        <span className="text-xs text-ink-400">{author?.role}</span>
        <span className="ml-auto font-mono text-xs text-ink-400">
          {formatTime(post.created_at)}
        </span>
      </div>
      <div className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-800">
        {post.body}
      </div>
    </div>
  );
}

function StandupSummary({
  posts,
  agents,
}: {
  posts: ForumPost[];
  agents: Map<string, Agent>;
}) {
  return (
    <ul className="space-y-2">
      {posts.map((post) => {
        const author = agents.get(post.author_id);
        return (
          <li
            key={post.id}
            className="rounded-lg border border-ink-200 bg-white p-3"
          >
            <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-sm font-medium text-ink-900">
                {author?.name ?? "Unknown"}
              </span>
              <span className="text-[11px] text-ink-400">{author?.role}</span>
              <span className="ml-auto font-mono text-[10px] text-ink-400">
                {formatTime(post.created_at)}
              </span>
            </div>
            <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-ink-700">
              {post.body}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
