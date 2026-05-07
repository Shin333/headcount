// ============================================================================
// dispatcher/index.ts — Public exports for the dispatcher module.
//
// Plan ref: 2026-05-07-phase2-dispatcher.md Tasks 2.1, 2.2, 3.1.
// ============================================================================

export { startDispatcherServer, buildApp } from "./server.js";
export { enqueue, getStatus } from "./queue.js";
export type {
  DispatcherServerHandle,
  DispatcherServerOptions,
  RunRequest,
  HealthResponse,
  DispatcherSseEvent,
  RunStartedEvent,
  AssistantMessageEvent,
  ToolUseEvent,
  ToolResultEvent,
  SubagentHandoffEvent,
  RunCompletedEvent,
  ErrorEvent,
  QueueStatusEvent,
  BudgetExhaustedEvent,
  QueueStatusSnapshot,
} from "./types.js";
