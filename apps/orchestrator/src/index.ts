import "dotenv/config";
import { config } from "./config.js";
import { startTickLoop } from "./world/tick.js";
import { db } from "./db.js";

async function main() {
  console.log("");
  console.log("==========================================");
  console.log("         HEADCOUNT - Day 1                ");
  console.log("   The world's first AI company you       ");
  console.log("          can lurk on.                    ");
  console.log("==========================================");
  console.log("");
  console.log(`Tenant:  ${config.tenantId}`);
  console.log(`Tick:    every ${config.tickIntervalMs}ms`);
  console.log(`Speed:   ${config.speedMultiplier}x (1 wall sec = ${config.speedMultiplier} company sec)`);
  console.log("");

  // Sanity check DB
  const { error } = await db.from("world_clock").select("id").eq("id", 1).single();
  if (error) {
    console.error("Cannot reach Supabase. Check SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    console.error(error);
    process.exit(1);
  }
  console.log("Supabase reachable.");

  // Sanity check Anthropic key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set.");
    process.exit(1);
  }
  console.log("Anthropic key present.");

  startTickLoop();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("Shutting down...");
  process.exit(0);
});
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  process.exit(0);
});
