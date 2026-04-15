// ============================================================================
// components/primitives/PostList.tsx - Day 11 (extracted from page.tsx)
// ----------------------------------------------------------------------------
// Renders a list of forum posts with author, channel, and timestamp.
// Used by the standup, forum, and watercooler tabs in the legacy dashboard.
// ============================================================================

"use client";

import type { ForumPost, Agent } from "../lib/types";
import { formatTime } from "../lib/formatTime";

export function PostList({
  posts,
  agents,
  emptyMessage,
}: {
  posts: ForumPost[];
  agents: Map<string, Agent>;
  emptyMessage: string;
}) {
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
          <li
            key={post.id}
            className="rounded-lg border border-ink-200 bg-white p-4 shadow-sm transition hover:border-ink-400"
          >
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
