import {
  AdapterRateLimitError,
  AuthenticationError,
  ResourceNotFoundError,
} from '@chat-adapter/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBacklogJsApi } from './backlog-js.js';
import { createFakeBacklogServer } from './backlog-js.fake-fetch.js';
import {
  conformanceFixture,
  describeBacklogApiConformance,
} from './conformance.js';

const { host, projectId, issueId } = conformanceFixture;

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
});
