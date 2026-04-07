-- ============================================================================
-- HEADCOUNT - Day 5.3 Schema Migration
-- Adds:
--   1. tool_result_cache table - per-tenant tool result cache (1hr TTL default)
--   2. dms.in_flight_since column - timestamp the responder picked up a DM
--      to process it; nulls when complete. Used for the dashboard in-flight
--      indicator so the user can see "Hoshino Ayaka is searching..." while
--      a multi-round tool loop is running.
-- Safe to re-run.
-- ============================================================================

create table if not exists tool_result_cache (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  tool_name text not null,
  cache_key text not null,
  result_content text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create unique index if not exists tool_result_cache_lookup_idx
  on tool_result_cache (tenant_id, tool_name, cache_key);

create index if not exists tool_result_cache_expiry_idx
  on tool_result_cache (expires_at);

alter table dms
  add column if not exists in_flight_since timestamptz;
