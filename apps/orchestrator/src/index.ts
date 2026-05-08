import "dotenv/config";
import { config } from "./config.js";
import { startDispatcherServer } from "./dispatcher/index.js";
import { logger } from "./ops/logger.js";
import { registerShutdown, registerCloser } from "./ops/shutdown.js";
import { closeBrowser } from "./tools/browser.js";
import { isEncryptionKeyConfigured } from "./auth/crypto.js";

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

  // Spec §6.9: Claude Max OAuth credentials only. ANTHROPIC_API_KEY must
  // NOT be set in the dispatcher environment — its presence forces the
  // SDK onto the API-key codepath and away from OAuth. Warn loudly if
  // someone shipped with it set; the production runbook covers unsetting it.
  if (process.env.ANTHROPIC_API_KEY) {
    logger.warn(
      { event: "dispatcher.startup.api_key_set" },
      "ANTHROPIC_API_KEY is set in dispatcher env; spec §6.9 requires OAuth-only. Unset before production.",
    );
  }

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

  // Plan 2 Task 5.2: boot the dispatcher (Hono + SSE) instead of the
  // dormant ritual tick loop. Port resolves via DISPATCHER_PORT env or
  // the dispatcher's default (3001) — see dispatcher/server.ts:resolvePort.
  await startDispatcherServer();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

// Day 26: shutdown handlers moved to ops/shutdown.ts so closers (Chromium,
// realtime subscriptions, etc.) can register and actually run on SIGTERM.
