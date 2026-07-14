// ============================================================================
// dispatcher/model-policy.ts — Fleet model-resolution + rate-limit failover
// policy (2026-07-14 fleet-model fix).
//
// Pure, side-effect-free logic (plus one small stateful failover counter) so
// the decisions are unit-testable in isolation (see
// migrations/foundation/model-policy-smoke-test.ts). Deliberately does NOT
// import ../config (which calls loadServerEnv() at module load and process.exit
// s on a missing env) — this module reads process.env directly with local
// parsers and safe defaults, exactly like dispatcher/retry.ts, so the policy
// runs and tests anywhere. The imperative shell that consults codex readiness,
// sleeps for backoff, mutates agent_runs, and alerts the operator lives in
// dispatcher/queue.ts.
//
// Policy (Shin 2026-07-14):
//   1. DEFAULT = Opus 4.8. An absent per-run model hint resolves to the pinned
//      default, NOT the SDK's always-latest pick (which was Fable).
//   2. Fable is opt-in ONLY. It is reachable solely through an explicit per-run
//      hint ("use Fable 5 …"); it is never a default and never a failover
//      target.
//   3. Fallback chain is exactly two links: Opus 4.8 -> GPT-5.6 via Codex. No
//      Sonnet, no Haiku, no Fable in the auto path.
//   4. Failover triggers on a HARD Claude rate-limit ONLY — never on real
//      errors/bugs.
// ============================================================================

// ---------------------------------------------------------------------------
// Local env parsing (no ../config dependency — see module header).
// ---------------------------------------------------------------------------
function envStr(name: string, fallback: string): string {
  const raw = process.env[name]?.trim();
  return raw && raw.length > 0 ? raw : fallback;
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) || n < 0 ? fallback : n;
}

function envDelays(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => Number.parseInt(p, 10));
  if (parts.length === 0 || parts.some((n) => Number.isNaN(n) || n < 0)) {
    return fallback;
  }
  return parts;
}

/** The absent-model default for the claude runtime (Opus 4.8, pinned). */
export const DEFAULT_CLAUDE_MODEL = envStr(
  "DEFAULT_CLAUDE_MODEL",
  "claude-opus-4-8",
);

/** The sole auto-failover target: GPT-5.6 via the sanctioned Codex surface. */
export const CODEX_FALLBACK_MODEL = envStr(
  "CODEX_FALLBACK_MODEL",
  "gpt-5.6-terra",
);

/** Exponential backoff schedule (ms) applied on a hard Claude rate-limit. */
export const RATE_LIMIT_BACKOFF_MS = envDelays(
  "RATE_LIMIT_BACKOFF_MS",
  [15000, 60000, 240000],
);

/** Rolling-window length for the Codex-failover volume cap (ms). */
export const CODEX_FAILOVER_WINDOW_MS = envPositiveInt(
  "CODEX_FAILOVER_WINDOW_MS",
  3_600_000,
);

/** Max auto-failovers per window before non-critical jobs pause + alert. */
export const CODEX_FAILOVER_MAX_PER_WINDOW = envPositiveInt(
  "CODEX_FAILOVER_MAX_PER_WINDOW",
  10,
);

/**
 * Resolve the model for a claude-runtime run. When the dispatch carries an
 * explicit hint (e.g. "use Fable 5 …" -> "claude-fable-5"), it wins. When
 * absent, we pin the default instead of letting the SDK resolve "latest"
 * (which is Fable) — this is the fix for the whole-fleet-on-Fable regression.
 *
 * NOTE: only apply this on the claude runtime. The codex runtime has its own
 * default (see codex-run-handler.ts).
 */
export function resolveClaudeModel(requestModel?: string | null): string {
  const hint = requestModel?.trim();
  return hint && hint.length > 0 ? hint : DEFAULT_CLAUDE_MODEL;
}

/**
 * True iff `model` names a Fable/Mythos-tier model. Used to assert that the
 * auto-failover target never lands on Fable, and to make the "Fable is opt-in"
 * invariant explicit at the policy layer.
 */
export function isFableModel(model?: string | null): boolean {
  if (!model) return false;
  return /\bfable\b/i.test(model) || /\bmythos\b/i.test(model);
}

/**
 * True iff a dispatcher error message looks like a provider rate-limit signal.
 * run-handler.ts classifies the SDK `rate_limit` error key to the literal
 * "rate limit exceeded"; we also tolerate other rate-limit phrasings.
 */
export function isRateLimitErrorMessage(message?: string | null): boolean {
  if (!message) return false;
  return /rate.?limit/i.test(message);
}

/**
 * The rate-limit-ONLY trigger. Failover is permitted only when the run failed
 * AND the failure carried a hard rate-limit signal. A plain failure (bug,
 * server_error, auth, cancellation) returns false — real errors never fail
 * over, so a Claude bug can't silently start draining the ChatGPT quota.
 */
export function shouldFailoverToCodex(outcome: {
  status: string;
  hardRateLimit?: boolean;
}): boolean {
  return outcome.status === "failed" && outcome.hardRateLimit === true;
}

/**
 * Exponential backoff (ms) for the Nth consecutive hard rate-limit. `streak`
 * is 1-based (1 = first hit this cluster). Trailing streaks reuse the last
 * configured delay. Applied before the worker either fails over or advances to
 * the next run, so the fleet stops instantly re-hammering the wall.
 */
export function rateLimitBackoffMs(streak: number): number {
  const delays = RATE_LIMIT_BACKOFF_MS;
  if (delays.length === 0) return 0;
  const idx = Math.min(Math.max(streak - 1, 0), delays.length - 1);
  return delays[idx] ?? 0;
}

// ---------------------------------------------------------------------------
// Failover volume budget — sliding window. Caps how many auto-failovers fire
// per rolling window so a sustained Claude outage can't silently drain the
// ChatGPT (Codex) subscription quota. On the first denial the caller pauses
// non-critical jobs and alerts the operator.
// ---------------------------------------------------------------------------
export interface FailoverBudget {
  /** Reserve one failover slot at `now` (ms epoch). Prunes the window first. */
  tryConsume(now: number): { allowed: boolean; count: number; cap: number };
  /** Current in-window count (prunes first). */
  count(now: number): number;
}

export function createFailoverBudget(opts: {
  windowMs: number;
  cap: number;
}): FailoverBudget {
  let stamps: number[] = [];
  const prune = (now: number): void => {
    stamps = stamps.filter((t) => now - t < opts.windowMs);
  };
  return {
    tryConsume(now: number) {
      prune(now);
      if (stamps.length >= opts.cap) {
        return { allowed: false, count: stamps.length, cap: opts.cap };
      }
      stamps.push(now);
      return { allowed: true, count: stamps.length, cap: opts.cap };
    },
    count(now: number) {
      prune(now);
      return stamps.length;
    },
  };
}
