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
  // Day 2b additions
  addendum_loop_active: z.boolean().default(false),
  chatter_posts_today: z.number().int().default(0),
  last_reset_company_date: z.string().nullable().default(null),
  last_reflection_at: z.string().nullable().default(null),
  // Day 5: per-agent tool access whitelist
  tool_access: z.array(z.string()).default([]),
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
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});
export type ForumPost = z.infer<typeof ForumPostSchema>;

// ============================================================================
// DM (Day 2b)
// ============================================================================
export const DmSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  from_id: z.string().uuid(),
  to_id: z.string().uuid(),
  body: z.string(),
  read_at: z.string().nullable(),
  created_at: z.string(),
});
export type Dm = z.infer<typeof DmSchema>;

// ============================================================================
// PROMPT EVOLUTION (Day 2b: addendum proposals)
// ============================================================================
export const ProposalStatusSchema = z.enum(["pending", "approved", "rejected", "applied"]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;

export const PromptEvolutionEntrySchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  old_value: z.string().nullable(),
  new_value: z.string().nullable(),
  reason: z.string().nullable(),
  proposed_by: z.string(),
  status: ProposalStatusSchema,
  reviewed_by_ceo_at: z.string().nullable(),
  created_at: z.string(),
});
export type PromptEvolutionEntry = z.infer<typeof PromptEvolutionEntrySchema>;

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

// ============================================================================
// COST CONFIG (Day 2b: used for the wall-hour cap)
// ============================================================================
export const COST_PER_M_TOKENS = {
  sonnet: { input_fresh: 3.00, input_cached: 0.30, output: 15.00 },
  haiku: { input_fresh: 1.00, input_cached: 0.10, output: 5.00 },
  opus: { input_fresh: 5.00, input_cached: 0.50, output: 25.00 },
} as const;

// ============================================================================
// REPORTS (Day 6: scheduled work output)
// ============================================================================
export const ReportSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  ritual_name: z.string(),
  agent_id: z.string().uuid(),
  title: z.string(),
  body: z.string(),
  company_date: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(),
});
export type Report = z.infer<typeof ReportSchema>;

export const ReportRunSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  ritual_name: z.string(),
  last_run_at: z.string().nullable(),
  last_run_company_date: z.string().nullable(),
  next_run_at: z.string(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ReportRun = z.infer<typeof ReportRunSchema>;
