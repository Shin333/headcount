-- ============================================================================
-- 0015_day17.sql - project_messages table ("meeting room" channels)
-- ----------------------------------------------------------------------------
-- Day 17 introduces shared project channels. Instead of all project
-- coordination flowing through 1:1 DMs (with Eleanor as the relay), agents
-- in a project post to a shared channel where everyone can see everything.
--
-- This fixes three problems:
--   1. Stalls: agents couldn't see when dependencies landed. Now artifact
--      creation auto-posts to the channel, triggering agents whose work
--      depends on it.
--   2. Context loss: agents only saw their own 1:1 thread. Now everyone
--      sees the same shared history.
--   3. Eleanor bottleneck: she was the only one who could relay information
--      between team members. Now agents talk directly in the channel.
--
-- The DM system continues to work alongside channels. DMs are for private
-- 1:1 conversations; channels are for shared project work.
--
-- No read_at column — channels are broadcast. Everyone sees everything.
-- No to_id column — there's no specific recipient, it's a room.
-- ============================================================================

create table if not exists project_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  agent_id   uuid not null references agents(id),
  body       text not null,

  -- Message type helps the UI and the project-responder differentiate
  -- between human-written messages, agent responses, and system events
  -- (like artifact creation notifications).
  --   'message'  = normal agent or CEO post
  --   'artifact' = auto-generated when an artifact is created by a member
  --   'system'   = system events (member joined, project status change, etc.)
  message_type text not null default 'message',

  created_at timestamptz not null default now()
);

-- Hot path: "get the last N messages for project X, newest first"
-- Used by the project-responder on every turn and by the channel history
-- injection in the DM responder.
create index if not exists project_messages_project_time_idx
  on project_messages (project_id, created_at desc);

-- Secondary: "what has agent Y posted across all projects?"
-- Used for debugging and cost tracking.
create index if not exists project_messages_agent_idx
  on project_messages (agent_id, created_at desc);

-- Enable realtime so the project-responder can subscribe to INSERT events
-- (same pattern as the DM realtime subscription from Day 16 Phase B).
alter publication supabase_realtime add table project_messages;
