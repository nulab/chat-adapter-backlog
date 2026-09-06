import {
  AdapterRateLimitError,
  AuthenticationError,
  ResourceNotFoundError,
} from '@chat-adapter/shared';
import { createMockLogger } from '@chat-adapter/tests';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBacklogJsApi } from './backlog-js.js';
import { createFakeBacklogServer } from './backlog-js.fake-fetch.js';
import {
  conformanceFixture,
  describeBacklogApiConformance,
} from './conformance.js';

const { host, projectId, issueId, alice, baseIssue } = conformanceFixture;

const REPOSITORY_ID = 700;
const PULL_REQUEST_NUMBER = 12;
const PULL_REQUEST_COMMENT_ID = 7_000_001;

const rateLimitHeaders = {
  'X-RateLimit-Limit': '600',
  'X-RateLimit-Remaining': '599',
  'X-RateLimit-Reset': '9999999999',
};

/** One pull request as Backlog puts it on the wire, `issue` left to the caller. */
function pullRequestWire(issue: unknown) {
  return {
    id: 90_001,
    projectId,
    repositoryId: REPOSITORY_ID,
    number: PULL_REQUEST_NUMBER,
    summary: 'Add the thing',
    description: 'Body of the PR.',
    base: 'main',
    branch: 'feature/thing',
    status: { id: 1, name: 'Open' },
    assignee: null,
    issue,
    baseCommit: null,
    branchCommit: null,
    mergeCommit: null,
    closeAt: null,
    mergeAt: null,
    createdUser: alice,
    created: '2026-01-01T00:00:00Z',
    updated: '2026-01-01T00:00:00Z',
    attachments: [],
    stars: [],
  };
}

describeBacklogApiConformance('createBacklogJsApi', () => {
  const server = createFakeBacklogServer();
  return createBacklogJsApi({
    host,
    credentials: { apiKey: () => 'test-api-key' },
    fetch: server.fetch,
  });
});

describe('createBacklogJsApi', () => {
  it('the API key is sent as a header and never in the URL', async () => {
    const requests: { url: URL; headers: Headers }[] = [];
    const server = createFakeBacklogServer({
      validApiKeys: ['secret-key'],
      onRequest: (request) => requests.push(request),
    });
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'secret-key' },
      fetch: server.fetch,
    });

    await api.getIssue(issueId);

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.headers.get('Backlog-API-Key')).toBe('secret-key');
      expect(request.url.search).not.toContain('secret-key');
      expect(request.url.toString()).not.toContain('apiKey=');
    }
  });

  it('a resolver is called for every request', async () => {
    const resolver = vi.fn(() => 'test-api-key');
    const server = createFakeBacklogServer();
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: resolver },
      fetch: server.fetch,
    });

    await api.getIssue(issueId);
    await api.getIssue(issueId);
    await api.getIssue(issueId);

    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it('a rejecting resolver becomes AuthenticationError', async () => {
    const server = createFakeBacklogServer();
    const api = createBacklogJsApi({
      host,
      credentials: {
        apiKey: () => {
          throw new Error('vault unavailable');
        },
      },
      fetch: server.fetch,
    });

    await expect(api.getIssue(issueId)).rejects.toBeInstanceOf(
      AuthenticationError
    );
  });

  it('an array query parameter is sent once, not with doubled brackets', async () => {
    const requests: { url: URL }[] = [];
    const server = createFakeBacklogServer({
      onRequest: (request) => requests.push(request),
    });
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: server.fetch,
    });

    await api.listIssues(projectId, { count: 10 });

    const search = requests[0]?.url.search ?? '';
    expect(decodeURIComponent(search)).toContain(`projectId[]=${projectId}`);
    expect(decodeURIComponent(search)).not.toContain('projectId[][]');
  });

  it('an array form parameter is sent once, not with doubled brackets', async () => {
    const bodies: string[] = [];
    const server = createFakeBacklogServer();
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: (input, init) => {
        if (typeof init?.body === 'string') {
          bodies.push(init.body);
        }
        return server.fetch(input, init);
      },
    });

    await api.addComment(issueId, {
      content: 'Hello',
      notifiedUserId: [100, 101],
      attachmentId: [7],
    });

    const body = decodeURIComponent(bodies[0] ?? '');
    expect(body).toContain('notifiedUserId[]=100');
    expect(body).toContain('notifiedUserId[]=101');
    expect(body).toContain('attachmentId[]=7');
    expect(body).not.toContain('[][]');
  });

  it('an issue-list call spends the search bucket, not read', async () => {
    const server = createFakeBacklogServer();
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: server.fetch,
    });

    await api.listIssues(projectId, { count: 10 });

    const snapshot = api.rateLimit();
    expect(snapshot.search).toBeDefined();
    expect(snapshot.read).toBeUndefined();
  });

  it('error code 6 maps to ResourceNotFoundError even on a 400 status', async () => {
    const fetchStub: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          errors: [{ message: 'No such issue', code: 6, moreInfo: '' }],
        }),
        {
          status: 400,
          headers: {
            'X-RateLimit-Limit': '600',
            'X-RateLimit-Remaining': '599',
            'X-RateLimit-Reset': '9999999999',
          },
        }
      );
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: fetchStub,
    });

    await expect(api.getIssue(999_999)).rejects.toBeInstanceOf(
      ResourceNotFoundError
    );
  });

  it('a response that violates the schema is an AdapterError, not a ZodError', async () => {
    const fetchStub: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ unexpected: 'shape' }), {
        status: 200,
        headers: {
          'X-RateLimit-Limit': '600',
          'X-RateLimit-Remaining': '599',
          'X-RateLimit-Reset': '9999999999',
        },
      });
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: fetchStub,
    });

    const rejection = api.getIssue(issueId);
    await expect(rejection).rejects.toMatchObject({ code: 'SCHEMA' });
    await expect(rejection).rejects.not.toBeInstanceOf(TypeError);
    await rejection.catch((error: unknown) => {
      expect(error).not.toHaveProperty('issues');
    });
  });

  it('uploading a file posts one multipart part named file', async () => {
    let capturedForm: FormData | undefined;
    const fetchStub: typeof globalThis.fetch = async (_input, init) => {
      capturedForm = init?.body as FormData;
      return new Response(
        JSON.stringify({ id: 1, name: 'notes.txt', size: 5 }),
        {
          status: 201,
          headers: {
            'X-RateLimit-Limit': '150',
            'X-RateLimit-Remaining': '149',
            'X-RateLimit-Reset': '9999999999',
          },
        }
      );
    };
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: fetchStub,
    });

    await api.uploadAttachment('notes.txt', Buffer.from('hello'), 'text/plain');

    expect(capturedForm).toBeInstanceOf(FormData);
    const parts = [...(capturedForm as FormData).keys()];
    expect(parts).toEqual(['file']);
  });

  it('a pull request is addressed by project, repository and number, never by its global id', async () => {
    const paths: string[] = [];
    const fetchStub: typeof globalThis.fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      paths.push(url.pathname);
      return new Response(JSON.stringify(pullRequestWire(null)), {
        status: 200,
        headers: rateLimitHeaders,
      });
    };
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: fetchStub,
    });

    const pullRequest = await api.getPullRequest({
      projectId,
      repositoryId: REPOSITORY_ID,
      number: PULL_REQUEST_NUMBER,
    });

    expect(paths).toEqual([
      `/api/v2/projects/${projectId}/git/repositories/${REPOSITORY_ID}/pullRequests/${PULL_REQUEST_NUMBER}`,
    ]);
    expect(pullRequest.id).toBe(90_001);
    expect(paths[0]).not.toContain(String(pullRequest.id));
  });

  it('starring a pull request comment sends pullRequestCommentId as the form parameter, an issue comment sends commentId', async () => {
    const bodies: string[] = [];
    const fetchStub: typeof globalThis.fetch = async (_input, init) => {
      bodies.push(String(init?.body));
      return new Response(null, { status: 204, headers: rateLimitHeaders });
    };
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: fetchStub,
    });

    await api.addStar({ pullRequestCommentId: PULL_REQUEST_COMMENT_ID });
    await api.addStar({ commentId: 1 });

    expect(
      bodies.map((body) => [...new URLSearchParams(body).entries()])
    ).toEqual([
      [['pullRequestCommentId', String(PULL_REQUEST_COMMENT_ID)]],
      [['commentId', '1']],
    ]);
  });

  it("the list page's issue stub and the full issue object normalise to the same two identity fields", async () => {
    const fetchStub: typeof globalThis.fetch = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      const body = url.pathname.endsWith(`/pullRequests/${PULL_REQUEST_NUMBER}`)
        ? pullRequestWire(baseIssue())
        : [pullRequestWire({ id: issueId })];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: rateLimitHeaders,
      });
    };
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: fetchStub,
    });

    const [listed] = await api.listPullRequests(projectId, REPOSITORY_ID, {
      count: 20,
    });
    const fetched = await api.getPullRequest({
      projectId,
      repositoryId: REPOSITORY_ID,
      number: PULL_REQUEST_NUMBER,
    });

    expect(Object.keys(listed?.issue ?? {})).toEqual(['id', 'issueKey']);
    expect(Object.keys(fetched.issue ?? {})).toEqual(['id', 'issueKey']);
    expect(listed?.issue).toEqual({ id: issueId, issueKey: null });
    expect(fetched.issue).toEqual({ id: issueId, issueKey: 'PROJECT-1' });
  });

  describe('429 retry timing', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('a 429 whose reset is imminent is retried once', async () => {
      const now = Math.floor(Date.now() / 1000);
      let attempt = 0;
      const fetchStub: typeof globalThis.fetch = async () => {
        attempt += 1;
        if (attempt === 1) {
          return new Response(
            JSON.stringify({
              errors: [
                { message: 'Too many requests', code: 13, moreInfo: '' },
              ],
            }),
            {
              status: 429,
              headers: {
                'X-RateLimit-Limit': '150',
                'X-RateLimit-Remaining': '0',
                'X-RateLimit-Reset': String(now + 2),
              },
            }
          );
        }
        return new Response(
          JSON.stringify({
            id: issueId,
            projectId,
            issueKey: 'PROJECT-1',
            summary: 'ok',
            description: '',
            issueType: { id: 1, name: 'Task' },
            priority: { id: 3, name: 'Normal' },
            status: { id: 1, name: 'Open' },
            assignee: null,
            createdUser: {
              id: 100,
              userId: 'alice',
              name: 'Alice',
              mailAddress: null,
            },
            created: '2026-01-01T00:00:00Z',
            updated: '2026-01-01T00:00:00Z',
          }),
          {
            status: 200,
            headers: {
              'X-RateLimit-Limit': '600',
              'X-RateLimit-Remaining': '599',
              'X-RateLimit-Reset': String(now + 60),
            },
          }
        );
      };
      const api = createBacklogJsApi({
        host,
        credentials: { apiKey: () => 'test-api-key' },
        fetch: fetchStub,
      });

      const resultPromise = api.getIssue(issueId);
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await resultPromise;

      expect(result.id).toBe(issueId);
      expect(attempt).toBe(2);
    });

    it('a 429 whose reset exceeds maxWaitMs throws without waiting', async () => {
      const now = Math.floor(Date.now() / 1000);
      let attempt = 0;
      const fetchStub: typeof globalThis.fetch = async () => {
        attempt += 1;
        return new Response(
          JSON.stringify({
            errors: [{ message: 'Too many requests', code: 13, moreInfo: '' }],
          }),
          {
            status: 429,
            headers: {
              'X-RateLimit-Limit': '150',
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': String(now + 300),
            },
          }
        );
      };
      const api = createBacklogJsApi({
        host,
        credentials: { apiKey: () => 'test-api-key' },
        fetch: fetchStub,
      });

      const rejection = api.getIssue(issueId);
      await expect(rejection).rejects.toBeInstanceOf(AdapterRateLimitError);
      await rejection.catch((error: unknown) => {
        expect(
          (error as AdapterRateLimitError).retryAfter
        ).toBeGreaterThanOrEqual(299);
      });
      expect(attempt).toBe(1);
    });

    it('maxRetries: 0 never retries', async () => {
      const now = Math.floor(Date.now() / 1000);
      let attempt = 0;
      const fetchStub: typeof globalThis.fetch = async () => {
        attempt += 1;
        return new Response(
          JSON.stringify({
            errors: [{ message: 'Too many requests', code: 13, moreInfo: '' }],
          }),
          {
            status: 429,
            headers: {
              'X-RateLimit-Limit': '150',
              'X-RateLimit-Remaining': '0',
              'X-RateLimit-Reset': String(now + 1),
            },
          }
        );
      };
      const api = createBacklogJsApi({
        host,
        credentials: { apiKey: () => 'test-api-key' },
        fetch: fetchStub,
        retry: { maxRetries: 0 },
      });

      await expect(api.getIssue(issueId)).rejects.toBeInstanceOf(
        AdapterRateLimitError
      );
      expect(attempt).toBe(1);
    });
  });

  describe('429 logging (§8.4, §10)', () => {
    // Pinned to a whole second so `waitMs` is exactly the header's distance
    // from now; `X-RateLimit-Reset` has one-second granularity, and a clock
    // sitting mid-second would make the asserted numbers drift by the
    // remainder.
    const now = Math.floor(Date.parse('2026-09-06T00:00:00.000Z') / 1000);

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(now * 1000);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function tooManyRequests(resetSeconds: number): Response {
      return new Response(
        JSON.stringify({
          errors: [{ message: 'Too many requests', code: 13, moreInfo: '' }],
        }),
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': '15',
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(resetSeconds),
          },
        }
      );
    }

    it('a wait is announced once, with the bucket, remaining, reset and wait it is about to block for', async () => {
      const logger = createMockLogger();
      let attempt = 0;
      const fetchStub: typeof globalThis.fetch = async () => {
        attempt += 1;
        return attempt === 1
          ? tooManyRequests(now + 2)
          : new Response(JSON.stringify(baseIssue()), {
              status: 200,
              headers: rateLimitHeaders,
            });
      };
      const api = createBacklogJsApi({
        host,
        credentials: { apiKey: () => 'test-api-key' },
        fetch: fetchStub,
        logger: () => logger,
      });

      const resultPromise = api.getIssue(issueId);
      await vi.advanceTimersByTimeAsync(2_000);
      await resultPromise;

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        'rate limited; waiting for the bucket to reset',
        {
          bucket: 'read',
          remaining: 0,
          resetAt: new Date((now + 2) * 1000).toISOString(),
          waitMs: 2_000,
          attempt: 1,
        }
      );
    });

    it('a refusal to wait is announced once, and names the update bucket a comment spends', async () => {
      const logger = createMockLogger();
      const fetchStub: typeof globalThis.fetch = async () =>
        tooManyRequests(now + 300);
      const api = createBacklogJsApi({
        host,
        credentials: { apiKey: () => 'test-api-key' },
        fetch: fetchStub,
        logger: () => logger,
      });

      await expect(
        api.addComment(issueId, { content: 'hello' })
      ).rejects.toBeInstanceOf(AdapterRateLimitError);

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith('rate limited; not retrying', {
        bucket: 'update',
        remaining: 0,
        resetAt: new Date((now + 300) * 1000).toISOString(),
        waitMs: 300_000,
        attempt: 1,
      });
    });

    it('a 429 without rate-limit headers still logs, reporting the full maxWaitMs it would have to block for', async () => {
      const logger = createMockLogger();
      const fetchStub: typeof globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: 'Too many requests', code: 13, moreInfo: '' }],
          }),
          { status: 429 }
        );
      const api = createBacklogJsApi({
        host,
        credentials: { apiKey: () => 'test-api-key' },
        fetch: fetchStub,
        retry: { maxRetries: 0 },
        logger: () => logger,
      });

      await expect(api.getIssue(issueId)).rejects.toBeInstanceOf(
        AdapterRateLimitError
      );

      expect(logger.warn).toHaveBeenCalledWith('rate limited; not retrying', {
        bucket: 'read',
        waitMs: 60_000,
        attempt: 1,
      });
    });

    it('the logger is resolved per request, so a caller that swaps its own logger is followed', async () => {
      const first = createMockLogger();
      const second = createMockLogger();
      let current = first;
      const fetchStub: typeof globalThis.fetch = async () =>
        tooManyRequests(now + 300);
      const api = createBacklogJsApi({
        host,
        credentials: { apiKey: () => 'test-api-key' },
        fetch: fetchStub,
        logger: () => current,
      });

      await expect(api.getIssue(issueId)).rejects.toBeInstanceOf(
        AdapterRateLimitError
      );
      current = second;
      await expect(api.getIssue(issueId)).rejects.toBeInstanceOf(
        AdapterRateLimitError
      );

      expect(first.warn).toHaveBeenCalledTimes(1);
      expect(second.warn).toHaveBeenCalledTimes(1);
    });

    it('a request that is not rate limited logs nothing', async () => {
      const logger = createMockLogger();
      const server = createFakeBacklogServer();
      const api = createBacklogJsApi({
        host,
        credentials: { apiKey: () => 'test-api-key' },
        fetch: server.fetch,
        logger: () => logger,
      });

      await api.getIssue(issueId);

      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.debug).not.toHaveBeenCalled();
    });
  });
});
