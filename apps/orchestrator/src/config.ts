import "dotenv/config";
import { loadServerEnv } from "@headcount/shared";

// Day 1 files (db.ts, claude.ts) import { env }; Day 2b files use { config }.
// Both must coexist. This file is the single source of truth for env loading.
export const env = loadServerEnv();

// ---------------------------------------------------------------------------
// Phase 2 dispatcher env-var helpers. Read directly from process.env to
// avoid modifying the deferred `packages/shared/src/schema.ts` (Phase 2
// Task 1.3 — stale, awaiting clean rewrite).
// ---------------------------------------------------------------------------

function readPositiveInt(envName: string, defaultValue: number): number {
  const raw = process.env[envName];
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    console.warn(`Invalid ${envName}="${raw}"; using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

function readDelaysList(envName: string, defaultValue: number[]): number[] {
  const raw = process.env[envName];
  if (!raw) return defaultValue;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const parsed = parts.map((p) => Number.parseInt(p, 10));
  if (parsed.length === 0 || parsed.some((n) => Number.isNaN(n) || n < 0)) {
    console.warn(
      `Invalid ${envName}="${raw}"; using default [${defaultValue.join(",")}]`,
    );
    return defaultValue;
  }
  return parsed;
}

/** Phase 2 Task 3.2: dispatcher daily-budget cap. Default 500 per spec §6.8. */
function readClaudeDailyBudgetCap(): number {
  return readPositiveInt("CLAUDE_DAILY_BUDGET_CAP", 500);
}

/**
 * Phase 2 Task 3.3: jitter + retry + soft-signal config.
 * Defaults match spec §6.8.
 */
const jitterMinMs = readPositiveInt("JITTER_MIN_MS", 5000);
const jitterMaxMs = readPositiveInt("JITTER_MAX_MS", 30000);
const maxTransientRetries = readPositiveInt("MAX_TRANSIENT_RETRIES", 3);
const transientRetryDelaysMs = readDelaysList(
  "TRANSIENT_RETRY_DELAYS_MS",
  [10000, 30000, 90000],
);
if (transientRetryDelaysMs.length < maxTransientRetries) {
  console.warn(
    `TRANSIENT_RETRY_DELAYS_MS has fewer entries (${transientRetryDelaysMs.length}) than MAX_TRANSIENT_RETRIES (${maxTransientRetries}); last delay will be reused for trailing attempts`,
  );
}
const softSignalClusterWindowMs = readPositiveInt(
  "SOFT_SIGNAL_CLUSTER_WINDOW_MS",
  60000,
);
const softSignalClusterThreshold = readPositiveInt(
  "SOFT_SIGNAL_CLUSTER_THRESHOLD",
  3,
);

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
  // Phase 2 Task 3.3: jitter + retry + soft-signal cluster
  jitterMinMs,
  jitterMaxMs,
  maxTransientRetries,
  transientRetryDelaysMs,
  softSignalClusterWindowMs,
  softSignalClusterThreshold,
} as const;
