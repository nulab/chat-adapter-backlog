import { AdapterRateLimitError } from '@chat-adapter/shared';

/**
 * Fixed rather than configurable (docs/specs/adapter.md D5): neither
 * first-party Chat SDK adapter exposes retry tuning, and a Backlog window is
 * one minute, so a reset is never further off than this ceiling allows for. A
 * runtime that stops a call sooner is the deployment's ceiling to raise.
 */
const MAX_RETRIES = 1;
const MAX_WAIT_MS = 60_000;
const MIN_RETRY_WAIT_MS = 1_000;
const MAX_RETRY_JITTER_MS = 250;

/**
 * An `X-RateLimit-*` header as a number, or `undefined` when there is no
 * number in it.
 *
 * The emptiness check is not redundant with `Number.isFinite`: `Number('')`
 * and `Number('  ')` are `0`, so a header present but blank used to read as
 * epoch zero — a reset in 1970, which is `waitMs` clamped to its floor
 * forever rather than the missing header it is.
 */
function finiteHeaderNumber(header: string | null): number | undefined {
  if (header === null || header.trim().length === 0) {
    return undefined;
  }
  const value = Number(header);
  return Number.isFinite(value) ? value : undefined;
}

export interface RetryDecision {
  /** `true` when the caller should wait `waitMs` and retry the same request. */
  shouldRetry: boolean;
  waitMs: number;
  /** Seconds to report on `AdapterRateLimitError` when `shouldRetry` is `false`. */
  retryAfterSeconds: number;
  /**
   * `X-RateLimit-Reset` as a `Date`, or `undefined` when the header was
   * absent or unparseable. Returned rather than re-read from the response by
   * the caller so the logged `resetAt` and the computed `waitMs` cannot
   * disagree about the same header (docs/specs/adapter.md §8.4).
   */
  resetAt: Date | undefined;
}

/**
 * Decides whether a 429 (or error code 13) should be retried.
 * docs/specs/adapter.md §8.4: wait `max(reset*1000 - now, 1000)` plus jitter,
 * or the full `MAX_WAIT_MS` when `X-RateLimit-Reset` is missing; give up
 * without waiting once `waitMs` exceeds `MAX_WAIT_MS` or retries are
 * exhausted, because
 * Backlog sends no `Retry-After` and a repeated POST could duplicate a
 * comment — retrying past one attempt risks that duplication for no benefit.
 *
 * The one-second floor is not a rounding convenience: a reset already in the
 * past is what a clock skewed against Backlog's, or a window that has not
 * become observable yet, looks like from here, and the unfloored
 * `max(…, 0)` turned both into an immediate retry into the same exhausted limit
 * and an `AdapterRateLimitError` telling the caller to wait zero seconds.
 * Jitter, drawn per call from `random`, spreads the callers a single
 * epoch-second header released in lockstep; a missing header takes exactly
 * `MAX_WAIT_MS` without it, since adding jitter there would exceed the
 * ceiling by construction.
 */
export function decideRetry(
  attempt: number,
  resetHeader: string | null,
  now: number,
  random: () => number = Math.random
): RetryDecision {
  const resetSeconds = finiteHeaderNumber(resetHeader);
  const resetAt =
    resetSeconds === undefined ? undefined : new Date(resetSeconds * 1000);
  const waitMs =
    resetSeconds === undefined
      ? MAX_WAIT_MS
      : Math.max(resetSeconds * 1000 - now, MIN_RETRY_WAIT_MS) +
        retryJitterMs(random());
  const retryAfterSeconds = Math.ceil(waitMs / 1000);

  if (attempt >= MAX_RETRIES || waitMs > MAX_WAIT_MS) {
    return { shouldRetry: false, waitMs, retryAfterSeconds, resetAt };
  }

  return { shouldRetry: true, waitMs, retryAfterSeconds, resetAt };
}

function retryJitterMs(sample: number): number {
  const normalizedRandom = Number.isFinite(sample)
    ? Math.min(Math.max(sample, 0), 1 - Number.EPSILON)
    : 0;
  return Math.floor(normalizedRandom * MAX_RETRY_JITTER_MS);
}

/** Builds the error thrown when a 429 cannot be retried further. */
export function rateLimitError(
  retryAfterSeconds: number
): AdapterRateLimitError {
  return new AdapterRateLimitError('backlog', retryAfterSeconds);
}
