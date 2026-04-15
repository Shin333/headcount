import { z } from "zod";

const ServerEnvSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  TENANT_ID: z.string().uuid(),
  TICK_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
  // Day 9d: wall-time sync. The simulation clock is the wall clock; there is
  // no speed-up. This default is now 1 so the orchestrator startup log line
  // ("speed: 1x") is truthful. The env var is still read for backward compat
  // but is ignored by clock.ts.
  SPEED_MULTIPLIER: z.coerce.number().positive().default(1),
  DAILY_TOKEN_CAP: z.coerce.number().int().positive().default(200000),
  // Day 2b additions; Day 9d: bumped from 0.50 to 5.00 because Wei-Ming on
  // Opus with code_artifact_create can burn $0.06+ per turn, and wall-time
  // sync makes the cap less of a "per-tick fairness" thing and more of a
  // "runaway protection" thing. $5/hour is a generous ceiling that should
  // never bite normal use but still catches infinite loops.
  HOURLY_COST_CAP_USD: z.coerce.number().positive().default(5.00),
  CHATTER_POSTS_PER_AGENT_PER_DAY: z.coerce.number().int().positive().default(3),
  REFLECTION_WALL_INTERVAL_HOURS: z.coerce.number().int().positive().default(1),
  CHATTER_ENABLED: z.coerce.boolean().default(true),
  // Day 5: Tavily web search backend (optional - tools degrade gracefully if missing)
  TAVILY_API_KEY: z.string().min(1).optional(),
  // Day 13: Google Gemini API key for nanobanana image generation (optional -
  // image_generate tool returns a friendly error if missing, doesn't crash).
  GEMINI_API_KEY: z.string().min(1).optional(),
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export function loadServerEnv(): ServerEnv {
  const parsed = ServerEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment variables:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

const PublicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

export type PublicEnv = z.infer<typeof PublicEnvSchema>;

export function loadPublicEnv(): PublicEnv {
  const parsed = PublicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  if (!parsed.success) {
    throw new Error("Invalid public env: " + JSON.stringify(parsed.error.flatten().fieldErrors));
  }
  return parsed.data;
}
