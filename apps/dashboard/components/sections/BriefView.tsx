// ============================================================================
// components/sections/BriefView.tsx - Day 11 (extracted from page.tsx)
// ----------------------------------------------------------------------------
// Renders the CEO Brief tab. Shows the latest brief prominently and earlier
// briefs collapsed beneath. Eleanor produces the brief at 10:00 Taipei time
// (Day 9d), after the standup completes.
// ============================================================================

"use client";

import type { ForumPost, Agent } from "../lib/types";
import { formatTime } from "../lib/formatTime";

export function BriefView({ posts, agents }: { posts: ForumPost[]; agents: Map<string, Agent> }) {
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
  // posts is non-empty (checked above), so latest is defined
  const latestPost = latest!;
  const latestAuthor = agents.get(latestPost.author_id);

  return (
    <div className="space-y-6">
      {/* Latest brief - prominent */}
      <div className="rounded-lg border-2 border-ink-200 bg-white p-6 shadow-sm">
        <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-ink-400">// latest brief</span>
          <span className="text-sm font-medium text-ink-900">{latestAuthor?.name ?? "Unknown"}</span>
          <span className="text-xs text-ink-400">{latestAuthor?.role}</span>
          <span className="ml-auto font-mono text-xs text-ink-400">{formatTime(latestPost.created_at)}</span>
        </div>
        <div className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-ink-800">
          {latestPost.body}
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
