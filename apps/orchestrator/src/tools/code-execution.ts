// ============================================================================
// tools/code-execution.ts - Day 23a - Anthropic server-side Python sandbox
// ----------------------------------------------------------------------------
// Lets agents write and execute Python code via Anthropic's hosted sandbox.
// Pre-installed: pandas, numpy, requests, matplotlib, scipy, scikit-learn,
// sympy. Each turn gets a fresh container; no state persists across turns.
//
// This is a SERVER-SIDE tool: Anthropic's API runs the code and inlines the
// result into the assistant response. Our runner skips its executor and
// captures the script + output into agent_actions.metadata.code_execution
// for the dashboard health view.
//
// Beta header required: anthropic-beta: code-execution-2025-05-22
// Billed at $0.05/hr container time, prorated per minute.
// ============================================================================

import type { Tool, ToolDefinition } from "./types.js";

// Definition presence is required by the Tool interface, but for server-side
// tools the runner uses serverApiShape instead. Keep this as informational
// metadata for catalog displays / Health view tool drift checks.
const definition: ToolDefinition = {
  name: "code_execution",
  description:
    "Run Python code in a sandboxed environment to compute results, parse data, or verify your reasoning. Use this when you need actual numbers (financial models, data analysis), need to validate code you wrote, or need to manipulate structured data (JSON, CSV). Pre-installed: pandas, numpy, requests, matplotlib, scipy, scikit-learn, sympy.",
  input_schema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description: "Python code to execute. Print results - return values are not captured.",
      },
    },
    required: ["code"],
  },
};

export const codeExecutionTool: Tool = {
  definition,
  // No executor: Anthropic runs this server-side.
  server_side: true,
  serverApiShape: {
    type: "code_execution_20250522",
    name: "code_execution",
  },
  beta_header: "code-execution-2025-05-22",
  real_action: true,
};
