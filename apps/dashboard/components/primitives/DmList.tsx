// ============================================================================
// components/primitives/DmList.tsx - Day 11 (extracted from page.tsx)
// ----------------------------------------------------------------------------
// Renders a list of all DMs system-wide. Used by the legacy "dms" tab as
// a debug surface to see every direct message.
// ============================================================================

"use client";

import type { Dm, Agent } from "../lib/types";
import { formatTime } from "../lib/formatTime";

export function DmList({ dms, agents }: { dms: Dm[]; agents: Map<string, Agent> }) {
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
          <li
            key={dm.id}
            className={`rounded-lg border bg-white p-3 ${isUnread ? "border-amber-400" : "border-ink-200"}`}
          >
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
