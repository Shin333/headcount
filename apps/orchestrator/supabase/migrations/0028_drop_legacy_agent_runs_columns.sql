-- 0028_drop_legacy_agent_runs_columns.sql
--
-- Plan 5 Phase 4: drops vestigial columns inherited from the
-- agent_actions predecessor (renamed to agent_runs in 0024).
-- Plan 2 kept these intact intentionally to keep the
-- entry-point swap (Task 5.2) surgical. After Plan 5 Phases
-- 1–3 deleted the legacy code that referenced them, the
-- columns are unused and can drop.
--
-- The dispatcher's queue.ts INSERTs do not reference any of
-- these columns; they ride on column DEFAULTs (action_type
-- DEFAULT 'sdk_run' from 0026, metadata DEFAULT '{}') that
-- go away with the columns themselves.

ALTER TABLE agent_runs DROP COLUMN action_type;
ALTER TABLE agent_runs DROP COLUMN trigger;
ALTER TABLE agent_runs DROP COLUMN response;
ALTER TABLE agent_runs DROP COLUMN tool_calls;
ALTER TABLE agent_runs DROP COLUMN metadata;
