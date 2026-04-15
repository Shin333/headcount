// ----------------------------------------------------------------------------
// world/clock.ts - Day 9d: wall-time sync
// ----------------------------------------------------------------------------
// The simulation clock is the wall clock. There is no stored company time,
// no speed multiplier, no drift, no pause state. Time is time.
//
// Why `company_time` is still a Date field (for backward compat):
//   The entire codebase reads clock.company_time.getUTCHours() etc. to
//   decide when rituals fire. Rather than rewrite every caller, we produce
//   a Date whose UTC fields return Taipei wall clock values. The trick:
//   add 8 hours to real UTC so that .getUTCHours() reads as Taipei hours.
//
//   This is a common pattern for "local-time-as-UTC" Dates in timezone-aware
//   systems. The Date object will look wrong if you try to convert it back
//   to absolute time - but we never do that. We only read UTC components.
//
// Why we still track current_tick:
//   Pure logging convenience. The tick counter increments by 1 each tick
//   and is visible in the orchestrator console. Not persisted.
// ----------------------------------------------------------------------------

export interface WorldClock {
  current_tick: number;
  company_time: Date;
  speed_multiplier: number; // retained for interface compat; always 1
  paused: boolean;           // retained for interface compat; always false
}

// Module-level tick counter. Not persisted. Resets on orchestrator restart.
let tickCounter = 0;

// Taipei is UTC+8 year-round (no DST). Singapore is also UTC+8.
const TAIPEI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * Return a Date whose UTC components reflect Taipei local time.
 *
 * Example: if wall time is 2026-04-09 15:30:00 UTC (which is 23:30 Taipei),
 * this returns a Date whose .getUTCHours() is 23, not 15.
 *
 * The returned Date's absolute moment is meaningless - don't compare it to
 * other Dates or convert to ISO expecting it to round-trip. Only read
 * getUTCHours, getUTCMinutes, getUTCDate, etc.
 */
function taipeiTimeAsPseudoUtc(): Date {
  const realUtcMs = Date.now();
  return new Date(realUtcMs + TAIPEI_UTC_OFFSET_MS);
}

/**
 * Read the current world clock state. No database access - this is
 * synchronous-equivalent work wrapped in a Promise for API compatibility.
 */
export async function getWorldClock(): Promise<WorldClock> {
  return {
    current_tick: tickCounter,
    company_time: taipeiTimeAsPseudoUtc(),
    speed_multiplier: 1,
    paused: false,
  };
}

/**
 * Advance the clock by one tick. No database write - just increments the
 * in-memory counter and returns fresh wall time.
 *
 * Day 9d: this used to do a DB update. Now it's essentially free.
 */
export async function advanceClock(): Promise<WorldClock> {
  tickCounter += 1;
  return {
    current_tick: tickCounter,
    company_time: taipeiTimeAsPseudoUtc(),
    speed_multiplier: 1,
    paused: false,
  };
}

/**
 * Format a company_time Date for log output.
 *
 * Since the Date is Taipei-as-UTC, toISOString() will produce a string
 * that reads as Taipei local time. We strip the trailing Z and rename
 * the tag to make this unambiguous in logs.
 */
export function formatCompanyTime(d: Date): string {
  return d.toISOString().replace("T", " ").substring(0, 19) + " (Taipei)";
}
