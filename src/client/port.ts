/**
 * The Backlog API port: every domain type and the `BacklogApi` interface
 * itself are owned here so the modules written against it — egress, reads,
 * the subject layer — never see a `backlog-js` or `zod` type.
 * `src/client/backlog-js.ts` and `src/client/in-memory.ts` both implement
 * this interface, and either can back any of them.
 *
 * The adapter as a whole is not `backlog-js`-free, and stopped being so on
 * purpose: `BacklogAdapter.client(host)` hands out the client the
 * `backlog-js` implementation speaks through, for the endpoints this
 * interface does not name (docs/specs/adapter.md §3.1).
 *
 * Method-to-endpoint-to-bucket mapping: docs/specs/adapter.md §8.1.
 */

/** One of the four independent per-user, per-minute rate-limit buckets. */
export type RateLimitBucket = 'read' | 'update' | 'search' | 'icon';

/** A snapshot of one bucket's `X-RateLimit-*` headers from the most recent response. */
export interface RateLimitSnapshot {
  limit: number;
  remaining: number;
  /** When this bucket resets. */
  reset: Date;
}

/**
 * A per-bucket view of the rate limit, from either source below. It is partial
 * on both: `rateLimit()` knows only the buckets a response has been observed
 * for, and `getRateLimit()` reports only the buckets the endpoint names. The
 * one type is deliberate — the two sources are interchangeable at a call site,
 * so a caller can move from the cheap one to the accurate one without
 * rewriting how it reads the figures.
 */
export type RateLimitSnapshots = Partial<
  Record<RateLimitBucket, RateLimitSnapshot>
>;

export interface BacklogUserRef {
  /**
   * The numeric Backlog user id — identity everywhere in this adapter
   * (docs/specs/adapter.md §2 `<host>:<userId>`, §6.5 `presenter.id ===
   * botUserId`, §7.3 `assignee`/`createdUserId`). `userId` below is the
   * login handle, not identity: it is `null` for a user signed in with a
   * Nulab account (see the field below), so it cannot serve as the stable
   * key `id` is.
   */
  id: number;
  /** `null` when the API omits it (e.g. a deleted user or a Nulab-account login), per docs/specs/adapter.md §8.1. */
  userId: string | null;
  name: string;
  mailAddress: string | null;
}

export interface BacklogStar {
  id: number;
  /** `null` on every observed payload; `.claude/rules/backlog-api-facts.md` "Stars". */
  comment: string | null;
  url: string;
  title: string;
  presenter: BacklogUserRef;
  created: Date;
}

/**
 * The attachment a `changeLog[]` entry names. Only `id` identifies it; `name`
 * and `size` are optional because the two doc pages disagree on whether a
 * `changeLog` carries them at all (see `src/client/schemas.ts`), and a comment
 * whose attachment is described the other way must still parse.
 */
export interface BacklogAttachmentInfo {
  id: number;
  name?: string | undefined;
  size?: number | undefined;
}

export interface BacklogChange {
  field: string;
  newValue: string | null;
  oldValue: string | null;
  attachmentInfo: BacklogAttachmentInfo | null;
}

/**
 * The comment shape both endpoint families return. A pull-request comment
 * carries **no parent reference** at all — no `issueId`, no pull-request id
 * (measured 2026-09-06, `.claude/rules/backlog-pull-request-facts.md`) — so
 * the parent lives on `BacklogIssueComment` alone and everything a caller can
 * do with either kind is expressed here.
 */
export interface BacklogComment {
  id: number;
  /** `null` for a system-generated comment such as an assignee change. */
  content: string | null;
  changeLog: BacklogChange[];
  createdUser: BacklogUserRef;
  created: Date;
  updated: Date;
  stars: BacklogStar[];
}

/** Issue comments additionally name their parent (docs/specs/adapter.md §8.1). */
export interface BacklogIssueComment extends BacklogComment {
  issueId: number;
}

export interface BacklogIssue {
  id: number;
  projectId: number;
  issueKey: string;
  summary: string;
  description: string;
  issueType: { id: number; name: string };
  priority: { id: number; name: string };
  status: { id: number; name: string };
  assignee: BacklogUserRef | null;
  createdUser: BacklogUserRef;
  created: Date;
  updated: Date;
}

export interface BacklogGitRepository {
  id: number;
  projectId: number;
  name: string;
  description: string;
}

/**
 * A pull request (docs/specs/adapter.md §8.1). Addressed by
 * `projectId` + `repositoryId` + `number`; the space-wide `id` addresses no
 * endpoint (`GET …/pullRequests/<global id>` is a 404, measured 2026-09-06)
 * and is carried only because `POST /stars` wants it as `pullRequestId`.
 */
export interface BacklogPullRequest {
  id: number;
  projectId: number;
  repositoryId: number;
  number: number;
  summary: string;
  description: string;
  base: string;
  branch: string;
  /** `1 Open`, `2 Closed`, `3 Merged` (measured 2026-09-06; the docs name only `1 Open`). */
  status: { id: number; name: string };
  assignee: BacklogUserRef | null;
  /**
   * The linked issue, normalised to its two identity fields. Backlog returns a
   * full Issue object here on every endpoint — the list page's `{ "id" }`
   * example is wrong (measured 2026-09-06) — so the wider shape is available
   * but not relied on.
   */
  issue: { id: number; issueKey: string | null } | null;
  baseCommit: string | null;
  branchCommit: string | null;
  mergeCommit: string | null;
  closeAt: Date | null;
  mergeAt: Date | null;
  createdUser: BacklogUserRef;
  created: Date;
  updated: Date;
  stars: BacklogStar[];
}

/**
 * The three coordinates every pull-request endpoint is keyed by
 * (`.claude/rules/backlog-pull-request-facts.md` "Addressing").
 */
export interface PullRequestRef {
  projectId: number;
  repositoryId: number;
  number: number;
}

/**
 * What `POST /stars` is aimed at. A discriminated union rather than a bare
 * number because issue and pull-request comment ids come from different
 * sequences and may overlap (measured 2026-09-06), so a star sent to the
 * wrong field would silently land on someone else's comment.
 */
export type StarTarget =
  | { commentId: number }
  | { pullRequestCommentId: number };

/**
 * One entry of `GET …/pullRequests/:number/attachments`. `created` is carried
 * because a pull-request comment's `changeLog` names an attachment without an
 * id, and resolving that name needs "newest match wins" (D-PR10).
 */
export interface BacklogPullRequestAttachment {
  id: number;
  name: string;
  size: number;
  created: Date;
}

/** A project's text formatting mode (docs/specs/adapter.md §9.1). */
export type TextFormattingRule = 'markdown' | 'backlog';

export interface BacklogProject {
  id: number;
  projectKey: string;
  name: string;
  textFormattingRule: TextFormattingRule;
}

export interface BacklogIssueType {
  id: number;
  name: string;
}

export interface BacklogPriority {
  id: number;
  name: string;
}

export interface BacklogNotification {
  id: number;
  /**
   * The inbox-badge flag: flipped to `true` on **every** notification by
   * [Reset Unread Notification Count](https://developer.nulab.com/docs/backlog/api/2/count-notification/)
   * (`POST /notifications/markAsRead`), left untouched by
   * `markNotificationAsRead` (measured 2026-09-06). `markAsRead` (§7.8) must
   * not read this field — see `resourceAlreadyRead` below.
   */
  alreadyRead: boolean;
  /**
   * Set on **this one** notification by
   * [Read Notification](https://developer.nulab.com/docs/backlog/api/2/read-notification/)
   * (`POST /notifications/:id/markAsRead`), left untouched by the
   * reset-count endpoint above (measured 2026-09-06). This is the flag
   * `markAsRead` (§7.8) short-circuits on.
   */
  resourceAlreadyRead: boolean;
  project: { id: number; projectKey: string; name: string };
  issue: { id: number; issueKey: string; summary: string } | null;
  comment: { id: number } | null;
  /**
   * Set on notifications a pull request caused (reasons 10–13,
   * [Get Notification](https://developer.nulab.com/docs/backlog/api/2/get-notification/)).
   * The fields exist on every item; a populated one needs a second user to
   * mention or assign the bot and is UNMEASURED
   * (`.claude/rules/backlog-pull-request-facts.md` "Unmeasured").
   */
  pullRequest: { id: number; number: number; repositoryId: number } | null;
  pullRequestComment: { id: number } | null;
  sender: BacklogUserRef;
  created: Date;
}

export interface BacklogUploadedFile {
  id: number;
  name: string;
  size: number;
}

export interface BacklogDownloadedFile {
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface ListIssuesOptions {
  count: number;
  offset?: number;
}

export type ListOrder = 'asc' | 'desc';

export interface ListCommentsOptions {
  count: number;
  order: ListOrder;
  minId?: number;
  maxId?: number;
}

export interface ListNotificationsOptions {
  count: number;
  maxId?: number;
}

export interface CreateIssueInput {
  projectId: number;
  summary: string;
  issueTypeId: number;
  priorityId: number;
  description?: string;
  assigneeId?: number;
  notifiedUserId?: number[];
  attachmentId?: number[];
}

export interface AddCommentInput {
  content: string;
  notifiedUserId?: number[];
  attachmentId?: number[];
}

/**
 * Add Pull Request Comment takes the same three parameters as Add Comment
 * ([Add Pull Request Comment](https://developer.nulab.com/docs/backlog/api/2/add-pull-request-comment/);
 * `attachmentId[]` is documented and measured 2026-09-06 although `backlog-js`
 * omits it from `PostPullRequestCommentsParams`), so the input is the same
 * shape under its own name rather than two declarations that could drift apart
 * without either endpoint changing.
 */
export type AddPullRequestCommentInput = AddCommentInput;

/**
 * [Get Pull Request List](https://developer.nulab.com/docs/backlog/api/2/get-pull-request-list/)
 * pages by `offset` only: it takes no `minId`/`maxId` and no order parameter.
 */
export interface ListPullRequestsOptions {
  count: number;
  offset?: number;
  statusId?: number[];
}

/**
 * The Backlog API port used by the rest of the adapter. Every method throws
 * only the `@chat-adapter/shared` error classes (docs/specs/adapter.md §8.5)
 * and returns only the domain types declared in this file.
 *
 * No `deletePullRequestComment` and no `getPullRequestComment` appear below,
 * and their absence is a fact about Backlog rather than an omission: both
 * routes answer 400 with error code 6 `Undefined resource` (measured
 * 2026-09-06, `.claude/rules/backlog-pull-request-facts.md`).
 */
export interface BacklogApi {
  getIssue(issueId: number): Promise<BacklogIssue>;
  getProject(projectId: number): Promise<BacklogProject>;
  getUser(userId: number): Promise<BacklogUserRef>;
  listIssues(
    projectId: number,
    options: ListIssuesOptions
  ): Promise<BacklogIssue[]>;
  createIssue(input: CreateIssueInput): Promise<BacklogIssue>;
  listIssueTypes(projectId: number): Promise<BacklogIssueType[]>;
  listPriorities(): Promise<BacklogPriority[]>;
  listComments(
    issueId: number,
    options: ListCommentsOptions
  ): Promise<BacklogIssueComment[]>;
  getComment(issueId: number, commentId: number): Promise<BacklogIssueComment>;
  addComment(
    issueId: number,
    input: AddCommentInput
  ): Promise<BacklogIssueComment>;
  updateComment(
    issueId: number,
    commentId: number,
    content: string
  ): Promise<BacklogIssueComment>;
  deleteComment(
    issueId: number,
    commentId: number
  ): Promise<BacklogIssueComment>;
  listGitRepositories(projectId: number): Promise<BacklogGitRepository[]>;
  getGitRepository(
    projectId: number,
    repositoryId: number
  ): Promise<BacklogGitRepository>;
  listPullRequests(
    projectId: number,
    repositoryId: number,
    options: ListPullRequestsOptions
  ): Promise<BacklogPullRequest[]>;
  getPullRequest(ref: PullRequestRef): Promise<BacklogPullRequest>;
  /**
   * There is no Get Pull Request Comment endpoint: the route answers 400 with
   * error code 6 `Undefined resource` (measured 2026-09-06). A single comment
   * is read through this list with a one-element window
   * (`minId: id - 1, maxId: id + 1, count: 1`).
   */
  listPullRequestComments(
    ref: PullRequestRef,
    options: ListCommentsOptions
  ): Promise<BacklogComment[]>;
  addPullRequestComment(
    ref: PullRequestRef,
    input: AddPullRequestCommentInput
  ): Promise<BacklogComment>;
  updatePullRequestComment(
    ref: PullRequestRef,
    commentId: number,
    content: string
  ): Promise<BacklogComment>;
  listPullRequestAttachments(
    ref: PullRequestRef
  ): Promise<BacklogPullRequestAttachment[]>;
  downloadPullRequestAttachment(
    ref: PullRequestRef,
    attachmentId: number
  ): Promise<BacklogDownloadedFile>;
  addStar(target: StarTarget): Promise<void>;
  deleteStar(starId: number): Promise<void>;
  listNotifications(
    options: ListNotificationsOptions
  ): Promise<BacklogNotification[]>;
  markNotificationAsRead(id: number): Promise<void>;
  uploadAttachment(
    filename: string,
    data: Buffer,
    mimeType?: string
  ): Promise<BacklogUploadedFile>;
  downloadAttachment(
    issueId: number,
    attachmentId: number
  ): Promise<BacklogDownloadedFile>;
  /**
   * The limits Backlog reports for the credentialed user **now**
   * (`GET /rateLimit`), covering every bucket whether or not this instance has
   * spent it. Costs one request; the classifier puts that request in the
   * `read` bucket, and whether Backlog counts it against a bucket at all is
   * undocumented (`.claude/rules/backlog-api-facts.md`).
   */
  getRateLimit(): Promise<RateLimitSnapshots>;
  /**
   * The last `X-RateLimit-*` headers **this instance** happened to see, per
   * bucket — free, but only ever as complete and as fresh as this instance's
   * own traffic. A bucket no request has touched is absent, and a `reset` in
   * the past means the window has since rolled over and `remaining` no longer
   * describes the budget. Where an instance is short-lived — one per
   * serverless invocation, say — prefer `getRateLimit()`.
   */
  rateLimit(): RateLimitSnapshots;
}

/**
 * The shape carried on `error.cause` for every mapped error
 * (docs/specs/adapter.md §8.5). `url` never carries a query string.
 */
export interface BacklogApiErrorDetail {
  status?: number;
  code?: number;
  message: string;
  moreInfo?: string;
  url?: string;
}

/** Resolves to a value, or a promise of one, awaited fresh on every call. */
export type MaybeAsync<T> = T | Promise<T>;

/** Backlog's two supported auth modes (docs/specs/adapter.md §8.7). Resolved per call, never memoised. */
export type BacklogCredentials =
  | { apiKey: () => MaybeAsync<string> }
  | { accessToken: () => MaybeAsync<string> };

export interface RetryOptions {
  /** Maximum number of retries on a 429. Default 1. */
  maxRetries?: number;
  /** Maximum wait, in milliseconds, before giving up instead of waiting. Default 60_000. */
  maxWaitMs?: number;
}
