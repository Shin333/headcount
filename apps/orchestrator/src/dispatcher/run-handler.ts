// ============================================================================
// dispatcher/run-handler.ts — Placeholder run generator (Phase 2 Task 2.2).
//
// PLACEHOLDER: this entire generator gets replaced by real SDK invocation
// in Plan 2 Task 4.1. Today it emits an 8-event sequence at 500ms intervals
// so the SSE wiring, event vocabulary, and attribution chain
// (tool_use → subagent_handoff.parent_tool_use_id → tool_result.tool_use_id)
// can be exercised end-to-end before the dispatcher actually invokes Claude.
// ============================================================================

import { randomUUID } from "node:crypto";
import type { DispatcherSseEvent, RunRequest } from "./types.js";

const STEP_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Yields the placeholder event sequence for a run.
 *
 * @param request  Validated run request (entry_agent_slug already defaulted).
 * @param runId    Pre-allocated run UUID. The server allocates this so the
 *                 outer error handler can reference it even if the generator
 *                 throws before yielding the first event.
 */
export async function* runHandler(
  request: Required<Pick<RunRequest, "project_id" | "prompt" | "entry_agent_slug">>,
  runId: string,
): AsyncGenerator<DispatcherSseEvent> {
  const toolUseId = randomUUID();
  const startedAt = Date.now();
  const entrySlug = request.entry_agent_slug;

  let seq = 0;
  const nextBase = () => ({
    run_id: runId,
    seq: seq++,
    timestamp: new Date().toISOString(),
  });

  // 1. run_started
  yield {
    type: "run_started",
    ...nextBase(),
    project_id: request.project_id,
    prompt: request.prompt,
    entry_agent_slug: entrySlug,
  };
  await sleep(STEP_MS);

  // 2. assistant_message — entry agent receives the prompt
  yield {
    type: "assistant_message",
    ...nextBase(),
    agent_slug: entrySlug,
    content: "[placeholder] entry agent received the prompt",
  };
  await sleep(STEP_MS);

  // 3. tool_use — entry agent dispatches to a subagent via Agent tool
  yield {
    type: "tool_use",
    ...nextBase(),
    agent_slug: entrySlug,
    tool_name: "Agent",
    tool_use_id: toolUseId,
    input: { agent: "tsai-wei-ming", prompt: "[placeholder]" },
  };
  await sleep(STEP_MS);

  // 4. subagent_handoff — attribution edge from parent tool_use to subagent
  yield {
    type: "subagent_handoff",
    ...nextBase(),
    from_agent_slug: entrySlug,
    to_agent_slug: "tsai-wei-ming",
    parent_tool_use_id: toolUseId,
  };
  await sleep(STEP_MS);

  // 5. assistant_message — subagent replies
  yield {
    type: "assistant_message",
    ...nextBase(),
    agent_slug: "tsai-wei-ming",
    content: "[placeholder] subagent response",
  };
  await sleep(STEP_MS);

  // 6. tool_result — subagent's reply lands back as the Agent tool's result
  yield {
    type: "tool_result",
    ...nextBase(),
    tool_use_id: toolUseId,
    output: { summary: "[placeholder]" },
    is_error: false,
  };
  await sleep(STEP_MS);

  // 7. assistant_message — entry agent summarises
  yield {
    type: "assistant_message",
    ...nextBase(),
    agent_slug: entrySlug,
    content: "[placeholder] entry agent summarizing",
  };
  await sleep(STEP_MS);

  // 8. run_completed
  yield {
    type: "run_completed",
    ...nextBase(),
    status: "success",
    final_message: "[placeholder] run completed",
    duration_ms: Date.now() - startedAt,
  };
}
