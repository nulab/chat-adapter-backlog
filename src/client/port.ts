/**
 * The Backlog API port: every domain type and the `BacklogApi` interface
 * itself are owned here so the rest of the adapter never sees a `backlog-js`
 * or `zod` type. `src/client/backlog-js.ts` and `src/client/in-memory.ts`
 * both implement this interface; swapping the former for a plain `fetch`
 * client later touches neither this file's consumers nor its shape.
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

/** `rateLimit()` result: only the buckets a response has been observed for are present. */
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

export interface BacklogComment {
  id: number;
  issueId: number;
  /** `null` for a system-generated comment such as an assignee change. */
  content: string | null;
  changeLog: BacklogChange[];
  createdUser: BacklogUserRef;
  created: Date;
  updated: Date;
  stars: BacklogStar[];
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
  alreadyRead: boolean;
  project: { id: number; projectKey: string; name: string };
  issue: { id: number; issueKey: string; summary: string } | null;
  comment: { id: number } | null;
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
 * The Backlog API port used by the rest of the adapter. Every method throws
 * only the `@chat-adapter/shared` error classes (docs/specs/adapter.md §8.5)
 * and returns only the domain types declared in this file.
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
  ): Promise<BacklogComment[]>;
  getComment(issueId: number, commentId: number): Promise<BacklogComment>;
  addComment(issueId: number, input: AddCommentInput): Promise<BacklogComment>;
  updateComment(
    issueId: number,
    commentId: number,
    content: string
  ): Promise<BacklogComment>;
  deleteComment(issueId: number, commentId: number): Promise<BacklogComment>;
  addStar(commentId: number): Promise<void>;
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
