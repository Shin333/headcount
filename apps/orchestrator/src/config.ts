import "dotenv/config";
import { loadServerEnv } from "@headcount/shared";

export const env = loadServerEnv();

export const config = {
  tenantId: env.TENANT_ID,
  tickIntervalMs: env.TICK_INTERVAL_MS,
  speedMultiplier: env.SPEED_MULTIPLIER,
  dailyTokenCap: env.DAILY_TOKEN_CAP,
} as const;
