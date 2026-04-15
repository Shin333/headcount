// ============================================================================
// components/primitives/TodayStrip.tsx - Day 11 (extracted from page.tsx)
// ----------------------------------------------------------------------------
// A horizontal strip in the dashboard header showing daily counts and the
// Tavily search quota. Day 5.3 added the Tavily quota with traffic-light
// coloring (green/amber/red) based on usage percentage.
// ============================================================================

"use client";

interface TavilyQuota {
  live_today: number;
  cache_hits_today: number;
  remaining: number;
  free_tier_daily: number;
}

export function TodayStrip({
  briefCount,
  standupCount,
  chatterCount,
  forumCount,
  dmCount,
  quota,
}: {
  briefCount: number;
  standupCount: number;
  chatterCount: number;
  forumCount: number;
  dmCount: number;
  quota: TavilyQuota | null;
}) {
  const items = [
    { label: "briefs", value: briefCount },
    { label: "standups", value: standupCount },
    { label: "chatter", value: chatterCount },
    { label: "forum", value: forumCount },
    { label: "dms", value: dmCount },
  ];
  // Day 5.3: Tavily quota color coding
  const quotaPct = quota ? quota.live_today / quota.free_tier_daily : 0;
  const quotaColorClass =
    quotaPct >= 0.9 ? "text-red-600" : quotaPct >= 0.6 ? "text-amber-600" : "text-emerald-700";

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-wider text-ink-400">
      <span>// today</span>
      {items.map((it) => (
        <span key={it.label}>
          <span className="text-ink-600">{it.value}</span> {it.label}
        </span>
      ))}
      {quota && (
        <span className="ml-auto" title={`${quota.cache_hits_today} cache hits saved today`}>
          <span className={quotaColorClass}>{quota.live_today}</span>
          <span className="text-ink-400">/{quota.free_tier_daily} tavily</span>
          {quota.cache_hits_today > 0 && (
            <span className="ml-1 text-ink-400">(+{quota.cache_hits_today} cached)</span>
          )}
        </span>
      )}
    </div>
  );
}
