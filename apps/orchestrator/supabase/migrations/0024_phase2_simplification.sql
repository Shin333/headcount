-- ============================================================================
-- 0024_phase2_simplification.sql — Claude Code re-architecture (Phase 2)
-- See: docs/superpowers/specs/2026-05-04-onepark-digital-claude-code-rearchitecture-design.md §7
--
-- AMENDED 2026-05-05 after surveying live DB state. Differences from initial
-- draft:
--   - `projects` already existed (different schema) — alter in place, do not rename `tickets`
--   - `project_messages` already existed (1732 rows) — alter + backfill in place
--   - `project_members` (24 rows) renamed to `project_participants` to preserve data
--   - Additional dead tables dropped: commitments, reports, report_runs,
--     reflection_triggers, tickets
--   - Additional dead agents columns dropped: tool_access, always_on,
--     in_standup, mcp_access
--   - Preserved (not touched): real_action_audit, agent_credentials, departments,
--     tool_result_cache, agents.is_human, agents.tic, agents.fallback_agent_id
--   - social_drafts created here (0023 was never applied to dev DB)
--
-- Idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- DROP deprecated tables
-- ----------------------------------------------------------------------------
drop table if exists forum_posts cascade;
drop table if exists dms cascade;
drop table if exists memories cascade;
drop table if exists relationships cascade;
drop table if exists world_clock cascade;
drop table if exists standups cascade;
drop table if exists wall_token_spend cascade;
drop table if exists ritual_state cascade;
drop table if exists cost_alerts cascade;
drop table if exists prompt_evolution_log cascade;
drop table if exists commitments cascade;
drop table if exists reports cascade;
drop table if exists report_runs cascade;
drop table if exists reflection_triggers cascade;
drop table if exists tickets cascade;

-- ----------------------------------------------------------------------------
-- ALTER agents — drop deprecated columns
-- Keep: id, tenant_id, name, role, department, tier, manager_id, reports_to_ceo,
--       status, created_at, updated_at, is_human, tic, fallback_agent_id
-- ----------------------------------------------------------------------------
alter table agents drop column if exists daily_token_budget;
alter table agents drop column if exists tokens_used_today;
alter table agents drop column if exists chatter_posts_today;
alter table agents drop column if exists last_reset_company_date;
alter table agents drop column if exists last_reflection_at;
alter table agents drop column if exists addendum_loop_active;
alter table agents drop column if exists manager_overlay;
alter table agents drop column if exists learned_addendum;
alter table agents drop column if exists model_tier;
alter table agents drop column if exists frozen_core;
alter table agents drop column if exists personality;
alter table agents drop column if exists background;
alter table agents drop column if exists allowed_tools;
alter table agents drop column if exists tool_access;
alter table agents drop column if exists always_on;
alter table agents drop column if exists in_standup;
alter table agents drop column if exists mcp_access;

-- ----------------------------------------------------------------------------
-- ALTER projects in place — existing 2 rows preserved.
-- Spec wants entry_agent_id + prompt; keep existing title/description/status/created_by.
-- ----------------------------------------------------------------------------
alter table projects add column if not exists tenant_id uuid not null default '00000000-0000-0000-0000-000000000001';
alter table projects add column if not exists entry_agent_id uuid references agents(id) on delete set null;
alter table projects add column if not exists prompt text;

-- ----------------------------------------------------------------------------
-- RENAME agent_actions → agent_runs (drop API metering, add handoff fields)
-- ----------------------------------------------------------------------------
alter table if exists agent_actions rename to agent_runs;
alter table if exists agent_runs drop column if exists input_tokens;
alter table if exists agent_runs drop column if exists output_tokens;
alter table if exists agent_runs drop column if exists system_prompt;
alter table if exists agent_runs drop column if exists user_prompt;
alter table if exists agent_runs add column if not exists runtime text not null default 'claude_code' check (runtime in ('claude_code','codex','codex_fallback'));
alter table if exists agent_runs add column if not exists parent_run_id uuid references agent_runs(id) on delete set null;
alter table if exists agent_runs add column if not exists project_id uuid references projects(id) on delete cascade;

create index if not exists agent_runs_project_idx on agent_runs(project_id, created_at desc);
create index if not exists agent_runs_parent_idx on agent_runs(parent_run_id);

-- ----------------------------------------------------------------------------
-- ALTER project_messages in place — preserve 1732 rows.
-- Add new columns, backfill from legacy agent_id/message_type, drop legacy cols.
-- ----------------------------------------------------------------------------
-- 1. Add new columns (nullable initially for backfill)
alter table project_messages add column if not exists tenant_id uuid;
alter table project_messages add column if not exists sender_type text;
alter table project_messages add column if not exists sender_id uuid;
alter table project_messages add column if not exists kind text;
alter table project_messages add column if not exists run_id uuid references agent_runs(id) on delete set null;
alter table project_messages add column if not exists parent_message_id uuid references project_messages(id) on delete set null;

-- 2. Backfill
update project_messages set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
update project_messages set sender_type = 'agent' where sender_type is null;
update project_messages set sender_id = agent_id where sender_id is null and agent_id is not null;
update project_messages set kind = case message_type
  when 'message' then 'comment'
  when 'system' then 'comment'
  when 'artifact' then 'output'
  else 'comment'
end where kind is null;

-- 3. Lock down constraints
alter table project_messages alter column tenant_id set not null;
alter table project_messages alter column tenant_id set default '00000000-0000-0000-0000-000000000001';
alter table project_messages alter column sender_type set not null;
alter table project_messages alter column kind set not null;
alter table project_messages drop constraint if exists project_messages_sender_type_check;
alter table project_messages add constraint project_messages_sender_type_check check (sender_type in ('agent','user'));
alter table project_messages drop constraint if exists project_messages_kind_check;
alter table project_messages add constraint project_messages_kind_check check (kind in ('prompt','handoff','output','comment','final'));

-- 4. Drop legacy columns now that backfill is committed
alter table project_messages drop constraint if exists project_messages_agent_id_fkey;
alter table project_messages drop column if exists agent_id;
alter table project_messages drop column if exists message_type;
alter table project_messages drop column if exists is_pinned;

-- 5. Add sender_id FK
alter table project_messages drop constraint if exists project_messages_sender_id_fkey;
alter table project_messages add constraint project_messages_sender_id_fkey foreign key (sender_id) references agents(id) on delete set null;

create index if not exists project_messages_project_idx on project_messages(project_id, created_at);
create index if not exists project_messages_run_idx on project_messages(run_id);

-- ----------------------------------------------------------------------------
-- RENAME project_members → project_participants (preserve 24 rows)
-- ----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'project_members')
     and not exists (select 1 from pg_tables where schemaname = 'public' and tablename = 'project_participants')
  then
    alter table project_members rename to project_participants;
    alter table project_participants rename column added_at to joined_at;
    alter table project_participants drop column if exists added_by;
  end if;
end $$;

alter table if exists project_participants add column if not exists joined_via_run_id uuid references agent_runs(id) on delete set null;
create index if not exists project_participants_agent_idx on project_participants(agent_id);

-- ----------------------------------------------------------------------------
-- NEW: briefs (cron-generated morning + ceo briefs)
-- ----------------------------------------------------------------------------
create table if not exists briefs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  kind text not null check (kind in ('morning','ceo')),
  body text not null,
  dismissed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists briefs_kind_created_idx on briefs(kind, created_at desc);

-- ----------------------------------------------------------------------------
-- NEW: cron_runs (cron-job observability)
-- ----------------------------------------------------------------------------
create table if not exists cron_runs (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  cron_kind text not null check (cron_kind in ('morning_brief','ceo_brief','nightly_learning')),
  status text not null check (status in ('ok','fail','partial','running')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error text,
  agents_processed int not null default 0,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists cron_runs_kind_started_idx on cron_runs(cron_kind, started_at desc);

-- ----------------------------------------------------------------------------
-- NEW: rate_budget (soft-ban hygiene tracking)
-- ----------------------------------------------------------------------------
create table if not exists rate_budget (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  provider text not null check (provider in ('claude','codex')),
  window_start timestamptz not null,
  calls_used int not null default 0,
  calls_cap int not null default 500,
  unique (provider, window_start)
);
create index if not exists rate_budget_window_idx on rate_budget(provider, window_start desc);

-- ----------------------------------------------------------------------------
-- NEW: social_drafts (mirrors 0023; 0023 never applied to this DB)
-- ----------------------------------------------------------------------------
create table if not exists social_drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  agent_id uuid not null,
  project_id uuid,
  platform text not null check (platform in ('instagram', 'tiktok', 'youtube', 'facebook', 'pinterest', 'linkedin')),
  account_id text not null,
  post_type text not null check (post_type in ('slideshow', 'image', 'video')),
  caption text not null,
  hashtags text[] not null default '{}',
  image_urls text[] not null default '{}',
  audio_suggestion text,
  genviral_post_id text,
  genviral_post_mode text,
  status text not null default 'drafting' check (status in ('drafting','uploaded','published','error','cancelled')),
  error_message text,
  external_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  published_at timestamptz
);
create index if not exists social_drafts_status_idx on social_drafts (tenant_id, status, created_at desc);
create index if not exists social_drafts_project_idx on social_drafts (project_id, created_at desc) where project_id is not null;
create index if not exists social_drafts_genviral_post_idx on social_drafts (genviral_post_id) where genviral_post_id is not null;
alter table social_drafts enable row level security;
drop policy if exists "anon_authenticated_select_tenant" on social_drafts;
create policy "anon_authenticated_select_tenant" on social_drafts
  for select to anon, authenticated
  using (tenant_id = '00000000-0000-0000-0000-000000000001');

-- ----------------------------------------------------------------------------
-- REALTIME publications (idempotent — guard against duplicate_object on re-run)
-- ----------------------------------------------------------------------------
do $$ begin alter publication supabase_realtime add table briefs; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table cron_runs; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table project_messages; exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table project_participants; exception when duplicate_object then null; end $$;
