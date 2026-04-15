// ============================================================================
// components/lib/useLastVisited.ts - Day 12
// ----------------------------------------------------------------------------
// Tracks "last visited" timestamps per section in localStorage so we can
// render NEW badges next to sections that have items newer than the last
// time the user looked at them.
//
// Pure client-side. No DB writes. No backend coordination. The timestamp
// updates when the user visits the page. If you open a tab, leave it for
// 8 hours, and come back, everything from those 8 hours shows as NEW until
// you visit again.
//
// API:
//   const { lastVisitedAt, markVisited } = useLastVisited("today");
//   const newCount = items.filter(i => new Date(i.created_at).getTime() > lastVisitedAt).length;
//   useEffect(() => { markVisited(); }, []);
//
// Returns lastVisitedAt = 0 on first visit (so everything is "new"), and
// returns Infinity briefly during SSR hydration (so nothing flashes as new
// before localStorage loads).
// ============================================================================

"use client";

import { useEffect, useState, useCallback } from "react";

const STORAGE_PREFIX = "headcount:lastVisited:";

export function useLastVisited(sectionKey: string): {
  lastVisitedAt: number;
  markVisited: () => void;
} {
  // Start at Infinity during SSR/hydration so nothing flashes as NEW before
  // we've actually checked localStorage. After mount, drop to the real value
  // (or 0 if never visited).
  const [lastVisitedAt, setLastVisitedAt] = useState<number>(Number.POSITIVE_INFINITY);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + sectionKey);
      if (raw) {
        const parsed = parseInt(raw, 10);
        if (!isNaN(parsed)) {
          setLastVisitedAt(parsed);
          return;
        }
      }
      // Never visited - set to 0 so everything counts as new
      setLastVisitedAt(0);
    } catch {
      // localStorage can throw in some sandboxed contexts (incognito iframes,
      // tightened cookie settings). Fall back to "everything is new".
      setLastVisitedAt(0);
    }
  }, [sectionKey]);

  const markVisited = useCallback(() => {
    const now = Date.now();
    try {
      localStorage.setItem(STORAGE_PREFIX + sectionKey, String(now));
    } catch {
      // ignore
    }
    setLastVisitedAt(now);
  }, [sectionKey]);

  return { lastVisitedAt, markVisited };
}

/**
 * Helper to count how many items in a list are newer than a given timestamp.
 * Returns 0 if lastVisitedAt is Infinity (still loading) so nothing flashes.
 */
export function countNewSince(
  items: { created_at: string }[],
  lastVisitedAt: number
): number {
  if (!isFinite(lastVisitedAt)) return 0;
  let count = 0;
  for (const item of items) {
    if (new Date(item.created_at).getTime() > lastVisitedAt) count++;
  }
  return count;
}
