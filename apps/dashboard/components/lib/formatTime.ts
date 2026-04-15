// ============================================================================
// components/lib/formatTime.ts - Day 11 (extracted from page.tsx)
// ----------------------------------------------------------------------------
// Format an ISO timestamp as "YYYY-MM-DD HH:MM:SS" for display in lists.
// Note: this returns UTC, not local. If you need Taipei time, use the
// orchestrator's formatCompanyTime helper instead.
// ============================================================================

export function formatTime(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ").substring(0, 19);
}
