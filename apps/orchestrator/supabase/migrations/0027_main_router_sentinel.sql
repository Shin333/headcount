-- 0027_main_router_sentinel.sql
-- Inserts the main-router sentinel agent. The dispatcher's run handler uses
-- this id as the root agent_runs.agent_id so that agent_runs hierarchies have
-- a stable root distinct from any persona-bearing dept head. See Plan 2
-- amendment 2026-05-09 (main-router pivot).
--
-- Sentinel UUID: 00000000-0000-0000-0000-000000a1a1a1 (valid hex; the
-- originally drafted '…ma1n' rendering used non-hex chars and would have
-- been rejected by Postgres' UUID parser).
--
-- Tier: 'bot' — the agents_tier_check constraint allows
-- {exec, director, manager, associate, intern, bot}. 'bot' matches the
-- uncle-tan automation-sentinel precedent.

INSERT INTO agents (
  id,
  tenant_id,
  name,
  role,
  department,
  tier,
  manager_id,
  reports_to_ceo,
  status,
  is_human,
  tic,
  fallback_agent_id
) VALUES (
  '00000000-0000-0000-0000-000000a1a1a1',
  '00000000-0000-0000-0000-000000000001',
  'Main Router',
  'router',
  NULL,
  'bot',
  NULL,
  false,
  'active',
  false,
  0,
  NULL
)
ON CONFLICT (id) DO NOTHING;
