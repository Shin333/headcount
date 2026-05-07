// ============================================================================
// dispatcher/index.ts — Public exports for the dispatcher module.
//
// Plan ref: 2026-05-07-phase2-dispatcher.md Task 2.1.
// ============================================================================

export { startDispatcherServer, buildApp } from "./server.js";
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
} from "./types.js";
