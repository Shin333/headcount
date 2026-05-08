// ============================================================================
// dispatcher/server.ts — Hono app + bootstrap (Phase 2 Tasks 2.1, 2.2, 3.1).
//
// Routes:
//   GET  /health      — liveness/version probe (Task 2.1).
//   POST /api/run     — enqueues a run; streams SSE events from the worker
//                       (Tasks 2.2 + 3.1).
//   GET  /api/queue   — queue introspection snapshot (Task 3.1).
//
// SDK invocation wires up in Task 4.1 — the run-handler is still a 500ms
// placeholder generator today.
//
// Plan ref: 2026-05-07-phase2-dispatcher.md Tasks 2.1, 2.2, 3.1.
// ============================================================================

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve, type ServerType } from "@hono/node-server";
import { logger } from "../ops/logger.js";
import { enqueue, getStatus } from "./queue.js";
import { resolveAgentIdBySlug } from "./agent-resolver.js";
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

  // GET /api/queue — queue introspection
  app.get("/api/queue", (c) => {
    return c.json(getStatus());
  });

  // POST /api/run — enqueue and stream SSE
  app.post("/api/run", async (c) => {
    const raw = await c.req.json().catch(() => null);
    if (raw == null) {
      return c.json(
        { error: "invalid request", details: "body is not valid JSON" },
        400,
      );
    }

    const parsed = RunRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "invalid request", details: parsed.error.issues },
        400,
      );
    }

    // Default + pre-resolve entry agent slug → agent_id (Phase 4 Task 4.1c).
    // Bad slug → HTTP 400 before any queue activity, INSERT, SDK call, or
    // budget increment. Worker downstream trusts agent_id is valid.
    const entryAgentSlug =
      parsed.data.entry_agent_slug ?? DEFAULT_ENTRY_AGENT_SLUG;
    let agentId: string | null;
    try {
      agentId = await resolveAgentIdBySlug(entryAgentSlug);
    } catch (e) {
      const err = e as Error;
      logger.error(
        { event: "dispatcher.agent_resolver_error", err: err.message },
        "agent-resolver failed",
      );
      return c.json(
        { error: "agent_resolver_unavailable", message: err.message },
        500,
      );
    }
    if (agentId == null) {
      logger.warn(
        {
          event: "dispatcher.unknown_agent_slug",
          slug: entryAgentSlug,
          project_id: parsed.data.project_id,
        },
        "unknown agent slug; rejecting at HTTP entry",
      );
      return c.json(
        { error: "unknown_agent_slug", slug: entryAgentSlug },
        400,
      );
    }

    // Enqueue the run with pre-resolved agent_id. The queue assigns the
    // runId and returns the events iterable that the worker will push into.
    const { runId, events, cancel } = enqueue({
      project_id: parsed.data.project_id,
      prompt: parsed.data.prompt,
      entry_agent_slug: entryAgentSlug,
      agent_id: agentId,
    });

    logger.info(
      {
        event: "dispatcher.run_accepted",
        run_id: runId,
        project_id: parsed.data.project_id,
      },
      "run accepted",
    );

    // If the client disconnects, signal cancel. Hono's underlying Request
    // exposes an AbortSignal that fires on disconnect (when the platform
    // adapter wires it through — Node adapter does so via http.IncomingMessage
    // close events). If the run hasn't started yet, cancel removes it from
    // the queue. If mid-run, the worker is allowed to finish so persistence
    // (Phase 4) records the full run.
    const abortSignal = c.req.raw.signal;
    if (abortSignal) {
      abortSignal.addEventListener("abort", cancel, { once: true });
    }

    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    return streamSSE(c, async (stream) => {
      try {
        for await (const event of events) {
          await stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
        }
      } catch (e) {
        const err = e as Error;
        logger.error(
          { event: "dispatcher.stream_error", run_id: runId, err: err.message },
          "SSE stream errored",
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
 *
 * Verification gap on Windows local dev — see commit d5ccac7.
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
