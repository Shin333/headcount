-- ============================================================================
-- HEADCOUNT - Day 5.1 Schema Migration
-- Adds: last_token_reset_company_date column to ritual_state
-- This tracks when we last reset all agents' tokens_used_today counters,
-- so the daily-reset ritual is idempotent across orchestrator restarts.
-- Safe to re-run.
-- ============================================================================

alter table ritual_state
  add column if not exists last_token_reset_company_date date;
