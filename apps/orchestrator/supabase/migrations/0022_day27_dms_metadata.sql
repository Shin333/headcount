-- ============================================================================
-- 0022_day27_dms_metadata.sql — backfill the missing dms.metadata column
-- ----------------------------------------------------------------------------
-- The dm-responder has been writing `metadata: { budget_backoff_until }` to
-- the dms row when it skips a budget-exceeded recipient (added Day 22 to
-- prevent log spam). The column was never added, so every UPDATE failed
-- silently and the next tick re-picked the same DM 5-6 seconds later — a
-- tight loop that drowned the logs and (after agent budgets reset) would
-- have burned tokens.
--
-- This adds the column. The responder's existing read/write code starts
-- working immediately without any code change.
-- ============================================================================

alter table dms
  add column if not exists metadata jsonb not null default '{}'::jsonb;
