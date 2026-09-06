import { conformanceFixture } from './conformance.js';

import type {
  BacklogComment,
  BacklogGitRepository,
  BacklogIssue,
  BacklogIssueComment,
  BacklogNotification,
  BacklogPullRequest,
  BacklogPullRequestAttachment,
  BacklogStar,
  BacklogUploadedFile,
} from './port.js';

/**
 * A fake `fetch` standing in for a real Backlog space, for
 * `backlog-js.test.ts` and `backlog-js.conformance.test.ts`. It speaks the
 * wire format (numeric ids, ISO date strings, the `{errors:[...]}` envelope)
 * over the same `restBaseURL` shape `backlog-js` requests
 * (`https://<host>/api/v2/<path>`), and stamps `X-RateLimit-*` on every
 * response so header capture (docs/specs/adapter.md §8.2) has something real
 * to read. It is not exported from `src/client/`; it exists only to drive
 * the conformance suite and `backlog-js.ts`'s own unit tests against a
 * predictable server.
 */
export interface FakeBacklogServerOptions {
  /** Overrides the `X-RateLimit-*` triple written on every response for a bucket. */
  rateLimitOverrides?: Partial<
    Record<
      'read' | 'update' | 'search' | 'icon',
      { limit: number; remaining: number; reset: number }
    >
  >;
  /** API key(s) accepted on `Backlog-API-Key`; a mismatch is a 401 with code 11. */
  validApiKeys?: string[];
  /** Called with every request before it is served, to make assertions on how it travelled. */
  onRequest?: (request: { method: string; url: URL; headers: Headers }) => void;
}

export interface FakeBacklogServer {
  fetch: typeof globalThis.fetch;
  state: {
    issues: BacklogIssue[];
    comments: BacklogIssueComment[];
    repositories: BacklogGitRepository[];
    pullRequests: BacklogPullRequest[];
    /**
     * Keyed by the two coordinates that identify a pull request within its
     * project, because a pull-request comment carries no reference back to
     * one (`.claude/rules/backlog-pull-request-facts.md` "Comments").
     */
    pullRequestComments: {
      repositoryId: number;
      number: number;
      comment: BacklogComment;
    }[];
    pullRequestAttachments: {
      repositoryId: number;
      number: number;
      attachment: BacklogPullRequestAttachment;
    }[];
    notifications: BacklogNotification[];
    uploads: BacklogUploadedFile[];
    stars: BacklogStar[];
  };
}

const {
  projectId,
  issueId,
  otherIssueId,
  repositoryId,
  otherRepositoryId,
  pullRequestNumber,
  otherPullRequestId,
  otherPullRequestNumber,
  pullRequestCommentIds,
  bot,
  alice,
  bob,
  baseProject,
  baseIssue,
  baseComment,
  statusChangeLog,
  baseGitRepository,
  basePullRequest,
  basePullRequestComment,
  basePullRequestAttachment,
  baseNotifications,
} = conformanceFixture;

function defaultRateLimitHeaders(
  bucket: 'read' | 'update' | 'search' | 'icon',
  overrides: FakeBacklogServerOptions['rateLimitOverrides']
): Record<string, string> {
  const defaults = { read: 600, update: 150, search: 150, icon: 60 } as const;
  const override = overrides?.[bucket];
  const limit = override?.limit ?? defaults[bucket];
  const remaining = override?.remaining ?? limit - 1;
  const reset = override?.reset ?? Math.floor(Date.now() / 1000) + 60;
  return {
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(reset),
  };
}

function toWireUser(user: {
  id: number;
  userId: string | null;
  name: string;
  mailAddress: string | null;
}) {
  return {
    id: user.id,
    userId: user.userId,
    name: user.name,
    mailAddress: user.mailAddress,
  };
}

/**
 * A REST `changeLog[]` entry as Backlog actually serialises it: the previous
 * value is named `originalValue`, not the port's `oldValue` (measured,
 * `.claude/rules/backlog-webhook-facts.md`). Emitting the port's own name here
 * would make the fake agree with a client that reads the wrong field.
 */
function toWireChangeLog(changeLog: BacklogComment['changeLog']) {
  return changeLog.map((change) => ({
    field: change.field,
    newValue: change.newValue,
    originalValue: change.oldValue,
    attachmentInfo: change.attachmentInfo,
  }));
}

function toWireStar(star: BacklogStar) {
  return {
    ...star,
    presenter: toWireUser(star.presenter),
    created: star.created.toISOString(),
  };
}

function toWireComment(comment: BacklogComment) {
  return {
    id: comment.id,
    content: comment.content,
    changeLog: toWireChangeLog(comment.changeLog),
    createdUser: toWireUser(comment.createdUser),
    created: comment.created.toISOString(),
    updated: comment.updated.toISOString(),
    stars: comment.stars.map(toWireStar),
  };
}

function toWireIssueComment(comment: BacklogIssueComment) {
  return { ...toWireComment(comment), issueId: comment.issueId };
}

function toWirePullRequest(pullRequest: BacklogPullRequest) {
  return {
    ...pullRequest,
    assignee:
      pullRequest.assignee === null ? null : toWireUser(pullRequest.assignee),
    createdUser: toWireUser(pullRequest.createdUser),
    closeAt: pullRequest.closeAt?.toISOString() ?? null,
    mergeAt: pullRequest.mergeAt?.toISOString() ?? null,
    created: pullRequest.created.toISOString(),
    updated: pullRequest.updated.toISOString(),
    stars: pullRequest.stars.map(toWireStar),
  };
}

function toWirePullRequestAttachment(attachment: BacklogPullRequestAttachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    size: attachment.size,
    createdUser: toWireUser(bot),
    created: attachment.created.toISOString(),
  };
}

function toWireIssue(issue: BacklogIssue) {
  return {
    ...issue,
    assignee: issue.assignee === null ? null : toWireUser(issue.assignee),
    createdUser: toWireUser(issue.createdUser),
    created: issue.created.toISOString(),
    updated: issue.updated.toISOString(),
  };
}

function jsonResponse(
  url: string,
  status: number,
  body: unknown,
  headers: Record<string, string>
): Response {
  const responseHeaders = new Headers(headers);
  const response =
    body === undefined
      ? new Response(null, { status, headers: responseHeaders })
      : new Response(JSON.stringify(body), {
          status,
          headers: responseHeaders,
        });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

/**
 * A pull-request attachment download, which is the one response that is not
 * JSON: it carries the file's real content type and names the file only in
 * `Content-Disposition` (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md` "Attachments").
 */
function fileResponse(
  url: string,
  attachment: BacklogPullRequestAttachment,
  headers: Record<string, string>
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'image/png');
  responseHeaders.set(
    'Content-Disposition',
    `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name)}`
  );
  const response = new Response(new Uint8Array(attachment.size), {
    status: 200,
    headers: responseHeaders,
  });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function errorBody(
  code: number,
  message: string
): { errors: { message: string; code: number; moreInfo: string }[] } {
  return { errors: [{ message, code, moreInfo: '' }] };
}

/**
 * Creates a fake server seeded with the same fixture the in-memory
 * implementation's conformance test uses, so both implementations answer the
 * shared assertions identically.
 */
export function createFakeBacklogServer(
  options: FakeBacklogServerOptions = {}
): FakeBacklogServer {
  const state: FakeBacklogServer['state'] = {
    issues: [
      baseIssue({ id: issueId }),
      baseIssue({ id: otherIssueId, issueKey: 'PROJECT-2' }),
    ],
    comments: [
      baseComment({ id: 1, issueId }),
      baseComment({ id: 2, issueId, createdUser: bob }),
      baseComment({
        id: 3,
        issueId,
        createdUser: bob,
        changeLog: statusChangeLog,
      }),
      baseComment({ id: 4, issueId: otherIssueId }),
    ],
    repositories: [
      baseGitRepository(),
      baseGitRepository({ id: otherRepositoryId, name: 'other-repo' }),
    ],
    pullRequests: [
      basePullRequest(),
      basePullRequest({
        id: otherPullRequestId,
        number: otherPullRequestNumber,
      }),
    ],
    pullRequestComments: pullRequestCommentIds.map((id) => ({
      repositoryId,
      number: pullRequestNumber,
      comment: basePullRequestComment({ id }),
    })),
    pullRequestAttachments: [
      {
        repositoryId,
        number: pullRequestNumber,
        attachment: basePullRequestAttachment(),
      },
    ],
    notifications: baseNotifications(),
    uploads: [],
    stars: [],
  };
  let nextId = 1000;
  // Pull-request comments are allocated from their own counter because the
  // two comment sequences are separate on a real space
  // (`.claude/rules/backlog-pull-request-facts.md` "Ids"); sharing `nextId`
  // would hand a new pull-request comment an id in the issue-comment range
  // and let a test that confuses the two pass.
  let nextPullRequestCommentId = Math.max(...pullRequestCommentIds) + 1;

  const project = baseProject();
  const users = [alice, bob, bot];
  const issueTypes = [{ id: 1, name: 'Task' }];
  const priorities = [
    { id: 2, name: 'High' },
    { id: 3, name: 'Normal' },
    { id: 4, name: 'Low' },
  ];

  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    options.onRequest?.({ method, url, headers });

    if (options.validApiKeys !== undefined) {
      const apiKey = headers.get('Backlog-API-Key');
      if (apiKey === null || !options.validApiKeys.includes(apiKey)) {
        return jsonResponse(
          url.toString(),
          401,
          errorBody(11, 'Authentication failure'),
          {
            ...defaultRateLimitHeaders('read', options.rateLimitOverrides),
          }
        );
      }
    }

    const path = url.pathname.replace(/^\/api\/v2\//, '');
    const segments = path.split('/');
    const bucket = classify(method, path);
    const rateLimitHeaders = defaultRateLimitHeaders(
      bucket,
      options.rateLimitOverrides
    );
    const rateLimited = isRateLimited(bucket, options.rateLimitOverrides);
    if (rateLimited) {
      return jsonResponse(
        url.toString(),
        429,
        errorBody(13, 'Too many requests'),
        rateLimitHeaders
      );
    }

    try {
      return await route({
        method,
        path,
        segments,
        url,
        init,
        rateLimitHeaders,
      });
    } catch (error) {
      if (error instanceof RouteError) {
        return jsonResponse(
          url.toString(),
          error.status,
          errorBody(error.code, error.message),
          rateLimitHeaders
        );
      }
      throw error;
    }
  };

  function classify(
    method: string,
    path: string
  ): 'read' | 'update' | 'search' | 'icon' {
    if (method !== 'GET') return 'update';
    // The Rate limit page puts only the issue and wiki list/count endpoints
    // in `search`, and `GET …/pullRequests` was measured decrementing `read`
    // (`.claude/rules/backlog-pull-request-facts.md` "Rate limit"), so no
    // branch for a listing endpoint belongs here beyond the two below —
    // however much a pull-request *list* reads like a search.
    if (/^issues\/?(?:$)/.test(path) || path === 'issues/count')
      return 'search';
    return 'read';
  }

  function isRateLimited(
    bucket: 'read' | 'update' | 'search' | 'icon',
    overrides: FakeBacklogServerOptions['rateLimitOverrides']
  ): boolean {
    return overrides?.[bucket]?.remaining === 0;
  }

  class RouteError extends Error {
    constructor(
      readonly status: number,
      readonly code: number,
      message: string
    ) {
      super(message);
    }
  }

  async function readParams(
    init: RequestInit | undefined
  ): Promise<Record<string, string | string[]>> {
    if (init?.body === undefined || init.body === null) {
      return {};
    }
    const text =
      typeof init.body === 'string'
        ? init.body
        : init.body instanceof URLSearchParams
          ? init.body.toString()
          : undefined;
    if (text === undefined) {
      return {};
    }
    const parsed = new URLSearchParams(text);
    const result: Record<string, string | string[]> = {};
    for (const key of new Set(parsed.keys())) {
      const values = parsed.getAll(key);
      result[key] = values.length > 1 ? values : (values[0] ?? '');
    }
    return result;
  }

  async function route(context: {
    method: string;
    path: string;
    segments: string[];
    url: URL;
    init: RequestInit | undefined;
    rateLimitHeaders: Record<string, string>;
  }): Promise<Response> {
    const { method, segments, url, init, rateLimitHeaders } = context;
    const respond = (status: number, body: unknown): Response =>
      jsonResponse(url.toString(), status, body, rateLimitHeaders);

    // GET /issues (search bucket) and GET /issues/count
    if (method === 'GET' && segments[0] === 'issues' && segments.length === 1) {
      const count = Number(url.searchParams.get('count') ?? '20');
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const forProject = state.issues.filter((i) => i.projectId === projectId);
      return respond(
        200,
        forProject.slice(offset, offset + count).map(toWireIssue)
      );
    }

    // POST /issues (create)
    if (
      method === 'POST' &&
      segments[0] === 'issues' &&
      segments.length === 1
    ) {
      const params = await readParams(init);
      const id = nextId++;
      const now = new Date();
      const issue: BacklogIssue = {
        id,
        projectId: Number(params['projectId']),
        issueKey: `PROJECT-${id}`,
        summary: String(params['summary'] ?? ''),
        description: String(params['description'] ?? ''),
        issueType: { id: Number(params['issueTypeId']), name: 'Task' },
        priority: { id: Number(params['priorityId']), name: 'Normal' },
        status: { id: 1, name: 'Open' },
        assignee: null,
        createdUser: bot,
        created: now,
        updated: now,
      };
      state.issues.push(issue);
      return respond(201, toWireIssue(issue));
    }

    // POST /space/attachment (multipart, one "file" part)
    if (
      method === 'POST' &&
      segments[0] === 'space' &&
      segments[1] === 'attachment'
    ) {
      const form = init?.body as FormData;
      const part = form.get('file');
      const id = nextId++;
      const file = {
        id,
        name: part instanceof File ? part.name : 'uploaded-file',
        size: part instanceof File ? part.size : 0,
      };
      state.uploads.push(file);
      return respond(201, file);
    }

    // /issues/:id
    if (segments[0] === 'issues' && segments.length >= 2) {
      const issueIdOrKey = Number(segments[1]);

      if (segments.length === 2 && method === 'GET') {
        const issue = state.issues.find((i) => i.id === issueIdOrKey);
        if (issue === undefined) throw new RouteError(404, 6, 'No such issue');
        return respond(200, toWireIssue(issue));
      }

      if (segments[2] === 'comments') {
        if (segments.length === 3 && method === 'GET') {
          const params = url.searchParams;
          const count = Number(params.get('count') ?? '20');
          const order = (params.get('order') ?? 'desc') as 'asc' | 'desc';
          const minId = params.has('minId')
            ? Number(params.get('minId'))
            : undefined;
          const maxId = params.has('maxId')
            ? Number(params.get('maxId'))
            : undefined;
          const forIssue = state.comments.filter(
            (c) => c.issueId === issueIdOrKey
          );
          const withinBounds = forIssue.filter((c) => {
            if (minId !== undefined && c.id <= minId) return false;
            if (maxId !== undefined && c.id >= maxId) return false;
            return true;
          });
          const sorted = [...withinBounds].sort((a, b) =>
            order === 'asc' ? a.id - b.id : b.id - a.id
          );
          return respond(200, sorted.slice(0, count).map(toWireIssueComment));
        }

        if (segments.length === 3 && method === 'POST') {
          const params = await readParams(init);
          const id = nextId++;
          const now = new Date();
          const comment: BacklogIssueComment = {
            id,
            issueId: issueIdOrKey,
            content: String(params['content'] ?? ''),
            changeLog: [],
            createdUser: bot,
            created: now,
            updated: now,
            stars: [],
          };
          state.comments.push(comment);
          return respond(201, toWireIssueComment(comment));
        }

        if (segments.length === 4) {
          const commentId = Number(segments[3]);
          const comment = state.comments.find(
            (c) => c.id === commentId && c.issueId === issueIdOrKey
          );

          if (method === 'GET') {
            if (comment === undefined)
              throw new RouteError(404, 6, 'No such comment');
            return respond(200, toWireIssueComment(comment));
          }
          if (method === 'PATCH') {
            if (comment === undefined)
              throw new RouteError(404, 6, 'No such comment');
            const params = await readParams(init);
            comment.content = String(params['content'] ?? comment.content);
            comment.updated = new Date();
            return respond(200, toWireIssueComment(comment));
          }
          if (method === 'DELETE') {
            if (comment === undefined)
              throw new RouteError(404, 6, 'No such comment');
            state.comments.splice(state.comments.indexOf(comment), 1);
            return respond(200, toWireIssueComment(comment));
          }
        }
      }
    }

    if (
      segments[0] === 'projects' &&
      segments.length === 2 &&
      method === 'GET'
    ) {
      const projectIdOrKey = Number(segments[1]);
      if (projectIdOrKey !== projectId)
        throw new RouteError(404, 6, 'No such project');
      return respond(200, project);
    }

    if (
      segments[0] === 'projects' &&
      segments[2] === 'issueTypes' &&
      method === 'GET'
    ) {
      return respond(200, issueTypes);
    }

    // /projects/:p/git/repositories[/:r[/pullRequests[/:n[/comments[/:cid]
    // |/attachments[/:aid]]]]]
    if (
      segments[0] === 'projects' &&
      segments[2] === 'git' &&
      segments[3] === 'repositories'
    ) {
      const projectIdOrKey = Number(segments[1]);
      if (projectIdOrKey !== projectId)
        throw new RouteError(404, 6, 'No such project');

      if (segments.length === 4 && method === 'GET') {
        return respond(
          200,
          state.repositories.filter((r) => r.projectId === projectIdOrKey)
        );
      }

      if (segments.length >= 5) {
        const repoIdOrName = Number(segments[4]);
        const repository = state.repositories.find(
          (r) => r.id === repoIdOrName
        );
        if (repository === undefined)
          throw new RouteError(404, 6, 'No such repository');

        if (segments.length === 5 && method === 'GET') {
          return respond(200, repository);
        }

        if (segments[5] === 'pullRequests') {
          if (segments.length === 6 && method === 'GET') {
            const count = Number(url.searchParams.get('count') ?? '20');
            const offset = Number(url.searchParams.get('offset') ?? '0');
            const inRepository = state.pullRequests.filter(
              (pr) => pr.repositoryId === repository.id
            );
            return respond(
              200,
              inRepository.slice(offset, offset + count).map(toWirePullRequest)
            );
          }

          if (segments.length >= 7) {
            const number = Number(segments[6]);
            const pullRequest = state.pullRequests.find(
              (pr) => pr.repositoryId === repository.id && pr.number === number
            );
            if (pullRequest === undefined)
              throw new RouteError(404, 6, 'No such PullRequest');

            if (segments.length === 7 && method === 'GET') {
              return respond(200, toWirePullRequest(pullRequest));
            }

            if (segments[7] === 'comments') {
              const inPullRequest = state.pullRequestComments.filter(
                (entry) =>
                  entry.repositoryId === repository.id &&
                  entry.number === pullRequest.number
              );

              if (segments.length === 8 && method === 'GET') {
                const params = url.searchParams;
                const count = Number(params.get('count') ?? '20');
                const order = (params.get('order') ?? 'desc') as 'asc' | 'desc';
                const minId = params.has('minId')
                  ? Number(params.get('minId'))
                  : undefined;
                const maxId = params.has('maxId')
                  ? Number(params.get('maxId'))
                  : undefined;
                const withinBounds = inPullRequest
                  .map((entry) => entry.comment)
                  .filter((c) => {
                    if (minId !== undefined && c.id <= minId) return false;
                    if (maxId !== undefined && c.id >= maxId) return false;
                    return true;
                  });
                const sorted = [...withinBounds].sort((a, b) =>
                  order === 'asc' ? a.id - b.id : b.id - a.id
                );
                return respond(200, sorted.slice(0, count).map(toWireComment));
              }

              if (segments.length === 8 && method === 'POST') {
                const params = await readParams(init);
                const now = new Date();
                const comment: BacklogComment = {
                  id: nextPullRequestCommentId++,
                  content: String(params['content'] ?? ''),
                  changeLog: [],
                  createdUser: bot,
                  created: now,
                  updated: now,
                  stars: [],
                };
                state.pullRequestComments.push({
                  repositoryId: repository.id,
                  number: pullRequest.number,
                  comment,
                });
                // 200, not the 201 Add Comment answers: Add Pull Request and
                // Add Pull Request Comment both answer 200 (measured
                // 2026-09-06, `.claude/rules/backlog-pull-request-facts.md`
                // "Addressing"). Aligning it with the issue side would make
                // the fake server disagree with the space it stands in for.
                return respond(200, toWireComment(comment));
              }

              if (segments.length === 9) {
                const commentId = Number(segments[8]);
                const entry = inPullRequest.find(
                  (e) => e.comment.id === commentId
                );
                if (method === 'PATCH') {
                  if (entry === undefined)
                    throw new RouteError(404, 6, 'No such comment');
                  const params = await readParams(init);
                  entry.comment.content = String(
                    params['content'] ?? entry.comment.content
                  );
                  entry.comment.updated = new Date();
                  return respond(200, toWireComment(entry.comment));
                }
                // GET and DELETE are 400/6 `Undefined resource`, not 404:
                // neither route exists on a real space (measured 2026-09-06),
                // and an undefined route answers 400 there.
                if (method === 'GET' || method === 'DELETE') {
                  throw new RouteError(
                    400,
                    6,
                    'Undefined resource. Please check the URL.'
                  );
                }
              }
            }

            if (segments[7] === 'attachments') {
              const inPullRequest = state.pullRequestAttachments.filter(
                (entry) =>
                  entry.repositoryId === repository.id &&
                  entry.number === pullRequest.number
              );

              if (segments.length === 8 && method === 'GET') {
                return respond(
                  200,
                  inPullRequest.map((entry) =>
                    toWirePullRequestAttachment(entry.attachment)
                  )
                );
              }

              if (segments.length === 9 && method === 'GET') {
                const attachmentId = Number(segments[8]);
                const entry = inPullRequest.find(
                  (e) => e.attachment.id === attachmentId
                );
                if (entry === undefined)
                  throw new RouteError(404, 6, 'No such attachment');
                return fileResponse(
                  url.toString(),
                  entry.attachment,
                  rateLimitHeaders
                );
              }
            }
          }
        }
      }
    }

    if (segments[0] === 'priorities' && method === 'GET') {
      return respond(200, priorities);
    }

    if (segments[0] === 'users' && segments.length === 2 && method === 'GET') {
      const userId = Number(segments[1]);
      const user = users.find((u) => u.id === userId);
      if (user === undefined) throw new RouteError(404, 6, 'No such user');
      return respond(200, toWireUser(user));
    }

    if (segments[0] === 'stars' && method === 'POST') {
      const params = await readParams(init);
      const comment =
        params['pullRequestCommentId'] !== undefined
          ? state.pullRequestComments.find(
              (e) => e.comment.id === Number(params['pullRequestCommentId'])
            )?.comment
          : state.comments.find((c) => c.id === Number(params['commentId']));
      if (comment === undefined)
        throw new RouteError(404, 6, 'No such comment');
      const star: BacklogStar = {
        id: nextId++,
        comment: null,
        url: '',
        title: '',
        presenter: bot,
        created: new Date(),
      };
      comment.stars.push(star);
      state.stars.push(star);
      return respond(204, undefined);
    }

    if (
      segments[0] === 'stars' &&
      segments.length === 2 &&
      method === 'DELETE'
    ) {
      const starId = Number(segments[1]);
      const star = state.stars.find((s) => s.id === starId);
      if (star === undefined) throw new RouteError(404, 6, 'No such star');
      state.stars.splice(state.stars.indexOf(star), 1);
      const starred = [
        ...state.comments,
        ...state.pullRequestComments.map((e) => e.comment),
      ];
      for (const comment of starred) {
        const index = comment.stars.findIndex((s) => s.id === starId);
        if (index !== -1) comment.stars.splice(index, 1);
      }
      return respond(204, undefined);
    }

    if (
      segments[0] === 'notifications' &&
      segments.length === 1 &&
      method === 'GET'
    ) {
      const params = url.searchParams;
      const count = Number(params.get('count') ?? '20');
      const maxId = params.has('maxId')
        ? Number(params.get('maxId'))
        : undefined;
      const withinBounds = state.notifications.filter(
        (n) => maxId === undefined || n.id < maxId
      );
      const sorted = [...withinBounds].sort((a, b) => b.id - a.id);
      return respond(
        200,
        sorted.slice(0, count).map((n) => ({
          ...n,
          sender: toWireUser(n.sender),
          created: n.created.toISOString(),
        }))
      );
    }

    if (
      segments[0] === 'notifications' &&
      segments[2] === 'markAsRead' &&
      method === 'POST'
    ) {
      const id = Number(segments[1]);
      const notification = state.notifications.find((n) => n.id === id);
      if (notification === undefined)
        throw new RouteError(404, 6, 'No such notification');
      notification.alreadyRead = true;
      return respond(204, undefined);
    }

    throw new RouteError(404, 6, `No route for ${method} ${context.path}`);
  }

  return { fetch: fetchImpl, state };
}
