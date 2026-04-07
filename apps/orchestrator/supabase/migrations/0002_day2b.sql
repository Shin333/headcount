-- ============================================================================
-- HEADCOUNT - Day 2b Schema Migration
-- Adds: ritual state persistence, wall-clock token spend tracking,
-- per-channel rate limiting, addendum loop opt-in flag.
-- Safe to re-run.
-- ============================================================================

-- Per-agent flag: is the learned addendum loop active for this agent?
alter table agents add column if not exists addendum_loop_active boolean not null default false;

-- Per-agent counter: chatter posts made today (resets at company midnight)
alter table agents add column if not exists chatter_posts_today int not null default 0;
alter table agents add column if not exists last_reset_company_date date;
alter table agents add column if not exists last_reflection_at timestamptz;

-- Persistent ritual state (so restarts don't replay rituals)
create table if not exists ritual_state (
  id int primary key default 1,
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  last_morning_greeting_date date,
  last_chatter_company_hour int,
  last_chatter_company_date date,
  last_token_budget_window timestamptz,
  updated_at timestamptz not null default now(),
  constraint ritual_state_single_row check (id = 1)
);

insert into ritual_state (id) values (1) on conflict (id) do nothing;

-- Wall-clock token spend tracking (for the hard cap)
-- One row per wall-clock hour. Orchestrator increments before/after each call.
create table if not exists wall_token_spend (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  wall_hour timestamptz not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cached_input_tokens bigint not null default 0,
  estimated_cost_usd numeric(10,4) not null default 0,
  call_count int not null default 0,
  created_at timestamptz not null default now(),
  unique(tenant_id, wall_hour)
);

create index if not exists wall_token_spend_hour_idx on wall_token_spend(wall_hour desc);

-- Realtime: stream addendum proposals to the dashboard so the CEO sees them
alter publication supabase_realtime add table prompt_evolution_log;
alter publication supabase_realtime add table dms;
