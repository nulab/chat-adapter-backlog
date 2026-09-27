import { AdapterError, ValidationError } from '@chat-adapter/shared';
import { Backlog } from 'backlog-js';
import { z } from 'zod';

import {
  mapBacklogError,
  mapCredentialResolverError,
  mapSchemaError,
  mapTransportError,
  stripQueryString,
} from './errors.js';
import { decideRetry } from './rate-limit.js';
import {
  commentListSchema,
  commentSchema,
  gitRepositoryListSchema,
  gitRepositorySchema,
  issueCommentListSchema,
  issueCommentSchema,
  issueListSchema,
  issueSchema,
  issueTypeListSchema,
  notificationListSchema,
  priorityListSchema,
  projectSchema,
  pullRequestAttachmentListSchema,
  pullRequestListSchema,
  pullRequestSchema,
  uploadedFileSchema,
  userResponseSchema,
} from './schemas.js';

import type { BacklogErrorBodyEntry } from './errors.js';
import type { RetryDecision } from './rate-limit.js';
import type {
  AddCommentInput,
  AddPullRequestCommentInput,
  BacklogApi,
  BacklogComment,
  BacklogCredentials,
  BacklogDownloadedFile,
  BacklogGitRepository,
  BacklogIssue,
  BacklogIssueComment,
  BacklogIssueType,
  BacklogNotification,
  BacklogPriority,
  BacklogProject,
  BacklogPullRequest,
  BacklogPullRequestAttachment,
  BacklogUploadedFile,
  BacklogUserRef,
  CreateIssueInput,
  ListCommentsOptions,
  ListIssuesOptions,
  ListNotificationsOptions,
  ListPullRequestsOptions,
  MaybeAsync,
  PullRequestRef,
  RetryOptions,
  StarTarget,
} from './port.js';
import type { Logger } from 'chat';
import type { ZodType } from 'zod';

type Fetch = typeof globalThis.fetch;

/**
 * The abort timer of a response whose body has not been read yet, keyed by
 * that response. The instrumented `fetch` arms the timeout but cannot stand it
 * down — the body is read after it returns — so the reader clears it through
 * here. A `WeakMap` because a response nobody clears (one read through
 * `backlog-js` by a caller holding the client) must not be retained.
 */
const responseTimers = new WeakMap<Response, () => void>();

/** The error envelope of https://developer.nulab.com/docs/backlog/error-response/. */
const errorBodySchema = z.object({
  errors: z
    .array(
      z.object({
        message: z.string(),
        code: z.number(),
        moreInfo: z.string().optional(),
      })
    )
    .min(1),
});

/**
 * The two readers below take the general `fetch` argument shapes rather
 * than the string `backlog-js` 0.20.1 always passes, so that the instrumented
 * fetch stays a `fetch` — a caller can hand it a `Request` and still get
 * its credential, its 429 retry and its error mapping.
 */
function requestUrl(input: Parameters<Fetch>[0]): string {
  if (typeof input === 'string') {
    return input;
  }
  return input instanceof URL ? input.href : input.url;
}

function requestHeaders(input: Parameters<Fetch>[0]): Headers | undefined {
  return input instanceof Request ? input.headers : undefined;
}

/** The one auth mode a transport was configured with (docs/specs/adapter.md §8.7). */
interface ChosenCredential {
  /** The request header the resolved value goes on. */
  header: string;
  /** Renders the resolved value the way that header wants it. */
  format: (value: string) => string;
  resolve: () => MaybeAsync<string>;
}

/**
 * Picks the auth mode, once per transport.
 *
 * Both credentials used to mean `apiKey`, silently, and that is the wrong
 * default to have: a deployment that added an OAuth token meaning to stop
 * sending its space's long-lived API key would have gone on sending the key,
 * with nothing in the logs to say so. Both and neither are therefore a
 * `ValidationError`, raised here rather than on the first request — neither
 * becomes right by retrying, and no resolver has run yet, so the message can
 * name the host with no secret in hand.
 *
 * The type says the same thing (§8.7), and it says it about the only caller
 * that can reach here — `toCredentials` in `src/adapter.ts`, since neither
 * `createBacklogJsApi` nor `createBacklogJsTransport` is on the package's
 * public surface (`src/index.test.ts` asserts both absences). So what these
 * two branches answer is a value cast past the compiler, and nothing else.
 * Deleting them as redundant restores the silent preference, because the
 * reader that follows them is a header being set, not a type being checked.
 */
function chooseCredential(
  host: string,
  credentials: BacklogCredentials
): ChosenCredential {
  // Both properties are readable off the bare union: `?: never` puts each of
  // them in both members, which is what lets one destructuring see the shape
  // the check needs.
  const { apiKey, accessToken } = credentials;
  if (apiKey !== undefined && accessToken !== undefined) {
    throw new ValidationError(
      'backlog',
      `Backlog credentials for ${host} carry both apiKey and accessToken; configure exactly one`
    );
  }
  if (apiKey !== undefined) {
    return {
      header: 'Backlog-API-Key',
      format: (value) => value,
      resolve: apiKey,
    };
  }
  if (accessToken !== undefined) {
    return {
      header: 'Authorization',
      format: (value) => `Bearer ${value}`,
      resolve: accessToken,
    };
  }
  throw new ValidationError(
    'backlog',
    `Backlog credentials for ${host} carry neither apiKey nor accessToken; configure exactly one`
  );
}

export interface CreateBacklogJsApiOptions {
  host: string;
  credentials: BacklogCredentials;
  /** Injected for tests; defaults to `globalThis.fetch`. See VERIFIED-FACTS: `backlog-js`'s `fetch` option is the seam for the 429 retry, the error mapping and per-call credentials. */
  fetch?: Fetch;
  /** Request timeout via `AbortSignal`, in milliseconds. Default 30 000 (docs/specs/adapter.md §8.2). */
  timeoutMs?: number;
  retry?: RetryOptions;
  /** Random source for bounded retry jitter; injectable so timing tests stay deterministic. */
  random?: () => number;
  /**
   * Sink for the two rate-limit lines (docs/specs/adapter.md §8.4, §10).
   * Taken as an accessor rather than a `Logger`, because `BacklogAdapter`
   * replaces its own logger in `initialize()` and caches this port across
   * that swap — a captured `Logger` would pin the pre-initialize
   * `ConsoleLogger` for the process's lifetime.
   */
  logger?: () => Logger;
}

interface RequestArgs {
  method: string;
  path: string;
  params?: Record<string, unknown> | FormData;
}

/**
 * The port, and the `backlog-js` client it speaks through.
 *
 * Handing the client out is what makes the second field worth having: a
 * consumer that needs an endpoint the port does not name reaches it through
 * the same instrumented `fetch`, rather than constructing a second client
 * that has neither the bounded 429 retry nor the typed errors.
 */
export interface BacklogJsTransport {
  api: BacklogApi;
  client: Backlog;
}

/** The port alone, for the callers that never reach past it. */
export function createBacklogJsApi(
  options: CreateBacklogJsApiOptions
): BacklogApi {
  return createBacklogJsTransport(options).api;
}

/**
 * `backlog-js`-backed `BacklogApi`. Three constraints from
 * docs/specs/adapter.md §8.2 shape this file:
 *
 * - `backlog-js`'s entity methods (`getIssue`, `postIssue`, ...) return
 *   parsed bodies and discard the `Response`, and turn a non-2xx into their
 *   own error before a caller sees its `X-RateLimit-Reset`. The 429 retry and
 *   the error mapping therefore live in the injected `fetch` — the one seam
 *   every method funnels through — so the port's own low-level `request()`
 *   calls and a consumer's `getIssue()` are retried and mapped alike.
 * - Credentials are resolved fresh before each request rather than once at
 *   construction, because the resolver form (VERIFIED-FACTS) must support a
 *   token that a caller refreshes between calls. The client is therefore
 *   built holding no credential at all.
 * - Array parameters are named **without** the `[]` Backlog's documentation
 *   shows (`projectId`, not `projectId[]`). `backlog-js` 0.20.1's
 *   `toQueryString` passes every key through verbatim into
 *   `qs.stringify(..., { arrayFormat: "brackets" })`, and that appends the
 *   brackets itself: `{ projectId: [500] }` reaches the wire as
 *   `projectId[]=500`, while `{ "projectId[]": [500] }` reaches it as
 *   `projectId[][]=500`, which Backlog does not bind to the parameter at all.
 */
export function createBacklogJsTransport(
  options: CreateBacklogJsApiOptions
): BacklogJsTransport {
  const {
    host,
    credentials,
    fetch = globalThis.fetch,
    timeoutMs = 30_000,
    retry,
    random,
    logger,
  } = options;
  const credential = chooseCredential(host, credentials);

  /**
   * Resolves the credential's value. Awaited on every attempt and never
   * memoised, because the resolver form exists so an OAuth token can be
   * refreshed between calls (docs/specs/adapter.md §8.2, §8.7).
   */
  async function resolveCredential(): Promise<string> {
    try {
      return await credential.resolve();
    } catch (cause) {
      throw mapCredentialResolverError(cause);
    }
  }

  /**
   * Issues one request with the per-call credential, the error mapping and
   * the bounded 429 retry.
   *
   * All three live in the injected `fetch` rather than around
   * `client.request()`, because that is the one seam every `backlog-js`
   * method funnels through — `request()` ends in
   * `this.fetch(url, init).then(this.checkStatus)` (0.20.1). Instrumenting
   * the call site instead would leave `getIssue()` and its two hundred
   * siblings unretried and unmapped, and those are exactly what a caller holding
   * {@link BacklogJsTransport.client} reaches for.
   *
   * A non-2xx throws here, before `checkStatus` can turn it into a
   * `backlog-js` error, so a mapped `@chat-adapter/shared` error is what
   * escapes both the port and the client.
   */
  async function attemptFetch(
    input: Parameters<Fetch>[0],
    init: Parameters<Fetch>[1],
    attempt: number
  ): Promise<Response> {
    const url = requestUrl(input);

    const headers = new Headers(init?.headers ?? requestHeaders(input));
    // The client is built with no credential at all, so `request()` sets no
    // auth header (backlog-js 0.20.1 only sets one when it was configured)
    // and the secret is never held on an object handed to a consumer. It goes
    // on here instead, resolved again for every attempt: the resolver form
    // exists so an OAuth token can be refreshed between calls.
    applyCredential(headers, await resolveCredential());

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Nothing clears this timer when a caller holding the client reads the
    // body itself, so it must not be able to hold a serverless invocation
    // open past the work it was doing.
    timer.unref?.();
    const clearTimer = (): void => {
      clearTimeout(timer);
    };

    let response: Response;
    try {
      response = await fetch(input, {
        ...init,
        headers,
        signal: controller.signal,
      });
    } catch (cause) {
      clearTimer();
      throw mapTransportError(cause);
    }

    if (response.ok) {
      // The timer is deliberately left running: the body has not been read
      // yet, and a proxy can answer the headers and then stall the stream, so
      // clearing it here would wait forever (docs/specs/adapter.md §8.2).
      // `call()` clears it once it has consumed the body; a caller reading
      // the body through `backlog-js` itself relies on the `unref` above.
      responseTimers.set(response, clearTimer);
      return response;
    }

    let bodyError: BacklogErrorBodyEntry | undefined;
    try {
      // The error body is read under the same timer as the request, for the
      // same reason the success body is: a 502 from in front of Backlog can
      // answer its headers and then stall.
      bodyError = await readBodyError(response);
    } finally {
      clearTimer();
    }

    if (response.status === 429 || bodyError?.code === 13) {
      const decision = decideRetry(
        attempt,
        response.headers.get('X-RateLimit-Reset'),
        Date.now(),
        retry,
        random
      );
      if (decision.shouldRetry) {
        logRateLimit(
          'rate limited; waiting for the limit to reset',
          response.headers,
          decision,
          attempt
        );
        await wait(decision.waitMs);
        return attemptFetch(input, init, attempt + 1);
      }
      logRateLimit(
        'rate limited; not retrying',
        response.headers,
        decision,
        attempt
      );
      throw mapBacklogError({
        status: response.status,
        url: stripQueryString(url),
        retryAfterSeconds: decision.retryAfterSeconds,
        ...(bodyError !== undefined && { bodyError }),
      });
    }

    throw mapBacklogError({
      status: response.status,
      url: stripQueryString(url),
      ...(bodyError !== undefined && { bodyError }),
    });
  }

  const client = new Backlog({
    host,
    fetch: (input, init) => attemptFetch(input, init, 0),
  });

  /**
   * `client.request()` reaches the network through the instrumented fetch,
   * which has already named every failure it can. Anything else escaping is
   * `backlog-js` failing before the request — a parameter it cannot serialise
   * — and is transport by elimination.
   *
   * `consume` reads the successful `Response` and runs inside this function's
   * own try/finally rather than at the call site, so that a malformed body is
   * mapped like any other transport failure and a stalled one is still
   * covered by the request's abort timer.
   */
  async function call<T>(
    args: RequestArgs,
    consume: (response: Response) => Promise<T>
  ): Promise<T> {
    let response: Response | undefined;
    try {
      response = await client.request({
        method: args.method,
        path: args.path,
        ...(args.params !== undefined && { params: args.params as never }),
      });
      return await consume(response);
    } catch (cause) {
      throw cause instanceof AdapterError ? cause : mapTransportError(cause);
    } finally {
      // Only now is the request finished, body included, so only now may the
      // timeout be stood down.
      if (response !== undefined) {
        responseTimers.get(response)?.();
      }
    }
  }

  /**
   * A credential carrying CR/LF is rejected by `Headers`, and that rejection
   * is reported as an `AuthenticationError` rather than left to escape as a
   * `TypeError` that the caller would see as a transport failure: the
   * credential is what is wrong, not the network. `backlog-js`'s constructor
   * used to make the same check for us, and cannot any more — this client is
   * built holding no credential at all.
   */
  function applyCredential(headers: Headers, value: string): void {
    try {
      headers.set(credential.header, credential.format(value));
    } catch (cause) {
      throw mapCredentialResolverError(cause);
    }
  }

  /**
   * The first entry of the documented `{"errors":[…]}` envelope, or
   * `undefined` when the body is not that shape: a 502 from in front of
   * Backlog is HTML, and losing the status code to a parse failure would be
   * the worse outcome.
   */
  async function readBodyError(
    response: Response
  ): Promise<BacklogErrorBodyEntry | undefined> {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return undefined;
    }
    const parsed = errorBodySchema.safeParse(body);
    if (!parsed.success) {
      return undefined;
    }
    const entry = parsed.data.errors[0];
    if (entry === undefined) {
      return undefined;
    }
    return {
      message: entry.message,
      code: entry.code,
      ...(entry.moreInfo !== undefined && { moreInfo: entry.moreInfo }),
    };
  }

  /**
   * The only two lines this port logs. Every other request stays silent on
   * purpose: an `X-RateLimit-Remaining` line per request would be one entry
   * per API call against a per-minute limit, which buries the two
   * moments an operator acts on — the request that blocked, and the request
   * that failed instead of blocking.
   */
  function logRateLimit(
    message: string,
    headers: Headers,
    decision: RetryDecision,
    attempt: number
  ): void {
    const log = logger?.();
    if (log === undefined) {
      return;
    }
    const remainingHeader = headers.get('X-RateLimit-Remaining');
    const remaining =
      remainingHeader === null ? Number.NaN : Number(remainingHeader);
    log.warn(message, {
      ...(Number.isFinite(remaining) && { remaining }),
      ...(decision.resetAt !== undefined && {
        resetAt: decision.resetAt.toISOString(),
      }),
      waitMs: decision.waitMs,
      attempt: attempt + 1,
    });
  }

  async function wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
  async function requestJson<T>(
    endpoint: string,
    schema: ZodType<T>,
    args: RequestArgs
  ): Promise<T> {
    const body = await call(args, async (response): Promise<unknown> =>
      response.status === 204 ? undefined : response.json()
    );
    const result = schema.safeParse(body);
    if (!result.success) {
      throw mapSchemaError(endpoint, z.prettifyError(result.error));
    }
    return result.data;
  }

  const api: BacklogApi = {
    async getIssue(issueId) {
      return requestJson('getIssue', issueSchema, {
        method: 'GET',
        path: `issues/${issueId}`,
      });
    },

    async getProject(projectId) {
      return requestJson<BacklogProject>('getProject', projectSchema, {
        method: 'GET',
        path: `projects/${projectId}`,
      });
    },

    async getUser(userId) {
      return requestJson<BacklogUserRef>('getUser', userResponseSchema, {
        method: 'GET',
        path: `users/${userId}`,
      });
    },

    async getMyself() {
      return requestJson<BacklogUserRef>('getMyself', userResponseSchema, {
        method: 'GET',
        path: 'users/myself',
      });
    },

    async listIssues(projectId, options: ListIssuesOptions) {
      const params: Record<string, unknown> = {
        projectId: [projectId],
        count: options.count,
      };
      if (options.offset !== undefined) {
        params['offset'] = options.offset;
      }
      return requestJson<BacklogIssue[]>('listIssues', issueListSchema, {
        method: 'GET',
        path: 'issues',
        params,
      });
    },

    async createIssue(input: CreateIssueInput) {
      const params: Record<string, unknown> = {
        projectId: input.projectId,
        summary: input.summary,
        issueTypeId: input.issueTypeId,
        priorityId: input.priorityId,
      };
      if (input.description !== undefined)
        params['description'] = input.description;
      if (input.assigneeId !== undefined)
        params['assigneeId'] = input.assigneeId;
      if (input.notifiedUserId !== undefined)
        params['notifiedUserId'] = input.notifiedUserId;
      if (input.attachmentId !== undefined)
        params['attachmentId'] = input.attachmentId;
      return requestJson<BacklogIssue>('createIssue', issueSchema, {
        method: 'POST',
        path: 'issues',
        params,
      });
    },

    async listIssueTypes(projectId) {
      return requestJson<BacklogIssueType[]>(
        'listIssueTypes',
        issueTypeListSchema,
        {
          method: 'GET',
          path: `projects/${projectId}/issueTypes`,
        }
      );
    },

    async listPriorities() {
      return requestJson<BacklogPriority[]>(
        'listPriorities',
        priorityListSchema,
        { method: 'GET', path: 'priorities' }
      );
    },

    async listComments(issueId, options: ListCommentsOptions) {
      return requestJson<BacklogIssueComment[]>(
        'listComments',
        issueCommentListSchema,
        {
          method: 'GET',
          path: `issues/${issueId}/comments`,
          params: commentPagingParams(options),
        }
      );
    },

    async getComment(issueId, commentId) {
      const comment = await requestJson<BacklogIssueComment>(
        'getComment',
        issueCommentSchema,
        {
          method: 'GET',
          path: `issues/${issueId}/comments/${commentId}`,
        }
      );
      if (comment.issueId !== issueId) {
        throw mapBacklogError({
          status: 404,
          resourceType: 'comment',
          resourceId: String(commentId),
        });
      }
      return comment;
    },

    async addComment(issueId, input: AddCommentInput) {
      const params: Record<string, unknown> = { content: input.content };
      if (input.notifiedUserId !== undefined)
        params['notifiedUserId'] = input.notifiedUserId;
      if (input.attachmentId !== undefined)
        params['attachmentId'] = input.attachmentId;
      return requestJson<BacklogIssueComment>(
        'addComment',
        issueCommentSchema,
        {
          method: 'POST',
          path: `issues/${issueId}/comments`,
          params,
        }
      );
    },

    async updateComment(issueId, commentId, content) {
      return requestJson<BacklogIssueComment>(
        'updateComment',
        issueCommentSchema,
        {
          method: 'PATCH',
          path: `issues/${issueId}/comments/${commentId}`,
          params: { content },
        }
      );
    },

    async deleteComment(issueId, commentId) {
      return requestJson<BacklogIssueComment>(
        'deleteComment',
        issueCommentSchema,
        {
          method: 'DELETE',
          path: `issues/${issueId}/comments/${commentId}`,
        }
      );
    },

    async listGitRepositories(projectId) {
      return requestJson<BacklogGitRepository[]>(
        'listGitRepositories',
        gitRepositoryListSchema,
        {
          method: 'GET',
          path: `projects/${projectId}/git/repositories`,
        }
      );
    },

    async getGitRepository(projectId, repositoryId) {
      return requestJson<BacklogGitRepository>(
        'getGitRepository',
        gitRepositorySchema,
        {
          method: 'GET',
          path: gitRepositoryPath(projectId, repositoryId),
        }
      );
    },

    async listPullRequests(
      projectId,
      repositoryId,
      options: ListPullRequestsOptions
    ) {
      const params: Record<string, unknown> = { count: options.count };
      if (options.offset !== undefined) params['offset'] = options.offset;
      if (options.statusId !== undefined) params['statusId'] = options.statusId;
      return requestJson<BacklogPullRequest[]>(
        'listPullRequests',
        pullRequestListSchema,
        {
          method: 'GET',
          path: `${gitRepositoryPath(projectId, repositoryId)}/pullRequests`,
          params,
        }
      );
    },

    async getPullRequest(ref: PullRequestRef) {
      return requestJson<BacklogPullRequest>(
        'getPullRequest',
        pullRequestSchema,
        {
          method: 'GET',
          path: pullRequestPath(ref),
        }
      );
    },

    async listPullRequestComments(
      ref: PullRequestRef,
      options: ListCommentsOptions
    ) {
      return requestJson<BacklogComment[]>(
        'listPullRequestComments',
        commentListSchema,
        {
          method: 'GET',
          path: `${pullRequestPath(ref)}/comments`,
          params: commentPagingParams(options),
        }
      );
    },

    async addPullRequestComment(
      ref: PullRequestRef,
      input: AddPullRequestCommentInput
    ) {
      const params: Record<string, unknown> = { content: input.content };
      if (input.notifiedUserId !== undefined)
        params['notifiedUserId'] = input.notifiedUserId;
      if (input.attachmentId !== undefined)
        params['attachmentId'] = input.attachmentId;
      return requestJson<BacklogComment>(
        'addPullRequestComment',
        commentSchema,
        {
          method: 'POST',
          path: `${pullRequestPath(ref)}/comments`,
          params,
        }
      );
    },

    async updatePullRequestComment(ref: PullRequestRef, commentId, content) {
      return requestJson<BacklogComment>(
        'updatePullRequestComment',
        commentSchema,
        {
          method: 'PATCH',
          path: `${pullRequestPath(ref)}/comments/${commentId}`,
          params: { content },
        }
      );
    },

    async listPullRequestAttachments(ref: PullRequestRef) {
      return requestJson<BacklogPullRequestAttachment[]>(
        'listPullRequestAttachments',
        pullRequestAttachmentListSchema,
        {
          method: 'GET',
          path: `${pullRequestPath(ref)}/attachments`,
        }
      );
    },

    async downloadPullRequestAttachment(
      ref: PullRequestRef,
      attachmentId
    ): Promise<BacklogDownloadedFile> {
      return call(
        {
          method: 'GET',
          path: `${pullRequestPath(ref)}/attachments/${attachmentId}`,
        },
        (response) => toDownloadedFile(response, attachmentId)
      );
    },

    async addStar(target: StarTarget) {
      const params: Record<string, unknown> =
        'commentId' in target
          ? { commentId: target.commentId }
          : { pullRequestCommentId: target.pullRequestCommentId };
      await call(
        { method: 'POST', path: 'stars', params },
        async () => undefined
      );
    },

    async deleteStar(starId) {
      await call(
        { method: 'DELETE', path: `stars/${starId}` },
        async () => undefined
      );
    },

    async listNotifications(options: ListNotificationsOptions) {
      const params: Record<string, unknown> = { count: options.count };
      if (options.maxId !== undefined) params['maxId'] = options.maxId;
      return requestJson<BacklogNotification[]>(
        'listNotifications',
        notificationListSchema,
        {
          method: 'GET',
          path: 'notifications',
          params,
        }
      );
    },

    async markNotificationAsRead(id) {
      await call(
        { method: 'POST', path: `notifications/${id}/markAsRead` },
        async () => undefined
      );
    },

    async uploadAttachment(filename, data, mimeType) {
      const form = new FormData();
      // `Buffer`'s backing `ArrayBufferLike` can widen to `SharedArrayBuffer`,
      // which `BlobPart` rejects; copy into a plain `Uint8Array<ArrayBuffer>`.
      const bytes = Uint8Array.from(data);
      const blob =
        mimeType === undefined
          ? new Blob([bytes])
          : new Blob([bytes], { type: mimeType });
      form.set('file', blob, filename);
      return requestJson<BacklogUploadedFile>(
        'uploadAttachment',
        uploadedFileSchema,
        {
          method: 'POST',
          path: 'space/attachment',
          params: form,
        }
      );
    },

    async downloadAttachment(
      issueId,
      attachmentId
    ): Promise<BacklogDownloadedFile> {
      return call(
        {
          method: 'GET',
          path: `issues/${issueId}/attachments/${attachmentId}`,
        },
        (response) => toDownloadedFile(response, attachmentId)
      );
    },
  };

  return { api, client };
}

/**
 * The three coordinates every pull-request endpoint is keyed by. The
 * pull request's space-wide `id` is deliberately not one of them:
 * `GET …/pullRequests/<global id>` answers 404 `No such PullRequest`
 * (measured 2026-09-06, `.claude/rules/backlog-pull-request-facts.md`), and
 * an `id` that happens to match some other repository's `number` would
 * silently address the wrong pull request.
 */
function pullRequestPath(ref: PullRequestRef): string {
  return `${gitRepositoryPath(ref.projectId, ref.repositoryId)}/pullRequests/${ref.number}`;
}

function gitRepositoryPath(projectId: number, repositoryId: number): string {
  return `projects/${projectId}/git/repositories/${repositoryId}`;
}

function commentPagingParams(
  options: ListCommentsOptions
): Record<string, unknown> {
  const params: Record<string, unknown> = {
    count: options.count,
    order: options.order,
  };
  if (options.minId !== undefined) params['minId'] = options.minId;
  if (options.maxId !== undefined) params['maxId'] = options.maxId;
  return params;
}

async function toDownloadedFile(
  response: Response,
  attachmentId: number
): Promise<BacklogDownloadedFile> {
  const arrayBuffer = await response.arrayBuffer();
  const disposition = response.headers.get('Content-Disposition');
  return {
    filename: parseFilename(disposition) ?? String(attachmentId),
    contentType:
      response.headers.get('Content-Type') ?? 'application/octet-stream',
    data: Buffer.from(arrayBuffer),
  };
}

/**
 * Extracts a filename from `Content-Disposition`. Backlog's download
 * endpoint (docs/specs/adapter.md §8.1) names the file this way; there is no
 * separate filename field in the JSON API.
 *
 * The two forms are matched separately, in the order
 * [RFC 6266 §4.3](https://www.rfc-editor.org/rfc/rfc6266#section-4.3) asks
 * for — `filename*` wins and plain `filename` is then ignored — rather than
 * with one pattern taking whichever appeared first in the header. A sender
 * that supplies both means the plain one as the fallback for a receiver that
 * cannot read the extended one, so taking it by position gets the answer
 * backwards whenever it happens to come first.
 *
 * Only the extended form is percent-decoded: RFC 6266 percent-encodes
 * `filename*` and leaves plain `filename` a quoted string, which is what
 * Backlog itself sends (`filename*=UTF-8''…`, measured 2026-09-06). Decoding
 * both is what made a plain `filename="100%.png"` throw a `URIError` out of a
 * download that had already succeeded, and it would also have turned a
 * literal `%20` in a plain name into a space.
 *
 * Only `UTF-8''` is stripped, so any other charset or a populated `language`
 * field stays in the returned name (`UTF-8'en'a%20b.png` → `UTF-8'en'a b.png`,
 * `ISO-8859-1''%E9.png` → `ISO-8859-1''%E9.png`). That is wrong and known to
 * be; what matters is that it cannot fail the call, which is why an
 * undecodable value falls back to the raw string instead of throwing. The
 * caller wanted the bytes, and the name is a label on them.
 */
function parseFilename(disposition: string | null): string | undefined {
  if (disposition === null) {
    return undefined;
  }
  const extended = /filename\*=(?:UTF-8'')?([^";]+)/i.exec(disposition)?.[1];
  if (extended !== undefined) {
    try {
      return decodeURIComponent(extended);
    } catch {
      return extended;
    }
  }
  return /filename="?([^";]+)"?/i.exec(disposition)?.[1];
}
