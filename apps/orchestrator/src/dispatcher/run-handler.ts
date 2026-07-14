// ============================================================================
// dispatcher/run-handler.ts — Real SDK invocation with subagent attribution
// (Phase 4 Tasks 4.1b + 4.1c).
//
// Streams events from the Claude Agent SDK via `query()`, mapping per the
// bounded table in Plan 2 Task 4.1c (post-amendment per Step 0 SDK recon).
//
// Entry-dispatch detection (Task 4.1c). The SDK general-purpose main agent
// is "tier 1" per Spec §5.2.2; its first Agent dispatch into the named entry
// agent is transparent routing — emit `tool_use` for SSE telemetry but no
// `subagent_handoff` and no nested agent_runs row. Detection criterion:
//   (a) message.parent_tool_use_id == null  (from main agent context)
//   (b) block.input.subagent_type == request.entry_agent_slug
//   (c) it is the first Agent tool_use of the run
// All three required to avoid false-matching an inner dispatch that
// coincidentally targets the entry slug.
//
// Subagent attribution. The run-handler maintains `toolUseIdToSlug` so that
// when a nested Agent tool_use is observed (parent_tool_use_id != null on
// the assistant message), the `from_agent_slug` on the emitted
// `subagent_handoff` reflects the actual dispatching agent. The SDK delivers
// subagent text exclusively via `tool_result` blocks on top-level `user`
// messages (per Step 0 recon); we never see subagent text as a separately-
// streamed `assistant` event.
// ============================================================================

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../ops/logger.js";
import { MAIN_ROUTER_SYSTEM_PROMPT } from "./main-router-prompt.js";
import { resolveClaudeModel } from "./model-policy.js";
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

export const REPO_ROOT = findRepoRoot();

// ---------------------------------------------------------------------------
// Resolved request shape. Per Plan 2 amendment 2026-05-09 (main-router pivot),
// `entry_agent_slug` is optional — when set, run-handler appends a one-line
// hint to the SDK system prompt so the main agent dispatches to that agent
// first; when absent, the main agent routes from prompt content alone.
// ---------------------------------------------------------------------------
export interface ResolvedRunRequest {
  project_id: string;
  prompt: string;
  entry_agent_slug?: string;
  /** Runtime powering the run. "claude" (default, Agent SDK on Max
   *  subscription) or "codex" (Codex CLI on ChatGPT subscription) —
   *  both sanctioned, subscription-quota surfaces. */
  runtime?: "claude" | "codex";
  /** Model hint: SDK `model` option on claude; `-m` on codex. */
  model?: string;
  /** Target GitHub repo NAME (from the Jarvis registry, e.g. "dua"). When
   *  set, the run edits that repo: cwd is pointed at its writable clone and
   *  the agent is instructed to branch/commit/push/PR. */
  repo?: string;
  /** Absolute path of the repo's writable clone (e.g. /home/openclaw/repos/dua).
   *  Resolved command-center-side from the registry; validated here before it
   *  becomes the run's cwd. */
  repo_path?: string;
}

// ---------------------------------------------------------------------------
// Per-run working directory. Default = the headcount repo root. When a run
// targets a repo (repo_path set), chdir the SDK there so file edits + git/gh
// land in that clone. Defense: only accept real directories under REPOS_BASE
// (the dispatcher is localhost-only + command-center-trusted, but we never
// chdir to an arbitrary request-supplied path).
// ---------------------------------------------------------------------------
const REPOS_BASE = resolve(
  process.env.JARVIS_REPOS_DIR ??
    join(process.env.HOME ?? "/home/openclaw", "repos"),
);

function resolveRunCwd(request: ResolvedRunRequest, runId: string): string {
  const rp = request.repo_path?.trim();
  if (!rp) return REPO_ROOT;
  const abs = resolve(rp);
  const allowed =
    (abs === REPOS_BASE || abs.startsWith(REPOS_BASE + "/")) &&
    existsSync(abs) &&
    statSync(abs).isDirectory();
  if (allowed) return abs;
  logger.warn(
    { event: "dispatcher.repo_path_rejected", repo_path: rp, run_id: runId },
    "repo_path is not an allowed repo clone under REPOS_BASE; using repo root",
  );
  return REPO_ROOT;
}

/**
 * Builds the SDK `systemPrompt` value for a run. Always appends
 * MAIN_ROUTER_SYSTEM_PROMPT to the `claude_code` preset (preserving the
 * preset's Agent-tool wiring + tool registry). When the request carries a
 * persona-hint slug, an additional one-line directive nudges the main agent
 * to dispatch there first.
 */
function buildSystemPrompt(request: ResolvedRunRequest): {
  type: "preset";
  preset: "claude_code";
  append: string;
} {
  let append = MAIN_ROUTER_SYSTEM_PROMPT;
  if (request.entry_agent_slug) {
    append += `\n\nThe user is addressing ${request.entry_agent_slug} directly; dispatch to ${request.entry_agent_slug} first.`;
  }
  // Repo-editing context. The working directory is already the repo's clone;
  // the agent that actually edits is a dispatched subagent, so instruct the
  // router to RELAY this workflow to whoever it dispatches (route to a
  // Bash-capable engineering persona), and to produce a real PR.
  if (request.repo && request.repo_path) {
    append += `\n\n# Repository-editing task
The working directory is a writable git checkout of the "${request.repo}" repository at ${request.repo_path}. Dispatch to a Bash-capable engineering agent and instruct it, in your Agent-tool prompt, to make the ACTUAL file changes with Write/Edit (real edits, not a description). Do NOT run git or gh and do NOT commit — the command-center opens the PR automatically from the resulting diff once the run finishes. Edit only files inside ${request.repo_path}.`;
  }
  return { type: "preset", preset: "claude_code", append };
}

// ---------------------------------------------------------------------------
// Error classification — maps SDKAssistantMessage.error keys per the
// Plan 2 Phase 4 amendment A3 table.
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

/**
 * Extracts a human-readable string from an SDK tool_result block's `content`
 * for project_messages persistence (Plan 2 Task 4.3). Strategy:
 *   - string passthrough.
 *   - array of content blocks → concatenate `text` fields of `type === 'text'`
 *     blocks with `\n\n`. If no text blocks (e.g., image-only return),
 *     `JSON.stringify` the whole content array as a structural fallback.
 *   - any other shape → `JSON.stringify` (or empty string for null/undefined).
 *
 * Empty strings allowed; the queue-side body NOT-NULL guard handles them.
 */
function extractToolResultText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const texts: string[] = [];
    for (const block of output) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          texts.push(b.text);
        }
      }
    }
    if (texts.length > 0) return texts.join("\n\n");
    return JSON.stringify(output);
  }
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

// ---------------------------------------------------------------------------
// runHandler — emits dispatcher SSE events from a single SDK query().
//
// `signal` (optional) is the route handler's AbortSignal (i.e.,
// `c.req.raw.signal`). When the client disconnects (or the route otherwise
// aborts), this signal fires and we forward it into the SDK via a local
// AbortController on `query()`'s options. The SDK then throws inside the
// for-await; we catch and emit a terminal `error` event with
// `cancelled: true` so the worker can persist `agent_runs.status='cancelled'`
// instead of `'failed'`. Plan 2 Task 4.1d.
// ---------------------------------------------------------------------------
export async function* runHandler(
  request: ResolvedRunRequest,
  runId: string,
  signal?: AbortSignal,
): AsyncGenerator<DispatcherSseEvent> {
  // Runtime switch: "codex" runs delegate wholesale to the Codex CLI handler
  // (ChatGPT subscription surface). Everything below is the claude runtime
  // (Agent SDK on the Max subscription — the default and unchanged path).
  if (request.runtime === "codex") {
    const { codexRunHandler } = await import("./codex-run-handler.js");
    yield* codexRunHandler(request, runId, signal);
    return;
  }

  const startedAt = Date.now();
  let seq = 0;
  const nextBase = () => ({
    run_id: runId,
    seq: seq++,
    timestamp: new Date().toISOString(),
  });

  // Resolve the effective model ONCE. Absent hint -> the pinned default
  // (Opus 4.8), never the SDK's always-latest pick (Fable). An explicit hint
  // ("use Fable 5 …") passes through unchanged — Fable stays opt-in only.
  const effectiveModel = resolveClaudeModel(request.model);

  // Per-run cwd: the target repo's clone when a repo is specified, else the
  // headcount root (validated + sandboxed to REPOS_BASE).
  const runCwd = resolveRunCwd(request, runId);
  if (runCwd !== REPO_ROOT) {
    logger.info(
      { event: "dispatcher.repo_cwd", run_id: runId, repo: request.repo, cwd: runCwd },
      `run editing repo "${request.repo}" in ${runCwd}`,
    );
  }

  // run_started — first event, before any SDK boot. `model` carries the
  // RESOLVED model so surfaces show what actually ran, not an empty default.
  yield {
    type: "run_started",
    ...nextBase(),
    project_id: request.project_id,
    prompt: request.prompt,
    entry_agent_slug: request.entry_agent_slug,
    runtime: "claude",
    model: effectiveModel,
  };

  // Per-run state for entry-dispatch detection + attribution.
  let agentDispatchCount = 0;
  // tool_use_id of an Agent dispatch → the slug of the spawned subagent.
  // Used to resolve `from_agent_slug` on nested subagent_handoff events:
  // when an inner Agent tool_use appears with parent_tool_use_id=X, the
  // dispatching agent's slug is `toolUseIdToSlug.get(X)`.
  const toolUseIdToSlug = new Map<string, string>();
  // One-shot guards for unexpected-shape warns.
  let warnedSubagentAssistant = false;

  let terminated = false;

  // Forward the route's AbortSignal into the SDK via a local controller.
  // The SDK accepts an AbortController instance (not a signal) on
  // `options.abortController` — pattern verified in
  // migrations/foundation/sdk-smoke-test.ts.
  const abortController = new AbortController();
  if (signal) {
    if (signal.aborted) {
      abortController.abort();
    } else {
      signal.addEventListener("abort", () => abortController.abort(), {
        once: true,
      });
    }
  }

  try {
    for await (const message of query({
      prompt: request.prompt,
      options: {
        cwd: runCwd,
        abortController,
        // Fully autonomous, headless dispatch: there is no human to answer a
        // tool-permission prompt. Without this the SDK defaults to "default"
        // mode and Write/Edit/Bash silently deadlock (the agent even reports a
        // false "created (pending approval)"), so repo-edit runs produce no
        // diff and no PR. Safety is enforced elsewhere, not via interactive
        // prompts: cwd is sandboxed to the target clone under REPOS_BASE
        // (resolveRunCwd), the command-center — not the agent — opens the PR,
        // and the CEO approves every merge.
        permissionMode: "bypassPermissions",
        systemPrompt: buildSystemPrompt(request),
        // ALWAYS pass a resolved model. Absent hint -> the pinned default
        // (Opus 4.8); an explicit "use Fable 5 …" hint passes through. Never
        // leave this unset — an unset `model` lets the SDK resolve "latest"
        // (Fable), which is exactly the whole-fleet-on-Fable bug we're fixing.
        model: effectiveModel,
        // On Linux the SDK probes the musl sidecar before the gnu one and
        // pnpm installs both, so a glibc host resolves (and fails to spawn)
        // the musl binary. CLAUDE_CODE_EXECUTABLE pins the correct one.
        ...(process.env.CLAUDE_CODE_EXECUTABLE
          ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_EXECUTABLE }
          : {}),
      },
    })) {
      if (terminated) break;
      const m = message as Record<string, unknown> & { type: string };

      // SKIP: all system/* messages (init, hook_*, task_*, notification, ...)
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

        // Empirically the SDK does NOT surface subagent assistant text into
        // the parent iterator (Step 0 recon — subagent text returns via
        // tool_result on top-level `user` messages instead). If a future SDK
        // version starts surfacing it, log a one-time warn and skip.
        if (am.parent_tool_use_id != null) {
          if (!warnedSubagentAssistant) {
            warnedSubagentAssistant = true;
            logger.warn(
              {
                event: "dispatcher.unexpected.subagent_assistant_message",
                run_id: runId,
                parent_tool_use_id: am.parent_tool_use_id,
              },
              "subagent assistant message observed (not expected per Phase 4 recon); revisit handling",
            );
          }
          continue;
        }

        // From-agent attribution: parent_tool_use_id == null means we're in
        // the SDK main agent's context. Per Plan 2 amendment 2026-05-09
        // (main-router pivot), the main agent IS the dispatcher's router,
        // so root-context narration attributes to the main-router sentinel
        // (slug "main-router"). For subagent contexts (parent_tool_use_id
        // != null), `from_agent_slug` would resolve via `toolUseIdToSlug`,
        // but empirically no such message has been observed.
        const fromSlug = "main-router";

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
                  agent_slug: fromSlug,
                  content: textBuf,
                };
                textBuf = "";
              }
              const toolName = (b.name as string | undefined) ?? "?";
              const toolUseId = (b.id as string | undefined) ?? "";
              yield {
                type: "tool_use",
                ...nextBase(),
                agent_slug: fromSlug,
                tool_name: toolName,
                tool_use_id: toolUseId,
                input: b.input ?? {},
              };

              // Dispatch detection: only the Agent tool spawns subagents.
              if (toolName === "Agent") {
                agentDispatchCount++;
                const input = (b.input as Record<string, unknown> | undefined) ?? {};
                const target =
                  typeof input.subagent_type === "string"
                    ? (input.subagent_type as string)
                    : "";
                const invocationPrompt =
                  typeof input.prompt === "string"
                    ? (input.prompt as string)
                    : "";
                if (target.length > 0) {
                  toolUseIdToSlug.set(toolUseId, target);
                }
                // Per Plan 2 amendment 2026-05-09 (main-router pivot): the
                // SDK main agent is now the dispatcher's router and there is
                // no transparent "entry dispatch" to elide — every Agent
                // tool_use is a real subagent dispatch deserving a nested
                // agent_runs row + handoff project_messages row. The
                // elision branch below is left as a defensive no-op
                // (always false) for git-blame continuity; remove in a
                // Plan 5 cleanup pass.
                const isEntryDispatch = false;
                if (!isEntryDispatch) {
                  // True subagent dispatch (or sibling-dispatch fallback per
                  // amended plan). Emit handoff so the worker INSERTs a
                  // nested agent_runs row + a kind='handoff' project_messages
                  // row (Task 4.2). invocation_prompt body source: the
                  // parent's Agent tool_use input.prompt field.
                  yield {
                    type: "subagent_handoff",
                    ...nextBase(),
                    from_agent_slug: fromSlug,
                    to_agent_slug: target,
                    parent_tool_use_id: toolUseId,
                    invocation_prompt: invocationPrompt,
                  };
                }
              }
            }
          }
          if (textBuf.length > 0) {
            yield {
              type: "assistant_message",
              ...nextBase(),
              agent_slug: fromSlug,
              content: textBuf,
            };
          }
        }
        continue;
      }

      // USER
      if (m.type === "user") {
        const um = m as unknown as UserMessageShape;

        // user with parent_tool_use_id != null carries the invocation prompt
        // INTO the subagent (verbatim copy of the parent's Agent tool_use
        // input.prompt). Redundant with the parent's tool_use event from the
        // SSE consumer's perspective. Skip from SSE; Task 4.2 will persist
        // these as kind='handoff' in project_messages.
        if (um.parent_tool_use_id != null) {
          continue;
        }

        // Top-level user message — typically carries tool_result blocks
        // (the subagent or any tool returning to the parent context).
        const content = um.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === "tool_result") {
              const output = b.content ?? null;
              yield {
                type: "tool_result",
                ...nextBase(),
                tool_use_id: (b.tool_use_id as string | undefined) ?? "",
                output,
                is_error: b.is_error === true,
                content_text: extractToolResultText(output),
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
    // Cancellation: detect by our own controller's state, not by `err.name`
    // (the SDK's AbortError class isn't a stable export). If our controller
    // is aborted at catch time, this throw was caused by the cancel path.
    if (abortController.signal.aborted) {
      yield {
        type: "error",
        ...nextBase(),
        message: "cancelled",
        recoverable: false,
        cancelled: true,
      };
      return;
    }
    yield {
      type: "error",
      ...nextBase(),
      message: err.message ?? "SDK iteration threw",
      recoverable: false,
    };
  }
}
