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
import { config } from "../config.js";
import { logger } from "../ops/logger.js";
import { AsyncQueue } from "./async-queue.js";
import { runHandler } from "./run-handler.js";
import { checkBudget, incrementBudget, type BudgetProvider } from "./budget.js";
import {
  withRetry,
  defaultIsAuthError,
  defaultIsTransient,
  createSoftSignalDetector,
} from "./retry.js";
import type {
  DispatcherSseEvent,
  QueueStatusEvent,
  QueueStatusSnapshot,
  RunRequest,
} from "./types.js";

const KEEPALIVE_INTERVAL_MS = 5000;
const DEFAULT_ENTRY_AGENT_SLUG = "eleanor-vance";
const BUDGET_PROVIDER: BudgetProvider = "claude";

// Module-level soft-signal cluster detector. Records transient SDK errors
// across runs; fires `dispatcher.soft_signal_cluster` once per cluster.
const softSignal = createSoftSignalDetector({
  windowMs: config.softSignalClusterWindowMs,
  threshold: config.softSignalClusterThreshold,
  onCluster: (errors) => {
    logger.warn(
      {
        event: "dispatcher.soft_signal_cluster",
        count: errors.length,
        window_ms: config.softSignalClusterWindowMs,
      },
      "transient-error cluster detected — possible rate-limit canary",
    );
  },
});

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
/** Last budget check result, reflected in `getStatus().budget_state`. */
let lastBudgetState: QueueStatusSnapshot["budget_state"] = null;
/** True at startup and any time the worker drains the queue to empty.
 *  Set to false after the first run dequeued from a non-empty wakeup.
 *  Used to skip jitter for the first run after an idle period. */
let firstRunAfterIdle = true;

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
    budget_state: lastBudgetState,
  };
}

// ---------------------------------------------------------------------------
// Worker loop
// ---------------------------------------------------------------------------

/**
 * Refreshes the worker's cached budget state from `checkBudget()`.
 * Stored in module-level `lastBudgetState`, surfaced via `getStatus()`.
 */
async function refreshBudgetState(): Promise<{
  allowed: boolean;
  windowResetsAt: Date;
  usageCount: number;
  cap: number;
}> {
  const result = await checkBudget(BUDGET_PROVIDER);
  lastBudgetState = {
    provider: BUDGET_PROVIDER,
    allowed: result.allowed,
    usage_count: result.usage_count,
    cap: result.cap,
    window_resets_at: result.window_resets_at.toISOString(),
  };
  return {
    allowed: result.allowed,
    windowResetsAt: result.window_resets_at,
    usageCount: result.usage_count,
    cap: result.cap,
  };
}

/** Random delay in [jitterMinMs, jitterMaxMs] inclusive, ms. */
function pickJitterMs(): number {
  const min = config.jitterMinMs;
  const max = config.jitterMaxMs;
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * Drains `runHandler` into the run's AsyncQueue. Logs and forwards
 * rate_limit_event messages from the SDK as scaffolding for Phase 4
 * (the placeholder generator never emits these today).
 */
async function iterateRunHandler(
  run: QueuedRun,
  inFlightRef: { current: InFlightRun | null },
): Promise<void> {
  for await (const event of runHandler(run.request, run.runId)) {
    if (event.type === "rate_limit_event") {
      logger.warn(
        {
          event: "dispatcher.rate_limit_event",
          severity: event.severity,
          provider: event.provider,
          run_id: event.run_id,
        },
        "rate-limit signal from SDK",
      );
    }
    if (inFlightRef.current) inFlightRef.current.currentSeq = event.seq;
    run.events.push(event);
  }
}

async function workerLoop(): Promise<void> {
  logger.info({ event: "dispatcher.worker_started" }, "queue worker started");

  while (true) {
    if (queue.length === 0) {
      // Drained → next run is "first after idle" and skips jitter.
      firstRunAfterIdle = true;
      await waitForWork();
      continue;
    }

    // Budget check before dequeue. If exhausted, broadcast a budget_exhausted
    // event to every queued run and pause until the window resets.
    let budget;
    try {
      budget = await refreshBudgetState();
    } catch (err) {
      logger.error(
        { event: "dispatcher.budget_check_error", err: (err as Error).message },
        "budget check failed; backing off 30s before retry",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 30_000));
      continue;
    }

    if (!budget.allowed) {
      const ts = new Date().toISOString();
      const resetsAt = budget.windowResetsAt.toISOString();
      for (const r of queue) {
        if (r.cancelled) continue;
        r.events.push({
          type: "budget_exhausted",
          run_id: r.runId,
          seq: -1,
          timestamp: ts,
          provider: BUDGET_PROVIDER,
          usage_count: budget.usageCount,
          cap: budget.cap,
          window_resets_at: resetsAt,
        });
      }
      logger.warn(
        {
          event: "dispatcher.budget_exhausted",
          provider: BUDGET_PROVIDER,
          usage_count: budget.usageCount,
          cap: budget.cap,
          window_resets_at: resetsAt,
          queue_length: queue.length,
        },
        "daily budget exhausted; pausing worker until window reset",
      );
      const sleepMs = Math.max(
        1000,
        budget.windowResetsAt.getTime() - Date.now(),
      );
      await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
      continue;
    }

    // Apply jitter before processing each successive run. The first run
    // after an idle period skips this — see firstRunAfterIdle handling.
    if (!firstRunAfterIdle) {
      const jitterMs = pickJitterMs();
      logger.info(
        { event: "dispatcher.jitter_sleep", jitter_ms: jitterMs },
        `jitter sleep ${jitterMs}ms`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, jitterMs));
    }

    const run = queue[0]!;
    if (run.cancelled) {
      queue.shift();
      continue;
    }
    queue.shift();
    stopKeepalive(run);
    firstRunAfterIdle = false;

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
      // SCAFFOLDING for Phase 4. Retrying re-runs the AsyncGenerator from
      // scratch; events already pushed to run.events would duplicate. The
      // placeholder generator never throws so retry never fires today.
      // Phase 4 will refactor to put retry around SDK invocation only,
      // with iterator state preserved across attempts.
      const inFlightRef = { current: inFlight };
      await withRetry(() => iterateRunHandler(run, inFlightRef), {
        maxRetries: config.maxTransientRetries,
        delays: config.transientRetryDelaysMs,
        isAuthError: defaultIsAuthError,
        isTransient: defaultIsTransient,
        onTransientFailure: (err, attempt) => {
          softSignal.recordTransient(err);
          logger.warn(
            {
              event: "dispatcher.transient_retry",
              run_id: run.runId,
              attempt,
              err: (err as Error).message,
            },
            "transient error; retrying",
          );
        },
      });
      logger.info(
        { event: "dispatcher.run_completed", run_id: run.runId },
        "run completed",
      );
    } catch (err) {
      const e = err as Error;
      const auth = defaultIsAuthError(err);
      logger.error(
        {
          event: "dispatcher.run_error",
          run_id: run.runId,
          err: e.message,
          auth_error: auth,
        },
        auth
          ? "auth error — operator must re-`claude auth login`"
          : "worker run failed after retries",
      );
      run.events.push({
        type: "error",
        run_id: run.runId,
        seq: -1,
        timestamp: new Date().toISOString(),
        message: auth
          ? `auth error: ${e.message ?? "unauthorized"}. Run \`claude auth login\` and restart the dispatcher.`
          : e.message ?? "internal error",
        recoverable: !auth,
      });
    } finally {
      run.events.close();
      inFlight = null;
      // Increment regardless of run outcome — the SDK session was consumed.
      try {
        await incrementBudget(BUDGET_PROVIDER);
        await refreshBudgetState();
      } catch (e) {
        logger.error(
          { event: "dispatcher.budget_increment_error", err: (e as Error).message },
          "failed to increment rate_budget",
        );
      }
    }
  }
}
