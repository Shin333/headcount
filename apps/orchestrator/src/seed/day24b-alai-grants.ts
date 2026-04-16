// ============================================================================
// seed/day24b-alai-grants.ts
// ----------------------------------------------------------------------------
// Grant the Alai MCP server to the 4 agents who produce the highest-stakes
// deck output: pitch decks, board decks, investor updates, strategy briefs.
//
// Alai is Anthropic-MCP-connector mounted via orchestrator's mcp-registry.ts;
// the runner passes mcp_servers on the API call and the model can call
// Alai's tools directly at runtime. No local executor wrapper needed.
//
// Gamma deferred — the marketing-deck use case (Tessa, Lai Kuan-Ting, Cheryl)
// can have Gamma added when that pipeline materializes. See project memory.
//
// Idempotent; dry-run via --dry-run.
// Run with: pnpm exec tsx src/seed/day24b-alai-grants.ts
// ============================================================================

import "dotenv/config";
import { db } from "../db.js";
import { config } from "../config.js";

const DRY = process.argv.includes("--dry-run");

const TARGETS = [
  "Siti Nurhaliza",   // Strategy manager — editor, stress-test decks
  "Amanda Setiawan",  // Strategy associate — first-draft decks
  "Han Jae-won",      // Strategy exec — framed analyses, chess-metaphor decks
  "Nadia Rahman",     // CFO — board / investor decks
];

async function main() {
  if (DRY) console.log("DRY RUN — no writes.\n");
  console.log(`=== Day 24b — Alai MCP grants to ${TARGETS.length} agents ===\n`);

  if (!process.env.ALAI_API_KEY) {
    console.warn("WARNING: ALAI_API_KEY is not set in apps/orchestrator/.env");
    console.warn("The grants will persist but the MCP server attachment will skip at runtime until the key is set.");
    console.warn("");
  }

  let granted = 0;
  let already = 0;

  for (const name of TARGETS) {
    const { data: agent, error } = await db
      .from("agents")
      .select("id, name, mcp_access")
      .eq("tenant_id", config.tenantId)
      .eq("name", name)
      .maybeSingle();

    if (error) {
      console.log(`  ! ${name}: query failed — ${error.message}`);
      continue;
    }
    if (!agent) {
      console.log(`  ! ${name}: not found`);
      continue;
    }
    const existing: string[] = (agent as { mcp_access?: string[] }).mcp_access ?? [];
    if (existing.includes("alai")) {
      console.log(`  - ${name}: alai already granted`);
      already++;
      continue;
    }
    const next = Array.from(new Set([...existing, "alai"]));
    if (DRY) {
      console.log(`  [DRY] ${name}: +alai`);
      granted++;
      continue;
    }
    const { error: uErr } = await db
      .from("agents")
      .update({ mcp_access: next, updated_at: new Date().toISOString() })
      .eq("id", agent.id);
    if (uErr) {
      console.log(`  ! ${name}: update failed — ${uErr.message}`);
      continue;
    }
    console.log(`  + ${name}: +alai`);
    granted++;
  }

  console.log(`\nGrants: ${granted}, already had it: ${already}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
