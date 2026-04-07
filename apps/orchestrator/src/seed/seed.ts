import "dotenv/config";
import { db } from "../db.js";
import { config } from "../config.js";
import {
  eleanorPersonality,
  eleanorBackground,
  eleanorFrozenCore,
} from "./chief-of-staff.js";

async function seed() {
  console.log("Seeding Headcount Day 1...");

  // Ensure world clock exists (the migration already inserts it, but be safe)
  const { error: clockError } = await db
    .from("world_clock")
    .upsert({ id: 1, tenant_id: config.tenantId }, { onConflict: "id" });
  if (clockError) {
    console.error("Failed to ensure world clock:", clockError);
    process.exit(1);
  }

  // Check if Eleanor already exists
  const { data: existing } = await db
    .from("agents")
    .select("id")
    .eq("tenant_id", config.tenantId)
    .eq("role", "Chief of Staff")
    .maybeSingle();

  if (existing) {
    console.log("Chief of Staff already exists. Updating prompt + personality.");
    const { error } = await db
      .from("agents")
      .update({
        name: "Eleanor Vance",
        personality: eleanorPersonality,
        background: eleanorBackground,
        frozen_core: eleanorFrozenCore,
        updated_at: new Date().toISOString(),
      })
      .eq("id", existing.id);

    if (error) {
      console.error("Failed to update Eleanor:", error);
      process.exit(1);
    }
    console.log("Updated Eleanor Vance.");
  } else {
    const { error } = await db.from("agents").insert({
      tenant_id: config.tenantId,
      name: "Eleanor Vance",
      role: "Chief of Staff",
      department: "Executive",
      tier: "exec",
      manager_id: null,
      reports_to_ceo: true,
      personality: eleanorPersonality,
      background: eleanorBackground,
      frozen_core: eleanorFrozenCore,
      manager_overlay: "",
      learned_addendum: "",
      allowed_tools: ["forum_post", "dm"],
      model_tier: "sonnet",
      status: "active",
      daily_token_budget: 50000,
      tokens_used_today: 0,
    });

    if (error) {
      console.error("Failed to insert Eleanor:", error);
      process.exit(1);
    }
    console.log("Hired Eleanor Vance as Chief of Staff.");
  }

  console.log("");
  console.log("Day 1 seed complete. Start the orchestrator with:");
  console.log("  pnpm orchestrator:dev");
  console.log("");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
