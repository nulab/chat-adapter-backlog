import { AdapterRateLimitError } from '@chat-adapter/shared';

import type {
  RateLimitBucket,
  RateLimitSnapshot,
  RateLimitSnapshots,
  RetryOptions,
} from './port.js';

/** The four buckets, in the order the rate-limit page lists them. */
export const RATE_LIMIT_BUCKETS = [
  'read',
  'update',
  'search',
  'icon',
] as const satisfies readonly RateLimitBucket[];

const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_MAX_WAIT_MS = 60_000;
const MIN_RETRY_WAIT_MS = 1_000;
const MAX_RETRY_JITTER_MS = 250;

function finiteHeaderNumber(header: string | null): number | undefined {
  if (header === null || header.trim().length === 0) {
    return undefined;
  }
  const value = Number(header);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Classifies a request into one of the four buckets from
 * https://developer.nulab.com/docs/backlog/rate-limit/, as a function of
 * method and path so an endpoint added later needs no table update
 * (docs/specs/adapter.md §8.1): GET /issues and GET /issues/count spend
 * `search`; the five icon endpoints spend `icon`; every other GET spends
 * `read`; POST/PATCH/DELETE spend `update`.
 */
export function classifyBucket(method: string, path: string): RateLimitBucket {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  if (normalizedMethod !== 'GET') {
    return 'update';
  }

  if (
    /^\/issues\/?(?:\?|$)/.test(normalizedPath) ||
    /^\/issues\/count(?:\?|$)/.test(normalizedPath)
  ) {
    return 'search';
  }

  if (isIconPath(normalizedPath)) {
    return 'icon';
  }

  return 'read';
}

/**
 * The five icon endpoints named in
 * https://developer.nulab.com/docs/backlog/rate-limit/: Space Logo, User
 * Icon, Project Icon, Group Icon, Team Icon.
 */
function isIconPath(path: string): boolean {
  return (
    /^\/space\/image(?:\?|$)/.test(path) ||
    /^\/users\/[^/]+\/icon(?:\?|$)/.test(path) ||
    /^\/projects\/[^/]+\/image(?:\?|$)/.test(path) ||
    /^\/groups\/[^/]+\/icon(?:\?|$)/.test(path) ||
    /^\/teams\/[^/]+\/icon(?:\?|$)/.test(path)
  );
}

/**
 * Tracks the last-observed `X-RateLimit-*` headers per `(host, bucket)`.
 * Limits are per user per minute and differ by plan
 * (https://developer.nulab.com/docs/backlog/rate-limit/), so nothing here is
 * ever hard-coded — a bucket stays undefined until a response reports it.
 */
export class RateLimitTracker {
  private readonly snapshots = new Map<string, RateLimitSnapshots>();

  /**
   * Records the `X-RateLimit-*` headers from a response. Headers are read at
   * the HTTP layer (not from a parsed body) because they arrive on every
   * response, success or error, while a parsed body only exists on success
   * (docs/specs/adapter.md §8.2).
   */
  record(host: string, bucket: RateLimitBucket, headers: Headers): void {
    const limitHeader = headers.get('X-RateLimit-Limit');
    const remainingHeader = headers.get('X-RateLimit-Remaining');
    const resetHeader = headers.get('X-RateLimit-Reset');
    if (
      limitHeader === null ||
      remainingHeader === null ||
      resetHeader === null
    ) {
      return;
    }
    const limit = finiteHeaderNumber(limitHeader);
    const remaining = finiteHeaderNumber(remainingHeader);
    const resetSeconds = finiteHeaderNumber(resetHeader);
    if (
      limit === undefined ||
      remaining === undefined ||
      resetSeconds === undefined
    ) {
      return;
    }
    const snapshot: RateLimitSnapshot = {
      limit,
      remaining,
      reset: new Date(resetSeconds * 1000),
    };
    const forHost = this.snapshots.get(host) ?? {};
    forHost[bucket] = snapshot;
    this.snapshots.set(host, forHost);
  }

  snapshot(host: string): RateLimitSnapshots {
    return { ...(this.snapshots.get(host) ?? {}) };
  }
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
 * docs/specs/adapter.md §8.4: wait `reset*1000 - now`; give up without
 * waiting once `waitMs` exceeds `maxWaitMs` or retries are exhausted, because
 * Backlog sends no `Retry-After` and a repeated POST could duplicate a
 * comment — retrying past one attempt risks that duplication for no benefit.
 * A missing `X-RateLimit-Reset` waits the full `maxWaitMs`.
 */
export function decideRetry(
  attempt: number,
  resetHeader: string | null,
  now: number,
  options: RetryOptions | undefined,
  random: () => number = Math.random
): RetryDecision {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  const resetSeconds = finiteHeaderNumber(resetHeader);
  const resetAt =
    resetSeconds === undefined ? undefined : new Date(resetSeconds * 1000);
  // A past reset can mean clock skew or that the next server window has not
  // become observable yet. Never retry in the same instant, and spread
  // callers that received the same epoch-second header across a bounded
  // quarter-second window. A missing header still uses exactly maxWaitMs: an
  // added jitter would exceed the caller's declared ceiling by construction.
  const waitMs =
    resetSeconds === undefined
      ? maxWaitMs
      : Math.max(resetSeconds * 1000 - now, MIN_RETRY_WAIT_MS) +
        retryJitterMs(random());
  const retryAfterSeconds = Math.ceil(waitMs / 1000);

  if (attempt >= maxRetries || waitMs > maxWaitMs) {
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
