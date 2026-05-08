// ============================================================================
// dispatcher/run-handler.ts — Real SDK invocation (Phase 4 Task 4.1b).
//
// Bounded scope: single-turn happy path. Subagent attribution + cancellation
// deferred to 4.1c / 4.1d. Mapping table is in Plan 2 Task 4.1 (post-amendment).
//
// Today: emit `assistant_message` / `tool_use` / `tool_result` / `run_completed`
// / `error` / `rate_limit_event`. Subagent `user` messages with
// `parent_tool_use_id` are skipped with a warn line so the deferral surfaces
// in logs.
//
// `agent_slug` on assistant/tool_use events is approximated as
// `request.entry_agent_slug` for now (the real SDK actor is the
// general-purpose main agent, not Eleanor herself). Task 4.1c handles
// proper attribution via `parent_tool_use_id` mapping.
// ============================================================================

import { existsSync } from "node:fs";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../ops/logger.js";
import type { DispatcherSseEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Repo discovery — query()'s cwd anchors `.claude/agents/*.md` lookup
// ---------------------------------------------------------------------------
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `cwd does not look like the headcount repo (no pnpm-workspace.yaml found from ${process.cwd()})`,
  );
}

const REPO_ROOT = findRepoRoot();

// ---------------------------------------------------------------------------
// Resolved request shape (entry_agent_slug already defaulted by queue.ts)
// ---------------------------------------------------------------------------
export interface ResolvedRunRequest {
  project_id: string;
  prompt: string;
  entry_agent_slug: string;
}

// ---------------------------------------------------------------------------
// Prompt builder — wraps user prompt with a delegation cue so the SDK's
// general-purpose main agent dispatches to the named subagent. Mirrors
// Task 1.2's smoke-test pattern. Phase 4 open question: whether the SDK
// will eventually expose an explicit entry_agent option.
// ---------------------------------------------------------------------------
function buildPrompt(request: ResolvedRunRequest): string {
  return (
    `Use the Agent tool to dispatch to the ${request.entry_agent_slug} subagent. ` +
    request.prompt
  );
}

// ---------------------------------------------------------------------------
// Error classification — maps SDKAssistantMessage.error keys and
// SDKResultError subtypes per the Phase 4 amendment A3 table.
// ---------------------------------------------------------------------------
function classifyAssistantError(errKey: string): {
  message: string;
  recoverable: boolean;
} {
  switch (errKey) {
    case "authentication_failed":
    case "oauth_org_not_allowed":
      return {
        message: `auth error (${errKey}). Run \`claude auth login\` and restart the dispatcher.`,
        recoverable: false,
      };
    case "rate_limit":
      return { message: "rate limit exceeded", recoverable: true };
    case "billing_error":
      return { message: "billing error", recoverable: false };
    case "server_error":
    case "unknown":
    case "invalid_request":
    case "max_output_tokens":
      return { message: `SDK error: ${errKey}`, recoverable: true };
    default:
      return { message: `SDK error: ${errKey}`, recoverable: true };
  }
}

// ---------------------------------------------------------------------------
// Helper types — keep weakly typed against the SDK union to avoid pulling
// in the SDK's full type tree just to discriminate at runtime.
// ---------------------------------------------------------------------------
interface AssistantMessageShape {
  type: "assistant";
  message?: { content?: unknown };
  parent_tool_use_id?: string | null;
  error?: string;
}
interface UserMessageShape {
  type: "user";
  message?: { content?: unknown };
  parent_tool_use_id?: string | null;
}
interface ResultMessageShape {
  type: "result";
  subtype?: string;
  result?: string;
  errors?: string[];
  terminal_reason?: string;
}
interface RateLimitMessageShape {
  type: "rate_limit_event";
  rate_limit_info?: { status?: string };
}

// ---------------------------------------------------------------------------
// runHandler — real impl
// ---------------------------------------------------------------------------
export async function* runHandler(
  request: ResolvedRunRequest,
  runId: string,
): AsyncGenerator<DispatcherSseEvent> {
  const startedAt = Date.now();
  let seq = 0;
  const nextBase = () => ({
    run_id: runId,
    seq: seq++,
    timestamp: new Date().toISOString(),
  });

  // run_started — first event, before any SDK boot
  yield {
    type: "run_started",
    ...nextBase(),
    project_id: request.project_id,
    prompt: request.prompt,
    entry_agent_slug: request.entry_agent_slug,
  };

  let terminated = false;

  try {
    for await (const message of query({
      prompt: buildPrompt(request),
      options: { cwd: REPO_ROOT },
    })) {
      if (terminated) break;
      const m = message as Record<string, unknown> & { type: string };

      // SKIP: all system/* messages (init, hook_*, task_*, notification, auth_status, ...)
      if (m.type === "system") continue;

      // ASSISTANT
      if (m.type === "assistant") {
        const am = m as unknown as AssistantMessageShape;

        // Inline error → terminal
        if (am.error) {
          const cls = classifyAssistantError(am.error);
          yield {
            type: "error",
            ...nextBase(),
            message: cls.message,
            recoverable: cls.recoverable,
          };
          terminated = true;
          break;
        }

        const content = am.message?.content;
        if (Array.isArray(content)) {
          let textBuf = "";
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              textBuf += b.text;
            } else if (b.type === "tool_use") {
              if (textBuf.length > 0) {
                yield {
                  type: "assistant_message",
                  ...nextBase(),
                  agent_slug: request.entry_agent_slug,
                  content: textBuf,
                };
                textBuf = "";
              }
              yield {
                type: "tool_use",
                ...nextBase(),
                agent_slug: request.entry_agent_slug,
                tool_name: (b.name as string | undefined) ?? "?",
                tool_use_id: (b.id as string | undefined) ?? "",
                input: b.input ?? {},
              };
            }
          }
          if (textBuf.length > 0) {
            yield {
              type: "assistant_message",
              ...nextBase(),
              agent_slug: request.entry_agent_slug,
              content: textBuf,
            };
          }
        }
        continue;
      }

      // USER
      if (m.type === "user") {
        const um = m as unknown as UserMessageShape;

        // Subagent context message — DEFERRED to 4.1c
        if (um.parent_tool_use_id != null) {
          logger.warn(
            {
              event: "dispatcher.deferred.subagent_user_message",
              run_id: runId,
              parent_tool_use_id: um.parent_tool_use_id,
            },
            "subagent user message; persistence deferred to Task 4.1c",
          );
          continue;
        }

        // Top-level user message carrying tool_result blocks (subagent
        // returned to parent context).
        const content = um.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === "tool_result") {
              yield {
                type: "tool_result",
                ...nextBase(),
                tool_use_id: (b.tool_use_id as string | undefined) ?? "",
                output: b.content ?? null,
                is_error: b.is_error === true,
              };
            }
          }
        }
        continue;
      }

      // RESULT — terminal in either branch
      if (m.type === "result") {
        const rm = m as unknown as ResultMessageShape;
        if (rm.subtype === "success") {
          yield {
            type: "run_completed",
            ...nextBase(),
            status: "success",
            final_message: typeof rm.result === "string" ? rm.result : "",
            duration_ms: Date.now() - startedAt,
          };
        } else {
          const subtype = rm.subtype ?? "unknown";
          const errs = Array.isArray(rm.errors) ? rm.errors.join("; ") : "";
          const terminal = rm.terminal_reason ?? "";
          yield {
            type: "error",
            ...nextBase(),
            message: `result/${subtype}${errs ? `: ${errs}` : ""}${terminal ? ` (${terminal})` : ""}`,
            recoverable: true,
          };
        }
        terminated = true;
        break;
      }

      // RATE LIMIT — informational, forward + log; does not terminate
      if (m.type === "rate_limit_event") {
        const re = m as unknown as RateLimitMessageShape;
        const status = re.rate_limit_info?.status ?? "unknown";
        const severity: "soft" | "hard" =
          status === "rejected" ? "hard" : "soft";
        yield {
          type: "rate_limit_event",
          ...nextBase(),
          provider: "claude",
          severity,
          details: re.rate_limit_info ?? null,
        };
        continue;
      }

      // Unknown variant
      logger.warn(
        {
          event: "dispatcher.unknown_sdk_message",
          sdk_type: m.type,
          run_id: runId,
        },
        "unknown SDK message type; skipping",
      );
    }
  } catch (e) {
    const err = e as Error;
    yield {
      type: "error",
      ...nextBase(),
      message: err.message ?? "SDK iteration threw",
      recoverable: false,
    };
  }
}
