import type { Agent } from "@headcount/shared";
import type { WorldClock } from "../world/clock.js";

// ----------------------------------------------------------------------------
// reports/types.ts - core types for Day 6 report rituals
// ----------------------------------------------------------------------------
// A "report ritual" is a scheduled work output produced by one agent on a
// cadence (e.g. Bradley's pipeline review every weekday afternoon).
//
// Each ritual implements ReportRitual:
//   - name: stable identifier used as the cadence ledger key
//   - agentName: who writes the report (looked up by name at runtime)
//   - displayTitleTemplate: human-readable title pattern
//   - shouldFireAt: given the current world clock and the last run time,
//     return the next time this ritual should fire (or null if it just fired)
//   - generate: produce the report body (as markdown) given context
//
// The report-runner ritual scans the registry on each tick, picks at most
// one due ritual, runs it, and persists the resulting report + cadence row.
// ----------------------------------------------------------------------------

/**
 * Context passed to a ritual's generate() function.
 */
export interface ReportContext {
  agent: Agent;
  clock: WorldClock;
  /** The last N reports this agent has produced for this ritual, oldest first. */
  recentReports: Array<{
    company_date: string;
    title: string;
    body: string;
  }>;
}

/**
 * What a ritual returns when it has produced a report.
 */
export interface GeneratedReport {
  title: string;
  body: string;
  /** Optional structured metadata to store alongside the report (Day 7+). */
  metadata?: Record<string, unknown>;
}

/**
 * The full ritual definition. Each report ritual file exports one of these.
 */
export interface ReportRitual {
  /** Stable ritual identifier - used as the cadence ledger key. Snake_case. */
  name: string;
  /** Human-readable name for logs and dashboard. */
  displayName: string;
  /** Name of the agent who writes this report (looked up by exact name). */
  agentName: string;
  /**
   * Given the current company time and the last run, return the company time
   * at which this ritual should next fire. Return null if the next fire time
   * cannot be determined yet.
   */
  computeNextRunAt(args: {
    now: Date;
    lastRunAt: Date | null;
    lastRunCompanyDate: string | null;
  }): Date;
  /** Produce the report content. */
  generate(ctx: ReportContext): Promise<GeneratedReport | null>;
}
