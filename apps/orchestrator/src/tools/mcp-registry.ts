// ============================================================================
// tools/mcp-registry.ts - Day 24 - remote MCP server registry
// ----------------------------------------------------------------------------
// Maps MCP server names → config shape for Anthropic's MCP connector
// (https://docs.anthropic.com/en/docs/agents-and-tools/mcp-connector).
//
// Agents declare which MCP servers they can use via agents.mcp_access. The
// runner resolves each entry through this registry and passes the resulting
// configs as the `mcp_servers` parameter on anthropic.messages.create, along
// with the beta header "anthropic-beta: mcp-client-2025-11-20".
//
// Shape mirrors the Anthropic connector spec — type:"url", name, url,
// authorization_token OR custom headers, and optional tool_configuration.
// ============================================================================

export const MCP_BETA_HEADER = "mcp-client-2025-11-20";

export interface McpServerConfig {
  type: "url";
  url: string;
  name: string;
  // Either authorization_token (→ Authorization: Bearer <token>) or custom
  // headers. Most servers use one or the other. Alai requires the custom
  // `api-key` header specifically.
  authorization_token?: string;
  headers?: Record<string, string>;
  // Tool-level controls. Default: enabled=true, all tools allowed.
  tool_configuration?: {
    enabled?: boolean;
    allowed_tools?: string[];
  };
}

type McpServerFactory = () => McpServerConfig | null;

const MCP_REGISTRY: Record<string, McpServerFactory> = {
  alai: () => {
    const key = process.env.ALAI_API_KEY?.trim();
    if (!key) {
      console.warn(`[mcp-registry] alai requested but ALAI_API_KEY is unset — skipping attachment`);
      return null;
    }
    return {
      type: "url",
      url: "https://slides-api.getalai.com/mcp/",
      name: "alai-presentations",
      headers: { "api-key": key },
      tool_configuration: { enabled: true },
    };
  },
};

export function getRegisteredMcpServerNames(): string[] {
  return Object.keys(MCP_REGISTRY);
}

/**
 * Resolve an agent's `mcp_access` list into concrete server configs. Entries
 * that aren't registered, or whose factory returns null (missing env), are
 * silently dropped. Returns empty array when nothing applies.
 */
export function resolveMcpServers(mcpAccess: string[]): McpServerConfig[] {
  const out: McpServerConfig[] = [];
  for (const name of mcpAccess) {
    const factory = MCP_REGISTRY[name];
    if (!factory) {
      console.warn(`[mcp-registry] agent references unknown MCP server '${name}' — ignoring`);
      continue;
    }
    const cfg = factory();
    if (cfg) out.push(cfg);
  }
  return out;
}
