-- 0025_drop_tool_result_cache.sql
--
-- Drop tool_result_cache. This table backed apps/orchestrator/src/tools/cache.ts,
-- which is scheduled for deletion in Phase 5 (legacy tools layer). The new
-- Claude Code dispatcher uses session state for tool results and does not
-- require cross-session caching. No FKs reference this table; safe to drop.

drop table if exists public.tool_result_cache;
