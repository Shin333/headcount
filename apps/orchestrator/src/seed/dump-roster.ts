// Throwaway: dumps agent roster to JSON for the bio audit subagents.
// Run with: pnpm exec tsx src/seed/dump-roster.ts > ../../workspace/audits/roster-snapshot.json
import "dotenv/config";
import { db } from "../db.js";
import { config } from "../config.js";

const { data, error } = await db
  .from("agents")
  .select(
    "id, name, role, department, tier, model_tier, status, always_on, in_standup, is_human, daily_token_budget, frozen_core, background, manager_overlay, learned_addendum, personality, tool_access, fallback_agent_id"
  )
  .eq("tenant_id", config.tenantId)
  .eq("is_human", false)
  .order("department", { ascending: true })
  .order("tier", { ascending: true });

if (error) {
  console.error(JSON.stringify({ error: error.message }));
  process.exit(1);
}

console.log(JSON.stringify(data, null, 2));
