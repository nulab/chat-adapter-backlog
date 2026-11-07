import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  ResourceNotFoundError,
} from '@chat-adapter/shared';
import { createMockLogger } from '@chat-adapter/tests';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { issue, REST } from '../test/fixtures/rest';
import { createBacklogClient } from './backlog';

import type { Logger } from 'chat';

const fetchMock = vi.fn<typeof globalThis.fetch>();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function clientWith(
  options: {
    resolveApiKey?: () => Promise<string>;
    logger?: () => Logger;
  } = {}
) {
  const logger = createMockLogger();
  return createBacklogClient({
    host: REST.host,
    resolveApiKey: options.resolveApiKey ?? (async () => 'test-api-key'),
    logger: options.logger ?? (() => logger),
  });
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

function backlogError(
  status: number,
  code: number,
  headers: Record<string, string> = {}
): Response {
  return json(
    { errors: [{ message: 'Backlog says no', code, moreInfo: '' }] },
    { status, headers }
  );
}

function sentHeaders(call = 0): Headers {
  return new Headers(fetchMock.mock.calls[call]?.[1]?.headers);
}

function sentUrl(call = 0): string {
  return String(fetchMock.mock.calls[call]?.[0]);
}

describe('credentials', () => {
  it('sends the API key in the Backlog-API-Key header and never in the URL', async () => {
    fetchMock.mockImplementation(async () => json(issue()));

    await clientWith().getIssue(REST.issueId);

    expect(sentHeaders().get('Backlog-API-Key')).toBe('test-api-key');
    expect(sentUrl()).not.toContain('apiKey');
    expect(sentUrl()).not.toContain('test-api-key');
  });

  it('resolves the credential afresh for every request', async () => {
    fetchMock.mockImplementation(async () => json(issue()));
    const keys = ['first-key', 'second-key'];
    const client = clientWith({
      resolveApiKey: async () => keys.shift() ?? 'exhausted',
    });

    await client.getIssue(REST.issueId);
    await client.getIssue(REST.issueId);

    expect(sentHeaders(0).get('Backlog-API-Key')).toBe('first-key');
    expect(sentHeaders(1).get('Backlog-API-Key')).toBe('second-key');
  });

  it('fails with AuthenticationError and sends nothing when the resolver rejects', async () => {
    const client = clientWith({
      resolveApiKey: () => Promise.reject(new Error('vault unavailable')),
    });

    await expect(client.getIssue(REST.issueId)).rejects.toBeInstanceOf(
      AuthenticationError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails with AuthenticationError, not NetworkError, on a credential containing CR/LF', async () => {
    const client = clientWith({
      resolveApiKey: async () => 'key\r\nX-Injected: 1',
    });

    await expect(client.getIssue(REST.issueId)).rejects.toBeInstanceOf(
      AuthenticationError
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('transport', () => {
  it('maps a fetch rejection to NetworkError', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(clientWith().getIssue(REST.issueId)).rejects.toBeInstanceOf(
      NetworkError
    );
  });

  it('bounds each request, body read included, by a 30 second timeout', async () => {
    const controller = new AbortController();
    const timeout = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(controller.signal);
    fetchMock.mockImplementation(async (_input, init) => {
      const response = json(issue());
      vi.spyOn(response, 'json').mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          })
      );
      return response;
    });

    const request = clientWith().getIssue(REST.issueId);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(timeout).toHaveBeenCalledWith(30_000);
  });
});

describe('error responses', () => {
  it('maps by the error code before the status, so code 6 on a 400 is ResourceNotFoundError', async () => {
    fetchMock.mockImplementation(async () => backlogError(400, 6));

    await expect(clientWith().getIssue(REST.issueId)).rejects.toBeInstanceOf(
      ResourceNotFoundError
    );
  });

  it('maps a non-JSON error body by its status', async () => {
    fetchMock.mockImplementation(
      async () => new Response('<html>Bad Gateway</html>', { status: 502 })
    );

    const rejection = clientWith().getIssue(REST.issueId);

    await expect(rejection).rejects.toBeInstanceOf(AdapterError);
    await expect(rejection).rejects.toMatchObject({
      code: '502',
      cause: {
        status: 502,
        url: `https://${REST.host}/api/v2/issues/${REST.issueId}`,
      },
    });
  });

  it('keeps the query string out of error.cause', async () => {
    fetchMock.mockImplementation(async () => backlogError(401, 11));

    const error: unknown = await clientWith()
      .getIssues({ keyword: 'secret words' })
      .catch((caught: unknown) => caught);

    expect(sentUrl()).toContain('?');
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as AdapterError).cause).toMatchObject({
      url: `https://${REST.host}/api/v2/issues`,
    });
  });
});

describe('rate limiting', () => {
  const now = Math.floor(Date.parse('2026-09-06T00:00:00.000Z') / 1000);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now * 1000);
    vi.spyOn(Math, 'random').mockReturnValue(0);
  });

  function tooManyRequests(resetSeconds: number): Response {
    return backlogError(429, 13, {
      'X-RateLimit-Remaining': '0',
      'X-RateLimit-Reset': String(resetSeconds),
    });
  }

  it('retries a 429 whose reset is imminent once, and returns the retry', async () => {
    fetchMock
      .mockResolvedValueOnce(tooManyRequests(now + 2))
      .mockResolvedValueOnce(json(issue()));

    const request = clientWith().getIssue(REST.issueId);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(request).resolves.toMatchObject({ id: REST.issueId });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resolves the credential again for the retry', async () => {
    fetchMock
      .mockResolvedValueOnce(tooManyRequests(now + 2))
      .mockResolvedValueOnce(json(issue()));
    const resolve = vi.fn(async () => 'test-api-key');

    const request = clientWith({ resolveApiKey: resolve }).getIssue(
      REST.issueId
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await request;

    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('throws AdapterRateLimitError without retrying when the reset is more than a minute away', async () => {
    fetchMock.mockImplementation(async () => tooManyRequests(now + 300));

    const rejection = clientWith().getIssue(REST.issueId);

    await expect(rejection).rejects.toBeInstanceOf(AdapterRateLimitError);
    await expect(rejection).rejects.toMatchObject({ retryAfter: 300 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up on the second 429 with AdapterRateLimitError', async () => {
    fetchMock.mockImplementation(async () => tooManyRequests(now + 2));

    const settled = expect(
      clientWith().getIssue(REST.issueId)
    ).rejects.toBeInstanceOf(AdapterRateLimitError);
    await vi.advanceTimersByTimeAsync(2_000);

    await settled;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats error code 13 as rate limited whatever the status', async () => {
    fetchMock.mockImplementation(async () =>
      backlogError(403, 13, { 'X-RateLimit-Reset': String(now + 300) })
    );

    await expect(clientWith().getIssue(REST.issueId)).rejects.toBeInstanceOf(
      AdapterRateLimitError
    );
  });

  it('announces a wait once, with the remaining, reset and wait it blocks for', async () => {
    const logger = createMockLogger();
    fetchMock
      .mockResolvedValueOnce(tooManyRequests(now + 2))
      .mockResolvedValueOnce(json(issue()));

    const request = clientWith({ logger: () => logger }).getIssue(REST.issueId);
    await vi.advanceTimersByTimeAsync(2_000);
    await request;

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'rate limited; waiting for the limit to reset',
      {
        remaining: 0,
        resetAt: new Date((now + 2) * 1000).toISOString(),
        waitMs: 2_000,
        attempt: 1,
      }
    );
  });

  it('announces a refusal to wait once', async () => {
    const logger = createMockLogger();
    fetchMock.mockImplementation(async () => tooManyRequests(now + 300));

    await expect(
      clientWith({ logger: () => logger }).postIssueComments(REST.issueId, {
        content: 'hello',
      })
    ).rejects.toBeInstanceOf(AdapterRateLimitError);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('rate limited; not retrying', {
      remaining: 0,
      resetAt: new Date((now + 300) * 1000).toISOString(),
      waitMs: 300_000,
      attempt: 1,
    });
  });

  it('logs a 429 without rate-limit headers with only the full minute it blocks for', async () => {
    const logger = createMockLogger();
    fetchMock.mockImplementation(async () => backlogError(429, 13));

    const settled = expect(
      clientWith({ logger: () => logger }).getIssue(REST.issueId)
    ).rejects.toBeInstanceOf(AdapterRateLimitError);
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;

    expect(logger.warn).toHaveBeenNthCalledWith(
      1,
      'rate limited; waiting for the limit to reset',
      { waitMs: 60_000, attempt: 1 }
    );
    expect(logger.warn).toHaveBeenNthCalledWith(
      2,
      'rate limited; not retrying',
      { waitMs: 60_000, attempt: 2 }
    );
  });

  it('resolves the logger per request, so a replaced logger is followed', async () => {
    const first = createMockLogger();
    const second = createMockLogger();
    let current = first;
    fetchMock.mockImplementation(async () => tooManyRequests(now + 300));
    const client = clientWith({ logger: () => current });

    await expect(client.getIssue(REST.issueId)).rejects.toBeInstanceOf(
      AdapterRateLimitError
    );
    current = second;
    await expect(client.getIssue(REST.issueId)).rejects.toBeInstanceOf(
      AdapterRateLimitError
    );

    expect(first.warn).toHaveBeenCalledTimes(1);
    expect(second.warn).toHaveBeenCalledTimes(1);
  });

  it('logs nothing for a request that is not rate limited', async () => {
    const logger = createMockLogger();
    fetchMock.mockImplementation(async () => json(issue()));

    await clientWith({ logger: () => logger }).getIssue(REST.issueId);

    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.debug).not.toHaveBeenCalled();
  });
});
