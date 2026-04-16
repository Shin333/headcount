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
  // Day 7: org structure additions
  always_on: z.boolean().default(false),
  in_standup: z.boolean().default(false),
  is_human: z.boolean().default(false),
  tic: z.string().nullable().default(null),
  // Day 22b: budget-exceeded failover. dm-responder routes CEO-bound DMs to
  // this agent when the primary is over daily_token_budget.
  fallback_agent_id: z.string().uuid().nullable().default(null),
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
  // Day 5.3: responder claims a DM by stamping this; cleared on completion.
  in_flight_since: z.string().nullable().default(null),
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
// TOOL REGISTRY (single source of truth for tool names)
// ============================================================================
// Both the orchestrator (tools/registry.ts) and the dashboard (health view's
// tool-access drift panel) import this. If you add a new tool, update this
// list AND register it in orchestrator's TOOL_REGISTRY.
// ============================================================================
export const KNOWN_TOOL_NAMES = [
  "web_search",
  "code_artifact_create",
  "markdown_artifact_create",
  "calendar_read",
  "image_generate",
  "dm_send",
  "roster_lookup",
  "project_create",
  "project_post",
  "commitment_create",
  "imagen_generate",
  "read_artifact",
  "project_complete",
  "code_execution",
  "browser_fetch_text",
  "browser_extract_links",
  "browser_screenshot",
] as const;
export type KnownToolName = (typeof KNOWN_TOOL_NAMES)[number];

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

// ============================================================================
// DEPARTMENTS (Day 7: org structure)
// ============================================================================
export const DepartmentSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  slug: z.string(),
  display_name: z.string(),
  description: z.string().nullable(),
  display_order: z.number().int(),
  head_agent_id: z.string().uuid().nullable(),
  created_at: z.string(),
});
export type Department = z.infer<typeof DepartmentSchema>;

// ============================================================================
// ARTIFACTS (Day 9b: agents produce real files)
// ============================================================================
// An artifact is a file an agent created that lives both on disk (under
// workspace/) and as a metadata row here. Artifacts can iterate via
// parent_artifact_id, building a version chain.
// ============================================================================
export const ArtifactContentTypeSchema = z.enum(["markdown", "plaintext", "code"]);
export type ArtifactContentType = z.infer<typeof ArtifactContentTypeSchema>;

export const ArtifactStatusSchema = z.enum(["draft", "accepted", "rejected", "superseded"]);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const ArtifactSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  agent_id: z.string().uuid(),

  title: z.string(),
  summary: z.string().nullable(),
  content_type: ArtifactContentTypeSchema,
  language: z.string().nullable(),

  file_path: z.string(),
  size_bytes: z.number().int(),

  parent_artifact_id: z.string().uuid().nullable(),
  version: z.number().int(),
  status: ArtifactStatusSchema,

  triggered_by_dm_id: z.string().uuid().nullable(),
  triggered_by_post_id: z.string().uuid().nullable(),

  created_at: z.string(),
  accepted_at: z.string().nullable(),
  accepted_by: z.string().nullable(),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

// ============================================================================
// AGENT CREDENTIALS (Day 9b: OAuth tokens for external API access)
// ============================================================================
// Tokens are PLAINTEXT in Day 9b. Encryption-at-rest is logged debt.
// ============================================================================
export const AgentCredentialSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  agent_id: z.string().uuid(),

  provider: z.string(),
  scope: z.string(),

  access_token: z.string(),
  refresh_token: z.string().nullable(),
  expires_at: z.string().nullable(),

  granted_by: z.string(),
  granted_at: z.string(),
  last_used_at: z.string().nullable(),
  use_count: z.number().int(),
});
export type AgentCredential = z.infer<typeof AgentCredentialSchema>;

// ============================================================================
// REAL ACTION AUDIT (Day 9b: log of real-world tool calls)
// ============================================================================
// Distinct from tool_use_audit. Every call against an external API (calendar,
// github, etc.) writes one row here regardless of success or failure.
// ============================================================================
export const RealActionAuditSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  agent_id: z.string().uuid(),

  tool_name: z.string(),
  arguments_json: z.record(z.string(), z.unknown()),
  result_summary: z.string().nullable(),
  result_full_json: z.record(z.string(), z.unknown()).nullable(),

  success: z.boolean(),
  error_message: z.string().nullable(),
  duration_ms: z.number().int().nullable(),

  triggered_by_dm_id: z.string().uuid().nullable(),

  created_at: z.string(),
});
export type RealActionAudit = z.infer<typeof RealActionAuditSchema>;

// ============================================================================
// PROJECT (Day 14: Eleanor's routing layer)
// ============================================================================
// A project anchors multi-deliverable work in the database. Eleanor's
// project_create tool inserts these. Coordination happens via existing dms
// rows referencing the project_id in their bodies - we explicitly do not
// have a project_messages table in v1.
// ============================================================================
export const ProjectStatusSchema = z.enum(["active", "completed", "cancelled"]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  title: z.string(),
  description: z.string(),
  status: ProjectStatusSchema,
  created_by: z.string().uuid().nullable(),
  created_at: z.string(),
});
export type Project = z.infer<typeof ProjectSchema>;

// ============================================================================
// PROJECT MEMBER (Day 15: persistent project membership)
// ============================================================================
// Connects agents to projects so the DM responder can inject project context
// into the system prompt. Without this, agents confabulate project context
// from thin air when a follow-up DM doesn't explicitly mention the project ID.
// See workspace/engineering/day15-runbook.md for the failure mode this fixes.
// ============================================================================
export const ProjectMemberSchema = z.object({
  project_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  added_at: z.string(),
  added_by: z.string().uuid().nullable(),
});
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;

// ============================================================================
// PROJECT MESSAGE (Day 17: shared project channels / "meeting rooms")
// ============================================================================
// A message posted to a project's shared channel. Everyone in the project
// sees every message — there's no recipient, it's a broadcast room.
// DMs continue to work alongside channels for private 1:1 conversations.
// ============================================================================
export const ProjectMessageTypeSchema = z.enum(["message", "artifact", "system"]);
export type ProjectMessageType = z.infer<typeof ProjectMessageTypeSchema>;

export const ProjectMessageSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  body: z.string(),
  message_type: ProjectMessageTypeSchema,
  // Day 19: CEO-pinned messages persist into every agent's context regardless of channel scroll position.
  is_pinned: z.boolean().default(false),
  created_at: z.string(),
});
export type ProjectMessage = z.infer<typeof ProjectMessageSchema>;

// ============================================================================
// COMMITMENT (Day 18: deliverable tracking with stall detection)
// ============================================================================
// A commitment is a promise an agent made to do something. The stall detector
// nudges when deadline_at passes; auto-resolution happens when an artifact's
// title overlaps the commitment description. status='pending' until either an
// artifact resolves it, the CEO closes it, or three nudges expire it to
// 'stalled'. resolved_artifact_id is intentionally NOT a hard FK (Day 18).
// ============================================================================
export const CommitmentStatusSchema = z.enum([
  "pending",
  "resolved",
  "stalled",
  "cancelled",
]);
export type CommitmentStatus = z.infer<typeof CommitmentStatusSchema>;

export const CommitmentResolutionTypeSchema = z.enum([
  "artifact",
  "manual",
  "nudge_produced",
]);
export type CommitmentResolutionType = z.infer<
  typeof CommitmentResolutionTypeSchema
>;

export const CommitmentSchema = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  project_id: z.string().uuid().nullable(),

  description: z.string(),
  committed_at: z.string(),
  // Nullable deadline = manual resolution only (no stall nudge).
  deadline_at: z.string().nullable(),

  status: CommitmentStatusSchema,
  resolution_type: CommitmentResolutionTypeSchema.nullable(),
  resolved_artifact_id: z.string().uuid().nullable(),
  resolved_at: z.string().nullable(),

  // Stall detector caps at 3 nudges before flipping to 'stalled'.
  nudge_count: z.number().int().default(0),
  last_nudge_at: z.string().nullable(),

  created_at: z.string(),
});
export type Commitment = z.infer<typeof CommitmentSchema>;
