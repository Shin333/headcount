// ============================================================================
// components/primitives/NewBadge.tsx - Day 12
// ----------------------------------------------------------------------------
// A small "NEW" pill that appears next to section headers when there are
// items newer than the user's last visit. Returns null if count is 0 so
// callers can render it unconditionally.
// ============================================================================

"use client";

export function NewBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ml-2 inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-amber-800">
      {count} new
    </span>
  );
}
