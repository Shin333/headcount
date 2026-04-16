import "dotenv/config";
import { config } from "./config.js";
import { startTickLoop } from "./world/tick.js";
import { db } from "./db.js";
import { getRegisteredToolNames } from "./tools/registry.js";
import { getRegisteredMcpServerNames } from "./tools/mcp-registry.js";
import { registerShutdown, registerCloser } from "./ops/shutdown.js";
import { closeBrowser } from "./tools/browser.js";
import { isEncryptionKeyConfigured } from "./auth/crypto.js";

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
  const knownMcp = new Set(getRegisteredMcpServerNames());

  const { data: agents, error } = await db
    .from("agents")
    .select("id, name, tool_access, mcp_access")
    .eq("tenant_id", config.tenantId)
    .eq("status", "active");

  if (error) {
    console.warn(`[startup] tool-access validator query failed: ${error.message}`);
    return;
  }

  const toolOffenders: Array<{ name: string; unknown: string[] }> = [];
  const mcpOffenders: Array<{ name: string; unknown: string[] }> = [];
  for (const agent of agents ?? []) {
    const access: string[] = (agent as { tool_access?: string[] }).tool_access ?? [];
    const mcpAccess: string[] = (agent as { mcp_access?: string[] }).mcp_access ?? [];
    const unknownTools = access.filter((t) => !knownTools.has(t));
    const unknownMcp = mcpAccess.filter((t) => !knownMcp.has(t));
    const name = (agent as { name: string }).name;
    if (unknownTools.length > 0) toolOffenders.push({ name, unknown: unknownTools });
    if (unknownMcp.length > 0) mcpOffenders.push({ name, unknown: unknownMcp });
  }

  if (toolOffenders.length === 0 && mcpOffenders.length === 0) {
    console.log(
      `Tool-access validator: OK (${agents?.length ?? 0} active agents, ${knownTools.size} tools, ${knownMcp.size} MCP servers).`
    );
    return;
  }
  if (toolOffenders.length > 0) {
    console.warn(`Tool-access validator: ${toolOffenders.length} agent(s) reference unknown tools:`);
    for (const o of toolOffenders) console.warn(`  - ${o.name}: [${o.unknown.join(", ")}]`);
  }
  if (mcpOffenders.length > 0) {
    console.warn(`MCP-access validator: ${mcpOffenders.length} agent(s) reference unknown MCP servers:`);
    for (const o of mcpOffenders) console.warn(`  - ${o.name}: [${o.unknown.join(", ")}]`);
  }
  console.warn("(Unknown entries will be silently dropped at runtime. Fix the column or update the registry.)");
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

  // Day 27: warn (don't fail) when credential encryption key isn't set yet.
  if (!isEncryptionKeyConfigured()) {
    console.warn("CRED_ENCRYPTION_KEY not set — agent_credentials will be stored PLAINTEXT.");
    console.warn("  Generate one: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"");
    console.warn("  Then run: pnpm exec tsx src/seed/day27-encrypt-credentials.ts");
  } else {
    console.log("Credential encryption: enabled (AES-256-GCM).");
  }

  // Day 26: register closers so PM2 SIGTERM releases Chromium + closes the
  // realtime subscriptions cleanly instead of leaking processes on restart.
  registerCloser(async () => { await closeBrowser(); });
  registerShutdown();

  startTickLoop();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

// Day 26: shutdown handlers moved to ops/shutdown.ts so closers (Chromium,
// realtime subscriptions, etc.) can register and actually run on SIGTERM.
