-- ============================================================================
-- HEADCOUNT - Day 5 Schema Migration
-- Adds: tool_access column to agents (per-agent tool whitelist)
-- Safe to re-run.
-- ============================================================================

alter table agents
  add column if not exists tool_access text[] not null default '{}';

-- Index for "find all agents with tool X" queries (cheap, won't be common)
create index if not exists agents_tool_access_idx on agents using gin (tool_access);
