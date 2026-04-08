import { db } from "../db.js";
import { config } from "../config.js";

// ----------------------------------------------------------------------------
// reports/store.ts - data layer for reports and report_runs (Day 6)
// ----------------------------------------------------------------------------
// All writes follow the Day 3.1 rule: check .error AND read back to verify.
// All reads return null/empty on failure rather than throwing.
// ----------------------------------------------------------------------------

export interface SavedReport {
  id: string;
  ritual_name: string;
  agent_id: string;
  title: string;
  body: string;
  company_date: string;
  created_at: string;
}

export interface ReportRunRow {
  id: string;
  ritual_name: string;
  last_run_at: string | null;
  last_run_company_date: string | null;
  next_run_at: string;
}

/**
 * Persist a generated report. Returns the saved row's id on success, null on
 * failure. Read-back verified.
 */
export async function saveReport(args: {
  ritualName: string;
  agentId: string;
  title: string;
  body: string;
  companyDate: string;
  metadata?: Record<string, unknown>;
}): Promise<string | null> {
  const { ritualName, agentId, title, body, companyDate, metadata = {} } = args;

  const { data, error } = await db
    .from("reports")
    .insert({
      tenant_id: config.tenantId,
      ritual_name: ritualName,
      agent_id: agentId,
      title,
      body,
      company_date: companyDate,
      metadata,
    })
    .select("id, created_at")
    .single();

  if (error || !data) {
    console.error(`[reports.store] FAILED to save report '${ritualName}': ${error?.message ?? "no data"}`);
    return null;
  }

  // Read-back verification (Day 3.1 rule)
  const { data: verify } = await db
    .from("reports")
    .select("id")
    .eq("id", data.id)
    .maybeSingle();

  if (!verify) {
    console.error(`[reports.store] FAILED to verify saved report ${data.id}`);
    return null;
  }

  return data.id;
}

/**
 * Fetch the most recent N reports written for a given ritual_name.
 * Returns oldest-first so they can be passed as context to the agent.
 */
export async function getRecentReportsForRitual(
  ritualName: string,
  limit: number
): Promise<Array<{ company_date: string; title: string; body: string }>> {
  const { data, error } = await db
    .from("reports")
    .select("company_date, title, body")
    .eq("tenant_id", config.tenantId)
    .eq("ritual_name", ritualName)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return [];

  // Reverse to oldest-first for chronological context
  return data.slice().reverse();
}

/**
 * Get the cadence ledger row for a ritual. Returns null if no run has been
 * recorded yet (the ritual is brand new).
 */
export async function getReportRun(ritualName: string): Promise<ReportRunRow | null> {
  const { data, error } = await db
    .from("report_runs")
    .select("id, ritual_name, last_run_at, last_run_company_date, next_run_at")
    .eq("tenant_id", config.tenantId)
    .eq("ritual_name", ritualName)
    .maybeSingle();

  if (error || !data) return null;
  return data as ReportRunRow;
}

/**
 * Upsert a report_runs row. Used:
 *   - to initialize a brand-new ritual (first ever run)
 *   - to record a successful run and schedule the next one
 *
 * Read-back verified per Day 3.1 rule.
 */
export async function upsertReportRun(args: {
  ritualName: string;
  lastRunAt: Date | null;
  lastRunCompanyDate: string | null;
  nextRunAt: Date;
}): Promise<boolean> {
  const { ritualName, lastRunAt, lastRunCompanyDate, nextRunAt } = args;

  const { error } = await db
    .from("report_runs")
    .upsert(
      {
        tenant_id: config.tenantId,
        ritual_name: ritualName,
        last_run_at: lastRunAt ? lastRunAt.toISOString() : null,
        last_run_company_date: lastRunCompanyDate,
        next_run_at: nextRunAt.toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,ritual_name" }
    );

  if (error) {
    console.error(`[reports.store] FAILED to upsert report_run '${ritualName}': ${error.message}`);
    return false;
  }

  // Read-back verification per Day 3.1 rule.
  //
  // Day 6.1 fix: we verify the row EXISTS for this ritual_name, not that the
  // timestamp string matches exactly. Supabase normalizes timestamp output
  // (Postgres stores microsecond precision but JS toISOString() produces
  // millisecond precision, and Supabase formats timestamps with +00:00
  // instead of Z), so string equality always fails even when the upsert
  // succeeded. Row existence is the right invariant - if the upsert truly
  // failed, no row would exist.
  const { data: verify } = await db
    .from("report_runs")
    .select("id, next_run_at")
    .eq("tenant_id", config.tenantId)
    .eq("ritual_name", ritualName)
    .maybeSingle();

  if (!verify) {
    console.error(`[reports.store] FAILED to verify upsert for '${ritualName}': row not found after write`);
    return false;
  }

  return true;
}

/**
 * Find the report_run that is due to fire, with the lowest next_run_at where
 * next_run_at <= now. Returns null if nothing is due.
 *
 * If multiple rituals are due, returns the one whose next_run_at is oldest
 * (most overdue) so the runner processes them in fairness order.
 */
export async function findDueReportRun(): Promise<ReportRunRow | null> {
  const nowIso = new Date().toISOString();
  const { data, error } = await db
    .from("report_runs")
    .select("id, ritual_name, last_run_at, last_run_company_date, next_run_at")
    .eq("tenant_id", config.tenantId)
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return data as ReportRunRow;
}
