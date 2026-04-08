import { z } from "zod";
declare const ServerEnvSchema: z.ZodObject<{
    SUPABASE_URL: z.ZodString;
    SUPABASE_SERVICE_ROLE_KEY: z.ZodString;
    ANTHROPIC_API_KEY: z.ZodString;
    TENANT_ID: z.ZodString;
    TICK_INTERVAL_MS: z.ZodDefault<z.ZodNumber>;
    SPEED_MULTIPLIER: z.ZodDefault<z.ZodNumber>;
    DAILY_TOKEN_CAP: z.ZodDefault<z.ZodNumber>;
    HOURLY_COST_CAP_USD: z.ZodDefault<z.ZodNumber>;
    CHATTER_POSTS_PER_AGENT_PER_DAY: z.ZodDefault<z.ZodNumber>;
    REFLECTION_WALL_INTERVAL_HOURS: z.ZodDefault<z.ZodNumber>;
    CHATTER_ENABLED: z.ZodDefault<z.ZodBoolean>;
    TAVILY_API_KEY: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    SUPABASE_URL: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    ANTHROPIC_API_KEY: string;
    TENANT_ID: string;
    TICK_INTERVAL_MS: number;
    SPEED_MULTIPLIER: number;
    DAILY_TOKEN_CAP: number;
    HOURLY_COST_CAP_USD: number;
    CHATTER_POSTS_PER_AGENT_PER_DAY: number;
    REFLECTION_WALL_INTERVAL_HOURS: number;
    CHATTER_ENABLED: boolean;
    TAVILY_API_KEY?: string | undefined;
}, {
    SUPABASE_URL: string;
    SUPABASE_SERVICE_ROLE_KEY: string;
    ANTHROPIC_API_KEY: string;
    TENANT_ID: string;
    TICK_INTERVAL_MS?: number | undefined;
    SPEED_MULTIPLIER?: number | undefined;
    DAILY_TOKEN_CAP?: number | undefined;
    HOURLY_COST_CAP_USD?: number | undefined;
    CHATTER_POSTS_PER_AGENT_PER_DAY?: number | undefined;
    REFLECTION_WALL_INTERVAL_HOURS?: number | undefined;
    CHATTER_ENABLED?: boolean | undefined;
    TAVILY_API_KEY?: string | undefined;
}>;
export type ServerEnv = z.infer<typeof ServerEnvSchema>;
export declare function loadServerEnv(): ServerEnv;
declare const PublicEnvSchema: z.ZodObject<{
    NEXT_PUBLIC_SUPABASE_URL: z.ZodString;
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.ZodString;
}, "strip", z.ZodTypeAny, {
    NEXT_PUBLIC_SUPABASE_URL: string;
    NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
}, {
    NEXT_PUBLIC_SUPABASE_URL: string;
    NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
}>;
export type PublicEnv = z.infer<typeof PublicEnvSchema>;
export declare function loadPublicEnv(): PublicEnv;
export {};
