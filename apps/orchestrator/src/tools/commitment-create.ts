// ============================================================================
// tools/commitment-create.ts - Day 18 - log a commitment
// ----------------------------------------------------------------------------
// When an agent promises a deliverable ("I'll have the bios done within the
// hour"), they call this tool to create a tracked commitment. The stall
// detector will nudge them if they don't deliver by the deadline.
//
// Agents should call this EVERY TIME they promise something with a timeline.
// If they don't call it, there's no tracking, and stalls go undetected.
// ============================================================================

import { createCommitment } from "../commitments/store.js";
import { postToChannel } from "../comms/channel.js";
import { getActiveProjectsForAgent } from "../projects/members.js";
import type { Tool, ToolResult, ToolExecutionContext } from "./types.js";

export const commitmentCreateTool: Tool = {
  definition: {
    name: "commitment_create",
    description:
      "MANDATORY: Log a commitment every time you say you will deliver something. If you say 'I'll generate the portraits' or 'posting the spec now' or 'will have this done shortly' — you MUST call commitment_create BEFORE you start the work. No exceptions.\n\nThe system tracks your commitment and will auto-nudge you if you don't deliver by the deadline. After 3 nudges, it escalates to the CEO.\n\nYou are an AI agent. Your work should take MINUTES, not hours. Default deadline is 10 minutes. Use 5 for simple tasks, 10 for medium tasks, 15 for complex multi-step tasks. Never set a deadline longer than 30 minutes unless the task genuinely requires multiple sequential tool calls.\n\nExamples:\n- 'Generating 18 portraits' → commitment_create(deadline_minutes=15)\n- 'Writing the card spec' → commitment_create(deadline_minutes=10)\n- 'Posting a status update' → commitment_create(deadline_minutes=5)\n\nIf you say you'll do something and DON'T call commitment_create, you are breaking protocol.",
    input_schema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description:
            "What you're committing to deliver. Be specific: 'Write 15 remaining /team page bios and post to channel' not 'finish the bios'.",
        },
        deadline_minutes: {
          type: "number",
          description:
            "Minutes until deadline. You are an AI — work takes minutes, not hours. Use 5 for simple tasks, 10 for medium, 15 for complex multi-step. Default is 10. NEVER exceed 30 unless the task requires many sequential tool calls.",
        },
        project_id: {
          type: "string",
          description:
            "The project ID this commitment is for (if applicable). Check your active projects context block.",
        },
      },
      required: ["description", "deadline_minutes"],
    },
  },
  executor: async (input, context): Promise<ToolResult> => {
    const toolName = "commitment_create";

    if (!context) {
      return {
        toolName,
        content: "Error: commitment_create requires execution context.",
        isError: true,
      };
    }

    const description = typeof input.description === "string" ? input.description.trim() : "";
    const deadlineMinutes = typeof input.deadline_minutes === "number" ? input.deadline_minutes : 10;
    const projectId = typeof input.project_id === "string" ? input.project_id.trim() : null;

    if (!description) {
      return { toolName, content: "Error: description is required.", isError: true };
    }
    if (deadlineMinutes < 1 || deadlineMinutes > 10080) {
      return { toolName, content: "Error: deadline_minutes must be between 1 and 10080 (1 week).", isError: true };
    }

    const deadlineAt = new Date(Date.now() + deadlineMinutes * 60 * 1000).toISOString();

    try {
      const result = await createCommitment({
        agentId: context.agentId,
        projectId: projectId || null,
        description,
        deadlineAt,
      });

      // Auto-post to project channel if this is a project commitment
      if (projectId) {
        try {
          await postToChannel({
            projectId,
            agentId: context.agentId,
            body: `📋 **Commitment logged:** ${description} — deadline: ${new Date(deadlineAt).toLocaleTimeString("en-SG", { timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit" })}`,
            messageType: "system",
          });
        } catch {
          // Don't fail the commitment if channel post fails
        }
      }

      console.log(
        `[commitment] ${context.agentName} committed: "${description}" (deadline: ${deadlineMinutes}min, id: ${result.id.slice(0, 8)})`
      );

      return {
        toolName,
        content: `Commitment logged. You committed to: "${description}" with a deadline of ${deadlineMinutes} minutes from now. The system will track this and remind you if the deadline passes without delivery. To fulfill this commitment, produce the deliverable using the appropriate tool (markdown_artifact_create, code_artifact_create, or project_post).`,
        isError: false,
        structuredPayload: {
          commitment_id: result.id,
          deadline_at: deadlineAt,
        },
      };
    } catch (err) {
      return {
        toolName,
        content: `Error creating commitment: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
};
