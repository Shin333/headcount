import "dotenv/config";
import { db } from "../db.js";
import { config } from "../config.js";

// ----------------------------------------------------------------------------
// seed-ceo.ts - inserts the CEO sentinel agent (Day 3)
// ----------------------------------------------------------------------------
// The human CEO is "just another agent" from the DB's perspective: they can
// receive DMs, they appear in queries, but the orchestrator never RUNS them
// (status='paused' so the runner skips them).
//
// This is the cleanest way to give the system a stable target for "DM the
// CEO" without inventing a parallel ceo_inbox table.
//
// Run after `pnpm seed`. Idempotent.
// ----------------------------------------------------------------------------

const CEO_SENTINEL_ID = "00000000-0000-0000-0000-00000000ce00";

async function main() {
  console.log("Seeding CEO sentinel agent...");

  const ceoSpec = {
    id: CEO_SENTINEL_ID,
    tenant_id: config.tenantId,
    name: "Shin Park",
    role: "CEO",
    department: "Executive",
    tier: "exec" as const,
    manager_id: null,
    reports_to_ceo: false,
    personality: {
      big5: {
        openness: 50,
        conscientiousness: 50,
        extraversion: 50,
        agreeableness: 50,
        neuroticism: 50,
      },
      archetype: "Human CEO. Not run by the orchestrator.",
      quirks: ["Reads everything. Decides what matters."],
      voiceExamples: ["This is the human CEO of Onepark Digital. The orchestrator does not run him."],
    },
    background: "Shin Park is the human CEO of Onepark Digital. This row exists so other agents can DM him through the standard dms table. The orchestrator never runs this agent (status=paused).",
    frozen_core: "DO NOT RUN. This agent represents the human CEO. The orchestrator must never call Claude on this agent's behalf.",
    manager_overlay: "",
    learned_addendum: "",
    allowed_tools: [],
    model_tier: "haiku" as const,
    status: "paused" as const, // critical: orchestrator skips paused agents
    daily_token_budget: 0,
    tokens_used_today: 0,
    addendum_loop_active: false,
    chatter_posts_today: 0,
  };

  // Upsert by id (not by role, because role 'CEO' is unique to this row)
  const { data: existing } = await db
    .from("agents")
    .select("id")
    .eq("id", CEO_SENTINEL_ID)
    .maybeSingle();

  if (existing) {
    const { error } = await db
      .from("agents")
      .update({
        ...ceoSpec,
        updated_at: new Date().toISOString(),
      })
      .eq("id", CEO_SENTINEL_ID);
    if (error) {
      console.error("Failed to update CEO sentinel:", error);
      process.exit(1);
    }
    console.log("  Updated CEO sentinel (Shin Park).");
  } else {
    const { error } = await db.from("agents").insert(ceoSpec);
    if (error) {
      console.error("Failed to insert CEO sentinel:", error);
      process.exit(1);
    }
    console.log("  Inserted CEO sentinel (Shin Park).");
  }

  console.log("");
  console.log("Done. The CEO can now receive DMs.");
  console.log("The orchestrator will NOT run this agent (status=paused).");
  console.log("");
  process.exit(0);
}

main().catch((err) => {
  console.error("CEO seed failed:", err);
  process.exit(1);
});
