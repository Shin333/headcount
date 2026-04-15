// ============================================================================
// tools/read-artifact.ts - Day 22: Let agents read workspace files
// ----------------------------------------------------------------------------
// Agents can't currently open workspace files. Eleanor made Heng a perfect
// roster brief, he couldn't read it. This tool loads file content from the
// workspace directory into the agent's context.
//
// Security: only reads from workspace/ directory. Cannot read config files,
// environment variables, or anything outside the workspace.
// ============================================================================

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Tool, ToolResult, ToolExecutionContext } from "./types.js";
import { findRepoRoot } from "./workspace.js";

async function executeReadArtifact(
  input: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const filePath = input.file_path as string;

  if (!filePath) {
    return {
      toolName: "read_artifact",
      content: "Error: file_path is required.",
      isError: true,
    };
  }

  try {
    const repoRoot = findRepoRoot();
    const workspaceDir = join(repoRoot, "workspace");

    // Resolve the path — support both "workspace/..." and just the relative part
    let fullPath: string;
    if (filePath.startsWith("workspace/") || filePath.startsWith("workspace\\")) {
      fullPath = join(repoRoot, filePath);
    } else {
      fullPath = join(workspaceDir, filePath);
    }

    // Security: ensure the resolved path is inside workspace/
    const resolved = resolve(fullPath);
    const workspaceResolved = resolve(workspaceDir);
    if (!resolved.startsWith(workspaceResolved)) {
      return {
        toolName: "read_artifact",
        content: `Error: cannot read files outside the workspace directory. Requested path resolves to: ${resolved}`,
        isError: true,
      };
    }

    if (!existsSync(resolved)) {
      return {
        toolName: "read_artifact",
        content: `Error: file not found at ${filePath}. Check the file path and try again.`,
        isError: true,
      };
    }

    // Read the file — cap at 30KB to avoid blowing up context
    const content = readFileSync(resolved, "utf-8");
    const MAX_SIZE = 30_000;
    const truncated = content.length > MAX_SIZE;
    const output = truncated ? content.slice(0, MAX_SIZE) + "\n\n[... truncated at 30KB ...]" : content;

    console.log(
      `[read_artifact] ${context?.agentName ?? "unknown"} read ${filePath} (${content.length} bytes${truncated ? ", truncated" : ""})`
    );

    return {
      toolName: "read_artifact",
      content: `Contents of ${filePath} (${content.length} bytes):\n\n${output}`,
      isError: false,
    };
  } catch (err) {
    return {
      toolName: "read_artifact",
      content: `Error reading file: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

export const readArtifactTool: Tool = {
  definition: {
    name: "read_artifact",
    description:
      "Read the contents of a file from the workspace directory. Use this to read artifacts created by yourself or other agents — bios, specs, briefs, code, images lists, etc. The file_path should be the workspace-relative path, e.g. 'workspace/marketing/team-bios-complete.md' or just 'marketing/team-bios-complete.md'.",
    input_schema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Path to the file to read. Can be a full workspace path (workspace/marketing/file.md) or just the relative path (marketing/file.md).",
        },
      },
      required: ["file_path"],
    },
  },
  executor: executeReadArtifact,
};
