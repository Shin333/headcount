// ============================================================================
// dispatcher/types.ts — Public types for the Phase 2 dispatcher module.
//
// These shapes are the contract Phase 2 nails down so Phase 4 (persistence)
// and the dashboard wiring can target them stably. Stubs for now; payloads
// fill in as later tasks need them.
//
// Plan ref: 2026-05-07-phase2-dispatcher.md Tasks 2.1, 2.2.
// ============================================================================

/**
 * Options accepted by `startDispatcherServer`.
 *
 * Port resolution precedence (highest first): explicit `port` option,
 * `DISPATCHER_PORT` env var, then the default 3001.
 */
export interface DispatcherServerOptions {
  /** Override port. If unset, falls back to `DISPATCHER_PORT` env var, then 3001. */
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
 * Inbound payload for `POST /api/run` (Plan 2 Task 2.2).
 * Matches the contract the dashboard will call against.
 */
export interface RunRequest {
  /** Project this run belongs to. */
  project_id: string;
  /** User-issued prompt that initiates the run. */
  prompt: string;
  /** Optional override; defaults to `eleanor-vance` (the spec entry router). */
  entry_agent_slug?: string;
}

// ----------------------------------------------------------------------------
// SSE event vocabulary (Plan 2 Task 2.2)
//
// Discriminated union on `type`. Each variant currently carries minimal
// fields; full payloads are filled in during Tasks 2.2 (skeleton emit) and
// Phase 4 (persistence-driven shapes).
// ----------------------------------------------------------------------------

interface DispatcherSseEventBase {
  /** ISO-8601 timestamp the dispatcher emitted this event. */
  emitted_at: string;
}

export interface RunStartedEvent extends DispatcherSseEventBase {
  type: "run_started";
  project_id: string;
  run_id: string;
}

export interface AssistantMessageEvent extends DispatcherSseEventBase {
  type: "assistant_message";
  // Body fills in during Task 2.2 / Phase 4 (mapped from SDK assistant text content).
}

export interface ToolUseEvent extends DispatcherSseEventBase {
  type: "tool_use";
  // Body fills in during Task 2.2 / Phase 4 (tool name + input preview).
}

export interface ToolResultEvent extends DispatcherSseEventBase {
  type: "tool_result";
  // Body fills in during Task 2.2 / Phase 4.
}

export interface SubagentHandoffEvent extends DispatcherSseEventBase {
  type: "subagent_handoff";
  // parent_tool_use_id, target slug, parent run_id fill in during Task 4.3.
}

export interface RunCompletedEvent extends DispatcherSseEventBase {
  type: "run_completed";
  run_id: string;
  status: "success" | "failed";
}

export interface ErrorEvent extends DispatcherSseEventBase {
  type: "error";
  message: string;
}

export type DispatcherSseEvent =
  | RunStartedEvent
  | AssistantMessageEvent
  | ToolUseEvent
  | ToolResultEvent
  | SubagentHandoffEvent
  | RunCompletedEvent
  | ErrorEvent;

/**
 * Shape returned by `GET /health`. Plain JSON, not SSE.
 */
export interface HealthResponse {
  status: "ok";
  version: string;
  uptime_seconds: number;
}
