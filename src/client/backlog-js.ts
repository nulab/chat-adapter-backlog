import { Backlog, Error as BacklogJsError } from 'backlog-js';
import { z } from 'zod';

import {
  mapBacklogError,
  mapCredentialResolverError,
  mapSchemaError,
  mapTransportError,
  stripQueryString,
} from './errors.js';
import { classifyBucket, decideRetry, RateLimitTracker } from './rate-limit.js';
import {
  commentListSchema,
  commentSchema,
  issueListSchema,
  issueSchema,
  issueTypeListSchema,
  notificationListSchema,
  priorityListSchema,
  projectSchema,
  uploadedFileSchema,
  userResponseSchema,
} from './schemas.js';

import type { BacklogErrorBodyEntry } from './errors.js';
import type {
  AddCommentInput,
  BacklogApi,
  BacklogComment,
  BacklogDownloadedFile,
  BacklogIssue,
  BacklogIssueType,
  BacklogNotification,
  BacklogPriority,
  BacklogProject,
  BacklogUploadedFile,
  BacklogUserRef,
  CreateIssueInput,
  ListCommentsOptions,
  ListIssuesOptions,
  ListNotificationsOptions,
  RateLimitSnapshots,
  RetryOptions,
} from './port.js';
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
   * not per call.
   */
  async function call(args: RequestArgs, attempt = 0): Promise<Response> {
    const resolved = await resolveCredentials();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const wrappedFetch: Fetch = (input, init) =>
      fetch(input, { ...init, signal: controller.signal });

    const client = new Backlog({
      host,
      ...resolved,
      fetch: wrappedFetch,
    });

    const bucket = classifyBucket(args.method, args.path);

    try {
      const response = await client.request({
        method: args.method,
        path: args.path,
        ...(args.params !== undefined && { params: args.params as never }),
      });
      tracker.record(host, bucket, response.headers);
      return response;
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
            await wait(decision.waitMs);
            return call(args, attempt + 1);
          }
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
    const entry = error.body?.errors[0];
    if (entry === undefined) {
      return undefined;
    }
    return {
      message: entry.message,
      code: entry.code,
      moreInfo: entry.moreInfo,
    };
  }

  async function wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function requestJson<T>(
    endpoint: string,
    schema: ZodType<T>,
    args: RequestArgs
  ): Promise<T> {
    const response = await call(args);
    const body: unknown =
      response.status === 204 ? undefined : await response.json();
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
      const params: Record<string, unknown> = {
        count: options.count,
        order: options.order,
      };
      if (options.minId !== undefined) params['minId'] = options.minId;
      if (options.maxId !== undefined) params['maxId'] = options.maxId;
      return requestJson<BacklogComment[]>('listComments', commentListSchema, {
        method: 'GET',
        path: `issues/${issueId}/comments`,
        params,
      });
    },

    async getComment(issueId, commentId) {
      const comment = await requestJson<BacklogComment>(
        'getComment',
        commentSchema,
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
      return requestJson<BacklogComment>('addComment', commentSchema, {
        method: 'POST',
        path: `issues/${issueId}/comments`,
        params,
      });
    },

    async updateComment(issueId, commentId, content) {
      return requestJson<BacklogComment>('updateComment', commentSchema, {
        method: 'PATCH',
        path: `issues/${issueId}/comments/${commentId}`,
        params: { content },
      });
    },

    async deleteComment(issueId, commentId) {
      return requestJson<BacklogComment>('deleteComment', commentSchema, {
        method: 'DELETE',
        path: `issues/${issueId}/comments/${commentId}`,
      });
    },

    async addStar(commentId) {
      await call({ method: 'POST', path: 'stars', params: { commentId } });
    },

    async deleteStar(starId) {
      await call({ method: 'DELETE', path: `stars/${starId}` });
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
      await call({ method: 'POST', path: `notifications/${id}/markAsRead` });
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
      const response = await call({
        method: 'GET',
        path: `issues/${issueId}/attachments/${attachmentId}`,
      });
      const arrayBuffer = await response.arrayBuffer();
      const disposition = response.headers.get('Content-Disposition');
      return {
        filename: parseFilename(disposition) ?? String(attachmentId),
        contentType:
          response.headers.get('Content-Type') ?? 'application/octet-stream',
        data: Buffer.from(arrayBuffer),
      };
    },

    rateLimit(): RateLimitSnapshots {
      return tracker.snapshot(host);
    },
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
