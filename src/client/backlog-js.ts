import { Backlog, Error as BacklogJsError } from 'backlog-js';
import { z } from 'zod';

import {
  mapBacklogError,
  mapCredentialResolverError,
  mapSchemaError,
  mapTransportError,
  stripQueryString,
} from './errors.js';
import {
  classifyBucket,
  decideRetry,
  RATE_LIMIT_BUCKETS,
  RateLimitTracker,
} from './rate-limit.js';
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
  rateLimitResponseSchema,
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
  PullRequestRef,
  RateLimitBucket,
  RateLimitSnapshots,
  RetryOptions,
  StarTarget,
} from './port.js';
import type { Logger } from 'chat';
import type { ZodType } from 'zod';

type Fetch = typeof globalThis.fetch;

export interface BacklogCredentials {
  apiKey?: () => string | Promise<string>;
  accessToken?: () => string | Promise<string>;
}

export interface CreateBacklogJsApiOptions {
  host: string;
  credentials: BacklogCredentials;
  /** Injected for tests; defaults to `globalThis.fetch`. See VERIFIED-FACTS: `backlog-js`'s `fetch` option is the seam for header capture and per-call credentials. */
  fetch?: Fetch;
  /** Request timeout via `AbortSignal`, in milliseconds. Default 30 000 (docs/specs/adapter.md §8.2). */
  timeoutMs?: number;
  retry?: RetryOptions;
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
 * `backlog-js`-backed `BacklogApi`. Two constraints from
 * docs/specs/adapter.md §8.2 shape this file:
 *
 * - `backlog-js`'s entity methods (`getIssue`, `postIssue`, ...) return
 *   parsed bodies and discard the `Response`, so `X-RateLimit-*` would be
 *   swallowed on success. Every call here goes through the low-level
 *   `request()` instead, which returns the raw `Response` on success and
 *   throws a `BacklogError` subclass — exposing `.response` — on failure, so
 *   headers are captured on both paths from one call site.
 * - Credentials are resolved fresh before each request rather than once at
 *   construction, because the resolver form (VERIFIED-FACTS) must support a
 *   token that a caller refreshes between calls.
 * - Array parameters are named **without** the `[]` Backlog's documentation
 *   shows (`projectId`, not `projectId[]`). `backlog-js` 0.20.1's
 *   `toQueryString` passes every key through verbatim into
 *   `qs.stringify(..., { arrayFormat: "brackets" })`, and that appends the
 *   brackets itself: `{ projectId: [500] }` reaches the wire as
 *   `projectId[]=500`, while `{ "projectId[]": [500] }` reaches it as
 *   `projectId[][]=500`, which Backlog does not bind to the parameter at all.
 */
export function createBacklogJsApi(
  options: CreateBacklogJsApiOptions
): BacklogApi {
  const {
    host,
    credentials,
    fetch = globalThis.fetch,
    timeoutMs = 30_000,
    retry,
    logger,
  } = options;
  const tracker = new RateLimitTracker();

  async function resolveCredentials(): Promise<{
    apiKey?: string;
    accessToken?: string;
  }> {
    try {
      if (credentials.apiKey) {
        return { apiKey: await credentials.apiKey() };
      }
      if (credentials.accessToken) {
        return { accessToken: await credentials.accessToken() };
      }
      throw new Error('No Backlog credential resolver configured');
    } catch (cause) {
      throw mapCredentialResolverError(cause);
    }
  }

  /**
   * Issues one Backlog API request with header capture and one bounded 429
   * retry. Credentials are resolved again on every call (including the retry
   * attempt) — see class doc — and a fresh `Backlog` client is constructed
   * per attempt because `backlog-js` takes credentials at construction time,
   * not per call. `consume` reads the successful `Response` and must run
   * inside this function's own try/catch/finally: it shares the request's
   * abort timer and error mapping, so a stalled or malformed body is
   * cancelled by the timeout and mapped to an adapter error like any other
   * transport failure.
   */
  async function call<T>(
    args: RequestArgs,
    consume: (response: Response) => Promise<T>,
    attempt = 0
  ): Promise<T> {
    const resolved = await resolveCredentials();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const wrappedFetch: Fetch = (input, init) =>
      fetch(input, { ...init, signal: controller.signal });

    const bucket = classifyBucket(args.method, args.path);

    try {
      // Construction belongs inside the mapping boundary too. A credential
      // resolver can return a string that the Fetch headers reject (CR/LF is
      // the common case), and no implementation error may escape the port.
      const client = new Backlog({
        host,
        ...resolved,
        fetch: wrappedFetch,
      });
      const response = await client.request({
        method: args.method,
        path: args.path,
        ...(args.params !== undefined && { params: args.params as never }),
      });
      tracker.record(host, bucket, response.headers);
      // Body consumption stays under the same AbortSignal timer as the
      // request. A proxy can answer the headers and then stall the stream;
      // clearing the timer before json()/arrayBuffer() would wait forever.
      return await consume(response);
    } catch (cause) {
      if (isAbortError(cause)) {
        throw mapTransportError(cause);
      }
      if (cause instanceof BacklogJsError.BacklogError) {
        tracker.record(host, bucket, cause.response.headers);
        const bodyError = firstBodyError(cause);
        if (cause.status === 429 || bodyError?.code === 13) {
          const decision = decideRetry(
            attempt,
            cause.response.headers.get('X-RateLimit-Reset'),
            Date.now(),
            retry
          );
          if (decision.shouldRetry) {
            logRateLimit(
              'rate limited; waiting for the bucket to reset',
              bucket,
              cause.response.headers,
              decision,
              attempt
            );
            await wait(decision.waitMs);
            return call(args, consume, attempt + 1);
          }
          logRateLimit(
            'rate limited; not retrying',
            bucket,
            cause.response.headers,
            decision,
            attempt
          );
          throw mapBacklogError({
            status: cause.status,
            url: stripQueryString(cause.url),
            retryAfterSeconds: decision.retryAfterSeconds,
            ...(bodyError !== undefined && { bodyError }),
          });
        }
        throw mapBacklogError({
          status: cause.status,
          url: stripQueryString(cause.url),
          ...(bodyError !== undefined && { bodyError }),
        });
      }
      throw mapTransportError(cause);
    } finally {
      clearTimeout(timer);
    }
  }

  function isAbortError(cause: unknown): boolean {
    return cause instanceof Error && cause.name === 'AbortError';
  }

  function firstBodyError(
    error: InstanceType<typeof BacklogJsError.BacklogError>
  ): BacklogErrorBodyEntry | undefined {
    const errors = error.body?.errors;
    if (!Array.isArray(errors)) {
      return undefined;
    }
    const entry: unknown = errors[0];
    if (typeof entry !== 'object' || entry === null) {
      return undefined;
    }
    const message = 'message' in entry ? entry.message : undefined;
    const code = 'code' in entry ? entry.code : undefined;
    if (typeof message !== 'string' || typeof code !== 'number') {
      return undefined;
    }
    const moreInfo = 'moreInfo' in entry ? entry.moreInfo : undefined;
    return {
      message,
      code,
      ...(typeof moreInfo === 'string' && { moreInfo }),
    };
  }

  /**
   * The only two lines this port logs. Every other request stays silent on
   * purpose: an `X-RateLimit-Remaining` line per request would be one entry
   * per API call against a 150-per-minute bucket, which buries the two
   * moments an operator acts on — the request that blocked, and the request
   * that failed instead of blocking.
   */
  function logRateLimit(
    message: string,
    bucket: RateLimitBucket,
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
      bucket,
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

  return {
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

    async getRateLimit(): Promise<RateLimitSnapshots> {
      const body = await requestJson('getRateLimit', rateLimitResponseSchema, {
        method: 'GET',
        path: 'rateLimit',
      });
      const snapshots: RateLimitSnapshots = {};
      for (const bucket of RATE_LIMIT_BUCKETS) {
        const reported = body.rateLimit[bucket];
        if (reported !== undefined) {
          snapshots[bucket] = {
            limit: reported.limit,
            remaining: reported.remaining,
            reset: new Date(reported.reset * 1000),
          };
        }
      }
      // The four buckets this answer describes are deliberately not fed to
      // `tracker`: it reports what this instance's own requests observed, and
      // mixing in a server-reported figure would make `rateLimit()` claim
      // knowledge of buckets nothing here has spent. The `read` entry the
      // response headers produced in `call()` is the honest part and is
      // already recorded.
      return snapshots;
    },

    rateLimit(): RateLimitSnapshots {
      return tracker.snapshot(host);
    },
  };
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
 */
function parseFilename(disposition: string | null): string | undefined {
  if (disposition === null) {
    return undefined;
  }
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}
