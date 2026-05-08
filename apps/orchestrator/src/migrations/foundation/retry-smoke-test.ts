// ============================================================================
// retry-smoke-test.ts — Synthetic verification for dispatcher/retry.ts.
//
// Five cases exercise the retry + soft-signal logic without any I/O. Tests
// use shortened delays (100/200/400 ms) so the whole suite runs in <1 second.
//
// Plan ref: 2026-05-07-phase2-dispatcher.md Task 3.3.
//
// CLI:
//   pnpm tsx apps/orchestrator/src/migrations/foundation/retry-smoke-test.ts
// ============================================================================

import {
  withRetry,
  defaultIsAuthError,
  defaultIsTransient,
  createSoftSignalDetector,
} from "../../dispatcher/retry.js";

const SHORT_DELAYS = [100, 200, 400];

interface CaseResult {
  name: string;
  pass: boolean;
  detail: string;
}

const results: CaseResult[] = [];

function record(name: string, pass: boolean, detail: string): void {
  results.push({ name, pass, detail });
  const tag = pass ? "✓ PASS" : "✗ FAIL";
  console.log(`${tag}  ${name} — ${detail}`);
}

function approxEq(actual: number, expected: number, tolerance = 50): boolean {
  return Math.abs(actual - expected) <= tolerance;
}

// ---------------------------------------------------------------------------
// Case 1 — success path: returns immediately, no delays applied.
// ---------------------------------------------------------------------------
async function case1Success(): Promise<void> {
  const start = Date.now();
  const result = await withRetry(async () => 42, {
    maxRetries: 3,
    delays: SHORT_DELAYS,
    isAuthError: defaultIsAuthError,
    isTransient: defaultIsTransient,
  });
  const elapsed = Date.now() - start;
  const pass = result === 42 && elapsed < 50;
  record("case 1 success path", pass, `result=${result} elapsed=${elapsed}ms`);
}

// ---------------------------------------------------------------------------
// Case 2 — transient retry: fails 2x with 503, then succeeds.
// Expected total elapsed ≈ delays[0] + delays[1] = 100 + 200 = 300 ms.
// ---------------------------------------------------------------------------
async function case2TransientRetry(): Promise<void> {
  let calls = 0;
  const start = Date.now();
  const result = await withRetry(
    async () => {
      calls++;
      if (calls < 3) {
        const err: { status: number; message: string } = {
          status: 503,
          message: "service temporarily unavailable",
        };
        throw err;
      }
      return "ok";
    },
    {
      maxRetries: 3,
      delays: SHORT_DELAYS,
      isAuthError: defaultIsAuthError,
      isTransient: defaultIsTransient,
    },
  );
  const elapsed = Date.now() - start;
  const expected = SHORT_DELAYS[0] + SHORT_DELAYS[1];
  const pass = result === "ok" && calls === 3 && approxEq(elapsed, expected, 100);
  record(
    "case 2 transient retry (succeeds on attempt 3)",
    pass,
    `calls=${calls} result=${result} elapsed=${elapsed}ms (expected ~${expected})`,
  );
}

// ---------------------------------------------------------------------------
// Case 3 — retry exhaustion: always fails transient.
// Expected elapsed ≈ sum of delays = 100 + 200 + 400 = 700 ms.
// ---------------------------------------------------------------------------
async function case3RetryExhaustion(): Promise<void> {
  let calls = 0;
  const start = Date.now();
  let threw = false;
  try {
    await withRetry(
      async () => {
        calls++;
        const err: { code: string; message: string } = {
          code: "ECONNRESET",
          message: "network blip",
        };
        throw err;
      },
      {
        maxRetries: 3,
        delays: SHORT_DELAYS,
        isAuthError: defaultIsAuthError,
        isTransient: defaultIsTransient,
      },
    );
  } catch {
    threw = true;
  }
  const elapsed = Date.now() - start;
  const expected = SHORT_DELAYS.reduce((s, d) => s + d, 0);
  // 4 total attempts (initial + 3 retries)
  const pass = threw && calls === 4 && approxEq(elapsed, expected, 100);
  record(
    "case 3 retry exhaustion",
    pass,
    `calls=${calls} threw=${threw} elapsed=${elapsed}ms (expected ~${expected})`,
  );
}

// ---------------------------------------------------------------------------
// Case 4 — auth fail-fast: 401 throws immediately, no retry.
// ---------------------------------------------------------------------------
async function case4AuthFailFast(): Promise<void> {
  let calls = 0;
  const start = Date.now();
  let threw = false;
  try {
    await withRetry(
      async () => {
        calls++;
        const err: { status: number; message: string } = {
          status: 401,
          message: "unauthorized",
        };
        throw err;
      },
      {
        maxRetries: 3,
        delays: SHORT_DELAYS,
        isAuthError: defaultIsAuthError,
        isTransient: defaultIsTransient,
      },
    );
  } catch {
    threw = true;
  }
  const elapsed = Date.now() - start;
  const pass = threw && calls === 1 && elapsed < 50;
  record(
    "case 4 auth fail-fast",
    pass,
    `calls=${calls} threw=${threw} elapsed=${elapsed}ms (expected <50ms, 1 call)`,
  );
}

// ---------------------------------------------------------------------------
// Case 5 — soft-signal cluster: fires once on threshold, debounces, refires
// after reset + threshold reach.
// ---------------------------------------------------------------------------
function case5SoftSignal(): void {
  let fireCount = 0;
  const detector = createSoftSignalDetector({
    windowMs: 60_000,
    threshold: 3,
    onCluster: () => {
      fireCount++;
    },
  });

  const transientErr = { code: "ECONNRESET" };

  // Feed 3 transients → onCluster fires once.
  detector.recordTransient(transientErr);
  detector.recordTransient(transientErr);
  detector.recordTransient(transientErr);
  const afterThree = fireCount;

  // Feed a 4th → does NOT re-fire.
  detector.recordTransient(transientErr);
  const afterFour = fireCount;

  // Reset + feed 3 more → fires again.
  detector.reset();
  detector.recordTransient(transientErr);
  detector.recordTransient(transientErr);
  detector.recordTransient(transientErr);
  const afterReset = fireCount;

  const pass = afterThree === 1 && afterFour === 1 && afterReset === 2;
  record(
    "case 5 soft-signal cluster",
    pass,
    `fires after 3=${afterThree}, after 4=${afterFour}, after reset+3=${afterReset} (expected 1, 1, 2)`,
  );
}

// ---------------------------------------------------------------------------
// Case 6 — SDK-shape auth error fail-fast: thrown Error whose message
// contains `authentication_failed` should be classified as auth and never
// retried. Mirrors the predicate broadening in Phase 4 Task 4.1b Step 3.
// ---------------------------------------------------------------------------
async function case6SDKAuthErrorFailFast(): Promise<void> {
  let calls = 0;
  const start = Date.now();
  let threw = false;
  try {
    await withRetry(
      async () => {
        calls++;
        throw new Error("authentication_failed: bad token");
      },
      {
        maxRetries: 3,
        delays: SHORT_DELAYS,
        isAuthError: defaultIsAuthError,
        isTransient: defaultIsTransient,
      },
    );
  } catch {
    threw = true;
  }
  const elapsed = Date.now() - start;
  const pass = threw && calls === 1 && elapsed < 50;
  record(
    "case 6 SDK-shape auth error fail-fast",
    pass,
    `calls=${calls} threw=${threw} elapsed=${elapsed}ms (expected <50ms, 1 call)`,
  );
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  console.log("> retry-smoke-test");
  console.log("");
  await case1Success();
  await case2TransientRetry();
  await case3RetryExhaustion();
  await case4AuthFailFast();
  case5SoftSignal();
  await case6SDKAuthErrorFailFast();
  console.log("");
  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`> ${passed}/${total} cases passed`);
  if (passed !== total) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`UNHANDLED: ${(e as Error).message}`);
  process.exit(1);
});
