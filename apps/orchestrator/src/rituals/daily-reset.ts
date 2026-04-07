import { db } from "../db.js";
import { config } from "../config.js";
import type { WorldClock } from "../world/clock.js";

// ----------------------------------------------------------------------------
// rituals/daily-reset.ts - Day 5.1
// ----------------------------------------------------------------------------
// Resets per-agent daily counters at company-day rollover:
//   - tokens_used_today  (the gate that locked Ayaka in Day 5)
//   - chatter_posts_today (the chatter cap from Day 2b that also never reset)
//   - last_reset_company_date (already on the schema, finally getting written)
//
// Idempotent: tracks last_token_reset_company_date in ritual_state. Reset only
// fires when current company_date > last reset date. Safe across orchestrator
// restarts at any company time.
//
// Fires on every tick (cheap - one ritual_state read) but only does real work
// once per company day. Same pattern as morning greeting.
// ----------------------------------------------------------------------------

export async function maybeRunDailyReset(clock: WorldClock): Promise<void> {
  const companyDate = clock.company_time.toISOString().substring(0, 10);

  // Check ritual_state for the last reset date
  const { data: state, error: stateErr } = await db
    .from("ritual_state")
    .select("last_token_reset_company_date")
    .eq("id", 1)
    .maybeSingle();

  if (stateErr) {
    console.error(`[daily-reset] failed to read ritual_state: ${stateErr.message}`);
    return;
  }

  const lastReset = state?.last_token_reset_company_date ?? null;

  if (lastReset === companyDate) {
    // Already done today - no work needed
    return;
  }

  console.log(`[daily-reset] resetting daily counters for company day ${companyDate} (last reset: ${lastReset ?? "never"})`);

  // Reset all active agents in one query
  const { error: updateErr, count } = await db
    .from("agents")
    .update(
      {
        tokens_used_today: 0,
        chatter_posts_today: 0,
        last_reset_company_date: companyDate,
        updated_at: new Date().toISOString(),
      },
      { count: "exact" }
    )
    .eq("tenant_id", config.tenantId)
    .eq("status", "active");

  if (updateErr) {
    console.error(`[daily-reset] FAILED to reset agents: ${updateErr.message}`);
    return;
  }

  // Read-back verification (Day 3.1 rule)
  const { data: verifyAgents } = await db
    .from("agents")
    .select("id, tokens_used_today, last_reset_company_date")
    .eq("tenant_id", config.tenantId)
    .eq("status", "active");

  if (!verifyAgents) {
    console.error(`[daily-reset] read-back verification returned no rows`);
    return;
  }

  const stillStuck = verifyAgents.filter((a) => a.last_reset_company_date !== companyDate);
  if (stillStuck.length > 0) {
    console.error(
      `[daily-reset] read-back verification FAILED: ${stillStuck.length} agents did not get reset`
    );
    return;
  }

  // Update ritual_state to mark today as done
  const { error: stateUpdateErr } = await db
    .from("ritual_state")
    .update({ last_token_reset_company_date: companyDate })
    .eq("id", 1);

  if (stateUpdateErr) {
    console.error(
      `[daily-reset] WARNING: agents reset but failed to update ritual_state: ${stateUpdateErr.message}. May re-run on next tick.`
    );
    return;
  }

  // Read-back verify the ritual_state write (Day 3.1 rule)
  const { data: verifyState } = await db
    .from("ritual_state")
    .select("last_token_reset_company_date")
    .eq("id", 1)
    .maybeSingle();

  if (verifyState?.last_token_reset_company_date !== companyDate) {
    console.error(`[daily-reset] WARNING: ritual_state read-back mismatch`);
    return;
  }

  console.log(`[daily-reset] OK - reset ${verifyAgents.length} agents for ${companyDate}`);
}
