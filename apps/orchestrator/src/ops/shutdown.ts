// ============================================================================
// ops/shutdown.ts - graceful shutdown hooks
// ----------------------------------------------------------------------------
// Registers handlers so the orchestrator can close its external connections
// cleanly when PM2 (or a dev Ctrl+C) sends SIGINT/SIGTERM. Without this,
// the Playwright Chromium browser can leak on shutdown (stale chromium
// processes accumulating on the droplet), and in-flight Supabase realtime
// subscriptions may hang the process exit.
//
// Called from index.ts after startTickLoop(). Safe to import multiple times;
// only the first call registers handlers.
// ============================================================================

let registered = false;
const closers: Array<() => Promise<void>> = [];

export function registerCloser(fn: () => Promise<void>): void {
  closers.push(fn);
}

export function registerShutdown(): void {
  if (registered) return;
  registered = true;

  const shutdown = async (signal: string) => {
    console.log(`\n[shutdown] received ${signal}; closing ${closers.length} resources...`);
    const timeout = setTimeout(() => {
      console.warn("[shutdown] graceful close timed out after 8s; forcing exit");
      process.exit(1);
    }, 8000);
    for (const closer of closers) {
      try {
        await closer();
      } catch (err) {
        console.warn(`[shutdown] closer threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    clearTimeout(timeout);
    console.log("[shutdown] clean exit");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
