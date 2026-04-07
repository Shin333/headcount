-- ============================================================================
-- HEADCOUNT - Day 4 Schema Migration
-- Adds: index for fast unread DM lookups
-- The dms table itself already exists from Day 1's 0001_init.sql with:
--   read_at timestamptz (nullable - null means unread)
-- We just need an index optimized for "give me unread DMs to agent X".
-- Safe to re-run.
-- ============================================================================

create index if not exists dms_unread_idx
  on dms(to_id, created_at desc)
  where read_at is null;
