// ============================================================================
// tools/project-post.ts - Day 17 - post to a project's shared channel
// ----------------------------------------------------------------------------
// Lets an agent post a message to a project channel ("meeting room") where
// all project members can see it. This is how agents share work, ask
// questions, post status updates, and coordinate directly without needing
// Eleanor to relay everything via 1:1 DMs.
//
// Use project_post for:
//   - Sharing work output or status updates that the whole team needs to see
//   - Asking a question that multiple team members might answer
//   - Flagging a blocker or dependency that affects the project
//   - Responding to someone else's channel message
//
// Use dm_send (not project_post) for:
//   - Private 1:1 conversations (e.g., asking Eleanor about a personnel issue)
//   - Messages that only one person needs to see
//
// Safety: only project members can post. Daily cap of 20 per agent per project.
// ============================================================================

import { db } from "../db.js";
import { config } from "../config.js";
import { postToChannel } from "../comms/channel.js";
import { isAgentInProject } from "../projects/members.js";
import { redactBody } from "../util/log-safe.js";
import type { Tool, ToolResult, ToolExecutionContext } from "./types.js";

const DAILY_POST_CAP_PER_PROJECT = 100;

async function countPostsToday(agentId: string, projectId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { count, error } = await db
    .from("project_messages")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("agent_id", agentId)
    .eq("message_type", "message") // only count agent-authored, not artifact/system
    .gte("created_at", startOfDay.toISOString());

  if (error) {
    console.warn(`[project-post] count error: ${error.message}`);
    return 0;
  }
  return count ?? 0;
}

async function writeAudit(args: {
  agentId: string;
  argsForAudit: Record<string, unknown>;
  resultSummary: string;
  resultFull: Record<string, unknown> | null;
  success: boolean;
  errorMessage: string | null;
  durationMs: number;
  triggeredByDmId: string | null;
}): Promise<void> {
  await db.from("real_action_audit").insert({
    tenant_id: config.tenantId,
    agent_id: args.agentId,
    tool_name: "project_post",
    arguments_json: args.argsForAudit,
    result_summary: args.resultSummary,
    result_full_json: args.resultFull,
    success: args.success,
    error_message: args.errorMessage,
    duration_ms: args.durationMs,
    triggered_by_dm_id: args.triggeredByDmId,
  });
}

export const projectPostTool: Tool = {
  real_action: true,
  definition: {
    name: "project_post",
    description:
      "Post a message to a project's shared channel where all team members can see it. Use this for work updates, questions, status reports, and coordination that the whole project team needs to see.\n\nEvery project has a shared channel — think of it as a meeting room. When you post here, everyone on the project team sees your message and can respond.\n\nUse project_post when:\n  - Sharing deliverables or work output\n  - Posting status updates on your workstream\n  - Asking questions the team needs to discuss\n  - Flagging blockers or dependency issues\n  - Responding to another team member's channel post\n\nUse dm_send (not this tool) for:\n  - Private 1:1 conversations\n  - Sensitive topics not for the whole team\n\nDaily cap: 100 posts per project.",
    input_schema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description:
            "The project ID (UUID) to post to. Must be an active project you're a member of. Check your 'Active projects' context block for available project IDs.",
        },
        body: {
          type: "string",
          description:
            "The message to post. Be clear and specific — everyone on the project team will read this. If referencing an artifact you created, mention the filename so others can find it.",
        },
      },
      required: ["project_id", "body"],
    },
  },
  executor: async (input, context): Promise<ToolResult> => {
    const start = Date.now();
    const toolName = "project_post";

    if (!context) {
      return {
        toolName,
        content: "Error: project_post requires execution context.",
        isError: true,
      };
    }

    const projectId = typeof input.project_id === "string" ? input.project_id.trim() : "";
    const body = typeof input.body === "string" ? input.body.trim() : "";

    if (!projectId) {
      return { toolName, content: "Error: project_id is required.", isError: true };
    }
    if (!body) {
      return { toolName, content: "Error: body is required and must be non-empty.", isError: true };
    }
    if (body.length > 5000) {
      return { toolName, content: "Error: body too long (max 5000 chars).", isError: true };
    }

    const argsForAudit = { project_id: projectId, body_preview: body.slice(0, 200) };

    // Verify the agent is a member of this project
    const isMember = await isAgentInProject(projectId, context.agentId);
    if (!isMember) {
      const durationMs = Date.now() - start;
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "not a project member",
        resultFull: null,
        success: false,
        errorMessage: "Agent is not a member of this project",
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content: `Error: you're not a member of project ${projectId}. Check your 'Active projects' context block for projects you're on.`,
        isError: true,
      };
    }

    // Daily cap
    const todayCount = await countPostsToday(context.agentId, projectId);
    if (todayCount >= DAILY_POST_CAP_PER_PROJECT) {
      const durationMs = Date.now() - start;
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "daily cap reached",
        resultFull: null,
        success: false,
        errorMessage: `Daily post cap of ${DAILY_POST_CAP_PER_PROJECT} reached`,
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content: `Error: you've posted ${todayCount} messages to this project channel today (cap is ${DAILY_POST_CAP_PER_PROJECT}). Use dm_send for private messages that don't need the whole team.`,
        isError: true,
      };
    }

    // Post to channel
    let messageId: string;
    try {
      const result = await postToChannel({
        projectId,
        agentId: context.agentId,
        body,
        messageType: "message",
      });
      messageId = result.id;
    } catch (err) {
      const durationMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "post failed",
        resultFull: null,
        success: false,
        errorMessage: errMsg,
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return { toolName, content: `Error posting to channel: ${errMsg}`, isError: true };
    }

    const durationMs = Date.now() - start;
    await writeAudit({
      agentId: context.agentId,
      argsForAudit,
      resultSummary: `Posted to project channel`,
      resultFull: { message_id: messageId, project_id: projectId, body_length: body.length },
      success: true,
      errorMessage: null,
      durationMs,
      triggeredByDmId: context.triggeredByDmId ?? null,
    });

    console.log(
      `[project-post] ${context.agentName} posted to project ${projectId.slice(0, 8)}: ${redactBody(body)}`
    );

    return {
      toolName,
      content: `Message posted to the project channel. All team members will see it on their next turn. If you need a specific person to see it urgently, follow up with a dm_send.`,
      isError: false,
      structuredPayload: {
        message_id: messageId,
        project_id: projectId,
      },
    };
  },
};
