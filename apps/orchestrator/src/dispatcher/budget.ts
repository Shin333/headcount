// ============================================================================
// dispatcher/budget.ts — Daily budget tracking via `rate_budget` (Phase 2 Task 3.2).
//
// The worker calls `checkBudget()` before dequeuing each run and
// `incrementBudget()` after each run completes (or fails). Budget windows
// are fixed UTC days — each row in `rate_budget` covers from UTC-midnight
// to the next UTC-midnight.
//
// Schema mapping (Plan 2 Task 3.2 spec ↔ live DB per 0024):
//   spec `usage_count` ↔ db `calls_used`
//   spec `cap`         ↔ db `calls_cap`
// Public API surface keeps the spec names; only the DB calls use the actual
// column names.
//
// Plan ref: 2026-05-07-phase2-dispatcher.md Task 3.2.
// Spec ref: §6.8 (500/day default cap), §6.9 (Auth policy).
// ============================================================================

import { db } from "../db.js";
import { config } from "../config.js";
import { logger } from "../ops/logger.js";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

export type BudgetProvider = "claude" | "codex";

export interface BudgetCheckResult {
  allowed: boolean;
  usage_count: number;
  cap: number;
  window_resets_at: Date;
}

function todayUtcMidnight(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function tomorrowUtcMidnight(): Date {
  const d = todayUtcMidnight();
  d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * Reads (or upserts an empty row for) the current UTC-day window.
 * Returns whether a new run is allowed and the current state.
 */
export async function checkBudget(
  provider: BudgetProvider,
): Promise<BudgetCheckResult> {
  const windowStart = todayUtcMidnight();
  const envCap = config.claudeDailyBudgetCap;
  const windowResetsAt = tomorrowUtcMidnight();

  const { data, error } = await db
    .from("rate_budget")
    .select("calls_used, calls_cap")
    .eq("provider", provider)
    .eq("window_start", windowStart.toISOString())
    .maybeSingle();

  if (error) {
    throw new Error(`rate_budget select failed: ${error.message}`);
  }

  let callsUsed = 0;
  let callsCap = envCap;

  if (data) {
    callsUsed = (data as { calls_used: number }).calls_used;
    callsCap = (data as { calls_cap: number }).calls_cap;
  } else {
    // Cold-start for this window. Insert empty row so subsequent increments
    // can rely on the row existing. Single-worker mode means the race window
    // is ~ms; the unique (provider, window_start) constraint catches it.
    const { error: insertErr } = await db.from("rate_budget").insert({
      tenant_id: TENANT_ID,
      provider,
      window_start: windowStart.toISOString(),
      calls_used: 0,
      calls_cap: envCap,
    });
    if (insertErr) {
      logger.warn(
        { event: "dispatcher.budget_insert_conflict", err: insertErr.message },
        "rate_budget cold-start insert conflict; re-reading",
      );
      const { data: retry, error: retryErr } = await db
        .from("rate_budget")
        .select("calls_used, calls_cap")
        .eq("provider", provider)
        .eq("window_start", windowStart.toISOString())
        .maybeSingle();
      if (retryErr) throw new Error(`rate_budget re-read failed: ${retryErr.message}`);
      if (retry) {
        callsUsed = (retry as { calls_used: number }).calls_used;
        callsCap = (retry as { calls_cap: number }).calls_cap;
      }
    }
  }

  return {
    allowed: callsUsed < callsCap,
    usage_count: callsUsed,
    cap: callsCap,
    window_resets_at: windowResetsAt,
  };
}

/**
 * Increments `calls_used` for the current UTC-day window. Cold-starts the
 * row if it doesn't exist yet (defensive — `checkBudget` normally ensures
 * the row is present before the worker runs anything, but we don't rely
 * on call ordering here).
 */
export async function incrementBudget(provider: BudgetProvider): Promise<void> {
  const windowStart = todayUtcMidnight();

  const { data, error: selErr } = await db
    .from("rate_budget")
    .select("calls_used")
    .eq("provider", provider)
    .eq("window_start", windowStart.toISOString())
    .maybeSingle();

  if (selErr) {
    throw new Error(`rate_budget select failed: ${selErr.message}`);
  }

  if (data) {
    const newValue = (data as { calls_used: number }).calls_used + 1;
    const { error: updErr } = await db
      .from("rate_budget")
      .update({ calls_used: newValue })
      .eq("provider", provider)
      .eq("window_start", windowStart.toISOString());
    if (updErr) throw new Error(`rate_budget update failed: ${updErr.message}`);
  } else {
    const { error: insErr } = await db.from("rate_budget").insert({
      tenant_id: TENANT_ID,
      provider,
      window_start: windowStart.toISOString(),
      calls_used: 1,
      calls_cap: config.claudeDailyBudgetCap,
    });
    if (insErr) throw new Error(`rate_budget cold-increment insert failed: ${insErr.message}`);
  }
}
