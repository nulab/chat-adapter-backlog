import { describe, expect, it, vi } from 'vitest';

import { classifyBucket, decideRetry, RateLimitTracker } from './rate-limit.js';

describe('classifyBucket', () => {
  it('classifies GET /issues as search, not read', () => {
    expect(classifyBucket('GET', '/issues')).toBe('search');
  });

  it('classifies GET /issues/count as search', () => {
    expect(classifyBucket('GET', '/issues/count')).toBe('search');
  });

  it('a pull request list call spends read, not search', () => {
    // Measured: `GET …/pullRequests` and `…/pullRequests/count` decrement
    // `read` while `search` stays put, unlike `GET /issues`
    // (`.claude/rules/backlog-pull-request-facts.md` "Rate limit").
    expect(
      classifyBucket('GET', '/projects/500/git/repositories/700/pullRequests')
    ).toBe('read');
    expect(
      classifyBucket(
        'GET',
        '/projects/500/git/repositories/700/pullRequests/count'
      )
    ).toBe('read');
  });

  it('a pull request comment post spends update', () => {
    expect(
      classifyBucket(
        'POST',
        '/projects/500/git/repositories/700/pullRequests/12/comments'
      )
    ).toBe('update');
  });

  it('classifies any other GET as read', () => {
    expect(classifyBucket('GET', '/issues/8001')).toBe('read');
    expect(classifyBucket('GET', '/projects/500')).toBe('read');
    expect(classifyBucket('GET', '/notifications')).toBe('read');
  });

  it('classifies POST, PATCH and DELETE as update', () => {
    expect(classifyBucket('POST', '/issues')).toBe('update');
    expect(classifyBucket('PATCH', '/issues/8001/comments/1')).toBe('update');
    expect(classifyBucket('DELETE', '/stars/1')).toBe('update');
  });

  it('classifies the five icon endpoints as icon regardless of GET-is-usually-read', () => {
    expect(classifyBucket('GET', '/space/image')).toBe('icon');
    expect(classifyBucket('GET', '/users/100/icon')).toBe('icon');
    expect(classifyBucket('GET', '/projects/500/image')).toBe('icon');
    expect(classifyBucket('GET', '/groups/1/icon')).toBe('icon');
    expect(classifyBucket('GET', '/teams/1/icon')).toBe('icon');
  });

  it('classifies a path with a query string the same as without one', () => {
    expect(classifyBucket('GET', '/issues?count=10')).toBe('search');
    expect(classifyBucket('GET', '/issues/8001?foo=bar')).toBe('read');
  });
});

describe('RateLimitTracker', () => {
  it('records limit, remaining and reset from headers per host and bucket', () => {
    const tracker = new RateLimitTracker();
    tracker.record(
      'example.backlog.com',
      'read',
      new Headers({
        'X-RateLimit-Limit': '600',
        'X-RateLimit-Remaining': '599',
        'X-RateLimit-Reset': '1000000000',
      })
    );

    const snapshot = tracker.snapshot('example.backlog.com');

    expect(snapshot.read).toEqual({
      limit: 600,
      remaining: 599,
      reset: new Date(1_000_000_000_000),
    });
  });

  it('tracks buckets independently: recording update does not affect read', () => {
    const tracker = new RateLimitTracker();
    tracker.record(
      'example.backlog.com',
      'read',
      new Headers({
        'X-RateLimit-Limit': '600',
        'X-RateLimit-Remaining': '599',
        'X-RateLimit-Reset': '1000000000',
      })
    );
    tracker.record(
      'example.backlog.com',
      'update',
      new Headers({
        'X-RateLimit-Limit': '150',
        'X-RateLimit-Remaining': '100',
        'X-RateLimit-Reset': '1000000010',
      })
    );

    const snapshot = tracker.snapshot('example.backlog.com');

    expect(snapshot.read?.remaining).toBe(599);
    expect(snapshot.update?.remaining).toBe(100);
  });

  it('leaves a bucket undefined until a response has reported it', () => {
    const tracker = new RateLimitTracker();
    expect(tracker.snapshot('example.backlog.com').search).toBeUndefined();
  });

  it('ignores a response missing any of the three rate-limit headers', () => {
    const tracker = new RateLimitTracker();
    tracker.record(
      'example.backlog.com',
      'read',
      new Headers({ 'X-RateLimit-Limit': '600' })
    );
    expect(tracker.snapshot('example.backlog.com').read).toBeUndefined();
  });

  it('treats an empty rate-limit header as missing rather than numeric zero', () => {
    const tracker = new RateLimitTracker();
    tracker.record(
      'example.backlog.com',
      'read',
      new Headers({
        'X-RateLimit-Limit': '600',
        'X-RateLimit-Remaining': '599',
        'X-RateLimit-Reset': '',
      })
    );

    expect(tracker.snapshot('example.backlog.com').read).toBeUndefined();
  });
});

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
