-- ============================================================================
-- 0024_phase2_simplification.sql — Claude Code re-architecture (Phase 2)
-- See: docs/superpowers/specs/2026-05-04-onepark-digital-claude-code-rearchitecture-design.md §7
--
-- Drops 10 deprecated tables, alters 3 surviving tables, creates 5 new tables.
-- Final: 10 tables (down from ~15).
-- Idempotent: safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- DROP deprecated tables (architecture no longer uses them)
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

-- ----------------------------------------------------------------------------
-- ALTER agents — drop deprecated columns, keep org-chart fields
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
-- Keep: id, tenant_id, name, role, department, tier, manager_id, reports_to_ceo, status, created_at, updated_at

-- ----------------------------------------------------------------------------
-- RENAME tickets → projects (drop unused fields)
-- ----------------------------------------------------------------------------
alter table if exists tickets rename to projects;
alter table if exists projects drop column if exists assignee_id;
alter table if exists projects drop column if exists creator_id;
alter table if exists projects drop column if exists parent_ticket_id;
alter table if exists projects drop column if exists priority;
alter table if exists projects drop column if exists department;
-- Add fields the new architecture needs
alter table if exists projects add column if not exists entry_agent_id uuid references agents(id) on delete set null;
alter table if exists projects add column if not exists prompt text;

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
-- NEW: project_messages (the project chat — single thread per project)
-- ----------------------------------------------------------------------------
create table if not exists project_messages (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  project_id uuid not null references projects(id) on delete cascade,
  sender_type text not null check (sender_type in ('agent','user')),
  sender_id uuid references agents(id) on delete set null,
  kind text not null check (kind in ('prompt','handoff','output','comment','final')),
  body text not null,
  run_id uuid references agent_runs(id) on delete set null,
  parent_message_id uuid references project_messages(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists project_messages_project_idx on project_messages(project_id, created_at);
create index if not exists project_messages_run_idx on project_messages(run_id);

-- ----------------------------------------------------------------------------
-- NEW: project_participants (who's in the project chat)
-- ----------------------------------------------------------------------------
create table if not exists project_participants (
  project_id uuid not null references projects(id) on delete cascade,
  agent_id uuid not null references agents(id) on delete cascade,
  joined_at timestamptz not null default now(),
  joined_via_run_id uuid references agent_runs(id) on delete set null,
  primary key (project_id, agent_id)
);
create index if not exists project_participants_agent_idx on project_participants(agent_id);

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
-- REALTIME publications (realtime channels for new tables)
-- ----------------------------------------------------------------------------
alter publication supabase_realtime add table briefs;
alter publication supabase_realtime add table cron_runs;
alter publication supabase_realtime add table project_messages;
alter publication supabase_realtime add table project_participants;
