// ============================================================================
// sdk-smoke-test.ts — Phase 2 Task 1.2.
//
// Proves the @anthropic-ai/claude-agent-sdk works in this environment with
// the OAuth-from-`~/.claude/credentials.json` auth path. Forces a subagent
// dispatch to eleanor-vance so we exercise the Agent-tool path that the
// dispatcher will rely on, and surfaces parent_tool_use_id so Task 4.3
// (subagent attribution) can be validated against real SDK output shape.
//
// CLI:
//   pnpm tsx apps/orchestrator/src/migrations/foundation/sdk-smoke-test.ts
//
// Spec ref: §6.9 Auth policy.
// Plan ref: 2026-05-07-phase2-dispatcher.md Task 1.2.
// ============================================================================

import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Repo discovery
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
// Auth guard — spec §6.9 forbids ANTHROPIC_API_KEY in dispatcher env
// ---------------------------------------------------------------------------
if (process.env.ANTHROPIC_API_KEY) {
  console.error(
    "ANTHROPIC_API_KEY is set; this would route through metered API access. " +
      "Unset it and re-run. Auth must come from `~/.claude/credentials.json` per spec §6.9.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Test parameters
// ---------------------------------------------------------------------------
const PROMPT =
  "Use the Agent tool to dispatch to the eleanor-vance subagent. " +
  "Ask her to introduce herself in one sentence as the Chief of Staff at Onepark Digital. " +
  "Then summarize her response in one short sentence.";

const TIMEOUT_MS = 90_000;
const startedAt = Date.now();
function elapsed(): string {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("> sdk-smoke-test");
  console.log(`> cwd:    ${REPO_ROOT}`);
  console.log(`> timeout: ${TIMEOUT_MS / 1000}s`);
  console.log(`> prompt: "${PROMPT}"`);
  console.log("");

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), TIMEOUT_MS);

  let lastMessage: unknown = null;
  let messageCount = 0;
  let sawParentToolUseId = false;
  let resultText: string | null = null;

  try {
    for await (const message of query({
      prompt: PROMPT,
      options: {
        cwd: REPO_ROOT,
        abortController,
      },
    })) {
      messageCount++;
      lastMessage = message;

      const m = message as Record<string, unknown>;
      const type = (m.type as string | undefined) ?? "(no-type)";
      const subtype = m.subtype as string | undefined;
      const subtypeStr = subtype ? `/${subtype}` : "";

      const parentToolUseId = m.parent_tool_use_id as string | undefined;
      const parentTag = parentToolUseId ? ` parent_tool_use_id=${parentToolUseId}` : "";
      if (parentToolUseId) sawParentToolUseId = true;

      console.log(`[${elapsed()}] [${messageCount}] ${type}${subtypeStr}${parentTag}`);

      // Assistant message: log text preview + tool_use targets
      if (type === "assistant") {
        const inner = m.message as { content?: unknown } | undefined;
        const content = inner?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = block as Record<string, unknown>;
            if (b.type === "text" && typeof b.text === "string") {
              const preview = b.text.slice(0, 200).replace(/\s+/g, " ");
              console.log(`           text: "${preview}${b.text.length > 200 ? "…" : ""}"`);
            } else if (b.type === "tool_use") {
              const toolName = (b.name as string | undefined) ?? "(unknown)";
              const input = (b.input as Record<string, unknown> | undefined) ?? {};
              const toolUseId = b.id as string | undefined;
              if (toolName === "Agent" || toolName === "Task") {
                const target =
                  (input.subagent_type as string | undefined) ??
                  (input.agent as string | undefined) ??
                  (input.description as string | undefined) ??
                  "(target unknown)";
                console.log(
                  `           tool_use: ${toolName} → ${target}  (id=${toolUseId ?? "?"})`,
                );
              } else {
                console.log(`           tool_use: ${toolName}  (id=${toolUseId ?? "?"})`);
              }
            }
          }
        }
      }

      // Final result message
      if (type === "result" && typeof m.result === "string") {
        resultText = m.result as string;
        const preview = resultText.slice(0, 400).replace(/\s+/g, " ");
        console.log(`           result: "${preview}${resultText.length > 400 ? "…" : ""}"`);
      }
    }
  } catch (e) {
    clearTimeout(timer);
    if (abortController.signal.aborted) {
      console.error(`\nFATAL: timeout after ${TIMEOUT_MS / 1000}s — no result message`);
      process.exit(2);
    }
    const err = e as Error;
    const errCtor = err.constructor?.name ?? "Error";
    const errMsg = err.message ?? String(err);
    const errStack = err.stack ?? "";
    console.error(`\nFATAL: ${errCtor}: ${errMsg}`);
    if (errStack && errStack !== errMsg) console.error(errStack);
    if (`${errMsg}\n${errStack}`.toLowerCase().includes("zod")) {
      console.error("⚠ ZOD-RELATED ERROR DETECTED");
    }
    process.exit(1);
  }

  clearTimeout(timer);

  // Final assertion
  console.log("");
  console.log(`> messages received: ${messageCount}`);
  console.log(`> elapsed: ${elapsed()}`);
  console.log(`> saw parent_tool_use_id: ${sawParentToolUseId}`);

  const last = lastMessage as Record<string, unknown> | null;
  const lastType = last?.type as string | undefined;
  const lastSubtype = last?.subtype as string | undefined;

  if (lastType !== "result" || lastSubtype !== "success") {
    console.error(
      `\nFAILED: last message was type=${lastType ?? "?"} subtype=${lastSubtype ?? "?"}; expected result/success`,
    );
    process.exit(1);
  }

  console.log("");
  console.log("✓ PASSED: final SDKResultMessage with subtype 'success' received");
}

main().catch((e) => {
  console.error(`UNHANDLED: ${(e as Error).message}`);
  process.exit(1);
});
