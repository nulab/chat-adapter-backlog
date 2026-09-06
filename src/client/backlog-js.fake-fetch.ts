import { conformanceFixture } from './conformance.js';

import type {
  BacklogComment,
  BacklogIssue,
  BacklogNotification,
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
    comments: BacklogComment[];
    notifications: BacklogNotification[];
    uploads: BacklogUploadedFile[];
    stars: BacklogStar[];
  };
}

const {
  projectId,
  issueId,
  otherIssueId,
  bot,
  alice,
  bob,
  baseProject,
  baseIssue,
  baseComment,
  statusChangeLog,
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

function toWireComment(comment: BacklogComment) {
  return {
    id: comment.id,
    issueId: comment.issueId,
    content: comment.content,
    changeLog: toWireChangeLog(comment.changeLog),
    createdUser: toWireUser(comment.createdUser),
    created: comment.created.toISOString(),
    updated: comment.updated.toISOString(),
    stars: comment.stars.map((s) => ({
      ...s,
      presenter: toWireUser(s.presenter),
      created: s.created.toISOString(),
    })),
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
    notifications: [
      {
        id: 1,
        alreadyRead: false,
        project: { id: projectId, projectKey: 'PROJECT', name: 'Project' },
        issue: null,
        comment: { id: 1 },
        sender: alice,
        created: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 2,
        alreadyRead: false,
        project: { id: projectId, projectKey: 'PROJECT', name: 'Project' },
        issue: null,
        comment: { id: 2 },
        sender: bob,
        created: new Date('2026-01-01T00:01:00Z'),
      },
    ],
    uploads: [],
    stars: [],
  };
  let nextId = 1000;

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
          return respond(200, sorted.slice(0, count).map(toWireComment));
        }

        if (segments.length === 3 && method === 'POST') {
          const params = await readParams(init);
          const id = nextId++;
          const now = new Date();
          const comment: BacklogComment = {
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
          return respond(201, toWireComment(comment));
        }

        if (segments.length === 4) {
          const commentId = Number(segments[3]);
          const comment = state.comments.find(
            (c) => c.id === commentId && c.issueId === issueIdOrKey
          );

          if (method === 'GET') {
            if (comment === undefined)
              throw new RouteError(404, 6, 'No such comment');
            return respond(200, toWireComment(comment));
          }
          if (method === 'PATCH') {
            if (comment === undefined)
              throw new RouteError(404, 6, 'No such comment');
            const params = await readParams(init);
            comment.content = String(params['content'] ?? comment.content);
            comment.updated = new Date();
            return respond(200, toWireComment(comment));
          }
          if (method === 'DELETE') {
            if (comment === undefined)
              throw new RouteError(404, 6, 'No such comment');
            state.comments.splice(state.comments.indexOf(comment), 1);
            return respond(200, toWireComment(comment));
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
      const commentId = Number(params['commentId']);
      const comment = state.comments.find((c) => c.id === commentId);
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
      for (const comment of state.comments) {
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
