// ============================================================================
// dispatcher/server.ts — Hono app + bootstrap (Phase 2 Task 2.1).
//
// Bare HTTP scaffold for the dispatcher. One route today (`GET /health`);
// `POST /api/run` skeleton lands in Task 2.2, persistence in Phase 4,
// SDK invocation wiring in Phase 4.
//
// Plan ref: 2026-05-07-phase2-dispatcher.md Task 2.1.
// ============================================================================

import { Hono } from "hono";
import { serve, type ServerType } from "@hono/node-server";
import { logger } from "../ops/logger.js";
import type {
  DispatcherServerHandle,
  DispatcherServerOptions,
  HealthResponse,
} from "./types.js";

const VERSION = "phase2-dispatcher-v0";
const DEFAULT_PORT = 3001;

// Module-level guards for signal-handler registration. These prevent
// double-registration if `startDispatcherServer` is called more than once
// in the same process, and prevent re-entering shutdown if multiple signals
// arrive in quick succession.
let signalsRegistered = false;
let shuttingDown = false;

const startedAt = Date.now();
function uptimeSeconds(): number {
  return Math.floor((Date.now() - startedAt) / 1000);
}

function resolvePort(options: DispatcherServerOptions): number {
  if (typeof options.port === "number" && Number.isFinite(options.port)) {
    return options.port;
  }
  const envPort = process.env.DISPATCHER_PORT;
  if (envPort) {
    const n = Number(envPort);
    if (Number.isFinite(n)) return n;
  }
  return DEFAULT_PORT;
}

export function buildApp(): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    const body: HealthResponse = {
      status: "ok",
      version: VERSION,
      uptime_seconds: uptimeSeconds(),
    };
    return c.json(body);
  });

  return app;
}

/**
 * Boots the dispatcher HTTP server. Resolves once the listener is bound.
 */
export async function startDispatcherServer(
  options: DispatcherServerOptions = {},
): Promise<DispatcherServerHandle> {
  const port = resolvePort(options);
  const app = buildApp();

  const server: ServerType = serve({
    fetch: app.fetch,
    port,
  });

  // Wait for the underlying http.Server to actually be listening before
  // returning, so callers can curl /health immediately without races.
  await new Promise<void>((resolve, reject) => {
    server.once("listening", () => resolve());
    server.once("error", (err) => reject(err));
  });

  logger.info(
    { event: "dispatcher.started", port, version: VERSION },
    `dispatcher started on port ${port}`,
  );

  const handle: DispatcherServerHandle = {
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      logger.info({ event: "dispatcher.stopped" }, "dispatcher stopped");
    },
  };

  registerShutdownHandlers(handle);

  return handle;
}

/**
 * Registers SIGINT/SIGTERM handlers that gracefully stop the dispatcher
 * and exit the process. Idempotent: subsequent calls are no-ops, and
 * concurrent signals only run shutdown once.
 */
function registerShutdownHandlers(handle: DispatcherServerHandle): void {
  if (signalsRegistered) return;
  signalsRegistered = true;

  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(
      { event: "dispatcher.shutdown_signal_received", signal },
      `received ${signal}, shutting down`,
    );
    handle
      .stop()
      .catch((err: unknown) => {
        logger.error(
          { event: "dispatcher.shutdown_error", err: (err as Error).message },
          "error during stop()",
        );
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
}
