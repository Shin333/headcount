-- ============================================================================
-- 0017_day19_pinned.sql - add pinned messages to project channels
-- ----------------------------------------------------------------------------
-- Critical project messages (roster, brief, decisions) should persist in
-- every agent's context regardless of how far back they are in the channel.
-- A pinned message is always injected into the agent's system prompt on
-- every turn, separate from the rolling channel history.
--
-- The CEO can pin/unpin from the dashboard or via SQL.
-- Agents cannot pin their own messages (CEO-only action).
-- ============================================================================

alter table project_messages 
  add column if not exists is_pinned boolean not null default false;

-- Fast lookup for pinned messages per project
create index if not exists project_messages_pinned_idx
  on project_messages (project_id, is_pinned)
  where is_pinned = true;
