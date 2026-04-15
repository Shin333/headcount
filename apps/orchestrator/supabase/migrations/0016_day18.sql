-- ============================================================================
-- 0016_day18.sql - commitments table ("I'll have X done by Y")
-- ----------------------------------------------------------------------------
-- Day 18 adds a commitments layer to track when agents promise deliverables.
--
-- The problem: agents say "within the hour" or "I'll post the bios today"
-- but have no internal clock, no self-triggering mechanism, and no way to
-- detect that they've stalled. The meeting room (Day 17) made coordination
-- visible but didn't solve the "agents are reactive, not proactive" gap.
--
-- The fix:
--   1. When an agent commits to a deliverable, a row goes in this table
--   2. A stall-detection ritual runs periodically, finds overdue commitments,
--      and auto-triggers the agent with "produce it now"
--   3. When an artifact is created by a committed agent, the commitment is
--      auto-resolved
--
-- States: pending → resolved | stalled | cancelled
--   - pending: commitment is active, not yet overdue
--   - resolved: deliverable was produced (artifact match or manual resolution)
--   - stalled: deadline passed without resolution, nudge sent
--   - cancelled: CEO or agent explicitly cancelled
-- ============================================================================

create table if not exists commitments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default '00000000-0000-0000-0000-000000000001',

  -- Who committed
  agent_id uuid not null references agents(id),

  -- Which project (nullable — some commitments might be outside projects)
  project_id uuid references projects(id) on delete set null,

  -- What was promised
  description text not null,

  -- When it was promised (wall time)
  committed_at timestamptz not null default now(),

  -- Deadline (wall time). The stall detector compares now() against this.
  -- If null, no automatic stall detection (manual resolution only).
  deadline_at timestamptz,

  -- Current state
  status text not null default 'pending'
    check (status in ('pending', 'resolved', 'stalled', 'cancelled')),

  -- How it was resolved (null if still pending/stalled)
  --   'artifact' = auto-resolved when agent created a matching artifact
  --   'manual' = CEO or agent marked it done manually
  --   'nudge_produced' = stall nudge triggered and agent delivered
  resolution_type text,

  -- Reference to the artifact that resolved this (if applicable)
  resolved_artifact_id uuid,

  -- When the status last changed
  resolved_at timestamptz,

  -- How many times the stall detector has nudged this commitment.
  -- Caps at 3 to prevent infinite nudge loops.
  nudge_count integer not null default 0,

  -- Last time a nudge was sent
  last_nudge_at timestamptz,

  created_at timestamptz not null default now()
);

-- Hot path: find all pending commitments for stall detection
create index if not exists commitments_pending_idx
  on commitments (status, deadline_at)
  where status = 'pending';

-- Find commitments by agent (for context injection)
create index if not exists commitments_agent_idx
  on commitments (agent_id, status);

-- Find commitments by project (for channel display)
create index if not exists commitments_project_idx
  on commitments (project_id, status);
