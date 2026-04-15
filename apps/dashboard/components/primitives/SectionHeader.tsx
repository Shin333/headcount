// ============================================================================
// components/primitives/SectionHeader.tsx - Day 12
// ----------------------------------------------------------------------------
// Reusable section header for the new TODAY/COMPANY/WORKBENCH views.
// Shows a title, an optional count, an optional NEW badge, and an optional
// trailing element (typically a count of total items, or a "view all" link).
//
// Visually: small uppercase mono label with a colored accent strip on the
// left to distinguish sections at a glance.
// ============================================================================

"use client";

import type { ReactNode } from "react";
import { NewBadge } from "./NewBadge";

export function SectionHeader({
  title,
  newCount = 0,
  trailing,
  accent = "ink",
}: {
  title: string;
  newCount?: number;
  trailing?: ReactNode;
  /**
   * Color accent for the left bar. Maps to a Tailwind color from your
   * existing palette. Default ink (neutral); use amber for "needs action",
   * sage/emerald for "ambient", blue for "system".
   */
  accent?: "ink" | "amber" | "emerald" | "blue";
}) {
  const accentClass = {
    ink: "bg-ink-300",
    amber: "bg-amber-400",
    emerald: "bg-emerald-400",
    blue: "bg-blue-400",
  }[accent];

  return (
    <div className="mb-3 flex items-center gap-3">
      <div className={`h-4 w-1 rounded-full ${accentClass}`} aria-hidden />
      <h2 className="font-mono text-[11px] uppercase tracking-wider text-ink-600">
        {title}
      </h2>
      <NewBadge count={newCount} />
      {trailing && <div className="ml-auto">{trailing}</div>}
    </div>
  );
}
