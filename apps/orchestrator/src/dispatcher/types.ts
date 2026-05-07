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
}

export interface SubagentHandoffEvent extends DispatcherSseEventBase {
  type: "subagent_handoff";
  from_agent_slug: string;
  to_agent_slug: string;
  parent_tool_use_id: string;
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
}

export type DispatcherSseEvent =
  | RunStartedEvent
  | AssistantMessageEvent
  | ToolUseEvent
  | ToolResultEvent
  | SubagentHandoffEvent
  | RunCompletedEvent
  | ErrorEvent;
