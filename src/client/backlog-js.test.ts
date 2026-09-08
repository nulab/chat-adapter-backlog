import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  ResourceNotFoundError,
  ValidationError,
} from '@chat-adapter/shared';
import { createMockLogger } from '@chat-adapter/tests';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBacklogJsApi, createBacklogJsTransport } from './backlog-js.js';
import { createFakeBacklogServer } from './backlog-js.fake-fetch.js';
import {
  conformanceFixture,
  describeBacklogApiConformance,
} from './conformance.js';

import type { BacklogCredentials } from './port.js';

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

/** The filename one attachment download settles on, given that `Content-Disposition`. */
async function downloadNamed(disposition: string): Promise<string> {
  const api = createBacklogJsApi({
    host,
    credentials: { apiKey: () => 'test-api-key' },
    fetch: async () =>
      new Response('file bytes', {
        status: 200,
        headers: {
          ...rateLimitHeaders,
          'Content-Disposition': disposition,
        },
      }),
  });

  const downloaded = await api.downloadAttachment(issueId, 55);
  return downloaded.filename;
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

  it('a resolver-produced API key containing CR/LF is an authentication failure, not a transport one', async () => {
    const fetchStub = vi.fn<typeof globalThis.fetch>();
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'invalid\r\nkey' },
      fetch: fetchStub,
    });

    // The same class a throwing resolver produces: no request was made, and
    // no retry makes this value acceptable (§8.5).
    await expect(api.getIssue(issueId)).rejects.toBeInstanceOf(
      AuthenticationError
    );
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('an access token is sent as a bearer token', async () => {
    const requests: { headers: Headers }[] = [];
    const server = createFakeBacklogServer({
      onRequest: (request) => requests.push(request),
    });
    const api = createBacklogJsApi({
      host,
      credentials: { accessToken: () => 'oauth-token' },
      fetch: server.fetch,
    });

    await api.getIssue(issueId);

    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.headers.get('Authorization')).toBe('Bearer oauth-token');
      expect(request.headers.get('Backlog-API-Key')).toBeNull();
    }
  });

  it('credentials carrying both an apiKey and an accessToken are refused instead of one of them winning', () => {
    const fetchStub = vi.fn<typeof globalThis.fetch>();

    // Both resolvers together are a compile error against
    // `BacklogCredentials` (§8.7), for a value assembled in a variable as
    // much as for this literal, so the assertion is the only way in — and a
    // value cast past the compiler is exactly what the check answers.
    expect(() =>
      createBacklogJsApi({
        host,
        credentials: {
          apiKey: () => 'test-api-key',
          accessToken: () => 'oauth-token',
        } as BacklogCredentials,
        fetch: fetchStub,
      })
    ).toThrow(ValidationError);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('credentials carrying neither an apiKey nor an accessToken are refused when the port is built, not when it is first used', () => {
    const fetchStub = vi.fn<typeof globalThis.fetch>();

    expect(() =>
      createBacklogJsApi({
        host,
        credentials: {} as BacklogCredentials,
        fetch: fetchStub,
      })
    ).toThrow(ValidationError);
    expect(fetchStub).not.toHaveBeenCalled();
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

  it("the rate-limit endpoint's reset is the epoch second it names, not that many milliseconds", async () => {
    const server = createFakeBacklogServer({
      rateLimitOverrides: {
        read: { limit: 600, remaining: 42, reset: 1_603_881_873 },
      },
    });
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: server.fetch,
    });

    const snapshot = await api.getRateLimit();

    expect(snapshot.read).toEqual({
      limit: 600,
      remaining: 42,
      reset: new Date('2020-10-28T10:44:33.000Z'),
    });
  });

  it('reading the rate-limit endpoint leaves the observed-header snapshot reporting only the bucket it spent', async () => {
    const server = createFakeBacklogServer();
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: server.fetch,
    });

    const reported = await api.getRateLimit();
    const observed = api.rateLimit();

    expect(reported.update).toBeDefined();
    expect(observed.read).toBeDefined();
    expect(observed.update).toBeUndefined();
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

  it('a 2xx HTML body becomes a NetworkError instead of leaking SyntaxError', async () => {
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: async () =>
        new Response('<html>sign in</html>', {
          status: 200,
          headers: rateLimitHeaders,
        }),
    });

    await expect(api.getIssue(issueId)).rejects.toBeInstanceOf(NetworkError);
  });

  it('a 2xx empty body becomes a NetworkError instead of leaking SyntaxError', async () => {
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: async () =>
        new Response(null, { status: 200, headers: rateLimitHeaders }),
    });

    await expect(api.getIssue(issueId)).rejects.toBeInstanceOf(NetworkError);
  });

  it('an attachment body read failure becomes a NetworkError', async () => {
    const response = new Response('file bytes', {
      status: 200,
      headers: rateLimitHeaders,
    });
    vi.spyOn(response, 'arrayBuffer').mockRejectedValue(
      new Error('body stream failed')
    );
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: async () => response,
    });

    await expect(api.downloadAttachment(issueId, 55)).rejects.toBeInstanceOf(
      NetworkError
    );
  });

  it('percent-decodes the extended Content-Disposition form Backlog sends', async () => {
    const filename = await downloadNamed(
      "attachment; filename*=UTF-8''diagram%20final.png"
    );

    expect(filename).toBe('diagram final.png');
  });

  it('leaves a plain filename undecoded, so a bare % in one is not a URIError', async () => {
    const filename = await downloadNamed('attachment; filename="100%.png"');

    expect(filename).toBe('100%.png');
  });

  it('keeps a literal %20 in a plain filename, which is not an escape there', async () => {
    const filename = await downloadNamed(
      'attachment; filename="report%20v2.pdf"'
    );

    expect(filename).toBe('report%20v2.pdf');
  });

  it('strips the charset prefix whatever case it is written in', async () => {
    const filename = await downloadNamed(
      "attachment; filename*=utf-8''a%20b.png"
    );

    expect(filename).toBe('a b.png');
  });

  it('falls back to the raw value when the extended form will not decode', async () => {
    const filename = await downloadNamed(
      "attachment; filename*=UTF-8''100%.png"
    );

    expect(filename).toBe('100%.png');
  });

  it('takes filename* over filename when a header carries both, whichever came first', async () => {
    const extendedLast = await downloadNamed(
      'attachment; filename="fallback.png"; filename*=UTF-8\'\'real%20name.png'
    );
    const extendedFirst = await downloadNamed(
      'attachment; filename*=UTF-8\'\'real%20name.png; filename="fallback.png"'
    );

    // RFC 6266 §4.3: the plain form is the fallback for a receiver that
    // cannot read the extended one, so position must not decide.
    expect(extendedLast).toBe('real name.png');
    expect(extendedFirst).toBe('real name.png');
  });

  it('leaves a charset it does not strip in the name rather than failing the download', async () => {
    const latin1 = await downloadNamed(
      "attachment; filename*=ISO-8859-1''%E9.png"
    );
    const withLanguage = await downloadNamed(
      "attachment; filename*=UTF-8'en'file%20name.png"
    );

    // Only `UTF-8''` is stripped, so both names come back carrying their
    // prefix. Wrong, and known to be; what is fixed here is that neither
    // throws out of a download whose bytes already arrived.
    expect(latin1).toBe("ISO-8859-1''%E9.png");
    expect(withLanguage).toBe("UTF-8'en'file name.png");
  });

  it('names a download by its attachment id when the header names no file', async () => {
    const filename = await downloadNamed('attachment');

    expect(filename).toBe('55');
  });

  it('an error body without errors[] still maps by status and records its headers', async () => {
    const response = new Response(
      JSON.stringify({ message: 'upstream timeout' }),
      {
        status: 502,
        headers: rateLimitHeaders,
      }
    );
    Object.defineProperty(response, 'url', {
      value: `https://${host}/api/v2/issues/${issueId}`,
    });
    const api = createBacklogJsApi({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: async () => response,
    });

    const rejection = api.getIssue(issueId);
    await expect(rejection).rejects.toBeInstanceOf(AdapterError);
    await expect(rejection).rejects.toMatchObject({
      code: '502',
      cause: {
        status: 502,
        url: `https://${host}/api/v2/issues/${issueId}`,
      },
    });
    expect(api.rateLimit().read).toEqual({
      limit: 600,
      remaining: 599,
      reset: new Date(Number(rateLimitHeaders['X-RateLimit-Reset']) * 1000),
    });
  });

  it('keeps a stalled JSON body read inside the request timeout', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null = null;
      const response = new Response(JSON.stringify(baseIssue()), {
        status: 200,
        headers: rateLimitHeaders,
      });
      vi.spyOn(response, 'json').mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            requestSignal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true }
            );
          })
      );
      const fetchStub: typeof globalThis.fetch = async (_input, init) => {
        requestSignal = init?.signal ?? null;
        return response;
      };
      const api = createBacklogJsApi({
        host,
        credentials: { apiKey: () => 'test-api-key' },
        fetch: fetchStub,
        timeoutMs: 25,
      });

      const rejection = api.getIssue(issueId);
      const assertion = expect(rejection).rejects.toBeInstanceOf(NetworkError);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a stalled error body read inside the request timeout', async () => {
    // The twin of the test above, on the failure path: the error body is what
    // names the Backlog error code, so it is read before the status is
    // mapped — and a 502 from in front of Backlog can answer its headers and
    // then stall the stream just as a 200 can.
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null = null;
      const response = new Response('', {
        status: 502,
        headers: rateLimitHeaders,
      });
      vi.spyOn(response, 'json').mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            requestSignal?.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true }
            );
          })
      );
      const fetchStub: typeof globalThis.fetch = async (_input, init) => {
        requestSignal = init?.signal ?? null;
        return response;
      };
      const api = createBacklogJsApi({
        host,
        credentials: { apiKey: () => 'test-api-key' },
        fetch: fetchStub,
        timeoutMs: 25,
      });

      const rejection = api.getIssue(issueId);
      const assertion = expect(rejection).rejects.toBeInstanceOf(AdapterError);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(25);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
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
        random: () => 0,
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
        random: () => 0,
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
        random: () => 0,
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

/**
 * The client the port speaks through is handed out as `transport.client`, so
 * these state what a caller reaching past the port still gets: the same
 * accounting, the same retry, the same errors and a credential resolved as
 * late as the port's own.
 */
describe('createBacklogJsTransport', () => {
  it('a call made through the client is counted in the port’s rate-limit snapshot', async () => {
    const server = createFakeBacklogServer();
    const { api, client } = createBacklogJsTransport({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: server.fetch,
    });

    await client.getIssue(issueId);

    expect(api.rateLimit().read).toBeDefined();
  });

  it('an issue-list call through the client spends the search bucket, as it does through the port', async () => {
    const server = createFakeBacklogServer();
    const { api, client } = createBacklogJsTransport({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: server.fetch,
    });

    await client.getIssues({ projectId: [projectId], count: 10 });

    expect(api.rateLimit().search).toBeDefined();
    expect(api.rateLimit().read).toBeUndefined();
  });

  it('the client carries the credential the resolver returns, resolved again on every call', async () => {
    const keys = ['first-key', 'second-key'];
    const sent: string[] = [];
    const server = createFakeBacklogServer({
      validApiKeys: keys,
      onRequest: ({ headers }) =>
        sent.push(headers.get('Backlog-API-Key') ?? ''),
    });
    const { client } = createBacklogJsTransport({
      host,
      credentials: { apiKey: () => keys[sent.length] ?? 'first-key' },
      fetch: server.fetch,
    });

    await client.getIssue(issueId);
    await client.getIssue(issueId);

    expect(sent).toEqual(keys);
  });

  it('the API key never reaches the URL, whichever way the request was made', async () => {
    const urls: URL[] = [];
    const server = createFakeBacklogServer({
      validApiKeys: ['secret-key'],
      onRequest: ({ url }) => urls.push(url),
    });
    const { client } = createBacklogJsTransport({
      host,
      credentials: { apiKey: () => 'secret-key' },
      fetch: server.fetch,
    });

    await client.getIssue(issueId);

    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.search).not.toContain('apiKey');
    }
  });

  it('a failure through the client is an adapter error, not a backlog-js one', async () => {
    const server = createFakeBacklogServer();
    const { client } = createBacklogJsTransport({
      host,
      credentials: { apiKey: () => 'test-api-key' },
      fetch: server.fetch,
    });

    await expect(client.getIssue(999_999)).rejects.toBeInstanceOf(
      ResourceNotFoundError
    );
  });

  it('a credential resolver that throws fails the call as an authentication error', async () => {
    const server = createFakeBacklogServer();
    const { client } = createBacklogJsTransport({
      host,
      credentials: {
        apiKey: () => {
          throw new Error('the vault is down');
        },
      },
      fetch: server.fetch,
    });

    await expect(client.getIssue(issueId)).rejects.toBeInstanceOf(
      AuthenticationError
    );
  });

  it('a credential the header rejects is an authentication failure, not a transport one', async () => {
    const server = createFakeBacklogServer();
    const { client } = createBacklogJsTransport({
      host,
      credentials: { apiKey: () => 'key-with\r\nheader-injection' },
      fetch: server.fetch,
    });

    await expect(client.getIssue(issueId)).rejects.toBeInstanceOf(
      AuthenticationError
    );
  });

  describe('429 through the client', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('is retried once, like a 429 through the port', async () => {
      const now = Math.floor(Date.now() / 1000);
      let attempt = 0;
      const fetchStub: typeof globalThis.fetch = async () => {
        attempt += 1;
        if (attempt === 1) {
          return new Response(
            JSON.stringify({
              errors: [{ message: 'Too many requests', code: 13 }],
            }),
            {
              status: 429,
              headers: {
                ...rateLimitHeaders,
                'X-RateLimit-Reset': String(now + 2),
              },
            }
          );
        }
        return new Response(JSON.stringify({ id: issueId }), {
          status: 200,
          headers: rateLimitHeaders,
        });
      };
      const { client } = createBacklogJsTransport({
        host,
        credentials: { apiKey: () => 'test-api-key' },
        fetch: fetchStub,
        // Pinned like the port's own retry tests: the wait carries jitter, so
        // a real `Math.random` would decide how far the timers must advance.
        random: () => 0,
      });

      const resultPromise = client.getIssue(issueId);
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(resultPromise).resolves.toMatchObject({ id: issueId });
      expect(attempt).toBe(2);
    });

    it('gives up as a rate-limit error once the reset is further off than maxWaitMs', async () => {
      const now = Math.floor(Date.now() / 1000);
      const fetchStub: typeof globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: 'Too many requests', code: 13 }],
          }),
          {
            status: 429,
            headers: {
              ...rateLimitHeaders,
              'X-RateLimit-Reset': String(now + 3_600),
            },
          }
        );
      const { client } = createBacklogJsTransport({
        host,
        credentials: { apiKey: () => 'test-api-key' },
        fetch: fetchStub,
        retry: { maxWaitMs: 1_000 },
        random: () => 0,
      });

      await expect(client.getIssue(issueId)).rejects.toBeInstanceOf(
        AdapterRateLimitError
      );
    });
  });
});
