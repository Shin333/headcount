import "dotenv/config";
import { config } from "./config.js";
import { startTickLoop } from "./world/tick.js";
import { db } from "./db.js";
import { getRegisteredToolNames } from "./tools/registry.js";

/**
 * Cross-check every active agent's tool_access against the in-process tool
 * registry. Unknown names are dropped silently at runtime (registry.ts:55),
 * so a typo like 'code_artfiact_create' produces a permanently tool-less
 * agent with no error. This validator surfaces those at startup.
 *
 * Warn-only for now — does not exit. Promote to hard-exit once we trust the
 * seed pipeline.
 */
async function validateAgentToolAccess(): Promise<void> {
  const knownTools = new Set(getRegisteredToolNames());

  const { data: agents, error } = await db
    .from("agents")
    .select("id, name, tool_access")
    .eq("tenant_id", config.tenantId)
    .eq("status", "active");

  if (error) {
    console.warn(`[startup] tool-access validator query failed: ${error.message}`);
    return;
  }

  const offenders: Array<{ name: string; unknown: string[] }> = [];
  for (const agent of agents ?? []) {
    const access: string[] = (agent as { tool_access?: string[] }).tool_access ?? [];
    const unknown = access.filter((t) => !knownTools.has(t));
    if (unknown.length > 0) {
      offenders.push({ name: (agent as { name: string }).name, unknown });
    }
  }

  if (offenders.length === 0) {
    console.log(`Tool-access validator: OK (${agents?.length ?? 0} active agents, ${knownTools.size} registered tools).`);
    return;
  }

  console.warn(`Tool-access validator: ${offenders.length} agent(s) reference unknown tools:`);
  for (const o of offenders) {
    console.warn(`  - ${o.name}: [${o.unknown.join(", ")}]`);
  }
  console.warn("(These tools will be silently dropped at runtime. Fix tool_access or update the registry.)");
}

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

  await validateAgentToolAccess();

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
