-- ============================================================================
-- HEADCOUNT - Day 6 Schema Migration
-- Adds:
--   1. reports - versioned report storage. Each row is one report instance,
--      written by one agent on one company date for one ritual.
--   2. report_runs - cadence ledger. One row per ritual_name (singleton),
--      tracks last_run_at and next_run_at for the report-runner scheduler.
-- Safe to re-run.
-- ============================================================================

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  ritual_name text not null,
  agent_id uuid not null,
  title text not null,
  body text not null,
  company_date date not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists reports_ritual_idx
  on reports (tenant_id, ritual_name, created_at desc);

create index if not exists reports_agent_idx
  on reports (tenant_id, agent_id, created_at desc);

create table if not exists report_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  ritual_name text not null,
  last_run_at timestamptz,
  last_run_company_date date,
  next_run_at timestamptz not null,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists report_runs_ritual_unique
  on report_runs (tenant_id, ritual_name);
