// ============================================================================
// dispatcher/server.ts — Hono app + bootstrap (Phase 2 Tasks 2.1, 2.2).
//
// Routes today:
//   GET  /health      — liveness/version probe (Task 2.1).
//   POST /api/run     — placeholder SSE event stream (Task 2.2; SDK wiring
//                       lands in Task 4.1).
//
// Plan ref: 2026-05-07-phase2-dispatcher.md Tasks 2.1, 2.2.
// ============================================================================

import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve, type ServerType } from "@hono/node-server";
import { logger } from "../ops/logger.js";
import { runHandler } from "./run-handler.js";
import {
  RunRequestSchema,
  type DispatcherServerHandle,
  type DispatcherServerOptions,
  type ErrorEvent,
  type HealthResponse,
} from "./types.js";

const VERSION = "phase2-dispatcher-v0";
const DEFAULT_PORT = 3001;
const DEFAULT_ENTRY_AGENT_SLUG = "eleanor-vance";

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

  // GET /health
  app.get("/health", (c) => {
    const body: HealthResponse = {
      status: "ok",
      version: VERSION,
      uptime_seconds: uptimeSeconds(),
    };
    return c.json(body);
  });

  // POST /api/run — placeholder SSE skeleton (Task 2.2).
  app.post("/api/run", async (c) => {
    // Parse JSON body. If parse fails, treat as a malformed request.
    const raw = await c.req.json().catch(() => null);
    if (raw == null) {
      return c.json(
        { error: "invalid request", details: "body is not valid JSON" },
        400,
      );
    }

    // Validate against the zod schema.
    const parsed = RunRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", details: parsed.error.issues },
        400,
      );
    }

    // Apply server-side defaults (entry_agent_slug → eleanor-vance).
    const request = {
      project_id: parsed.data.project_id,
      prompt: parsed.data.prompt,
      entry_agent_slug: parsed.data.entry_agent_slug ?? DEFAULT_ENTRY_AGENT_SLUG,
    };

    // Pre-allocate the run_id so the error handler can reference it even if
    // the generator throws before yielding the first event.
    const runId = randomUUID();

    logger.info(
      { event: "dispatcher.run_accepted", run_id: runId, project_id: request.project_id },
      "run accepted",
    );

    // Set the standard SSE response headers. streamSSE sets Content-Type and
    // Cache-Control; the rest are conventional hints for proxies.
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of runHandler(request, runId)) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
        }
      } catch (e) {
        const err = e as Error;
        logger.error(
          { event: "dispatcher.run_error", run_id: runId, err: err.message },
          "run handler threw mid-stream",
        );
        const errorEvent: ErrorEvent = {
          type: "error",
          run_id: runId,
          seq: -1,
          timestamp: new Date().toISOString(),
          message: err.message ?? "internal error",
          recoverable: false,
        };
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify(errorEvent),
        });
      }
    });
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

  // Wait for the underlying http.Server to bind before resolving.
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
