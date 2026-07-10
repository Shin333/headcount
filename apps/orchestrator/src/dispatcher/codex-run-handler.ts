// ============================================================================
// dispatcher/codex-run-handler.ts — codex runtime: GPT-5.x via the OpenAI
// Codex CLI on the ChatGPT SUBSCRIPTION login (sanctioned surface, free).
//
// HARD RULES (spec §6.9 extension, Shin 2026-07-10):
//   - Sanctioned surface ONLY: we spawn the official `codex exec` CLI, which
//     authenticates from ~/.codex/auth.json (ChatGPT login). We never lift
//     tokens out of that file or call backend endpoints directly — raw token
//     reuse risks the account.
//   - Never metered by accident: OPENAI_API_KEY is STRIPPED from the child
//     environment so the CLI cannot silently fall back to pay-per-token API
//     billing. If the subscription auth is missing/expired, the run FAILS
//     with a clear message instead of improvising.
//   - Mirrors the Claude path's no-ANTHROPIC_API_KEY invariant.
//
// Event mapping (codex exec --json emits JSONL on stdout):
//   thread.started / turn.started        -> (skipped; run_started is ours)
//   item.completed{agent_message}        -> assistant_message
//   item.completed{command_execution}    -> tool_use (name "Bash")
//   item.completed{reasoning}            -> (skipped; internal)
//   turn.completed                       -> run_completed (final = last
//                                           agent_message text)
//   turn.failed / error                  -> error
// ============================================================================

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { logger } from "../ops/logger.js";
import type { DispatcherSseEvent } from "./types.js";
import type { ResolvedRunRequest } from "./run-handler.js";
import { REPO_ROOT } from "./run-handler.js";

const CODEX_AUTH_FILE = join(homedir(), ".codex", "auth.json");
const CODEX_BIN = process.env.CODEX_EXECUTABLE ?? "codex";
const DEFAULT_MODEL = "gpt-5.6-terra";
const WALL_MS = 30 * 60 * 1000; // same order as claude runs; worker owns retry

/**
 * True iff the box holds a ChatGPT subscription login for Codex.
 * (auth.json with OpenAI tokens — written by `codex login`, chmod 600.)
 */
export function codexSubscriptionReady(): { ok: boolean; reason?: string } {
  if (!existsSync(CODEX_AUTH_FILE)) {
    return {
      ok: false,
      reason: "codex not authenticated — run `codex login --device-auth` on the box",
    };
  }
  try {
    const auth = JSON.parse(readFileSync(CODEX_AUTH_FILE, "utf8")) as {
      tokens?: unknown;
      OPENAI_API_KEY?: string | null;
    };
    if (!auth.tokens) {
      return {
        ok: false,
        reason:
          "codex auth.json has no ChatGPT login tokens (API-key auth would be METERED) — run `codex login --device-auth`",
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: "codex auth.json unreadable" };
  }
}

interface CodexJsonEvent {
  type?: string;
  item?: {
    type?: string;
    text?: string;
    command?: string;
    exit_code?: number;
    aggregated_output?: string;
  };
  error?: { message?: string };
  usage?: Record<string, unknown>;
}

export async function* codexRunHandler(
  request: ResolvedRunRequest,
  runId: string,
  signal?: AbortSignal,
): AsyncGenerator<DispatcherSseEvent> {
  const startedAt = Date.now();
  let seq = 0;
  const nextBase = () => ({
    run_id: runId,
    seq: seq++,
    timestamp: new Date().toISOString(),
  });

  yield {
    type: "run_started",
    ...nextBase(),
    project_id: request.project_id,
    prompt: request.prompt,
    entry_agent_slug: request.entry_agent_slug,
    runtime: "codex",
    model: request.model ?? DEFAULT_MODEL,
  };

  const ready = codexSubscriptionReady();
  if (!ready.ok) {
    // Sanctioned surface unreachable -> fail loudly, never improvise.
    yield {
      type: "error",
      ...nextBase(),
      message: `codex runtime unavailable: ${ready.reason}`,
      recoverable: false,
    };
    return;
  }

  // Strip metered credentials from the child env — subscription auth only.
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;

  const model = request.model ?? DEFAULT_MODEL;
  const args = [
    "exec",
    "--json",
    "-m", model,
    "-C", REPO_ROOT,
    "--skip-git-repo-check",
    "--sandbox", "workspace-write",
    request.prompt,
  ];

  const child = spawn(CODEX_BIN, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const killTimer = setTimeout(() => child.kill("SIGKILL"), WALL_MS);
  const onAbort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });

  let finalText = "";
  let stderrTail = "";
  child.stderr.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-500);
  });

  try {
    const rl = createInterface({ input: child.stdout });
    for await (const line of rl) {
      if (signal?.aborted) break;
      let evt: CodexJsonEvent;
      try {
        evt = JSON.parse(line) as CodexJsonEvent;
      } catch {
        continue; // non-JSON banner lines
      }
      if (evt.type === "item.completed" && evt.item) {
        if (evt.item.type === "agent_message" && typeof evt.item.text === "string") {
          finalText = evt.item.text;
          yield {
            type: "assistant_message",
            ...nextBase(),
            agent_slug: "codex",
            content: evt.item.text,
          };
        } else if (evt.item.type === "command_execution") {
          yield {
            type: "tool_use",
            ...nextBase(),
            agent_slug: "codex",
            tool_name: "Bash",
            tool_use_id: `codex-${runId}-${seq}`,
            input: { command: (evt.item.command ?? "").slice(0, 500) },
          };
        }
      } else if (evt.type === "turn.failed" || evt.type === "error") {
        yield {
          type: "error",
          ...nextBase(),
          message: `codex: ${evt.error?.message ?? "turn failed"}`.slice(0, 300),
          recoverable: false,
        };
        return;
      }
    }

    const exitCode: number = await new Promise((resolve) => {
      if (child.exitCode !== null) resolve(child.exitCode);
      else child.once("close", (code) => resolve(code ?? -1));
    });

    if (signal?.aborted) {
      yield {
        type: "error",
        ...nextBase(),
        message: "cancelled",
        recoverable: false,
        cancelled: true,
      };
      return;
    }
    if (exitCode !== 0) {
      yield {
        type: "error",
        ...nextBase(),
        message: `codex exec exited ${exitCode}: ${stderrTail.slice(-200)}`,
        recoverable: false,
      };
      return;
    }

    yield {
      type: "run_completed",
      ...nextBase(),
      status: "success",
      final_message: finalText || "(codex run produced no final message)",
      duration_ms: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null) child.kill("SIGKILL");
    logger.info(
      { event: "dispatcher.codex_run_done", run_id: runId, model },
      "codex run finished",
    );
  }
}
