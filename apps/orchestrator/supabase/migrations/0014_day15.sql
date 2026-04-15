-- ============================================================================
-- 0014_day15.sql - project_members table for project context injection
-- ----------------------------------------------------------------------------
-- Day 15 fixes the confabulation failure mode observed at the end of Day 14.
-- When Rina received a follow-up DM ("hey eleanor - just to be clear before i
-- jump in...") her DM responder had no way to know which project the message
-- referred to. Eleanor's original project kickoff DM was in a different thread
-- and not in context. Both agents pattern-matched on "personality intake
-- calls" and invented a cross-functional org study that didn't exist.
--
-- Root cause: agents had no persistent membership concept for projects. The
-- only project linkage was the project ID string in individual DM bodies, and
-- that string only appeared in the kickoff messages, not in follow-ups.
--
-- Day 15 fix: persist a (project_id, agent_id) membership row. When the DM
-- responder processes a message, it looks up all active projects the agent is
-- a member of and injects them as a context block in the system prompt. The
-- agent then has grounded context about what they're working on, regardless
-- of whether the current DM mentions the project ID explicitly.
--
-- Membership propagation: membership is added in two places:
--   1. project_create auto-adds the creator as a member
--   2. dm_send scans the message body for UUIDs matching active projects the
--      sender is a member of, and auto-adds the recipient as a member
--
-- The dm_send path means Eleanor's "kicking off project 1806c510..." message
-- to Rina automatically adds Rina to the project without any explicit tool
-- call. This matches Eleanor's observed discipline of including project IDs
-- in every kickoff DM.
--
-- v1 design notes:
--   - No role column (owner/contributor/etc). Just membership.
--   - No "left" / "removed_at" state. Projects are short-lived; clean up via
--     SQL if someone gets added by mistake.
--   - Composite PK (project_id, agent_id) makes re-adds no-ops.
--   - No RLS. Single-tenant.
-- ============================================================================

create table if not exists project_members (
  project_id uuid not null references projects(id) on delete cascade,
  agent_id   uuid not null references agents(id) on delete cascade,
  added_at   timestamptz not null default now(),

  -- Provenance: who added this member. NULL if added by a seed/backfill
  -- script rather than by a real agent action.
  added_by   uuid references agents(id),

  primary key (project_id, agent_id)
);

-- Lookup pattern: "what active projects is agent X on?" This is the hot path
-- hit on every DM responder turn, so we want it fast.
create index if not exists project_members_agent_idx
  on project_members (agent_id);

-- Reverse lookup: "who's on project X?" Used by the dashboard and by the
-- backfill script.
create index if not exists project_members_project_idx
  on project_members (project_id);
