// ============================================================================
// seed/day28b-view-image-grants.ts
// ----------------------------------------------------------------------------
// Grant view_image to every agent whose job involves looking at images —
// designers, visual reviewers, UX researchers, brand auditors, content
// curators, and the two content leads who'll review drafts.
//
// Idempotent. Dry-run with --dry-run.
// Run with: pnpm exec tsx src/seed/day28b-view-image-grants.ts
// ============================================================================

import "dotenv/config";
import { db } from "../db.js";
import { config } from "../config.js";

const DRY = process.argv.includes("--dry-run");

// Everyone who benefits from being able to see images directly
const TARGETS = [
  // Design department
  "Choi Seung-hyun",          // UI designer — slide templates
  "Michelle Pereira",         // UX architect
  "Lai Kuan-Ting",            // Visual storyteller — palette extraction
  "Suresh Palaniappan",       // Whimsy injector
  "Heng Kok Wei",             // Image prompt engineer
  "Lau Cheng Yi",             // Inclusive visuals
  // Product — research
  "James Whitfield",          // UX researcher
  // Marketing leads who review visuals
  "Tessa Goh",                // CMO — final sign-off on drafts
  "Kavitha Balasubramaniam",  // IG curator
  "Chua Li Ting",             // TikTok
  "Ong Kai Xiang",            // Brand compliance — critical for visual audit
  // Engineering — frontend + architects who review mockups
  "Faizal Harun",             // Frontend architect
  "Jung Hae-won",             // Senior frontend engineer
];

async function main() {
  if (DRY) console.log("DRY RUN — no writes.\n");
  console.log(`=== Day 28b — view_image grants to ${TARGETS.length} agents ===\n`);

  let granted = 0;
  let already = 0;

  for (const name of TARGETS) {
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
    if (existing.includes("view_image")) {
      console.log(`  - ${name}: already has view_image`);
      already++;
      continue;
    }

    const next = Array.from(new Set([...existing, "view_image"]));
    if (DRY) {
      console.log(`  [DRY] ${name}: +view_image`);
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
    console.log(`  + ${name}: +view_image`);
    granted++;
  }

  console.log(`\nGrants: ${granted}, already had: ${already}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
