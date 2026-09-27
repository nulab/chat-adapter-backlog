import { describe, expect, it, vi } from 'vitest';

import { decideRetry } from './rate-limit.js';

describe('decideRetry', () => {
  it('retries once when the reset is within maxWaitMs', () => {
    const now = 1_000_000_000_000;
    const resetSeconds = String(now / 1000 + 2);

    const decision = decideRetry(0, resetSeconds, now, undefined, () => 0);

    expect(decision.shouldRetry).toBe(true);
    expect(decision.waitMs).toBe(2000);
  });

  it('gives up without waiting when the wait would exceed maxWaitMs', () => {
    const now = 1_000_000_000_000;
    const resetSeconds = String(now / 1000 + 300);

    const decision = decideRetry(
      0,
      resetSeconds,
      now,
      { maxWaitMs: 60_000 },
      () => 0
    );

    expect(decision.shouldRetry).toBe(false);
    expect(decision.retryAfterSeconds).toBe(300);
  });

  it('gives up once maxRetries attempts have already been made', () => {
    const now = 1_000_000_000_000;
    const resetSeconds = String(now / 1000 + 1);

    const decision = decideRetry(
      1,
      resetSeconds,
      now,
      { maxRetries: 1 },
      () => 0
    );

    expect(decision.shouldRetry).toBe(false);
  });

  it('maxRetries: 0 never retries even with an imminent reset', () => {
    const now = 1_000_000_000_000;
    const resetSeconds = String(now / 1000 + 1);

    const decision = decideRetry(
      0,
      resetSeconds,
      now,
      { maxRetries: 0 },
      () => 0
    );

    expect(decision.shouldRetry).toBe(false);
  });

  it('waits the full maxWaitMs when X-RateLimit-Reset is missing', () => {
    const now = 1_000_000_000_000;

    const decision = decideRetry(0, null, now, {
      maxWaitMs: 60_000,
      maxRetries: 1,
    });

    expect(decision.waitMs).toBe(60_000);
    expect(decision.shouldRetry).toBe(true);
  });

  it('waits at least one second and reports retryAfter 1 for a past reset', () => {
    const now = 1_000_000_000_000;

    const decision = decideRetry(
      0,
      String(now / 1000 - 10),
      now,
      undefined,
      () => 0
    );

    expect(decision.shouldRetry).toBe(true);
    expect(decision.waitMs).toBe(1_000);
    expect(decision.retryAfterSeconds).toBe(1);
  });

  it('treats an empty reset header as missing and waits maxWaitMs', () => {
    const decision = decideRetry(
      0,
      '   ',
      1_000_000_000_000,
      { maxWaitMs: 12_345 },
      () => 0.5
    );

    expect(decision.resetAt).toBeUndefined();
    expect(decision.waitMs).toBe(12_345);
    expect(decision.retryAfterSeconds).toBe(13);
  });

  it('adds jitter from zero up to but not including 250 milliseconds', () => {
    const now = 1_000_000_000_000;
    const resetSeconds = String(now / 1000 + 2);

    const lower = decideRetry(0, resetSeconds, now, undefined, () => 0);
    const upper = decideRetry(0, resetSeconds, now, undefined, () => 1);

    expect(lower.waitMs).toBe(2_000);
    expect(upper.waitMs).toBe(2_249);
  });

  it('does not sample jitter when the reset header is missing', () => {
    const random = vi.fn(() => 0.5);

    decideRetry(0, null, 1_000_000_000_000, undefined, random);

    expect(random).not.toHaveBeenCalled();
  });
});
