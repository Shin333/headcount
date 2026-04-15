-- ============================================================================
-- 0018_day22b_failover.sql - per-agent fallback for budget-exceeded routing
-- ----------------------------------------------------------------------------
-- When an agent (most importantly Eleanor, the CoS routing CEO comms) hits
-- her daily token budget, the dm-responder previously had no recourse:
-- CEO-bound DMs would queue unread until tomorrow's daily-reset.
--
-- This adds a self-referential FK so any agent can name a backup. The
-- dm-responder consults it on `skipped: budget_exceeded` for CEO-bound DMs
-- and re-runs the turn against the fallback (who responds AS THEMSELVES,
-- explicitly noting they're stepping in).
--
-- Nullable: agents without a fallback are unchanged.
-- ON DELETE SET NULL: deleting the fallback doesn't cascade-kill the primary.
-- ============================================================================

alter table agents
  add column if not exists fallback_agent_id uuid
    references agents(id) on delete set null;

create index if not exists agents_fallback_idx on agents (fallback_agent_id)
  where fallback_agent_id is not null;
