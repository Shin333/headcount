// ----------------------------------------------------------------------------
// seed/reset-project-budgets.ts - one-time budget fix
// ----------------------------------------------------------------------------
// Ensures all agents currently in active projects have at least 200k
// daily token budget and resets tokens_used_today for anyone over budget.
//
// Run with:
//   pnpm tsx src/seed/reset-project-budgets.ts
// ----------------------------------------------------------------------------

import { db } from "../db.js";
import { config } from "../config.js";
import { pathToFileURL } from "node:url";

const PROJECT_MIN_BUDGET = 200000;

async function resetProjectBudgets(): Promise<void> {
  console.log("");
  console.log(`[reset-budgets] fixing budgets for all project members`);

  // Get all agents in active projects
  const { data: members } = await db
    .from("project_members")
    .select("agent_id, projects!inner(status)")
    .eq("projects.status", "active");

  if (!members || members.length === 0) {
    console.log("[reset-budgets] no active project members found");
    return;
  }

  const agentIds = Array.from(new Set(members.map((m: any) => m.agent_id)));
  console.log(`[reset-budgets] found ${agentIds.length} agents in active projects`);

  const { data: agents } = await db
    .from("agents")
    .select("id, name, daily_token_budget, tokens_used_today")
    .in("id", agentIds);

  let bumped = 0;
  let reset = 0;

  for (const agent of agents ?? []) {
    const budget = agent.daily_token_budget ?? 0;
    const used = agent.tokens_used_today ?? 0;
    const updates: Record<string, unknown> = {};

    if (budget < PROJECT_MIN_BUDGET) {
      updates.daily_token_budget = PROJECT_MIN_BUDGET;
      bumped++;
    }
    if (used >= budget) {
      updates.tokens_used_today = 0;
      reset++;
    }

    if (Object.keys(updates).length > 0) {
      await db.from("agents").update(updates).eq("id", agent.id);
      console.log(`  ${agent.name}: budget ${budget}→${updates.daily_token_budget ?? budget}, used ${used}→${updates.tokens_used_today ?? used}`);
    }
  }

  console.log(`\n[reset-budgets] ${bumped} budgets bumped, ${reset} usage counters reset`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  resetProjectBudgets()
    .then(() => process.exit(0))
    .catch((err) => { console.error(err); process.exit(1); });
}
