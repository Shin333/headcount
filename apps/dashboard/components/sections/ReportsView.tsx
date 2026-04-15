// ============================================================================
// components/sections/ReportsView.tsx - Day 11 (extracted from page.tsx)
// ----------------------------------------------------------------------------
// Renders the weekly reports tab. Shows a filterable list of reports with
// expand/collapse for the body. Reports come from scheduled report rituals
// (Bradley on Mondays, Tessa on Tuesdays, Wei-Ming on Fridays - Day 9d
// confirmed Taipei wall time).
// ============================================================================

"use client";

import { useState } from "react";
import type { Report, Agent } from "../lib/types";
import { formatTime } from "../lib/formatTime";

export function ReportsView({
  reports,
  agents,
}: {
  reports: Report[];
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
