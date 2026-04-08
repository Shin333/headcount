import { db } from "../db.js";
import { config } from "../config.js";
import { isOverHourlyCap } from "../agents/runner.js";
import { AgentSchema } from "@headcount/shared";
import type { Agent } from "@headcount/shared";
import type { WorldClock } from "../world/clock.js";
import {
  findDueReportRun,
  getRecentReportsForRitual,
  saveReport,
  upsertReportRun,
  getReportRun,
} from "../reports/store.js";
import {
  getAllReportRituals,
  getReportRitualByName,
} from "../reports/registry.js";
import type { ReportRitual } from "../reports/types.js";

// ----------------------------------------------------------------------------
// rituals/report-runner.ts - always-on report scheduler (Day 6)
// ----------------------------------------------------------------------------
// Fires on every tick. Picks AT MOST ONE due report ritual per tick and
// processes it. Volume cap is rate-limited by the tick interval (5 wall
// seconds default).
//
// Cost cap: defers to existing isOverHourlyCap() check.
//
// Idempotent across orchestrator restarts via the report_runs cadence
// ledger. On first run after a fresh deploy, seedRitualLedger() ensures
// every registered ritual has a cadence row so the scheduler knows when
// to fire it.
//
// Failure modes:
//   - Agent not found: log error, push next_run_at forward by 1 hour
//   - Ritual generate() returns null: log, push next_run_at forward
//   - saveReport fails: log, do NOT advance next_run_at (will retry next tick)
//   - upsertReportRun fails: log warning, may produce duplicate report next tick
// ----------------------------------------------------------------------------

const RECENT_REPORTS_CONTEXT_LIMIT = 3;

// Track whether we've seeded the registry yet this orchestrator process
let seeded = false;

export async function maybeRunReportScheduler(clock: WorldClock): Promise<void> {
  // First-tick seeding - ensure every registered ritual has a cadence row
  if (!seeded) {
    await seedRitualLedger();
    seeded = true;
  }

  // Cost cap guard - silent skip, no log spam (fires every tick)
  if (await isOverHourlyCap()) return;

  // Find one due report run, oldest first (fairness)
  const due = await findDueReportRun();
  if (!due) return;

  const ritual = getReportRitualByName(due.ritual_name);
  if (!ritual) {
    console.error(`[report-runner] DUE ritual '${due.ritual_name}' not found in registry - pushing next_run_at +1h to avoid loop`);
    await upsertReportRun({
      ritualName: due.ritual_name,
      lastRunAt: due.last_run_at ? new Date(due.last_run_at) : null,
      lastRunCompanyDate: due.last_run_company_date,
      nextRunAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    return;
  }

  await processOneRitual(ritual, clock);
}

async function processOneRitual(ritual: ReportRitual, clock: WorldClock): Promise<void> {
  console.log(`[report-runner] firing ritual: ${ritual.name} (${ritual.displayName})`);

  // Resolve the agent by name
  const { data: agentRow, error: loadErr } = await db
    .from("agents")
    .select("*")
    .eq("tenant_id", config.tenantId)
    .eq("name", ritual.agentName)
    .maybeSingle();

  if (loadErr || !agentRow) {
    console.error(`[report-runner] agent '${ritual.agentName}' not found for ritual '${ritual.name}': ${loadErr?.message ?? "missing"}`);
    // Push forward to avoid hammering
    await pushNextRunAt(ritual.name, 60 * 60 * 1000);
    return;
  }

  const parsed = AgentSchema.safeParse(agentRow);
  if (!parsed.success) {
    console.error(`[report-runner] agent '${ritual.agentName}' failed schema validation`);
    await pushNextRunAt(ritual.name, 60 * 60 * 1000);
    return;
  }
  const agent: Agent = parsed.data;

  if (agent.status !== "active") {
    console.log(`[report-runner] agent '${ritual.agentName}' is ${agent.status}, skipping`);
    await pushNextRunAt(ritual.name, 60 * 60 * 1000);
    return;
  }

  // Pull the agent's last N reports for this ritual as context
  const recentReports = await getRecentReportsForRitual(
    ritual.name,
    RECENT_REPORTS_CONTEXT_LIMIT
  );

  // Generate the report
  let generated;
  try {
    generated = await ritual.generate({ agent, clock, recentReports });
  } catch (err) {
    console.error(`[report-runner] ritual '${ritual.name}' generate() crashed: ${err instanceof Error ? err.message : String(err)}`);
    await pushNextRunAt(ritual.name, 60 * 60 * 1000);
    return;
  }

  if (!generated || !generated.body.trim()) {
    console.log(`[report-runner] ritual '${ritual.name}' returned no report - advancing next_run_at`);
    // Day 6.2: schedule is WALL-time relative because findDueReportRun
    // compares next_run_at against wall time. Passing company_time here
    // produced a runaway loop at 60x speed.
    const wallNow = new Date();
    const nextRunAt = ritual.computeNextRunAt({
      now: wallNow,
      lastRunAt: wallNow,
      lastRunCompanyDate: companyDateOf(clock),
    });
    await upsertReportRun({
      ritualName: ritual.name,
      lastRunAt: wallNow,
      lastRunCompanyDate: companyDateOf(clock),
      nextRunAt,
    });
    return;
  }

  // Persist the report
  const companyDate = companyDateOf(clock);
  const savedId = await saveReport({
    ritualName: ritual.name,
    agentId: agent.id,
    title: generated.title,
    body: generated.body,
    companyDate,
    metadata: generated.metadata,
  });

  if (!savedId) {
    console.error(`[report-runner] FAILED to persist report for '${ritual.name}'. Will retry next tick.`);
    // Don't advance next_run_at - retry on next tick
    return;
  }

  // Day 6.2: schedule the next run in WALL time, not company time.
  // findDueReportRun compares next_run_at against wall time, so the schedule
  // arithmetic must be wall-time relative. Day 6 incorrectly used company_time
  // here which produced a runaway loop at 60x speed (24 company minutes =
  // 24 wall seconds, so the next run was due almost immediately).
  const wallNow = new Date();
  const nextRunAt = ritual.computeNextRunAt({
    now: wallNow,
    lastRunAt: wallNow,
    lastRunCompanyDate: companyDate,
  });

  const recorded = await upsertReportRun({
    ritualName: ritual.name,
    lastRunAt: wallNow,
    lastRunCompanyDate: companyDate,
    nextRunAt,
  });

  if (!recorded) {
    console.error(`[report-runner] WARNING: report saved as ${savedId} but failed to update report_runs cadence. May produce duplicate next tick.`);
    return;
  }

  console.log(`[report-runner] ${ritual.name} OK - report ${savedId.slice(0, 8)}, next run at ${nextRunAt.toISOString()}`);
}

async function pushNextRunAt(ritualName: string, deltaMs: number): Promise<void> {
  const existing = await getReportRun(ritualName);
  const lastRunAt = existing?.last_run_at ? new Date(existing.last_run_at) : null;
  const lastRunCompanyDate = existing?.last_run_company_date ?? null;
  const nextRunAt = new Date(Date.now() + deltaMs);
  await upsertReportRun({
    ritualName,
    lastRunAt,
    lastRunCompanyDate,
    nextRunAt,
  });
}

function companyDateOf(clock: WorldClock): string {
  return clock.company_time.toISOString().substring(0, 10);
}

/**
 * Seed the cadence ledger for any ritual that doesn't have a row yet.
 * Idempotent - reads existing rows and only inserts the missing ones.
 *
 * Spreads first runs across the next ~10 wall minutes (offsets based on
 * registration order) so all three rituals don't fire at once after a
 * fresh deploy.
 */
async function seedRitualLedger(): Promise<void> {
  const rituals = getAllReportRituals();
  const now = Date.now();
  let offsetMinutes = 5;

  for (const ritual of rituals) {
    const existing = await getReportRun(ritual.name);
    if (existing) continue;

    // First-time seed: schedule first run for offsetMinutes from now,
    // staggered so the 3 rituals don't fire on the same tick.
    const firstRunAt = new Date(now + offsetMinutes * 60 * 1000);
    await upsertReportRun({
      ritualName: ritual.name,
      lastRunAt: null,
      lastRunCompanyDate: null,
      nextRunAt: firstRunAt,
    });
    console.log(`[report-runner] seeded cadence for '${ritual.name}', first run at ${firstRunAt.toISOString()}`);
    offsetMinutes += 2;
  }
}
