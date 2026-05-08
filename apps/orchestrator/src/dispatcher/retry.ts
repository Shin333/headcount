// ============================================================================
// dispatcher/retry.ts — Retry + soft-signal cluster detection (Phase 2 Task 3.3).
//
// Pure-logic, no I/O of its own. Two exports:
//   - withRetry(): wraps a Promise-returning function with exponential backoff
//     on transient errors; auth errors fail fast.
//   - createSoftSignalDetector(): sliding-window counter that fires once per
//     transient-error cluster, used to spot rate-limit canaries.
//
// Plan ref: 2026-05-07-phase2-dispatcher.md Task 3.3 (amended for rate_limit_event).
// Spec ref: §6.8 — "jitter, exponential backoff, no auth-retry storms".
// ============================================================================

export interface RetryOptions {
  /** Number of retries after the initial attempt (0 = no retries, only initial call). */
  maxRetries: number;
  /** Delay (ms) before each retry. delays[i] applies before retry attempt i+1.
   *  If shorter than maxRetries, the last entry is reused for trailing attempts. */
  delays: number[];
  isAuthError: (err: unknown) => boolean;
  isTransient: (err: unknown) => boolean;
  /** Hook fired on each transient failure that will be retried. */
  onTransientFailure?: (err: unknown, attempt: number) => void;
}

/**
 * Calls `fn`, retrying on transient errors per `options`. Auth errors throw
 * immediately. Non-transient errors throw immediately.
 *
 * The `attempt` arg passed to `onTransientFailure` is 0-indexed: 0 = first
 * call failed, retrying with delays[0]; 1 = second call failed, retrying
 * with delays[1]; etc.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const totalAttempts = options.maxRetries + 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (options.isAuthError(err)) {
        throw err;
      }
      if (!options.isTransient(err)) {
        throw err;
      }
      const isLastAttempt = attempt === options.maxRetries;
      if (isLastAttempt) {
        throw err;
      }
      options.onTransientFailure?.(err, attempt);
      const delayIdx = Math.min(attempt, options.delays.length - 1);
      const delay = options.delays[delayIdx] ?? 0;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
  // Unreachable in practice; loop either returns or throws.
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Default error classifiers
// ---------------------------------------------------------------------------

/**
 * Auth errors (401/403, or message matches /auth|unauthorized|forbidden/i,
 * or SDK-specific error keys `authentication_failed` / `oauth_org_not_allowed`).
 * Also peeks at `err.cause.error` for nested SDK error shapes.
 *
 * These never get retried — the operator needs to re-`claude auth login`.
 */
export function defaultIsAuthError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { status?: unknown; message?: unknown; cause?: unknown };
  if (e.status === 401 || e.status === 403) return true;

  // Collect all message strings worth scanning (top-level + nested cause).
  const haystack: string[] = [];
  if (typeof e.message === "string") haystack.push(e.message);
  if (e.cause && typeof e.cause === "object") {
    const c = e.cause as { error?: unknown; message?: unknown };
    if (typeof c.error === "string") haystack.push(c.error);
    if (typeof c.message === "string") haystack.push(c.message);
  }
  for (const m of haystack) {
    if (/\b(auth|unauthorized|forbidden)\b/i.test(m)) return true;
    if (/(authentication_failed|oauth_org_not_allowed)/i.test(m)) return true;
  }
  return false;
}

/**
 * Transient errors worth retrying: connection resets / timeouts, 5xx,
 * messages mentioning network/timeout/temporarily, or SDK-specific
 * `server_error` / `rate_limit` keys.
 */
export function defaultIsTransient(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { code?: unknown; status?: unknown; message?: unknown };
  if (e.code === "ECONNRESET" || e.code === "ETIMEDOUT") return true;
  if (typeof e.status === "number" && e.status >= 500 && e.status < 600) return true;
  if (typeof e.message === "string") {
    if (/(network|timeout|temporarily)/i.test(e.message)) return true;
    if (/(server_error|rate_limit)/i.test(e.message)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Soft-signal cluster detector
// ---------------------------------------------------------------------------

export interface SoftSignalOptions {
  windowMs: number;
  threshold: number;
  /** Fires once when the buffer first crosses the threshold; refires after
   *  the buffer drops back below threshold and crosses up again. */
  onCluster: (errors: Array<{ err: unknown; ts: number }>) => void;
}

export interface SoftSignalDetector {
  recordTransient: (err: unknown) => void;
  reset: () => void;
}

/**
 * Sliding-window cluster detector. Useful for spotting bursts of rate-limit
 * canaries (multiple transient failures in quick succession suggest the
 * subscription is being throttled).
 */
export function createSoftSignalDetector(
  options: SoftSignalOptions,
): SoftSignalDetector {
  let buffer: Array<{ err: unknown; ts: number }> = [];
  let firedThisCluster = false;

  const prune = (now: number): void => {
    buffer = buffer.filter((e) => now - e.ts <= options.windowMs);
  };

  return {
    recordTransient(err: unknown): void {
      const now = Date.now();
      buffer.push({ err, ts: now });
      prune(now);
      if (buffer.length >= options.threshold) {
        if (!firedThisCluster) {
          firedThisCluster = true;
          options.onCluster([...buffer]);
        }
      } else {
        firedThisCluster = false;
      }
    },
    reset(): void {
      buffer = [];
      firedThisCluster = false;
    },
  };
}
