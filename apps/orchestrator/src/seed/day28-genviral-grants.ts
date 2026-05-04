// ============================================================================
// seed/day28-genviral-grants.ts
// ----------------------------------------------------------------------------
// Grant Genviral social-media tools to the agents who own the NoCodeShips
// content pipeline. Each of the three agents needs the full trio (list +
// create + check) because they'll drive their own platform-specific drafts.
//
// Idempotent. Dry-run via --dry-run.
// Run with: pnpm exec tsx src/seed/day28-genviral-grants.ts
// ============================================================================

import "dotenv/config";
import { db } from "../db.js";
import { config } from "../config.js";

const DRY = process.argv.includes("--dry-run");

const GENVIRAL_TOOLS = [
  "genviral_list_accounts",
  "genviral_create_draft",
  "genviral_check_status",
];

// Who gets the tools + which platforms they own
const TARGETS: Array<{ name: string; platformsOwned: string }> = [
  { name: "Tessa Goh", platformsOwned: "editorial lead (both platforms)" },
  { name: "Kavitha Balasubramaniam", platformsOwned: "Instagram carousel ops" },
  { name: "Chua Li Ting", platformsOwned: "TikTok photo-mode + trending audio" },
];

async function main() {
  if (DRY) console.log("DRY RUN — no writes.\n");
  console.log(`=== Day 28 — Genviral tool grants to ${TARGETS.length} agents ===\n`);

  let granted = 0;
  let already = 0;

  for (const { name, platformsOwned } of TARGETS) {
    const { data: agent, error } = await db
      .from("agents")
      .select("id, name, tool_access")
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

    const existing: string[] = agent.tool_access ?? [];
    const missing = GENVIRAL_TOOLS.filter((t) => !existing.includes(t));

    if (missing.length === 0) {
      console.log(`  - ${name} (${platformsOwned}): all Genviral tools already granted`);
      already++;
      continue;
    }

    const next = Array.from(new Set([...existing, ...GENVIRAL_TOOLS]));
    if (DRY) {
      console.log(`  [DRY] ${name} (${platformsOwned}): +${missing.join(", ")}`);
      granted++;
      continue;
    }

    const { error: uErr } = await db
      .from("agents")
      .update({ tool_access: next, updated_at: new Date().toISOString() })
      .eq("id", agent.id);
    if (uErr) {
      console.log(`  ! ${name}: update failed — ${uErr.message}`);
      continue;
    }
    console.log(`  + ${name} (${platformsOwned}): +${missing.join(", ")}`);
    granted++;
  }

  console.log(`\nGrants: ${granted}, already had: ${already}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
