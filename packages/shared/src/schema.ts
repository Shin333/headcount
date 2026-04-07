import { z } from "zod";

// ============================================================================
// AGENT
// ============================================================================
export const TierSchema = z.enum([
  "exec",
  "director",
  "manager",
  "associate",
  "intern",
  "bot",
]);
export type Tier = z.infer<typeof TierSchema>;

export const ModelTierSchema = z.enum(["sonnet", "haiku", "opus"]);
export type ModelTier = z.infer<typeof ModelTierSchema>;

export const Big5Schema = z.object({
  openness: z.number().min(0).max(100),
  conscientiousness: z.number().min(0).max(100),
  extraversion: z.number().min(0).max(100),
  agreeableness: z.number().min(0).max(100),
  neuroticism: z.number().min(0).max(100),
});
export type Big5 = z.infer<typeof Big5Schema>;

export const PersonalitySchema = z.object({
  big5: Big5Schema,
  archetype: z.string(),
  quirks: z.array(z.string()),
  voiceExamples: z.array(z.string()),
});
export type Personality = z.infer<typeof PersonalitySchema>;

export const AgentSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  name: z.string(),
  role: z.string(),
  department: z.string().nullable(),
  tier: TierSchema,
  manager_id: z.string().uuid().nullable(),
  reports_to_ceo: z.boolean(),
  personality: PersonalitySchema,
  background: z.string().nullable(),
  frozen_core: z.string(),
  manager_overlay: z.string(),
  learned_addendum: z.string(),
  allowed_tools: z.array(z.string()),
  model_tier: ModelTierSchema,
  status: z.enum(["active", "paused", "terminated"]),
  daily_token_budget: z.number().int(),
  tokens_used_today: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type Agent = z.infer<typeof AgentSchema>;

// ============================================================================
// FORUM POST
// ============================================================================
export const ForumPostSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  channel: z.string(),
  author_id: z.string().uuid(),
  parent_id: z.string().uuid().nullable(),
  body: z.string(),
  metadata: z.record(z.unknown()),
  created_at: z.string(),
});
export type ForumPost = z.infer<typeof ForumPostSchema>;

// ============================================================================
// CHANNELS (canonical list)
// ============================================================================
export const Channels = {
  ANNOUNCEMENTS: "announcements",
  GENERAL: "general",
  WATERCOOLER: "watercooler",
  STANDUP: "standup",
  CEO_BRIEF: "ceo-brief",
} as const;

export type Channel = (typeof Channels)[keyof typeof Channels];
