// ============================================================================
// components/lib/formatLastActivity.ts - Day 11 (extracted from page.tsx)
// ----------------------------------------------------------------------------
// Day 9d added "last activity: X min ago" to the dashboard header so the
// user can see the system is alive even when wall-time sync means most
// refreshes are boring. Day 11 extracts it into its own module.
//
// Returns "just now" / "X min ago" / "X hours ago" / "X days ago" /
// "no activity yet" depending on the most recent created_at across all
// inputs.
// ============================================================================

interface HasCreatedAt {
  created_at: string;
}

export function formatLastActivity(
  posts: HasCreatedAt[],
  dms: HasCreatedAt[],
  reports: HasCreatedAt[]
): string {
  let mostRecent = 0;
  for (const p of posts) {
    const t = new Date(p.created_at).getTime();
    if (t > mostRecent) mostRecent = t;
  }
  for (const d of dms) {
    const t = new Date(d.created_at).getTime();
    if (t > mostRecent) mostRecent = t;
  }
  for (const r of reports) {
    const t = new Date(r.created_at).getTime();
    if (t > mostRecent) mostRecent = t;
  }
  if (mostRecent === 0) return "no activity yet";
  const ageMs = Date.now() - mostRecent;
  if (ageMs < 60_000) return "just now";
  const ageMin = Math.floor(ageMs / 60_000);
  if (ageMin < 60) return `${ageMin} min ago`;
  const ageHr = Math.floor(ageMin / 60);
  if (ageHr < 24) return `${ageHr} hour${ageHr === 1 ? "" : "s"} ago`;
  const ageDay = Math.floor(ageHr / 24);
  return `${ageDay} day${ageDay === 1 ? "" : "s"} ago`;
}
