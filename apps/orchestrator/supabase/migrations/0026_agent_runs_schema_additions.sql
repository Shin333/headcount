-- 0026_agent_runs_schema_additions.sql
-- Adds started_at, completed_at, status columns to agent_runs.
-- Sets action_type default to 'sdk_run' so dispatcher inserts don't need to specify it.
-- Legacy columns (action_type, trigger, response, tool_calls, metadata) left intact;
-- cleanup migration after Phase 5 entry-point swap removes the dormant ritual code
-- that still references them.

ALTER TABLE agent_runs ADD COLUMN started_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE agent_runs ADD COLUMN completed_at timestamptz;
ALTER TABLE agent_runs ADD COLUMN status text NOT NULL DEFAULT 'running'
  CHECK (status IN ('running','completed','failed','cancelled'));
ALTER TABLE agent_runs ALTER COLUMN action_type SET DEFAULT 'sdk_run';
