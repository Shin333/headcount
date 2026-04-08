-- ============================================================================
-- HEADCOUNT - Day 7 Schema Migration
-- Adds the org structure: always_on, in_standup, is_human, tic columns,
-- plus the departments table and reporting_chain view.
--
-- IMPORTANT: The existing agents table from Day 1 already has:
--   - tier (enum: exec/director/manager/associate/intern/bot) - the seniority field
--   - department (text, nullable) - currently mostly NULL
--   - manager_id (uuid, nullable) - currently mostly NULL
--   - reports_to_ceo (boolean) - currently true for everyone
--   - background (text, nullable) - the existing backstory field
--
-- So Day 7 is much smaller than originally planned. We're only adding:
--   - always_on, in_standup (the standup-cost-control flags)
--   - is_human (the Shin Park CEO root row marker)
--   - tic (per-agent character tic, used by the 4 new execs)
--
-- Plus a manager_id FK constraint if not present, indices for the new
-- query patterns, the departments table, and the reporting_chain view.
-- Safe to re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. New columns on agents (only the 4 that don't already exist)
-- ----------------------------------------------------------------------------

alter table agents add column if not exists always_on boolean not null default false;
alter table agents add column if not exists in_standup boolean not null default false;
alter table agents add column if not exists is_human boolean not null default false;
alter table agents add column if not exists tic text;

-- ----------------------------------------------------------------------------
-- 2. Self-referential FK constraint on manager_id (if not already present)
-- ----------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from information_schema.table_constraints
    where constraint_name = 'agents_manager_id_fkey'
      and table_name = 'agents'
  ) then
    alter table agents
      add constraint agents_manager_id_fkey
      foreign key (manager_id) references agents(id) on delete set null;
  end if;
end$$;

-- ----------------------------------------------------------------------------
-- 3. Indices for the new query patterns
-- ----------------------------------------------------------------------------

create index if not exists agents_department_active_idx
  on agents (tenant_id, department) where is_human = false;

create index if not exists agents_always_on_idx
  on agents (tenant_id, always_on) where is_human = false and always_on = true;

create index if not exists agents_in_standup_idx
  on agents (tenant_id, in_standup) where is_human = false and in_standup = true;

create index if not exists agents_manager_idx
  on agents (manager_id) where manager_id is not null;

-- ----------------------------------------------------------------------------
-- 4. departments table (dashboard sidebar grouping)
-- ----------------------------------------------------------------------------

create table if not exists departments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  slug text not null,
  display_name text not null,
  description text,
  display_order int not null default 0,
  head_agent_id uuid,
  created_at timestamptz not null default now()
);

create unique index if not exists departments_slug_unique
  on departments (tenant_id, slug);

-- ----------------------------------------------------------------------------
-- 5. reporting_chain view (recursive walk of manager_id)
-- ----------------------------------------------------------------------------
-- Returns one row per agent with their full chain of managers as arrays.
-- Used by the dashboard breadcrumb display and project intake.
-- 10-level depth limit prevents runaway on accidental cycles.
-- ----------------------------------------------------------------------------

create or replace view reporting_chain as
with recursive chain as (
  select
    a.id as agent_id,
    a.tenant_id,
    a.name,
    a.manager_id,
    1 as depth,
    array[a.id]::uuid[] as chain_ids,
    array[a.name]::text[] as chain_names
  from agents a
  where a.manager_id is null

  union all

  select
    child.id as agent_id,
    child.tenant_id,
    child.name,
    child.manager_id,
    parent.depth + 1 as depth,
    parent.chain_ids || child.id as chain_ids,
    parent.chain_names || child.name as chain_names
  from agents child
  inner join chain parent on child.manager_id = parent.agent_id
  where parent.depth < 10
)
select
  agent_id,
  tenant_id,
  name,
  depth,
  chain_ids,
  chain_names
from chain;
