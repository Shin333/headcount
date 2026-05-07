// ============================================================================
// dispatcher/queue.ts — Single-worker FIFO queue (Phase 2 Task 3.1).
//
// Module-level singleton. Routes call `enqueue()` which returns:
//   - runId: pre-allocated UUID (used by route for error events).
//   - events: AsyncIterable the route pipes to SSE.
//   - cancel: hook the route calls if the client disconnects before
//             the run starts (mid-flight cancellation lets the worker
//             finish; persistence in Phase 4 still needs to record).
//
// Worker is lazily started on first enqueue and runs forever in the
// process. Spec invariant §6.8: "strictly serial — one Claude Code
// session at a time." Soft-ban prevention.
//
// Plan ref: 2026-05-07-phase2-dispatcher.md Task 3.1.
// ============================================================================

import { randomUUID } from "node:crypto";
import { logger } from "../ops/logger.js";
import { AsyncQueue } from "./async-queue.js";
import { runHandler } from "./run-handler.js";
import type {
  DispatcherSseEvent,
  QueueStatusEvent,
  QueueStatusSnapshot,
  RunRequest,
} from "./types.js";

const KEEPALIVE_INTERVAL_MS = 5000;
const DEFAULT_ENTRY_AGENT_SLUG = "eleanor-vance";

interface ResolvedRequest {
  project_id: string;
  prompt: string;
  entry_agent_slug: string;
}

interface QueuedRun {
  runId: string;
  request: ResolvedRequest;
  events: AsyncQueue<DispatcherSseEvent>;
  queuedAt: string;
  cancelled: boolean;
  keepaliveTimer: NodeJS.Timeout | null;
}

interface InFlightRun {
  runId: string;
  projectId: string;
  startedAt: string;
  currentSeq: number;
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
const queue: QueuedRun[] = [];
let inFlight: InFlightRun | null = null;
let workerStarted = false;
let wakeupResolver: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Worker wakeup
// ---------------------------------------------------------------------------
function wakeWorker(): void {
  if (wakeupResolver) {
    const w = wakeupResolver;
    wakeupResolver = null;
    w();
  }
}

function waitForWork(): Promise<void> {
  return new Promise<void>((resolve) => {
    wakeupResolver = resolve;
  });
}

// ---------------------------------------------------------------------------
// Keepalive: emit queue_status while a run waits
// ---------------------------------------------------------------------------

/**
 * Position is 0-indexed across the global ordering: the in-flight run
 * occupies position 0; queued runs are at 1+. While a run is in the
 * waiting queue, its position therefore = (inFlight ? 1 : 0) + idx.
 */
function computePosition(run: QueuedRun): number {
  const idx = queue.indexOf(run);
  if (idx < 0) return -1; // already dequeued, shouldn't be emitting
  return (inFlight ? 1 : 0) + idx;
}

function emitKeepalive(run: QueuedRun): void {
  if (run.cancelled) return;
  const position = computePosition(run);
  if (position < 0) return;
  const ev: QueueStatusEvent = {
    type: "queue_status",
    run_id: run.runId,
    seq: -1,
    timestamp: new Date().toISOString(),
    position,
    total_queued: queue.length,
    queued_at: run.queuedAt,
  };
  run.events.push(ev);
}

function startKeepalive(run: QueuedRun): void {
  emitKeepalive(run); // immediate
  run.keepaliveTimer = setInterval(() => emitKeepalive(run), KEEPALIVE_INTERVAL_MS);
}

function stopKeepalive(run: QueuedRun): void {
  if (run.keepaliveTimer) {
    clearInterval(run.keepaliveTimer);
    run.keepaliveTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function enqueue(request: RunRequest): {
  runId: string;
  events: AsyncIterable<DispatcherSseEvent>;
  cancel: () => void;
} {
  const runId = randomUUID();
  const resolved: ResolvedRequest = {
    project_id: request.project_id,
    prompt: request.prompt,
    entry_agent_slug: request.entry_agent_slug ?? DEFAULT_ENTRY_AGENT_SLUG,
  };
  const events = new AsyncQueue<DispatcherSseEvent>();
  const queuedAt = new Date().toISOString();
  const run: QueuedRun = {
    runId,
    request: resolved,
    events,
    queuedAt,
    cancelled: false,
    keepaliveTimer: null,
  };

  queue.push(run);
  startKeepalive(run);

  if (!workerStarted) {
    workerStarted = true;
    void workerLoop();
  } else {
    wakeWorker();
  }

  logger.info(
    {
      event: "dispatcher.run_enqueued",
      run_id: runId,
      project_id: resolved.project_id,
      queue_length: queue.length,
    },
    "run enqueued",
  );

  const cancel = (): void => {
    if (run.cancelled) return;
    run.cancelled = true;
    stopKeepalive(run);
    const idx = queue.indexOf(run);
    if (idx >= 0) {
      queue.splice(idx, 1);
      run.events.close();
      logger.info(
        { event: "dispatcher.run_cancelled", run_id: runId, phase: "queued" },
        "queued run cancelled before start",
      );
    } else {
      // Mid-flight: log but let the worker finish. Phase 4 persistence still
      // needs to record what happened. Events go to a dead consumer.
      logger.info(
        { event: "dispatcher.run_cancelled", run_id: runId, phase: "in_flight" },
        "in-flight run abandoned by client (worker continues)",
      );
    }
  };

  return { runId, events, cancel };
}

export function getStatus(): QueueStatusSnapshot {
  return {
    in_flight: inFlight
      ? {
          run_id: inFlight.runId,
          project_id: inFlight.projectId,
          started_at: inFlight.startedAt,
          current_seq: inFlight.currentSeq,
        }
      : null,
    queued: queue.map((r) => ({
      run_id: r.runId,
      project_id: r.request.project_id,
      queued_at: r.queuedAt,
    })),
    total_queued: queue.length,
  };
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

async function workerLoop(): Promise<void> {
  logger.info({ event: "dispatcher.worker_started" }, "queue worker started");

  while (true) {
    if (queue.length === 0) {
      await waitForWork();
      continue;
    }

    const run = queue[0]!;
    if (run.cancelled) {
      queue.shift();
      continue;
    }
    queue.shift();
    stopKeepalive(run);

    inFlight = {
      runId: run.runId,
      projectId: run.request.project_id,
      startedAt: new Date().toISOString(),
      currentSeq: 0,
    };

    logger.info(
      { event: "dispatcher.run_started", run_id: run.runId, project_id: run.request.project_id },
      "run started by worker",
    );

    try {
      for await (const event of runHandler(run.request, run.runId)) {
        if (inFlight) inFlight.currentSeq = event.seq;
        run.events.push(event);
      }
      logger.info(
        { event: "dispatcher.run_completed", run_id: run.runId },
        "run completed",
      );
    } catch (err) {
      const e = err as Error;
      logger.error(
        { event: "dispatcher.run_error", run_id: run.runId, err: e.message },
        "worker run failed",
      );
      run.events.push({
        type: "error",
        run_id: run.runId,
        seq: -1,
        timestamp: new Date().toISOString(),
        message: e.message ?? "internal error",
        recoverable: false,
      });
    } finally {
      run.events.close();
      inFlight = null;
    }
  }
}
