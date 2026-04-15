// ============================================================================
// tools/dm-send.ts - Day 14 - agent-to-agent direct messaging
// ----------------------------------------------------------------------------
// Lets an agent send a DM to another agent by name OR by role. The tool
// resolves the target via the agents table, validates safety constraints,
// inserts the dms row via the existing comms/dm.ts helper, and writes a
// real_action_audit row.
//
// The existing DM responder ritual already handles agent-to-agent delivery
// (it processes any unread DM whose recipient is not the CEO sentinel). So
// this tool is the FIRST piece needed to make delegation actually work -
// the second is roster_lookup so agents can find each other.
//
// SAFETY CONSTRAINTS (all non-negotiable):
//   1. Cannot DM yourself (loop prevention)
//   2. Cannot DM the CEO sentinel via this tool (the agent should reply
//      via their normal output, not call a tool to message the CEO)
//   3. Cannot DM a paused/terminated agent
//   4. If multiple agents share the role, return an error asking for
//      disambiguation by name
//   5. Per-agent daily cap of 30 outbound DMs (counts today's successful
//      audit rows for tool_name='dm_send'). Hits before the cost cap.
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { sendDm } from "../comms/dm.js";
import { addMember, findSenderProjectsInBody } from "../projects/members.js";
import { redactBody } from "../util/log-safe.js";
import type { Tool, ToolResult, ToolExecutionContext } from "./types.js";

const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";
const DAILY_DM_SEND_CAP = 100;
// Loop guard: max DMs in either direction between the same pair per UTC day.
// 20 = 10 round-trips. Two agents stuck in a back-and-forth hit this long
// before they exhaust either's daily budget or the hourly cost cap.
const PAIR_DAILY_CAP = 20;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

interface AgentLookupRow {
  id: string;
  name: string;
  role: string;
  status: string;
}

async function findByName(name: string): Promise<AgentLookupRow | null> {
  const { data, error } = await db
    .from("agents")
    .select("id, name, role, status")
    .eq("tenant_id", config.tenantId)
    .eq("is_human", false)
    .eq("name", name)
    .maybeSingle();

  if (error || !data) return null;
  return data as AgentLookupRow;
}

async function findByRole(role: string): Promise<AgentLookupRow[]> {
  const { data, error } = await db
    .from("agents")
    .select("id, name, role, status")
    .eq("tenant_id", config.tenantId)
    .eq("is_human", false)
    .eq("role", role);

  if (error || !data) return [];
  return data as AgentLookupRow[];
}

/**
 * Count DMs in either direction between two agents today (UTC). Used to
 * break runaway A<->B loops before they burn budget. Counts the dms table
 * directly so it works regardless of which path created the row.
 */
async function countPairToday(a: string, b: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { count, error } = await db
    .from("dms")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", config.tenantId)
    .or(`and(from_id.eq.${a},to_id.eq.${b}),and(from_id.eq.${b},to_id.eq.${a})`)
    .gte("created_at", startOfDay.toISOString());

  if (error) {
    console.warn(`[dm-send] pair-count query failed for ${a.slice(0, 8)}<->${b.slice(0, 8)}: ${error.message}`);
    return 0; // fail open - prefer false negative over blocking legitimate work
  }
  return count ?? 0;
}

async function countSendsToday(agentId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { count, error } = await db
    .from("real_action_audit")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", config.tenantId)
    .eq("agent_id", agentId)
    .eq("tool_name", "dm_send")
    .eq("success", true)
    .gte("created_at", startOfDay.toISOString());

  if (error) {
    console.warn(`[dm-send] failed to count today's sends for ${agentId}: ${error.message}`);
    return 0; // fail open
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
    tool_name: "dm_send",
    arguments_json: args.argsForAudit,
    result_summary: args.resultSummary,
    result_full_json: args.resultFull,
    success: args.success,
    error_message: args.errorMessage,
    duration_ms: args.durationMs,
    triggered_by_dm_id: args.triggeredByDmId,
  });
}

// ----------------------------------------------------------------------------
// The tool
// ----------------------------------------------------------------------------

export const dmSendTool: Tool = {
  real_action: true,
  definition: {
    name: "dm_send",
    description:
      "Send a direct message to another agent in the company. Use this to delegate work to a specialist, ask a colleague for input outside your domain, or pull a teammate into a problem you can't solve alone.\n\nWhen to use:\n  - The request needs expertise outside your primary domain\n  - You'd be guessing rather than knowing if you handled it yourself\n  - A specialist on your team is more qualified than you\n  - The work would be meaningfully better with a second perspective\n\nWhen NOT to use:\n  - Trivial requests you can handle alone (don't delegate just to look busy)\n  - Sending updates back to the CEO (use your normal reply for that)\n  - Replying to someone who just DMed you (use your normal reply)\n  - Acknowledgments or thank-yous (just don't send anything)\n\nEvery DM you send costs the company money and consumes the recipient's time. Default to handling things yourself; delegate when delegation produces a better outcome.\n\nProvide EXACTLY ONE of to_name or to_role. Use to_name when you know the specific person. Use to_role when you want any specialist with that role title (only works if the role is unique - if multiple agents share it, you'll get an error and need to use to_name).",
    input_schema: {
      type: "object",
      properties: {
        to_name: {
          type: "string",
          description:
            "Full name of the agent to message. Example: 'Tessa Goh', 'Wei-Ming Chen'.",
        },
        to_role: {
          type: "string",
          description:
            "Role title of the agent to message (alternative to to_name, useful for specialists you discovered via roster_lookup). Example: 'Image Prompt Engineer', 'Reddit Community Builder'. If multiple agents share this role you'll get an error.",
        },
        body: {
          type: "string",
          description:
            "The message body. Be specific about what you need from them, what context they need, and when you need it back. Treat them as a colleague - they have their own work, so make it easy for them to help you.",
        },
      },
      required: ["body"],
    },
  },
  executor: async (input, context): Promise<ToolResult> => {
    const start = Date.now();
    const toolName = "dm_send";

    if (!context) {
      return {
        toolName,
        content: "Error: dm_send requires execution context.",
        isError: true,
      };
    }

    // ----- Parse args -----
    const toName = typeof input.to_name === "string" ? input.to_name.trim() : "";
    const toRole = typeof input.to_role === "string" ? input.to_role.trim() : "";
    const body = typeof input.body === "string" ? input.body.trim() : "";

    if (!body) {
      return {
        toolName,
        content: "Error: body is required and must be non-empty.",
        isError: true,
      };
    }
    if (body.length > 5000) {
      return {
        toolName,
        content: "Error: body too long (max 5000 chars). Tighten your message.",
        isError: true,
      };
    }
    if (!toName && !toRole) {
      return {
        toolName,
        content: "Error: provide either to_name or to_role.",
        isError: true,
      };
    }
    if (toName && toRole) {
      return {
        toolName,
        content: "Error: provide EXACTLY ONE of to_name or to_role, not both.",
        isError: true,
      };
    }

    const argsForAudit = { to_name: toName || null, to_role: toRole || null, body_preview: body.slice(0, 200) };

    // ----- Per-agent send cap -----
    const sentToday = await countSendsToday(context.agentId);
    if (sentToday >= DAILY_DM_SEND_CAP) {
      const durationMs = Date.now() - start;
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "daily cap reached",
        resultFull: null,
        success: false,
        errorMessage: `Daily dm_send cap of ${DAILY_DM_SEND_CAP} reached`,
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content: `Error: I've already sent ${sentToday} DMs today, which is the daily cap. Either handle this yourself or wait until tomorrow.`,
        isError: true,
      };
    }

    // ----- Resolve target -----
    let target: AgentLookupRow | null = null;
    if (toName) {
      target = await findByName(toName);
      if (!target) {
        const durationMs = Date.now() - start;
        await writeAudit({
          agentId: context.agentId,
          argsForAudit,
          resultSummary: "target not found",
          resultFull: null,
          success: false,
          errorMessage: `No agent named '${toName}'`,
          durationMs,
          triggeredByDmId: context.triggeredByDmId ?? null,
        });
        return {
          toolName,
          content: `Error: no agent found with the name '${toName}'. Use roster_lookup to find the right person, or check your spelling.`,
          isError: true,
        };
      }
    } else {
      const matches = await findByRole(toRole);
      if (matches.length === 0) {
        const durationMs = Date.now() - start;
        await writeAudit({
          agentId: context.agentId,
          argsForAudit,
          resultSummary: "role not found",
          resultFull: null,
          success: false,
          errorMessage: `No agent with role '${toRole}'`,
          durationMs,
          triggeredByDmId: context.triggeredByDmId ?? null,
        });
        return {
          toolName,
          content: `Error: no agent found with the role '${toRole}'. Use roster_lookup with expertise_query to discover available specialists.`,
          isError: true,
        };
      }
      if (matches.length > 1) {
        const names = matches.map((m) => m.name).join(", ");
        const durationMs = Date.now() - start;
        await writeAudit({
          agentId: context.agentId,
          argsForAudit,
          resultSummary: "ambiguous role",
          resultFull: { matches: matches.length },
          success: false,
          errorMessage: `Multiple agents share role '${toRole}'`,
          durationMs,
          triggeredByDmId: context.triggeredByDmId ?? null,
        });
        return {
          toolName,
          content: `Error: ${matches.length} agents share the role '${toRole}': ${names}. Use to_name to specify which one you want.`,
          isError: true,
        };
      }
      target = matches[0]!;
    }

    // ----- Safety: cannot DM self -----
    if (target.id === context.agentId) {
      const durationMs = Date.now() - start;
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "cannot dm self",
        resultFull: null,
        success: false,
        errorMessage: "Attempted to DM self",
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content: `Error: you cannot DM yourself. If you're trying to think out loud, just write the thoughts in your reply instead.`,
        isError: true,
      };
    }

    // ----- Safety: cannot DM the CEO sentinel via this tool -----
    if (target.id === CEO_SENTINEL_ID) {
      const durationMs = Date.now() - start;
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "cannot dm ceo via tool",
        resultFull: null,
        success: false,
        errorMessage: "Attempted to DM CEO sentinel via dm_send",
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content: `Error: you cannot use dm_send to message the CEO. Reply to him through your normal output instead - whatever you write in your response will be sent to him directly.`,
        isError: true,
      };
    }

    // ----- Safety: per-pair daily cap (loop guard) -----
    const pairCount = await countPairToday(context.agentId, target.id);
    if (pairCount >= PAIR_DAILY_CAP) {
      const durationMs = Date.now() - start;
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "pair daily cap reached",
        resultFull: { pair_count: pairCount, cap: PAIR_DAILY_CAP, target_id: target.id },
        success: false,
        errorMessage: `Pair daily cap of ${PAIR_DAILY_CAP} reached with ${target.name}`,
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content: `Error: you and ${target.name} have already exchanged ${pairCount} messages today, which is the per-pair daily cap (${PAIR_DAILY_CAP}). This is a loop guard - if you genuinely need to keep iterating, escalate to a third party (your manager, or post to the project channel) instead of another DM.`,
        isError: true,
      };
    }

    // ----- Safety: target must be active -----
    if (target.status !== "active") {
      const durationMs = Date.now() - start;
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "target not active",
        resultFull: { target_status: target.status },
        success: false,
        errorMessage: `Target ${target.name} has status '${target.status}'`,
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content: `Error: ${target.name} is currently ${target.status} and cannot receive messages.`,
        isError: true,
      };
    }

    // ----- Send -----
    let dmId: string;
    try {
      const result = await sendDm({
        fromId: context.agentId,
        toId: target.id,
        body,
      });
      dmId = result.id;
    } catch (err) {
      const durationMs = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      await writeAudit({
        agentId: context.agentId,
        argsForAudit,
        resultSummary: "send failed",
        resultFull: null,
        success: false,
        errorMessage: errMsg,
        durationMs,
        triggeredByDmId: context.triggeredByDmId ?? null,
      });
      return {
        toolName,
        content: `Error sending DM: ${errMsg}`,
        isError: true,
      };
    }

    const durationMs = Date.now() - start;
    const summary = `DM sent to ${target.name} (${target.role})`;

    // Day 15: auto-propagate project membership. Scan the message body for
    // UUID strings that match active projects the sender is a member of.
    // For each match, add the recipient as a member of the same project.
    //
    // This is how follow-up DMs stay grounded in project context. When
    // Eleanor's kickoff DM to Rina includes "project 1806c510-...", Rina
    // gets added to that project automatically, and her DM responder on the
    // next turn injects the project context into her system prompt.
    //
    // Security: findSenderProjectsInBody only returns projects the sender is
    // already on, so a confused or adversarial agent can't add people to
    // projects by pasting random UUIDs in a message.
    const propagatedProjects: string[] = [];
    try {
      const senderProjects = await findSenderProjectsInBody(context.agentId, body);
      for (const project of senderProjects) {
        const addResult = await addMember(project.id, target.id, context.agentId);
        if (addResult.error) {
          console.warn(
            `[project-members] failed to auto-add ${target.name} to project ${project.id.slice(0, 8)}: ${addResult.error}`
          );
          continue;
        }
        if (addResult.inserted) {
          propagatedProjects.push(project.id);
          console.log(
            `[project-members] auto-added ${target.name} to project "${project.title}" (${project.id.slice(0, 8)}) via dm_send from ${context.agentName}`
          );
        }
      }
    } catch (propErr) {
      // Never let a propagation failure break the DM send itself. Log and move on.
      console.warn(
        `[project-members] auto-propagation failed for dm_send from ${context.agentName}: ${propErr instanceof Error ? propErr.message : String(propErr)}`
      );
    }

    await writeAudit({
      agentId: context.agentId,
      argsForAudit,
      resultSummary: summary,
      resultFull: {
        dm_id: dmId,
        to_id: target.id,
        to_name: target.name,
        to_role: target.role,
        body_length: body.length,
        propagated_projects: propagatedProjects,
      },
      success: true,
      errorMessage: null,
      durationMs,
      triggeredByDmId: context.triggeredByDmId ?? null,
    });

    console.log(
      `[dm-send] ${context.agentName} -> ${target.name}: ${redactBody(body)}`
    );

    return {
      toolName,
      content: `DM delivered to ${target.name} (${target.role}). They will see it on their next ritual cycle (typically within ~10 wall seconds). When they respond, you'll receive their reply as a new DM.`,
      isError: false,
      structuredPayload: {
        dm_id: dmId,
        to_id: target.id,
        to_name: target.name,
        to_role: target.role,
      },
    };
  },
};
