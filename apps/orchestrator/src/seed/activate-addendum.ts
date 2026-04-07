import "dotenv/config";
import { db } from "../db.js";
import { config } from "../config.js";

// ----------------------------------------------------------------------------
// activate-addendum.ts - Day 2b
// Flags two test agents as having the learned-addendum loop active.
// Run AFTER `pnpm seed`.
// ----------------------------------------------------------------------------

const ACTIVE_ROLES = [
  "Marketing Manager", // Rina Halim
  "Sales Manager",     // Chen Yu-ting
];

async function main() {
  console.log("Activating addendum loop on test agents...");
  console.log("");

  // Reset everyone first (idempotent)
  await db
    .from("agents")
    .update({ addendum_loop_active: false })
    .eq("tenant_id", config.tenantId);

  for (const role of ACTIVE_ROLES) {
    const { data, error } = await db
      .from("agents")
      .update({ addendum_loop_active: true })
      .eq("tenant_id", config.tenantId)
      .eq("role", role)
      .select("name")
      .single();

    if (error) {
      console.error(`  FAIL ${role}: ${error.message}`);
      process.exit(1);
    }
    console.log(`  ACTIVE  ${data?.name} (${role})`);
  }

  console.log("");
  console.log("Done. The reflection ritual will now run for these agents.");
  console.log("Proposed addendum changes will queue in prompt_evolution_log.");
  console.log("Review and approve them in the dashboard addendum tab.");
  console.log("");
  process.exit(0);
}

main().catch((err) => {
  console.error("Activation failed:", err);
  process.exit(1);
});
