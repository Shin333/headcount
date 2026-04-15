// ============================================================================
// seed/day22b-eleanor-evie-failover.ts
// ----------------------------------------------------------------------------
// Sets Eleanor Vance (CoS) -> Evangeline Tan (PA to CEO) as her budget
// failover. When Eleanor is over her daily_token_budget, the dm-responder
// will reroute CEO-bound DMs to Evie. Evie responds AS HERSELF.
//
// Idempotent: re-running this is a no-op if the link is already in place.
// Run with: pnpm tsx src/seed/day22b-eleanor-evie-failover.ts
// ============================================================================

import "dotenv/config";
import { db } from "../db.js";
import { config } from "../config.js";

const PRIMARY = "Eleanor Vance";
const FALLBACK = "Evangeline Tan";

async function main() {
  const { data: agents, error } = await db
    .from("agents")
    .select("id, name, fallback_agent_id")
    .eq("tenant_id", config.tenantId)
    .in("name", [PRIMARY, FALLBACK]);

  if (error) throw error;

  const primary = agents?.find((a) => a.name === PRIMARY);
  const fallback = agents?.find((a) => a.name === FALLBACK);

  if (!primary) {
    console.error(`Agent '${PRIMARY}' not found.`);
    process.exit(1);
  }
  if (!fallback) {
    console.error(`Agent '${FALLBACK}' not found.`);
    process.exit(1);
  }

  if (primary.fallback_agent_id === fallback.id) {
    console.log(`No-op: ${PRIMARY}.fallback_agent_id is already ${FALLBACK}.`);
    return;
  }

  const { error: updateErr } = await db
    .from("agents")
    .update({ fallback_agent_id: fallback.id, updated_at: new Date().toISOString() })
    .eq("id", primary.id);

  if (updateErr) throw updateErr;

  // Read-back verify (Day 3.1 rule)
  const { data: verify } = await db
    .from("agents")
    .select("fallback_agent_id")
    .eq("id", primary.id)
    .single();

  if (verify?.fallback_agent_id !== fallback.id) {
    console.error(`Read-back FAILED: expected ${fallback.id}, got ${verify?.fallback_agent_id}`);
    process.exit(1);
  }

  console.log(`OK: ${PRIMARY} -> ${FALLBACK} failover set.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
