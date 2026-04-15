import type { Tool, ToolDefinition } from "./types.js";
import { webSearchTool } from "./web-search.js";
import { codeArtifactCreateTool, markdownArtifactCreateTool } from "./artifacts.js";
import { calendarReadTool } from "./calendar-read.js";
import { nanobananaImageGenerateTool } from "./nanobanana.js";
import { dmSendTool } from "./dm-send.js";
import { rosterLookupTool } from "./roster-lookup.js";
import { projectCreateTool } from "./project-create.js";
import { projectPostTool } from "./project-post.js";
import { commitmentCreateTool } from "./commitment-create.js";
import { imagenGenerateTool } from "./imagen.js";
import { readArtifactTool } from "./read-artifact.js";
import { projectCompleteTool } from "./project-complete.js";

// ----------------------------------------------------------------------------
// tools/registry.ts - the tool catalog
// ----------------------------------------------------------------------------
// All tools register here. Agents declare which tools they can use via
// agent.tool_access (a text[] column). The runner consults this registry
// to look up the actual Tool objects when an agent's call needs tools.
//
// Day 5: web_search
// Day 9b: code_artifact_create, markdown_artifact_create, calendar_read
// Day 13: image_generate (nanobanana / Gemini)
// Day 14: dm_send, roster_lookup, project_create (delegation + Eleanor routing)
// Day 22: read_artifact (agents can read workspace files)
// ----------------------------------------------------------------------------

const TOOL_REGISTRY: Record<string, Tool> = {
  web_search: webSearchTool,
  code_artifact_create: codeArtifactCreateTool,
  markdown_artifact_create: markdownArtifactCreateTool,
  calendar_read: calendarReadTool,
  image_generate: nanobananaImageGenerateTool,
  dm_send: dmSendTool,
  roster_lookup: rosterLookupTool,
  project_create: projectCreateTool,
  project_post: projectPostTool,
  commitment_create: commitmentCreateTool,
  imagen_generate: imagenGenerateTool,
  read_artifact: readArtifactTool,
  project_complete: projectCompleteTool,
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

// ----------------------------------------------------------------------------
// Day 9b: helpers for the runner to inspect tool flags
// ----------------------------------------------------------------------------

/**
 * Returns true if any tool in the given set has extended_thinking enabled.
 * The runner uses this to decide whether to enable adaptive thinking on
 * the API call. Per Anthropic docs, the entire assistant turn must operate
 * in a single thinking mode, so we check at the turn level (all tools)
 * not per individual tool call.
 */
export function anyToolHasExtendedThinking(tools: Tool[]): boolean {
  return tools.some((t) => t.extended_thinking === true);
}

/**
 * Returns the maximum max_output_tokens override across all tools in the
 * set. If no tool sets max_output_tokens, returns undefined. The runner
 * uses this to override its default max_tokens when a tool needs more
 * room for its output (e.g., code_artifact_create wants 16k).
 */
export function maxOutputTokensOverride(tools: Tool[]): number | undefined {
  let max: number | undefined;
  for (const t of tools) {
    if (typeof t.max_output_tokens === "number") {
      if (max === undefined || t.max_output_tokens > max) {
        max = t.max_output_tokens;
      }
    }
  }
  return max;
}

/**
 * Returns the canonical list of registered tool names. Used by startup
 * validation to detect typos / drift in agents.tool_access. Should match
 * KNOWN_TOOL_NAMES in @headcount/shared at all times - if it doesn't, the
 * dashboard's tool-drift health panel will surface the mismatch.
 */
export function getRegisteredToolNames(): string[] {
  return Object.keys(TOOL_REGISTRY);
}
