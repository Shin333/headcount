-- ============================================================================
-- 0020_day26_cost_alerts_dlq.sql - cost circuit breaker + DLQ bookkeeping
-- ----------------------------------------------------------------------------
-- Adds:
--   1. cost_alerts - singleton-per-day rows recording when the system
--      crossed 80% (warning) or 100% (circuit_open) of DAILY_COST_CAP_USD.
--      Agent turns are blocked while a row with level='circuit_open' exists
--      for today. The block clears at midnight UTC when the rolling 24h
--      spend naturally ages out.
--
--   2. commitments.dlq_action - records the operator's resolution for a
--      stalled commitment from the dashboard's Dead Letter Queue tab.
--      Values: 'killed' | 'requeued' | 'reassigned' | null.
--      Distinct from `status` (which is the lifecycle state) so we can see
--      WHAT the operator did vs. only that the commitment is closed.
--
--   3. commitments.dlq_resolved_at / dlq_resolved_by - audit trail for DLQ
--      actions. resolved_by is free text (usually 'ceo' for manual action).
-- ============================================================================

create table if not exists cost_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  day date not null,
  level text not null check (level in ('warning', 'circuit_open')),
  spend_at_trip numeric(10, 4) not null,
  cap_usd numeric(10, 4) not null,
  message text,
  created_at timestamptz not null default now(),
  unique (tenant_id, day, level)
);

create index if not exists cost_alerts_day_idx on cost_alerts (day desc);

alter table commitments
  add column if not exists dlq_action text check (dlq_action in ('killed', 'requeued', 'reassigned')),
  add column if not exists dlq_resolved_at timestamptz,
  add column if not exists dlq_resolved_by text;

create index if not exists commitments_dlq_candidates_idx
  on commitments (tenant_id, status, last_nudge_at)
  where status = 'stalled' and dlq_resolved_at is null;
