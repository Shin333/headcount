// ============================================================================
// dispatcher/types.ts — Public types + request schema for the dispatcher.
//
// Plan ref: 2026-05-07-phase2-dispatcher.md Tasks 2.1, 2.2.
//
// Skeleton-grade today: SSE event payloads carry the fields Phase 4
// (persistence) needs, but the generator that produces them is a 500ms-paced
// placeholder until Task 4.1 wires the SDK.
// ============================================================================

import { z } from "zod";

// ---------------------------------------------------------------------------
// Server bootstrap
// ---------------------------------------------------------------------------

/**
 * Options accepted by `startDispatcherServer`.
 *
 * Port resolution precedence (highest first): explicit `port` option,
 * `DISPATCHER_PORT` env var, then the default 3001.
 */
export interface DispatcherServerOptions {
  port?: number;
}

/**
 * Handle returned by `startDispatcherServer`. Call `stop()` to gracefully
 * shut down the server (closes the listening socket).
 */
export interface DispatcherServerHandle {
  stop: () => Promise<void>;
}

/**
 * Shape returned by `GET /health`. Plain JSON, not SSE.
 */
export interface HealthResponse {
  status: "ok";
  version: string;
  uptime_seconds: number;
}

// ---------------------------------------------------------------------------
// Inbound request: POST /api/run
// ---------------------------------------------------------------------------

/**
 * Zod schema for validating `POST /api/run` request bodies.
 *
 * `entry_agent_slug` is optional here; the server applies the
 * `eleanor-vance` default after validation passes.
 */
export const RunRequestSchema = z.object({
  project_id: z.string().uuid(),
  prompt: z.string().min(1),
  entry_agent_slug: z.string().optional(),
});

export type RunRequest = z.infer<typeof RunRequestSchema>;

/**
 * The shape `enqueue()` consumes after the route has resolved the entry
 * agent: `entry_agent_slug` is defaulted (no longer optional), and `agent_id`
 * is the pre-resolved UUID from the live `agents` table. Phase 4 Task 4.1c
 * moved this resolution out of the worker so bad slugs return HTTP 400
 * immediately rather than as a deferred SSE error event.
 */
export interface ResolvedEnqueueRequest {
  project_id: string;
  prompt: string;
  entry_agent_slug: string;
  agent_id: string;
}

// ---------------------------------------------------------------------------
// SSE event vocabulary
//
// Discriminated union on `type`. Common base fields are present on every
// event: `run_id` (UUID, same across all events of one run), `seq` (sequence
// within the run starting at 0), `timestamp` (ISO 8601).
// ---------------------------------------------------------------------------

interface DispatcherSseEventBase {
  /** UUID assigned at run start, identical on every event of a single run. */
  run_id: string;
  /** 0-based sequence within the run. */
  seq: number;
  /** ISO 8601 timestamp the event was generated. */
  timestamp: string;
}

export interface RunStartedEvent extends DispatcherSseEventBase {
  type: "run_started";
  project_id: string;
  prompt: string;
  entry_agent_slug: string;
}

export interface AssistantMessageEvent extends DispatcherSseEventBase {
  type: "assistant_message";
  agent_slug: string;
  content: string;
}

export interface ToolUseEvent extends DispatcherSseEventBase {
  type: "tool_use";
  agent_slug: string;
  tool_name: string;
  tool_use_id: string;
  input: unknown;
}

export interface ToolResultEvent extends DispatcherSseEventBase {
  type: "tool_result";
  tool_use_id: string;
  output: unknown;
  is_error: boolean;
  /**
   * Text-only extraction of `output` for downstream `project_messages`
   * persistence (Plan 2 Task 4.3). When `output` is an array of content
   * blocks, all `type === 'text'` blocks are concatenated with `\n\n`. If no
   * text blocks are present, falls back to `JSON.stringify(output)`. Empty
   * extractions are allowed; the persistence layer's body NOT-NULL guard
   * skips them.
   */
  content_text: string;
}

export interface SubagentHandoffEvent extends DispatcherSseEventBase {
  type: "subagent_handoff";
  from_agent_slug: string;
  to_agent_slug: string;
  parent_tool_use_id: string;
  /**
   * The prompt being passed INTO the subagent's context — i.e., the
   * `prompt` field of the parent's Agent tool_use input shape (recon Q2:
   * `{description, subagent_type, prompt}`). Phase 4 Task 4.2 uses this to
   * persist a `kind='handoff'` row to project_messages without re-mining
   * the SDK's `user` invocation messages (which carry the same string but
   * are otherwise SSE-redundant — skipped per Task 4.1c).
   */
  invocation_prompt: string;
}

/**
 * Pre-run keepalive event. Emitted while a run waits in the queue.
 * `position` is 0-indexed across the global ordering — the running run
 * occupies position 0; queued runs are at position 1+. `seq` is set to
 * -1 since these events fire before the run's own seq sequence begins.
 */
export interface QueueStatusEvent extends DispatcherSseEventBase {
  type: "queue_status";
  position: number;
  total_queued: number;
  queued_at: string;
}

/**
 * Emitted to all queued runs when the worker fails a daily-budget check.
 * The dispatcher then sleeps until `window_resets_at`. New runs enqueued
 * during the pause receive this event on the next budget check.
 */
export interface BudgetExhaustedEvent extends DispatcherSseEventBase {
  type: "budget_exhausted";
  provider: string;
  usage_count: number;
  cap: number;
  window_resets_at: string;
}

/**
 * Forwarded from the SDK's stream when the underlying provider signals
 * rate-limit pressure (informational, not a failure). The dispatcher logs
 * each occurrence as a soft-signal canary; the route forwards it to the
 * client. NOT persisted to project_messages (per Plan 2 Task 4.2 amendment).
 *
 * Scaffolding only today — the placeholder runHandler doesn't emit these;
 * the real SDK wiring in Phase 4 will surface them.
 */
export interface RateLimitEvent extends DispatcherSseEventBase {
  type: "rate_limit_event";
  provider: string;
  severity: "soft" | "hard";
  details: unknown;
}

export interface RunCompletedEvent extends DispatcherSseEventBase {
  type: "run_completed";
  status: "success" | "error";
  final_message?: string;
  duration_ms: number;
}

export interface ErrorEvent extends DispatcherSseEventBase {
  type: "error";
  message: string;
  recoverable: boolean;
  /**
   * True iff this error originated from a user/client cancellation
   * (route's AbortSignal fired). Distinguishes user-cancelled runs from
   * auth/transient/billing errors per Plan 2 Phase 4 amendment A3 table.
   * Absent → not a cancellation (normal error semantics).
   */
  cancelled?: boolean;
}

export type DispatcherSseEvent =
  | RunStartedEvent
  | AssistantMessageEvent
  | ToolUseEvent
  | ToolResultEvent
  | SubagentHandoffEvent
  | RunCompletedEvent
  | ErrorEvent
  | QueueStatusEvent
  | BudgetExhaustedEvent
  | RateLimitEvent;

// ---------------------------------------------------------------------------
// Queue introspection (GET /api/queue)
// ---------------------------------------------------------------------------

/**
 * Snapshot returned by `GET /api/queue` for operator inspection.
 *
 * `budget_state` reflects the most recent budget check result. `null`
 * before the worker has performed its first check (cold-start).
 */
export interface QueueStatusSnapshot {
  in_flight: {
    run_id: string;
    project_id: string;
    started_at: string;
    current_seq: number;
  } | null;
  queued: Array<{
    run_id: string;
    project_id: string;
    queued_at: string;
  }>;
  total_queued: number;
  budget_state: {
    provider: string;
    allowed: boolean;
    usage_count: number;
    cap: number;
    window_resets_at: string;
  } | null;
}
