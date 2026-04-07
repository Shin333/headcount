import type { Tool, ToolDefinition } from "./types.js";
import { webSearchTool } from "./web-search.js";

// ----------------------------------------------------------------------------
// tools/registry.ts - the tool catalog (Day 5)
// ----------------------------------------------------------------------------
// All tools register here. Agents declare which tools they can use via
// agent.tool_access (a text[] column). The runner consults this registry
// to look up the actual Tool objects when an agent's call needs tools.
// ----------------------------------------------------------------------------

const TOOL_REGISTRY: Record<string, Tool> = {
  web_search: webSearchTool,
};

/**
 * Given an agent's tool_access list (e.g. ['web_search']), return the
 * corresponding Tool objects. Unknown tool names are silently dropped
 * with a warning - we don't want a renamed tool to crash the runner.
 */
export function getToolsForAgent(toolAccess: string[]): Tool[] {
  const tools: Tool[] = [];
  for (const name of toolAccess) {
    const tool = TOOL_REGISTRY[name];
    if (!tool) {
      console.warn(`[tools] agent has unknown tool '${name}' in tool_access - ignoring`);
      continue;
    }
    tools.push(tool);
  }
  return tools;
}

/**
 * Look up a single tool by name. Used by the runner to execute a tool the
 * model just requested.
 */
export function getToolByName(name: string): Tool | null {
  return TOOL_REGISTRY[name] ?? null;
}

/**
 * Convert a list of Tool objects to the JSON schema format Anthropic's API
 * expects in the `tools` parameter.
 */
export function toolsToApiFormat(tools: Tool[]): ToolDefinition[] {
  return tools.map((t) => t.definition);
}
