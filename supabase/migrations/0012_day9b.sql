-- ============================================================================
-- 0012_day9b.sql - Artifact layer + Wei-Ming on Opus + credentials/audit
-- ----------------------------------------------------------------------------
-- Day 9b ships three new tables and one row update:
--
--   1. artifacts                  - the artifact layer (files agents produce)
--   2. agent_credentials          - OAuth tokens for external API access
--   3. real_action_audit          - audit log of every real-world tool call
--
-- Plus a one-row update: Wei-Ming Tsai's model_tier flips from sonnet to opus
-- so all his interactions get the better model. Adaptive thinking is enabled
-- per-tool in the runner, not per-agent.
--
-- The seed script (day9b-grant-tools.ts) handles the tool_access updates for
-- Evie (calendar_read) and Wei-Ming/So-yeon (code_artifact_create + markdown).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. artifacts table
-- ----------------------------------------------------------------------------
create table if not exists artifacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  agent_id uuid not null references agents(id),

  -- Content metadata
  title text not null,
  summary text,
  content_type text not null,           -- 'markdown' | 'plaintext' | 'code'
  language text,                         -- for code: 'typescript', 'python', etc.

  -- File location (relative to repo root)
  file_path text not null,
  size_bytes int not null,

  -- Versioning
  parent_artifact_id uuid references artifacts(id),
  version int not null default 1,
  status text not null default 'draft', -- 'draft'|'accepted'|'rejected'|'superseded'

  -- Provenance
  triggered_by_dm_id uuid references dms(id),
  triggered_by_post_id uuid references forum_posts(id),

  -- Lifecycle
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  accepted_by text,                      -- 'shin' or another agent name

  -- The natural key: only one artifact per file_path per tenant. Re-creating
  -- the same file overwrites cleanly via upsert.
  unique (tenant_id, file_path)
);

create index if not exists artifacts_tenant_agent_idx on artifacts (tenant_id, agent_id);
create index if not exists artifacts_tenant_status_idx on artifacts (tenant_id, status);
create index if not exists artifacts_tenant_created_idx on artifacts (tenant_id, created_at desc);
create index if not exists artifacts_parent_idx on artifacts (parent_artifact_id);

-- ----------------------------------------------------------------------------
-- 2. agent_credentials table
-- ----------------------------------------------------------------------------
-- Stores OAuth tokens for agents that have been granted access to external
-- APIs. Tokens are PLAINTEXT in Day 9b - encryption-at-rest is logged debt
-- to be addressed before any other human gets database access.
-- ----------------------------------------------------------------------------
create table if not exists agent_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  agent_id uuid not null references agents(id) on delete cascade,

  provider text not null,                -- 'google'
  scope text not null,                   -- 'calendar.readonly'

  access_token text not null,            -- TODO: encrypt at rest
  refresh_token text,
  expires_at timestamptz,

  granted_by text not null,              -- 'shin'
  granted_at timestamptz not null default now(),
  last_used_at timestamptz,
  use_count int not null default 0,

  -- One credential per (agent, provider, scope) tuple
  unique (tenant_id, agent_id, provider, scope)
);

create index if not exists agent_credentials_tenant_agent_idx
  on agent_credentials (tenant_id, agent_id);

-- ----------------------------------------------------------------------------
-- 3. real_action_audit table
-- ----------------------------------------------------------------------------
-- Every real-world tool call writes here. Distinct from tool_use_audit
-- (which captures all tool calls, mostly web_search) because real actions
-- have higher stakes and we want to be able to query them in isolation.
-- ----------------------------------------------------------------------------
create table if not exists real_action_audit (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  agent_id uuid not null references agents(id),

  tool_name text not null,               -- 'calendar_read', etc.
  arguments_json jsonb not null,
  result_summary text,                   -- one-line description
  result_full_json jsonb,                -- the actual API response, for debugging

  success boolean not null,
  error_message text,
  duration_ms int,

  triggered_by_dm_id uuid references dms(id),

  created_at timestamptz not null default now()
);

create index if not exists real_action_audit_tenant_agent_idx
  on real_action_audit (tenant_id, agent_id);
create index if not exists real_action_audit_tenant_created_idx
  on real_action_audit (tenant_id, created_at desc);
create index if not exists real_action_audit_tool_idx
  on real_action_audit (tenant_id, tool_name);

-- ----------------------------------------------------------------------------
-- 4. Wei-Ming Tsai → opus tier
-- ----------------------------------------------------------------------------
-- All Wei-Ming's API calls now use Opus 4.6. Adaptive thinking is enabled
-- per-tool in the runner (only on code_artifact_create), not here.
-- ----------------------------------------------------------------------------
update agents
set model_tier = 'opus'
where name = 'Tsai Wei-Ming';

-- Refresh PostgREST schema cache so the new tables show up immediately
notify pgrst, 'reload schema';
