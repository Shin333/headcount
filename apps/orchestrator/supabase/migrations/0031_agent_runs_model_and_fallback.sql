-- 0031_agent_runs_model_and_fallback.sql
--
-- (Numbered 0031: 0029/0030 are owned by the security-privileges migrations.)
--
-- Fleet model-config fix (2026-07-14). Records which model actually ran and,
-- when a hard Claude rate-limit forced an Opus -> GPT-5.6 (Codex) failover,
-- why. The HUD/activity view reads these to show e.g. "ran on GPT-5.6 — Opus
-- rate-limited" so Shin always knows which surface served a run.
--
-- The runtime check constraint from 0024 already permits 'codex_fallback';
-- these columns add the effective-model string and a short failover reason.

ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS fallback_reason text;
