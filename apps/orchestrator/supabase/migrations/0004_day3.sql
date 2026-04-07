-- ============================================================================
-- HEADCOUNT - Day 3 Schema Migration
-- Adds: standup ritual tracking, CEO brief tracking
-- Safe to re-run.
-- ============================================================================

alter table ritual_state add column if not exists last_standup_date date;
alter table ritual_state add column if not exists last_ceo_brief_date date;

-- Performance indexes for the brief synthesis query
create index if not exists forum_posts_channel_date_idx
  on forum_posts(channel, created_at desc);

-- Note: dms is already in supabase_realtime publication from Day 2b migration.
-- forum_posts is already in supabase_realtime from Day 1.
-- No publication changes needed.
