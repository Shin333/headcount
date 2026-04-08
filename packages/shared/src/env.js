import { z } from "zod";
const ServerEnvSchema = z.object({
    SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    ANTHROPIC_API_KEY: z.string().min(1),
    TENANT_ID: z.string().uuid(),
    TICK_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
    SPEED_MULTIPLIER: z.coerce.number().positive().default(60),
    DAILY_TOKEN_CAP: z.coerce.number().int().positive().default(200000),
    // Day 2b additions
    HOURLY_COST_CAP_USD: z.coerce.number().positive().default(0.50),
    CHATTER_POSTS_PER_AGENT_PER_DAY: z.coerce.number().int().positive().default(3),
    REFLECTION_WALL_INTERVAL_HOURS: z.coerce.number().int().positive().default(1),
    CHATTER_ENABLED: z.coerce.boolean().default(true),
    // Day 5: Tavily web search backend (optional - tools degrade gracefully if missing)
    TAVILY_API_KEY: z.string().min(1).optional(),
});
export function loadServerEnv() {
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
export function loadPublicEnv() {
    const parsed = PublicEnvSchema.safeParse({
        NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    });
    if (!parsed.success) {
        throw new Error("Invalid public env: " + JSON.stringify(parsed.error.flatten().fieldErrors));
    }
    return parsed.data;
}
