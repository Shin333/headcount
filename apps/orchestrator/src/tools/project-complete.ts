// ============================================================================
// tools/project-complete.ts - Day 22 - Mark a project as complete
// ----------------------------------------------------------------------------
// When a project ships, the CEO (or Eleanor) can mark it complete.
// This:
//   1. Sets project status to 'completed'
//   2. Resolves all remaining pending commitments as 'manual'
//   3. Posts a celebration message to the project channel
//   4. Records completion timestamp
//
// The project channel stays readable but agents stop getting heartbeat
// nudges and dependency triggers for it.
// ============================================================================

import { db } from "../db.js";
import { config } from "../config.js";
import type { Tool, ToolResult, ToolExecutionContext } from "./types.js";

async function executeProjectComplete(
  input: Record<string, unknown>,
  context?: ToolExecutionContext
): Promise<ToolResult> {
  const projectId = input.project_id as string;

  if (!projectId) {
    return {
      toolName: "project_complete",
      content: "Error: project_id is required.",
      isError: true,
    };
  }

  // Verify the project exists and is active
  const { data: project, error: projectErr } = await db
    .from("projects")
    .select("id, title, status")
    .eq("id", projectId)
    .eq("tenant_id", config.tenantId)
    .maybeSingle();

  if (projectErr || !project) {
    return {
      toolName: "project_complete",
      content: `Error: project not found (${projectId}).`,
      isError: true,
    };
  }

  if (project.status === "completed") {
    return {
      toolName: "project_complete",
      content: `Project "${project.title}" is already marked complete.`,
      isError: false,
    };
  }

  // 1. Mark project as completed
  const { error: updateErr } = await db
    .from("projects")
    .update({
      status: "completed",
      updated_at: new Date().toISOString(),
    })
    .eq("id", projectId);

  if (updateErr) {
    return {
      toolName: "project_complete",
      content: `Error updating project status: ${updateErr.message}`,
      isError: true,
    };
  }

  // 2. Resolve all remaining pending commitments
  const { data: pendingCommitments } = await db
    .from("commitments")
    .select("id")
    .eq("project_id", projectId)
    .eq("status", "pending");

  let resolvedCount = 0;
  if (pendingCommitments && pendingCommitments.length > 0) {
    const { error: resolveErr } = await db
      .from("commitments")
      .update({
        status: "resolved",
        resolution_type: "manual",
        resolved_at: new Date().toISOString(),
      })
      .eq("project_id", projectId)
      .eq("status", "pending");

    if (!resolveErr) {
      resolvedCount = pendingCommitments.length;
    }
  }

  // 3. Post celebration message to the project channel
  try {
    const { postToChannel } = await import("../comms/channel.js");
    await postToChannel({
      projectId,
      agentId: context?.agentId ?? "00000000-0000-0000-0000-00000000ce00",
      body: `🎉 **Project "${project.title}" is complete!** All work is shipped. ${resolvedCount > 0 ? `${resolvedCount} remaining commitment(s) auto-resolved.` : ""} Great work, team.`,
      messageType: "system",
    });
  } catch {
    // Non-critical
  }

  // 4. Count final stats
  const { count: artifactCount } = await db
    .from("artifacts")
    .select("*", { count: "exact", head: true })
    .eq("tenant_id", config.tenantId);
  // Note: can't filter by project_id since artifacts table doesn't have it

  const { count: memberCount } = await db
    .from("project_members")
    .select("*", { count: "exact", head: true })
    .eq("project_id", projectId);

  const { count: messageCount } = await db
    .from("project_messages")
    .select("*", { count: "exact", head: true })
    .eq("project_id", projectId);

  console.log(
    `[project-complete] "${project.title}" marked complete. ${resolvedCount} commitments resolved, ${memberCount} members, ${messageCount} messages.`
  );

  return {
    toolName: "project_complete",
    content: `Project "${project.title}" is now complete! ${resolvedCount} pending commitment(s) resolved. ${memberCount ?? 0} team members, ${messageCount ?? 0} channel messages. The project channel remains readable but no new heartbeat nudges will fire.`,
    isError: false,
  };
}

export const projectCompleteTool: Tool = {
  definition: {
    name: "project_complete",
    description:
      "Mark a project as complete. This resolves all remaining pending commitments, posts a celebration message to the project channel, and stops heartbeat nudges. Use this when a project has shipped and all deliverables are done. Only the CEO or Chief of Staff should use this.",
    input_schema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "The UUID of the project to mark complete.",
        },
      },
      required: ["project_id"],
    },
  },
  executor: executeProjectComplete,
};
