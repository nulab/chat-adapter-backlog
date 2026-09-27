import { describe, expect, it, vi } from 'vitest';

import { decideRetry } from './rate-limit.js';

describe('decideRetry', () => {
  it('retries the first 429 when its reset is within a minute', () => {
    const now = 1_000_000_000_000;
    const resetSeconds = String(now / 1000 + 2);

    const decision = decideRetry(0, resetSeconds, now, () => 0);

    expect(decision.shouldRetry).toBe(true);
    expect(decision.waitMs).toBe(2000);
  });

  it('gives up without waiting when the reset is more than a minute away', () => {
    const now = 1_000_000_000_000;
    const resetSeconds = String(now / 1000 + 300);

    const decision = decideRetry(0, resetSeconds, now, () => 0);

    expect(decision.shouldRetry).toBe(false);
    expect(decision.retryAfterSeconds).toBe(300);
  });

  it('gives up on the second 429 even with an imminent reset', () => {
    const now = 1_000_000_000_000;
    const resetSeconds = String(now / 1000 + 1);

    const decision = decideRetry(1, resetSeconds, now, () => 0);

    expect(decision.shouldRetry).toBe(false);
  });

  it('waits the full minute when X-RateLimit-Reset is missing', () => {
    const decision = decideRetry(0, null, 1_000_000_000_000);

    expect(decision.waitMs).toBe(60_000);
    expect(decision.shouldRetry).toBe(true);
  });

  it('waits at least one second and reports retryAfter 1 for a past reset', () => {
    const now = 1_000_000_000_000;

    const decision = decideRetry(0, String(now / 1000 - 10), now, () => 0);

    expect(decision.shouldRetry).toBe(true);
    expect(decision.waitMs).toBe(1_000);
    expect(decision.retryAfterSeconds).toBe(1);
  });

  it('treats an empty reset header as missing and waits the full minute', () => {
    const decision = decideRetry(0, '   ', 1_000_000_000_000, () => 0.5);

    expect(decision.resetAt).toBeUndefined();
    expect(decision.waitMs).toBe(60_000);
    expect(decision.retryAfterSeconds).toBe(60);
  });

  it('adds jitter from zero up to but not including 250 milliseconds', () => {
    const now = 1_000_000_000_000;
    const resetSeconds = String(now / 1000 + 2);

    const lower = decideRetry(0, resetSeconds, now, () => 0);
    const upper = decideRetry(0, resetSeconds, now, () => 1);

    expect(lower.waitMs).toBe(2_000);
    expect(upper.waitMs).toBe(2_249);
  });

  it('does not sample jitter when the reset header is missing', () => {
    const random = vi.fn(() => 0.5);

    decideRetry(0, null, 1_000_000_000_000, random);

    expect(random).not.toHaveBeenCalled();
  });
});
