import { loadServerEnv } from "@headcount/shared";

const env = loadServerEnv();

export const config = {
  supabaseUrl: env.SUPABASE_URL,
  supabaseServiceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  anthropicApiKey: env.ANTHROPIC_API_KEY,
  tenantId: env.TENANT_ID,
  tickIntervalMs: env.TICK_INTERVAL_MS,
  speedMultiplier: env.SPEED_MULTIPLIER,
  dailyTokenCap: env.DAILY_TOKEN_CAP,
  // Day 2b additions
  hourlyCostCapUsd: env.HOURLY_COST_CAP_USD,
  chatterPostsPerAgentPerDay: env.CHATTER_POSTS_PER_AGENT_PER_DAY,
  reflectionWallIntervalHours: env.REFLECTION_WALL_INTERVAL_HOURS,
  chatterEnabled: env.CHATTER_ENABLED,
};
