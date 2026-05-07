import "dotenv/config";
import { loadServerEnv } from "@headcount/shared";

// Day 1 files (db.ts, claude.ts) import { env }; Day 2b files use { config }.
// Both must coexist. This file is the single source of truth for env loading.
export const env = loadServerEnv();

/**
 * Phase 2 dispatcher daily-budget cap. Read directly from process.env to
 * avoid modifying the deferred `packages/shared/src/schema.ts` (Phase 2
 * Task 1.3 — stale, awaiting clean rewrite). Default 500 matches spec §6.8.
 */
function readClaudeDailyBudgetCap(): number {
  const raw = process.env.CLAUDE_DAILY_BUDGET_CAP;
  if (!raw) return 500;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    console.warn(
      `Invalid CLAUDE_DAILY_BUDGET_CAP="${raw}"; using default 500`,
    );
    return 500;
  }
  return parsed;
}

export const config = {
  tenantId: env.TENANT_ID,
  tickIntervalMs: env.TICK_INTERVAL_MS,
  speedMultiplier: env.SPEED_MULTIPLIER,
  dailyTokenCap: env.DAILY_TOKEN_CAP,
  // Day 2b additions
  hourlyCostCapUsd: env.HOURLY_COST_CAP_USD,
  dailyCostCapUsd: env.DAILY_COST_CAP_USD,
  dailyCostWarnFraction: env.DAILY_COST_WARN_FRACTION,
  chatterPostsPerAgentPerDay: env.CHATTER_POSTS_PER_AGENT_PER_DAY,
  reflectionWallIntervalHours: env.REFLECTION_WALL_INTERVAL_HOURS,
  chatterEnabled: env.CHATTER_ENABLED,
  credEncryptionKey: env.CRED_ENCRYPTION_KEY,
  genviralApiKey: env.GENVIRAL_API_KEY,
  supabaseStorageBucket: env.SUPABASE_STORAGE_BUCKET,
  // Phase 2 Task 3.2: dispatcher daily-budget cap (Claude SDK runs)
  claudeDailyBudgetCap: readClaudeDailyBudgetCap(),
} as const;
