import type { ReportRitual } from "./types.js";
import { bradleyPipelineRitual } from "./bradley-pipeline.js";
import { weimingRoadmapRitual } from "./weiming-roadmap.js";
import { tessaMarketingRitual } from "./tessa-marketing.js";

// ----------------------------------------------------------------------------
// reports/registry.ts - the report ritual catalog (Day 6)
// ----------------------------------------------------------------------------
// All report rituals register here. The report-runner consults this map to
// resolve a ritual_name (from the cadence ledger) to the actual ritual
// implementation.
//
// Adding a new report ritual = add the file + add it here. That's it.
// ----------------------------------------------------------------------------

const REPORT_RITUAL_REGISTRY: Record<string, ReportRitual> = {
  [bradleyPipelineRitual.name]: bradleyPipelineRitual,
  [weimingRoadmapRitual.name]: weimingRoadmapRitual,
  [tessaMarketingRitual.name]: tessaMarketingRitual,
};

/**
 * Returns all registered ritual definitions. Used at orchestrator startup
 * to seed the report_runs cadence ledger for any rituals that don't have a
 * row yet.
 */
export function getAllReportRituals(): ReportRitual[] {
  return Object.values(REPORT_RITUAL_REGISTRY);
}

/**
 * Look up a single ritual by name. Used by the report-runner when it pulls
 * a due ritual_name from the cadence ledger.
 */
export function getReportRitualByName(name: string): ReportRitual | null {
  return REPORT_RITUAL_REGISTRY[name] ?? null;
}
