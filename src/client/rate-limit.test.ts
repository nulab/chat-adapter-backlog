import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';

import { decideRetry } from './rate-limit';

import type { MockInstance } from 'vite-plus/test';

const now = 1_000_000_000_000;

function resetIn(seconds: number): string {
  return String(now / 1000 + seconds);
}

describe('decideRetry', () => {
  let random: MockInstance<() => number>;

  beforeEach(() => {
    random = vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries the first 429 when its reset is within a minute', () => {
    const decision = decideRetry(0, resetIn(2), now);

    expect(decision.shouldRetry).toBe(true);
    expect(decision.waitMs).toBe(2000);
  });

  it('gives up without waiting when the reset is more than a minute away', () => {
    const decision = decideRetry(0, resetIn(300), now);

    expect(decision.shouldRetry).toBe(false);
    expect(decision.retryAfterSeconds).toBe(300);
  });

  it('gives up on the second 429 even with an imminent reset', () => {
    const decision = decideRetry(1, resetIn(1), now);

    expect(decision.shouldRetry).toBe(false);
  });

  it('waits the full minute when X-RateLimit-Reset is missing', () => {
    const decision = decideRetry(0, null, now);

    expect(decision.waitMs).toBe(60_000);
    expect(decision.shouldRetry).toBe(true);
  });

  it('waits at least one second and reports retryAfter 1 for a past reset', () => {
    const decision = decideRetry(0, resetIn(-10), now);

    expect(decision.shouldRetry).toBe(true);
    expect(decision.waitMs).toBe(1_000);
    expect(decision.retryAfterSeconds).toBe(1);
  });

  it('treats an empty reset header as missing and waits the full minute', () => {
    random.mockReturnValue(0.5);

    const decision = decideRetry(0, '   ', now);

    expect(decision.resetAt).toBeUndefined();
    expect(decision.waitMs).toBe(60_000);
    expect(decision.retryAfterSeconds).toBe(60);
  });

  it('adds jitter from zero up to but not including 250 milliseconds', () => {
    const lower = decideRetry(0, resetIn(2), now);
    random.mockReturnValue(0.9999);
    const upper = decideRetry(0, resetIn(2), now);

    expect(lower.waitMs).toBe(2_000);
    expect(upper.waitMs).toBe(2_249);
  });

  it('does not sample jitter when the reset header is missing', () => {
    decideRetry(0, null, now);

    expect(random).not.toHaveBeenCalled();
  });
});
