-- ============================================================================
-- 0019_day24_mcp_access.sql — per-agent MCP server whitelist
-- ----------------------------------------------------------------------------
-- Parallel to agents.tool_access. Lists the MCP server names a given agent
-- has access to (e.g. 'alai'). The runner looks these up in the MCP registry
-- (orchestrator tools/mcp-registry.ts) and passes the resolved server configs
-- as the mcp_servers parameter on anthropic.messages.create.
--
-- Distinct from tool_access because MCP servers are configuration, not tools:
-- the model calls whatever tools the server exposes at runtime, and each
-- server can expose many tools. Keeping these concepts separate avoids
-- confusing an agent-level tool whitelist with an orchestration-level
-- server attachment.
-- ============================================================================

alter table agents
  add column if not exists mcp_access text[] not null default '{}';

create index if not exists agents_mcp_access_idx on agents using gin (mcp_access);
