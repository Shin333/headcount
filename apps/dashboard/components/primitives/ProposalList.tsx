// ============================================================================
// components/primitives/ProposalList.tsx - Day 11 (extracted from page.tsx)
// ----------------------------------------------------------------------------
// Renders a list of addendum proposals (agents proposing edits to their
// own system prompts via the reflection ritual). Each proposal can be
// approved or rejected by the CEO.
// ============================================================================

"use client";

import type { AddendumProposal, Agent } from "../lib/types";
import { formatTime } from "../lib/formatTime";

export function ProposalList({
  proposals,
  agents,
  onAction,
}: {
  proposals: AddendumProposal[];
  agents: Map<string, Agent>;
  onAction: (id: string, action: "approve" | "reject") => void;
}) {
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
        const statusColor =
          (
            {
              pending: "text-amber-600",
              applied: "text-emerald-600",
              rejected: "text-ink-400",
              approved: "text-emerald-600",
            } as Record<string, string>
          )[p.status] ?? "text-ink-400";
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
              <pre className="mt-1 whitespace-pre-wrap rounded bg-ink-100 p-2 font-mono text-xs text-ink-800">
                {p.new_value ?? "(empty)"}
              </pre>
            </div>
            {p.status === "pending" && (
              <div className="flex gap-2">
                <button
                  onClick={() => onAction(p.id, "approve")}
                  className="rounded bg-emerald-600 px-3 py-1 font-mono text-xs uppercase tracking-wider text-white hover:bg-emerald-700"
                >
                  approve
                </button>
                <button
                  onClick={() => onAction(p.id, "reject")}
                  className="rounded border border-ink-200 px-3 py-1 font-mono text-xs uppercase tracking-wider text-ink-600 hover:bg-ink-100"
                >
                  reject
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
