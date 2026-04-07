// ----------------------------------------------------------------------------
// tools/types.ts - core types for the tool use system (Day 5)
// ----------------------------------------------------------------------------
// A "tool" has two parts:
//   1. A definition (JSON schema) that we send to the model so it knows
//      the tool exists, what it does, and what arguments to pass.
//   2. An executor (TypeScript function) that we run when the model
//      requests the tool, and whose output we send back as a tool_result.
//
// The model decides WHEN to call. We decide WHAT exists.
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
}

/**
 * An executor takes the parsed input from the model and produces a ToolResult.
 * Executors should NEVER throw - they should return ToolResult with isError=true
 * and a useful error message in content. The runner relies on this contract.
 */
export type ToolExecutor = (input: Record<string, unknown>) => Promise<ToolResult>;

/**
 * A complete tool: definition + executor, paired together.
 */
export interface Tool {
  definition: ToolDefinition;
  executor: ToolExecutor;
}
