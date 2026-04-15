// ============================================================================
// tools/project-create.ts - Day 14 - Eleanor's project intake tool
// ----------------------------------------------------------------------------
// Inserts a row in the projects table when Eleanor (or any agent granted
// this tool, but in practice only Eleanor) decides a CEO request warrants
// a multi-deliverable project rather than a one-shot answer.
//
// The "project" is intentionally minimal in v1: just a row that anchors
// the work in the database so it has an ID, a title, and a description.
// There's no project_members table, no project_messages table, no UI view
// yet. Coordination happens via dm_send referencing the project ID in
// each message body.
//
// Per-day cap: 5 projects per agent. This catches over-creation - Eleanor
// shouldn't be creating a project for every CEO message; only multi-
// deliverable, multi-specialty, or multi-day requests.
//
// Note: this tool intentionally doesn't enforce "Eleanor only" in code.
// The grant script grants it only to Eleanor. If we ever want other
// directors to spin up projects (e.g. Wei-Ming starting a multi-week
// engineering initiative), we just grant it to them and the tool works.
// ============================================================================

import { db } from "../db.js";
import { config } from "../config.js";
import { addMember } from "../projects/members.js";
import type { Tool, ToolResult, ToolExecutionContext } from "./types.js";

const DAILY_PROJECT_CAP = 5;

async function countProjectsToday(agentId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { count, error } = await db
    .from("real_action_audit")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", config.tenantId)
    .eq("agent_id", agentId)
    .eq("tool_name", "project_create")
    .eq("success", true)
    .gte("created_at", startOfDay.toISOString());

  if (error) {
    console.warn(`[project-create] failed to count today's projects for ${agentId}: ${error.message}`);
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
    tool_name: "project_create",
    arguments_json: args.argsForAudit,
    result_summary: args.resultSummary,
    result_full_json: args.resultFull,
    success: args.success,
    error_message: args.errorMessage,
    duration_ms: args.durationMs,
    triggered_by_dm_id: args.triggeredByDmId,
  });
}

export const projectCreateTool: Tool = {
  real_action: true,
  definition: {
    name: "project_create",
    description:
      "Create a new project record. Use this ONLY when the CEO brings you a request that meets ALL of these thresholds:\n\n  - Multiple deliverables (not just one image, one document, one answer)\n  - Multiple specialties needed (not solvable by a single department alone)\n  - Multi-day or longer timeline (not finishable in a single message exchange)\n\nA single hero image is NOT a project. A single research question is NOT a project. A single document edit is NOT a project. The Onepark website redesign IS a project. A Q2 marketing plan IS a project. 'Help me think through pricing strategy' IS a project.\n\nAfter creating the project, use dm_send to introduce each relevant manager to the project (referencing the project ID in your message body so they can track it). Then reply to the CEO with the project ID, who you pulled in, and what each is doing.\n\nDaily cap of 5 projects. If you're creating more than 1 a day from the same conversation thread, you're over-creating.",
    input_schema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Short project title, 4-8 words. Example: 'Onepark website v1', 'Q2 Shopee growth strategy', 'Headcount pricing research'.",
        },
        description: {
          type: "string",
          description:
            "1-3 paragraphs explaining what the project is, what success looks like, and the rough scope. This becomes the canonical description that managers can reference.",
        },
      },
      required: ["title", "description"],
    },
  },
  executor: async (input, context): Promise<ToolResult> => {
    const start = Date.now();
    const toolName = "project_create";

    if (!context) {
      return {
        toolName,
        content: "Error: project_create requires execution context.",
        isError: true,
      };
    }

    const title = typeof input.title === "string" ? input.title.trim() : "";
    const description = typeof input.description === "string" ? input.description.trim() : "";

    if (!title) {
      return {
        toolName,
        content: "Error: title is required and must be non-empty.",
        isError: true,
      };
    }
    if (title.length > 200) {
      return {
        toolName,
        content: "Error: title too long (max 200 chars). Tighten it.",
        isError: true,
      };
    }
    if (!description) {
      return {
        toolName,
        content: "Error: description is required. Explain what the project is and what success looks like.",
        isError: true,
      };
    }
    if (description.length > 5000) {
      return {
        toolName,
        content: "Error: description too long (max 5000 chars). Trim it - the brief should fit on one screen.",
        isError: true,
      };
    }

    const argsForAudit = { title, description_preview: description.slice(0, 300) };

    // ----- Daily cap -----
    const todayCount = await countProjectsToday(context.agentId);
    if (todayCount >= DAILY_PROJECT_CAP) {
      const durationMs = Date.now() - start;
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "daily cap reached",
        resultFull: null,
        success: false,
        errorMessage: `Daily project cap of ${DAILY_PROJECT_CAP} reached`,
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content: `Error: I've already created ${todayCount} projects today, which is the daily cap. If this is genuinely a new project, ask Shin to confirm before I create more - I might be over-creating.`,
        isError: true,
      };
    }

    // ----- Insert project row -----
    const { data: inserted, error: insertErr } = await db
      .from("projects")
      .insert({
        tenant_id: config.tenantId,
        title,
        description,
        status: "active",
        created_by: context.agentId,
      })
      .select("id, created_at")
      .single();

    if (insertErr || !inserted) {
      const durationMs = Date.now() - start;
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "db insert error",
        resultFull: null,
        success: false,
        errorMessage: insertErr?.message ?? "no row returned",
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content: `Error creating project: ${insertErr?.message ?? "no row returned"}`,
        isError: true,
      };
    }

    const durationMs = Date.now() - start;
    const summary = `Created project "${title}" (id: ${inserted.id.slice(0, 8)})`;

    // Day 15: auto-add the creator as a project member so the DM responder
    // injects this project's context on the creator's next turn. Without this,
    // Eleanor creates a project but immediately loses the context when she
    // starts DMing people about it on subsequent turns.
    const memberResult = await addMember(inserted.id, context.agentId, context.agentId);
    if (memberResult.error) {
      console.warn(
        `[project-create] created project ${inserted.id.slice(0, 8)} but failed to add creator as member: ${memberResult.error}`
      );
    } else {
      console.log(
        `[project-members] auto-added creator ${context.agentName} to project ${inserted.id.slice(0, 8)} (via project_create)`
      );
    }

    await writeAudit({
      agentId: context.agentId,
      argsForAudit,
      resultSummary: summary,
      resultFull: {
        project_id: inserted.id,
        title,
        created_at: inserted.created_at,
      },
      success: true,
      errorMessage: null,
      durationMs,
      triggeredByDmId: context.triggeredByDmId ?? null,
    });

    console.log(
      `[project-create] ${context.agentName} created project: "${title}" (id=${inserted.id.slice(0, 8)})`
    );

    return {
      toolName,
      content: `Project "${title}" created successfully. Project ID: ${inserted.id}\n\nNext steps:\n  1. Use dm_send to introduce each relevant manager to the project. Reference this project ID in the body so they can track which work belongs to which initiative.\n  2. Reply to the CEO with the project ID, who you pulled in, and what each is doing.\n  3. The CEO can monitor progress via the dashboard MESSAGES view (each manager's thread is separate) or by querying the projects table directly.`,
      isError: false,
      structuredPayload: {
        project_id: inserted.id,
        title,
        created_at: inserted.created_at,
      },
    };
  },
};
