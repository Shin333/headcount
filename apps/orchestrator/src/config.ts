import "dotenv/config";
import { loadServerEnv } from "@headcount/shared";

// Day 1 files (db.ts, claude.ts) import { env }; Day 2b files use { config }.
// Both must coexist. This file is the single source of truth for env loading.
export const env = loadServerEnv();

export const config = {
  tenantId: env.TENANT_ID,
  tickIntervalMs: env.TICK_INTERVAL_MS,
  speedMultiplier: env.SPEED_MULTIPLIER,
  dailyTokenCap: env.DAILY_TOKEN_CAP,
  // Day 2b additions
  hourlyCostCapUsd: env.HOURLY_COST_CAP_USD,
  chatterPostsPerAgentPerDay: env.CHATTER_POSTS_PER_AGENT_PER_DAY,
  reflectionWallIntervalHours: env.REFLECTION_WALL_INTERVAL_HOURS,
  chatterEnabled: env.CHATTER_ENABLED,
} as const;
