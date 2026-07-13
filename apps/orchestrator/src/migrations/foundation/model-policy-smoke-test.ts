// ============================================================================
// model-policy-smoke-test.ts — Synthetic verification for the fleet-model fix
// (dispatcher/model-policy.ts). No I/O, no env required — mirrors the pure
// style of retry-smoke-test.ts.
//
// Proves the three behaviors Shin asked to see, plus the guardrails:
//   A) a default run resolves to Opus 4.8 (NOT Fable);
//   B) a hard Opus rate-limit fails over to GPT-5.6 via Codex — and ONLY on a
//      rate-limit, never on a real error;
//   C) "use Fable 5 …" still routes explicitly to Fable;
//   D) the auto-failover target is never Fable;
//   E) the failover volume cap and exponential backoff behave.
//
// CLI:
//   pnpm tsx apps/orchestrator/src/migrations/foundation/model-policy-smoke-test.ts
// ============================================================================

import {
  CODEX_FALLBACK_MODEL,
  DEFAULT_CLAUDE_MODEL,
  createFailoverBudget,
  isFableModel,
  isRateLimitErrorMessage,
  rateLimitBackoffMs,
  resolveClaudeModel,
  shouldFailoverToCodex,
} from "../../dispatcher/model-policy.js";

interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: CaseResult[] = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? "✓ PASS" : "✗ FAIL"}  ${name} — ${detail}`);
}

// ---------------------------------------------------------------------------
// A) Default run resolves to Opus 4.8, never Fable.
// ---------------------------------------------------------------------------
function caseDefaultIsOpus(): void {
  const resolved = resolveClaudeModel(undefined);
  const alsoEmpty = resolveClaudeModel("   ");
  const pass =
    resolved === "claude-opus-4-8" &&
    resolved === DEFAULT_CLAUDE_MODEL &&
    alsoEmpty === "claude-opus-4-8" &&
    !isFableModel(resolved);
  record(
    "A default run uses Opus 4.8 (not Fable)",
    pass,
    `resolve(∅)=${resolved} resolve('  ')=${alsoEmpty} isFable=${isFableModel(resolved)}`,
  );
}

// ---------------------------------------------------------------------------
// C) Explicit "use Fable 5 …" still routes to Fable.
// ---------------------------------------------------------------------------
function caseFableIsOptIn(): void {
  const resolved = resolveClaudeModel("claude-fable-5");
  const pass = resolved === "claude-fable-5" && isFableModel(resolved);
  record(
    'C explicit "use Fable 5" routes to Fable',
    pass,
    `resolve('claude-fable-5')=${resolved} isFable=${isFableModel(resolved)}`,
  );
}

// ---------------------------------------------------------------------------
// D) The auto-failover target is GPT-5.6 via Codex — and never Fable.
// ---------------------------------------------------------------------------
function caseTargetNeverFable(): void {
  const pass =
    CODEX_FALLBACK_MODEL === "gpt-5.6-terra" &&
    !isFableModel(CODEX_FALLBACK_MODEL) &&
    /gpt-5\.6/i.test(CODEX_FALLBACK_MODEL);
  record(
    "D auto-failover target is GPT-5.6 via Codex, never Fable",
    pass,
    `target=${CODEX_FALLBACK_MODEL} isFable=${isFableModel(CODEX_FALLBACK_MODEL)}`,
  );
}

// ---------------------------------------------------------------------------
// B) Failover triggers on a HARD rate-limit only — never on a real error.
// ---------------------------------------------------------------------------
function caseRateLimitOnlyTrigger(): void {
  const hardRL = shouldFailoverToCodex({ status: "failed", hardRateLimit: true });
  const realErr = shouldFailoverToCodex({ status: "failed", hardRateLimit: false });
  const bareFail = shouldFailoverToCodex({ status: "failed" });
  const completedRL = shouldFailoverToCodex({ status: "completed", hardRateLimit: true });
  const cancelled = shouldFailoverToCodex({ status: "cancelled", hardRateLimit: true });
  const msgMatch =
    isRateLimitErrorMessage("rate limit exceeded") &&
    isRateLimitErrorMessage("HTTP 429 rate_limit") &&
    !isRateLimitErrorMessage("TypeError: undefined is not a function") &&
    !isRateLimitErrorMessage(undefined);
  const pass =
    hardRL === true &&
    realErr === false &&
    bareFail === false &&
    completedRL === false &&
    cancelled === false &&
    msgMatch;
  record(
    "B failover triggers on hard rate-limit ONLY (not real errors)",
    pass,
    `hardRL=${hardRL} realErr=${realErr} bareFail=${bareFail} completedRL=${completedRL} cancelled=${cancelled} msgMatch=${msgMatch}`,
  );
}

// ---------------------------------------------------------------------------
// E1) Failover volume cap: allows `cap` in a window, denies beyond, recovers
//     after the window slides.
// ---------------------------------------------------------------------------
function caseFailoverCap(): void {
  const budget = createFailoverBudget({ windowMs: 1000, cap: 2 });
  const a = budget.tryConsume(0).allowed; // 1st
  const b = budget.tryConsume(100).allowed; // 2nd
  const c = budget.tryConsume(200).allowed; // 3rd -> denied
  const afterWindow = budget.tryConsume(1300).allowed; // window slid past 0/100
  const pass = a && b && !c && afterWindow;
  record(
    "E1 failover cap denies beyond N/window and recovers after",
    pass,
    `consume#1=${a} #2=${b} #3=${c} afterWindowSlide=${afterWindow}`,
  );
}

// ---------------------------------------------------------------------------
// E2) Exponential backoff: non-decreasing, escalates, clamps past the tail.
// ---------------------------------------------------------------------------
function caseBackoff(): void {
  const b1 = rateLimitBackoffMs(1);
  const b2 = rateLimitBackoffMs(2);
  const b3 = rateLimitBackoffMs(3);
  const b9 = rateLimitBackoffMs(9); // clamps to the last delay
  const pass = b1 > 0 && b2 > b1 && b3 > b2 && b9 === b3;
  record(
    "E2 backoff escalates then clamps",
    pass,
    `b(1)=${b1} b(2)=${b2} b(3)=${b3} b(9)=${b9}`,
  );
}

function main(): void {
  console.log("> model-policy-smoke-test");
  console.log("");
  caseDefaultIsOpus();
  caseFableIsOptIn();
  caseTargetNeverFable();
  caseRateLimitOnlyTrigger();
  caseFailoverCap();
  caseBackoff();
  console.log("");
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`> ${passed}/${total} cases passed`);
  if (passed !== total) process.exit(1);
}

main();
