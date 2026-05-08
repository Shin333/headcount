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
import { db } from "../db.js";
import { logger } from "../ops/logger.js";
import { AsyncQueue } from "./async-queue.js";
import { runHandler } from "./run-handler.js";
import { resolveAgentIdBySlug } from "./agent-resolver.js";
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
  ResolvedEnqueueRequest,
} from "./types.js";

const KEEPALIVE_INTERVAL_MS = 5000;
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

interface QueuedRun {
  runId: string;
  request: ResolvedEnqueueRequest;
  events: AsyncQueue<DispatcherSseEvent>;
  queuedAt: string;
  cancelled: boolean;
  keepaliveTimer: NodeJS.Timeout | null;
  /** Route's AbortSignal (Phase 4 Task 4.1d). When this fires, the SDK
   *  query() inside run-handler aborts and emits a `cancelled: true` error
   *  event that the worker translates to `agent_runs.status='cancelled'`. */
  abortSignal?: AbortSignal;
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

export function enqueue(
  request: ResolvedEnqueueRequest,
  abortSignal?: AbortSignal,
): {
  runId: string;
  events: AsyncIterable<DispatcherSseEvent>;
  cancel: () => void;
} {
  const runId = randomUUID();
  const events = new AsyncQueue<DispatcherSseEvent>();
  const queuedAt = new Date().toISOString();
  const run: QueuedRun = {
    runId,
    request,
    events,
    queuedAt,
    cancelled: false,
    keepaliveTimer: null,
    abortSignal,
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
      project_id: request.project_id,
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
 * Drains `runHandler` into the run's AsyncQueue. Tracks outcome by inspecting
 * terminal events (`run_completed` → success, `error` → failure). Returns
 * the outcome so the worker can write the appropriate `agent_runs` UPDATE.
 *
 * Defaults to `failed` if the generator returns done without yielding either
 * terminal event — conservative.
 */
/**
 * Per-run state for nested agent_runs lifecycle + project_messages chain
 * (Phase 4 Tasks 4.1c, 4.2, 4.3). Built up as `subagent_handoff` events
 * flow by; consulted on `tool_result` to close the matching nested
 * agent_runs row, INSERT a `comment` project_messages row attributed to
 * the dispatched subagent and chained via `parent_message_id` to the
 * handoff row; on terminal error/cancellation to fail/cancel any leftovers.
 *
 * Populated incrementally:
 *   - 4.1c sets nestedRunId + agentSlug + startedAt + agentId on
 *     subagent_handoff event observation.
 *   - 4.2 sets handoffMessageId after the handoff project_messages INSERT
 *     succeeds.
 *   - 4.3 reads {agentId, nestedRunId, handoffMessageId} when a tool_result
 *     event matches a tracked dispatch.
 */
interface SubagentDispatchRecord {
  nestedRunId: string;
  agentSlug: string;
  agentId: string;
  startedAt: number;
  /** Null between subagent_handoff event observation and the handoff
   *  project_messages INSERT. After the INSERT, the new row's id; if the
   *  INSERT fails, stays null and the comment row's parent_message_id
   *  becomes null too (degraded but not fatal — chain breaks gracefully). */
  handoffMessageId: string | null;
}

interface IterationOutcome {
  status: "completed" | "failed" | "cancelled";
  errorMessage?: string;
}

/**
 * Inserts one project_messages row. Logs + swallows on error so persistence
 * failures don't kill the run. Returns the new row's id, or null on failure.
 *
 * Body NOT NULL guard: empty bodies are skipped (semantically useless rows;
 * SDK occasionally produces empty result.result on edge paths).
 */
async function insertProjectMessage(args: {
  runId: string;
  projectId: string;
  senderId: string;
  kind: "output" | "handoff" | "comment" | "final";
  body: string;
  /** Optional parent_message_id for `kind='comment'` rows that chain to a
   *  previously-INSERTed `kind='handoff'` row (Plan 2 Task 4.3). null/
   *  undefined leaves the column null (output/handoff/final use this). */
  parentMessageId?: string | null;
}): Promise<string | null> {
  if (args.body.length === 0) return null;
  try {
    const insertRow: Record<string, unknown> = {
      project_id: args.projectId,
      sender_type: "agent",
      sender_id: args.senderId,
      kind: args.kind,
      body: args.body,
      run_id: args.runId,
    };
    if (args.parentMessageId != null) {
      insertRow.parent_message_id = args.parentMessageId;
    }
    const { data, error } = await db
      .from("project_messages")
      .insert(insertRow)
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return (data as { id: string }).id;
  } catch (e) {
    logger.error(
      {
        event: "dispatcher.project_messages_insert_error",
        err: (e as Error).message,
        run_id: args.runId,
        kind: args.kind,
      },
      "failed to insert project_messages row",
    );
    return null;
  }
}

async function iterateRunHandler(
  run: QueuedRun,
  inFlightRef: { current: InFlightRun | null },
): Promise<IterationOutcome> {
  let outcome: IterationOutcome = { status: "failed" };

  // Unified per-run map: tool_use_id → record carrying everything the
  // tool_result handler needs (nested agent_runs id for status UPDATE +
  // duration_ms; agent_id for sender attribution; handoff_message_id for
  // parent_message_id chaining on the comment row). See
  // SubagentDispatchRecord docstring for incremental-population timeline.
  const toolUseDispatch = new Map<string, SubagentDispatchRecord>();

  // Entry-agent sender id — used for output/handoff/final rows. Subagent
  // comment rows resolve sender via the dispatch record's agentId instead.
  const entrySenderId = run.request.agent_id;

  for await (const event of runHandler(run.request, run.runId, run.abortSignal)) {
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

    // Per A4 mapping (Plan 2 Task 4.2): persist text-bearing dispatcher
    // events to project_messages so the dashboard chat view can replay the
    // conversation. tool_use / tool_result / error / rate_limit_event /
    // queue_status / run_started / budget_exhausted have no project_messages
    // row by design (chat view shows what the agent said, not what tooling
    // happened around it).
    if (event.type === "assistant_message") {
      await insertProjectMessage({
        runId: run.runId,
        projectId: run.request.project_id,
        senderId: entrySenderId,
        kind: "output",
        body: event.content,
      });
    } else if (event.type === "run_completed") {
      const finalBody = event.final_message ?? "";
      await insertProjectMessage({
        runId: run.runId,
        projectId: run.request.project_id,
        senderId: entrySenderId,
        kind: "final",
        body: finalBody,
      });
    }

    if (event.type === "subagent_handoff") {
      // Resolve agent_id for the dispatched slug. If unresolved, log + skip
      // both the nested agent_runs INSERT and the handoff project_messages
      // INSERT; the SSE event still flows. Map stays empty for this
      // tool_use_id, so the eventual tool_result won't write a comment row
      // either — acceptable degradation.
      let agentId: string | null = null;
      try {
        agentId = await resolveAgentIdBySlug(event.to_agent_slug);
      } catch (e) {
        logger.error(
          {
            event: "dispatcher.agent_resolver_error",
            run_id: event.run_id,
            err: (e as Error).message,
          },
          "agent-resolver failed during subagent_handoff",
        );
      }
      if (agentId == null) {
        logger.warn(
          {
            event: "dispatcher.unknown_subagent_slug",
            slug: event.to_agent_slug,
            tool_use_id: event.parent_tool_use_id,
            run_id: event.run_id,
          },
          "unknown subagent slug; skipping nested agent_runs + handoff INSERTs",
        );
      } else {
        const nestedRunId = randomUUID();
        const startedAt = Date.now();

        // INSERT nested agent_runs row first so the dispatch record is
        // populated even if the handoff project_messages INSERT fails.
        try {
          const { error: insErr } = await db.from("agent_runs").insert({
            id: nestedRunId,
            agent_id: agentId,
            project_id: run.request.project_id,
            parent_run_id: run.runId,
            status: "running",
          });
          if (insErr) throw new Error(insErr.message);
          toolUseDispatch.set(event.parent_tool_use_id, {
            nestedRunId,
            agentSlug: event.to_agent_slug,
            agentId,
            startedAt,
            handoffMessageId: null,
          });
          logger.info(
            {
              event: "dispatcher.nested_run_started",
              run_id: nestedRunId,
              parent_run_id: run.runId,
              agent_slug: event.to_agent_slug,
              tool_use_id: event.parent_tool_use_id,
            },
            "nested run started",
          );
        } catch (e) {
          logger.error(
            {
              event: "dispatcher.nested_agent_runs_insert_error",
              err: (e as Error).message,
              parent_run_id: run.runId,
              slug: event.to_agent_slug,
            },
            "failed to insert nested agent_runs row",
          );
        }

        // INSERT handoff project_messages row (Task 4.2). Sender attribution
        // for the handoff itself is the entry agent (the dispatcher of the
        // subagent), not the dispatched subagent. Record the new id on the
        // dispatch record so the eventual comment row can chain to it.
        const handoffMessageId = await insertProjectMessage({
          runId: run.runId,
          projectId: run.request.project_id,
          senderId: entrySenderId,
          kind: "handoff",
          body: event.invocation_prompt,
        });
        const rec = toolUseDispatch.get(event.parent_tool_use_id);
        if (rec && handoffMessageId != null) {
          rec.handoffMessageId = handoffMessageId;
        }
      }
    } else if (event.type === "tool_result") {
      // Look up the matching tracked subagent dispatch. Non-Agent
      // tool_results (Bash, Read, etc.) and the entry dispatch's own
      // tool_result return both miss the map — fine, no-op.
      const rec = toolUseDispatch.get(event.tool_use_id);
      if (rec) {
        toolUseDispatch.delete(event.tool_use_id);

        // UPDATE nested agent_runs row to terminal status (Task 4.1c).
        const completionStatus = event.is_error ? "failed" : "completed";
        try {
          const { error: updErr } = await db
            .from("agent_runs")
            .update({
              status: completionStatus,
              completed_at: new Date().toISOString(),
              duration_ms: Date.now() - rec.startedAt,
            })
            .eq("id", rec.nestedRunId);
          if (updErr) throw new Error(updErr.message);
          logger.info(
            {
              event: "dispatcher.nested_run_completed",
              run_id: rec.nestedRunId,
              parent_run_id: run.runId,
              agent_slug: rec.agentSlug,
              status: completionStatus,
            },
            "nested run completed",
          );
        } catch (e) {
          logger.error(
            {
              event: "dispatcher.nested_agent_runs_update_error",
              err: (e as Error).message,
              run_id: rec.nestedRunId,
            },
            "failed to UPDATE nested agent_runs row",
          );
        }

        // INSERT comment project_messages row (Task 4.3). Sender is the
        // dispatched subagent; run_id is the nested run; parent_message_id
        // chains to the handoff row that introduced this subagent. Persist
        // is_error=true returns too — body conveys the failure signal.
        await insertProjectMessage({
          runId: rec.nestedRunId,
          projectId: run.request.project_id,
          senderId: rec.agentId,
          kind: "comment",
          body: event.content_text,
          parentMessageId: rec.handoffMessageId,
        });
      }
    }

    if (event.type === "run_completed") {
      outcome = { status: "completed" };
    } else if (event.type === "error") {
      outcome = {
        status: event.cancelled === true ? "cancelled" : "failed",
        errorMessage: event.message,
      };
    }
  }

  // Failsafe: any nested rows still in 'running' (subagent didn't return
  // before the entry run terminated). If the entry was cancelled, propagate
  // 'cancelled' to the orphans (the user disconnect implicitly cancels every
  // nested subagent that was still running). Otherwise mark them 'failed' so
  // the table doesn't carry stale 'running' rows.
  if (toolUseDispatch.size > 0) {
    const orphanStatus = outcome.status === "cancelled" ? "cancelled" : "failed";
    const completedAt = new Date().toISOString();
    for (const [, rec] of toolUseDispatch) {
      try {
        // Only flip rows that are still 'running' — guards against
        // overwriting nested rows that completed normally between the last
        // tool_result and the entry-run cancellation.
        await db
          .from("agent_runs")
          .update({
            status: orphanStatus,
            completed_at: completedAt,
            duration_ms: Date.now() - rec.startedAt,
          })
          .eq("id", rec.nestedRunId)
          .eq("status", "running");
        logger.warn(
          {
            event: "dispatcher.nested_run_orphaned",
            run_id: rec.nestedRunId,
            parent_run_id: run.runId,
            agent_slug: rec.agentSlug,
            status: orphanStatus,
          },
          `nested run orphaned by entry-run termination; marked ${orphanStatus}`,
        );
      } catch (e) {
        logger.error(
          {
            event: "dispatcher.nested_orphan_update_error",
            err: (e as Error).message,
            run_id: rec.nestedRunId,
          },
          "failed to UPDATE orphaned nested agent_runs row",
        );
      }
    }
  }

  return outcome;
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
    const workerStartedAt = Date.now();

    // agent_id is pre-resolved by the route handler (see server.ts) per Phase 4
    // Task 4.1c. Bad slugs are rejected at HTTP entry with 400 before reaching
    // the worker; nothing more to validate here.
    const agentId = run.request.agent_id;

    // INSERT agent_runs row. Failure short-circuits before any SDK call.
    try {
      const { error: insErr } = await db.from("agent_runs").insert({
        id: run.runId,
        agent_id: agentId,
        project_id: run.request.project_id,
        status: "running",
      });
      if (insErr) throw new Error(insErr.message);
    } catch (e) {
      const err = e as Error;
      run.events.push({
        type: "run_started",
        run_id: run.runId,
        seq: 0,
        timestamp: new Date().toISOString(),
        project_id: run.request.project_id,
        prompt: run.request.prompt,
        entry_agent_slug: run.request.entry_agent_slug,
      });
      run.events.push({
        type: "error",
        run_id: run.runId,
        seq: 1,
        timestamp: new Date().toISOString(),
        message: `failed to record run: ${err.message}`,
        recoverable: false,
      });
      run.events.close();
      logger.error(
        {
          event: "dispatcher.agent_runs_insert_error",
          err: err.message,
          run_id: run.runId,
        },
        "failed to insert agent_runs row; skipping run",
      );
      continue;
    }

    inFlight = {
      runId: run.runId,
      projectId: run.request.project_id,
      startedAt: new Date().toISOString(),
      currentSeq: 0,
    };

    logger.info(
      {
        event: "dispatcher.run_started",
        run_id: run.runId,
        project_id: run.request.project_id,
        agent_id: agentId,
      },
      "run started by worker",
    );

    let outcome: IterationOutcome = { status: "failed" };

    try {
      // Retry wraps the SDK iteration. Events emitted by run-handler before
      // a thrown exception remain in run.events — see scaffolding note below.
      // SCAFFOLDING for Phase 4: retrying re-runs the AsyncGenerator from
      // scratch; events already pushed to run.events would duplicate. Real
      // SDK throws only on stream-drop / network errors before iteration
      // begins. SDK message-level errors (auth, rate_limit) flow as
      // assistant.error / result/error_* events and are translated by
      // run-handler to dispatcher `error` events without retry.
      const inFlightRef = { current: inFlight };
      outcome = await withRetry(() => iterateRunHandler(run, inFlightRef), {
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
        {
          event: "dispatcher.run_completed",
          run_id: run.runId,
          outcome: outcome.status,
        },
        outcome.status === "completed"
          ? "run completed"
          : outcome.status === "cancelled"
            ? "run cancelled mid-flight"
            : "run ended (failed)",
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
      outcome = { status: "failed", errorMessage: e.message };
    }

    // UPDATE agent_runs row with completion metadata.
    try {
      const { error: updErr } = await db
        .from("agent_runs")
        .update({
          status: outcome.status,
          completed_at: new Date().toISOString(),
          duration_ms: Date.now() - workerStartedAt,
        })
        .eq("id", run.runId);
      if (updErr) throw new Error(updErr.message);
    } catch (e) {
      logger.error(
        {
          event: "dispatcher.agent_runs_update_error",
          err: (e as Error).message,
          run_id: run.runId,
        },
        "failed to UPDATE agent_runs",
      );
    }

    run.events.close();
    inFlight = null;

    // Budget increment fires only when the SDK was actually consulted
    // (i.e., we got past the agent-id resolution and INSERT) AND the run
    // was not user-cancelled. Cancelled runs partial-burn API tokens but
    // we don't count them against the daily cap (user-friendlier; revisit
    // if budget accuracy becomes operationally important — Plan 2 Task 4.1d).
    if (outcome.status !== "cancelled") {
      try {
        await incrementBudget(BUDGET_PROVIDER);
        await refreshBudgetState();
      } catch (e) {
        logger.error(
          {
            event: "dispatcher.budget_increment_error",
            err: (e as Error).message,
          },
          "failed to increment rate_budget",
        );
      }
    } else {
      logger.info(
        {
          event: "dispatcher.budget_skip_cancelled",
          run_id: run.runId,
        },
        "skipping budget increment for cancelled run",
      );
    }
  }
}
