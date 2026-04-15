// ----------------------------------------------------------------------------
// seed/grant-day14-delegation.ts - grant Day 14 tools to the named cast
// ----------------------------------------------------------------------------
// Tool grants:
//   - All named cast (except Uncle Tan): + dm_send, + roster_lookup
//   - Eleanor Vance:                     + dm_send, + roster_lookup, + project_create
//   - 104 specialists:                   no changes (still dormant, but will
//                                        receive DMs from delegators)
//
// Why grant to all named cast and not just directors:
//   The point of Day 14 is to enable delegation. Even non-director named
//   cast (Rina, Devraj, etc.) benefit from being able to ask a colleague
//   for input. The cost is minimal - the per-agent daily DM cap of 30
//   prevents abuse, and the cost cap catches runaway loops. Better to grant
//   widely and watch what happens than to over-restrict and re-grant later.
//
// Why Eleanor gets project_create:
//   She's the routing front door for project-shaped CEO requests. The
//   project_create tool gives her a way to record those projects in the
//   database. The day14-prompt-addendum.ts script teaches her when to use
//   it. Other directors don't need it for v1 - if they want to start a
//   multi-deliverable initiative they can just use dm_send to coordinate;
//   we add project_create to other roles when there's a real need.
//
// Idempotent: re-running has no effect on agents that already have the
// tools. Uses array union semantics.
//
// Run with:
//   pnpm tsx apps/orchestrator/src/seed/grant-day14-delegation.ts
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { pathToFileURL } from "node:url";

interface ToolGrant {
  agentName: string;
  newTools: string[];
}

const GRANTS: ToolGrant[] = [
  // Eleanor gets the full set including project_create (routing layer)
  {
    agentName: "Eleanor Vance",
    newTools: ["dm_send", "roster_lookup", "project_create"],
  },

  // All other named cast get dm_send + roster_lookup (delegation tools)
  { agentName: "Evangeline Tan", newTools: ["dm_send", "roster_lookup"] },
  { agentName: "Tsai Wei-Ming", newTools: ["dm_send", "roster_lookup"] },
  { agentName: "Park So-yeon", newTools: ["dm_send", "roster_lookup"] },
  { agentName: "Han Jae-won", newTools: ["dm_send", "roster_lookup"] },
  { agentName: "Bradley Koh", newTools: ["dm_send", "roster_lookup"] },
  { agentName: "Chen Yu-ting", newTools: ["dm_send", "roster_lookup"] },
  { agentName: "Tessa Goh", newTools: ["dm_send", "roster_lookup"] },
  { agentName: "Rina Halim", newTools: ["dm_send", "roster_lookup"] },
  { agentName: "Hoshino Ayaka", newTools: ["dm_send", "roster_lookup"] },
  { agentName: "Lim Geok Choo", newTools: ["dm_send", "roster_lookup"] },
  { agentName: "Nadia Rahman", newTools: ["dm_send", "roster_lookup"] },
  { agentName: "Devraj Pillai", newTools: ["dm_send", "roster_lookup"] },
  { agentName: "Faridah binte Yusof", newTools: ["dm_send", "roster_lookup"] },
  { agentName: "Siti Nurhaliza", newTools: ["dm_send", "roster_lookup"] },
  // Uncle Tan deliberately excluded - he's a vibes character, no delegation tools
];

interface GrantResult {
  granted: number;
  already: number;
  missing: number;
  errors: number;
}

async function grantOne(target: ToolGrant): Promise<"granted" | "already" | "missing" | "error"> {
  const { data: agent, error } = await db
    .from("agents")
    .select("id, name, tool_access")
    .eq("tenant_id", config.tenantId)
    .eq("name", target.agentName)
    .maybeSingle();

  if (error) {
    console.error(`[grant-day14] error querying ${target.agentName}: ${error.message}`);
    return "error";
  }

  if (!agent) {
    console.error(`[grant-day14] MISSING: ${target.agentName} - no matching agent`);
    return "missing";
  }

  const existing: string[] = (agent.tool_access as string[] | null) ?? [];
  const merged: string[] = [...existing];
  let added = 0;
  for (const tool of target.newTools) {
    if (!merged.includes(tool)) {
      merged.push(tool);
      added++;
    }
  }

  if (added === 0) {
    console.log(`[grant-day14] ALREADY: ${target.agentName} already has all Day 14 tools`);
    return "already";
  }

  const { error: updateErr } = await db
    .from("agents")
    .update({ tool_access: merged, updated_at: new Date().toISOString() })
    .eq("id", agent.id);

  if (updateErr) {
    console.error(`[grant-day14] FAILED: ${target.agentName}: ${updateErr.message}`);
    return "error";
  }

  console.log(`[grant-day14] GRANTED: ${target.agentName} (+${added} tools) -> [${merged.join(", ")}]`);
  return "granted";
}

export async function runGrantDay14Delegation(): Promise<void> {
  console.log(``);
  console.log(`[grant-day14] granting Day 14 delegation tools to ${GRANTS.length} agents`);
  console.log(`[grant-day14] tenant: ${config.tenantId}`);
  console.log(``);

  const result: GrantResult = { granted: 0, already: 0, missing: 0, errors: 0 };
  for (const target of GRANTS) {
    const r = await grantOne(target);
    if (r === "granted") result.granted++;
    else if (r === "already") result.already++;
    else if (r === "missing") result.missing++;
    else result.errors++;
  }

  console.log(``);
  console.log(`[grant-day14] summary: ${result.granted} granted, ${result.already} already had it, ${result.missing} missing, ${result.errors} errors`);
  console.log(``);

  if (result.granted > 0) {
    console.log(`[grant-day14] Next step: run the prompt addendum script to teach agents when to use these tools:`);
    console.log(`[grant-day14]   pnpm tsx apps/orchestrator/src/seed/day14-prompt-addendum.ts`);
    console.log(``);
    console.log(`[grant-day14] Then restart the orchestrator and DM Eleanor with a project-shaped request.`);
  }

  if (result.missing > 0) {
    console.log(``);
    console.log(`[grant-day14] WARNING: ${result.missing} target(s) not found.`);
    console.log(`[grant-day14] Make sure the seed-day7 scripts have run.`);
  }

  if (result.errors > 0) {
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runGrantDay14Delegation()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`[grant-day14] unexpected error:`, err);
      process.exit(1);
    });
}
