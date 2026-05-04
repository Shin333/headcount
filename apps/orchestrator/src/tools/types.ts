// ----------------------------------------------------------------------------
// tools/types.ts - core types for the tool use system
// ----------------------------------------------------------------------------
// A "tool" has two parts:
//   1. A definition (JSON schema) that we send to the model so it knows
//      the tool exists, what it does, and what arguments to pass.
//   2. An executor (TypeScript function) that we run when the model
//      requests the tool, and whose output we send back as a tool_result.
//
// The model decides WHEN to call. We decide WHAT exists.
//
// Day 9b additions:
//   - extended_thinking flag on Tool: when true, the runner enables adaptive
//     thinking with effort: "high" for any turn that has access to this tool.
//   - max_output_tokens override on Tool: when set, the runner uses this
//     instead of the default max_tokens for any turn that has this tool.
//   - real_action flag on Tool: when true, the executor is expected to write
//     a row to real_action_audit. The runner does not enforce this; it's a
//     marker for the catalog and for future telemetry.
// ----------------------------------------------------------------------------

/**
 * The shape Anthropic's API expects for tool definitions.
 * This is sent in the `tools` parameter of messages.create.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * What an executor returns when it has finished running a tool.
 * This is fed back to the model in the next round-trip as a tool_result block.
 */
export interface ToolResult {
  /** The tool name (matches the definition). */
  toolName: string;
  /** The text content the model will see as the tool's output. */
  content: string;
  /** True if the tool encountered an error. The model will see this flagged. */
  isError: boolean;
  /** Day 5.3: true if the result came from the cache (no live tool call was made). */
  cacheHit?: boolean;
  /**
   * Day 9b: optional structured payload for the runner to surface separately
   * from `content`. Currently used by artifact tools to expose the
   * artifact_id and file_path so the runner can attach them to the agent's
   * outgoing DM/post for dashboard rendering.
   */
  structuredPayload?: Record<string, unknown>;
  /**
   * Day 28: when a tool (view_image, browser_screenshot with inline mode)
   * produces images the agent should "see", it returns them here. The runner
   * unpacks these into the `content` field of the tool_result block as
   * Anthropic-compatible image content, so the agent can use vision on the
   * next round. Must be well-formed base64 ImageBlocks (see agents/vision.ts).
   */
  imageBlocks?: Array<{
    type: "image";
    source: {
      type: "base64";
      media_type: "image/png" | "image/jpeg" | "image/webp";
      data: string;
    };
  }>;
}

/**
 * Context passed into an executor at runtime. Lets the executor know who is
 * calling it (so it can attribute artifacts and audit rows to the right
 * agent), and what triggered the call (so artifacts can record provenance).
 */
export interface ToolExecutionContext {
  agentId: string;
  agentName: string;
  agentDepartment: string | null;
  triggeredByDmId?: string | null;
  triggeredByPostId?: string | null;
}

/**
 * An executor takes the parsed input from the model and produces a ToolResult.
 * Executors should NEVER throw - they should return ToolResult with isError=true
 * and a useful error message in content. The runner relies on this contract.
 *
 * Day 9b: executors now optionally accept a context arg. Existing executors
 * (web_search) ignore it. New artifact/calendar tools require it.
 */
export type ToolExecutor = (
  input: Record<string, unknown>,
  context?: ToolExecutionContext
) => Promise<ToolResult>;

/**
 * A complete tool: definition + executor + flags, paired together.
 *
 * Day 9b flags:
 *   extended_thinking - enable adaptive thinking + effort:high on the API
 *                       call when this tool is in scope. Stays on for the
 *                       entire tool loop.
 *   max_output_tokens - override the default output token cap for any turn
 *                       that has this tool in scope. Used by code_artifact_create
 *                       to allow up to 16k tokens of generated code.
 *   real_action       - marker for real-world API calls (calendar, github,
 *                       etc.). Currently informational; the executor itself
 *                       handles writing to real_action_audit.
 *
 * Day 23a flags (server-side tools):
 *   server_side       - when true, Anthropic's API runs the tool and inlines
 *                       the result into the assistant response. Our runner
 *                       does NOT dispatch an executor. Used for code_execution.
 *   serverApiShape    - the raw shape Anthropic expects for server-side tools
 *                       (e.g. { type: "code_execution_20250522", name: "code_execution" }),
 *                       which differs from regular ToolDefinition. When present,
 *                       toolsToApiFormat emits this verbatim.
 *   beta_header       - HTTP beta header required to enable this server-side
 *                       tool (e.g. "code-execution-2025-05-22"). The runner
 *                       collects all beta_header values across the tool set
 *                       and joins them comma-separated in the request.
 */
export interface Tool {
  definition: ToolDefinition;
  executor?: ToolExecutor;
  extended_thinking?: boolean;
  max_output_tokens?: number;
  real_action?: boolean;
  server_side?: boolean;
  serverApiShape?: Record<string, unknown>;
  beta_header?: string;
}
