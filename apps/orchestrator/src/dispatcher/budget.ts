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
 * Daily budget ENFORCEMENT DISABLED — always returns `allowed: true` (2026-07-14).
 *
 * These per-provider daily caps were built for the metered-API era, where
 * per-token / per-call spend needed capping. On the Claude Max subscription
 * (flat rate, zero per-token cost) they protect against nothing and only stall
 * the fleet — e.g. Eleanor, the routing hub, hitting the daily cap blocked
 * EVERY dispatch. So this now always allows: no agent is ever blocked by a
 * token/call budget, and `queue.ts`'s `budget_exhausted` pause is unreachable.
 *
 * The `rate_budget` table is preserved for historical logging: it is still read
 * here (best-effort, only to populate the status display) and still incremented
 * by `incrementBudget()`. It is simply never a blocker again.
 *
 * SEPARATE and untouched: real subscription rate-limit protection — the SDK's
 * rate_limit_event + the Opus 4.8 -> GPT-5.6 (Codex) failover in
 * dispatcher/model-policy.ts. This change does not affect that path.
 */
export async function checkBudget(
  provider: BudgetProvider,
): Promise<BudgetCheckResult> {
  const windowResetsAt = tomorrowUtcMidnight();
  let callsUsed = 0;
  let callsCap = config.claudeDailyBudgetCap;

  // Best-effort read for the status display ONLY. Enforcement is off, so a
  // failure here must never stall dispatch — swallow it rather than throwing
  // the way the old enforcing version did.
  try {
    const windowStart = todayUtcMidnight();
    const { data } = await db
      .from("rate_budget")
      .select("calls_used, calls_cap")
      .eq("provider", provider)
      .eq("window_start", windowStart.toISOString())
      .maybeSingle();
    if (data) {
      callsUsed = (data as { calls_used: number }).calls_used;
      callsCap = (data as { calls_cap: number }).calls_cap;
    }
  } catch (err) {
    logger.warn(
      { event: "dispatcher.budget_read_skipped", err: (err as Error).message },
      "rate_budget read failed; enforcement is disabled so proceeding anyway",
    );
  }

  return {
    // Enforcement disabled — see function doc. Never block on budget.
    allowed: true,
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
