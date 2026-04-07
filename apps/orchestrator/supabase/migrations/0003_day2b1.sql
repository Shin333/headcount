-- ============================================================================
-- HEADCOUNT - Day 2b.1 patch
-- Adds: reflection_triggers table for the dashboard "Force reflection" button.
-- Safe to re-run.
-- ============================================================================

create table if not exists reflection_triggers (
  id uuid primary key default uuid_generate_v4(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',
  agent_id uuid not null references agents(id) on delete cascade,
  requested_by text not null default 'ceo_dashboard',
  status text not null default 'pending', -- 'pending' | 'processed' | 'error'
  result text,
  error_message text,
  created_at timestamptz not null default now(),
  processed_at timestamptz
);

create index if not exists reflection_triggers_pending_idx
  on reflection_triggers(status, created_at)
  where status = 'pending';
