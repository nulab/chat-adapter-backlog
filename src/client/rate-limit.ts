/**
 * Fixed rather than configurable: neither first-party Chat SDK adapter
 * exposes retry tuning. A runtime that stops a call sooner than `MAX_WAIT_MS`
 * is the deployment's ceiling to raise (D5).
 */
const MAX_RETRIES = 1;
const MAX_WAIT_MS = 60_000;
const MIN_RETRY_WAIT_MS = 1_000;
const MAX_RETRY_JITTER_MS = 250;

/**
 * The emptiness check is not redundant with `Number.isFinite`: `Number('')`
 * and `Number('  ')` are `0`, which would read a blank header as a reset in
 * 1970 rather than as the missing header it is.
 */
function finiteHeaderNumber(header: string | null): number | undefined {
  if (header === null || header.trim().length === 0) {
    return undefined;
  }
  const value = Number(header);
  return Number.isFinite(value) ? value : undefined;
}

export interface RetryDecision {
  shouldRetry: boolean;
  waitMs: number;
  retryAfterSeconds: number;
  /**
   * Returned rather than re-read from the response by the caller so the
   * logged `resetAt` and the computed `waitMs` cannot disagree about the
   * same header.
   */
  resetAt: Date | undefined;
}

/**
 * One retry and a ceiling on the wait, because the wait blocks the caller's
 * promise: past that the caller gets `AdapterRateLimitError` promptly rather
 * than an unbounded stall.
 *
 * The one-second floor stops a past reset — a clock skewed against Backlog's
 * — from becoming an immediate retry into the same exhausted limit, or an
 * error telling the caller to wait zero seconds. A missing header waits
 * exactly `MAX_WAIT_MS` without jitter, because jitter would push it past the
 * ceiling it is compared against.
 */
export function decideRetry(
  attempt: number,
  resetHeader: string | null,
  now: number
): RetryDecision {
  const resetSeconds = finiteHeaderNumber(resetHeader);
  const resetAt =
    resetSeconds === undefined ? undefined : new Date(resetSeconds * 1000);
  const waitMs =
    resetSeconds === undefined
      ? MAX_WAIT_MS
      : Math.max(resetSeconds * 1000 - now, MIN_RETRY_WAIT_MS) +
        retryJitterMs();
  const retryAfterSeconds = Math.ceil(waitMs / 1000);

  if (attempt >= MAX_RETRIES || waitMs > MAX_WAIT_MS) {
    return { shouldRetry: false, waitMs, retryAfterSeconds, resetAt };
  }

  return { shouldRetry: true, waitMs, retryAfterSeconds, resetAt };
}

function retryJitterMs(): number {
  return Math.floor(Math.random() * MAX_RETRY_JITTER_MS);
}
