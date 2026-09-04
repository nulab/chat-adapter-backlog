import { ResourceNotFoundError, ValidationError } from '@chat-adapter/shared';
import { paragraph, root, text as textNode } from 'chat';

import { decodeMessageId, decodeThreadId, encodeMessageId } from './ids';

import type { BacklogApi, BacklogComment, BacklogIssue } from './client/port';
import type { BacklogRawMessage } from './types';
import type {
  Attachment,
  Author,
  FetchDirection,
  FetchOptions,
  FetchResult,
  Message,
  MessageData,
  ThreadInfo,
} from 'chat';

const CURSOR_PATTERN = /^(0|[1-9]\d*)$/;
const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, limit));
}

function parseCursor(cursor: string | undefined): number | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  if (!CURSOR_PATTERN.test(cursor)) {
    throw new ValidationError('backlog', `"${cursor}" is not a valid cursor`);
  }
  return Number(cursor);
}

/**
 * Author for a REST-derived message (a comment or the issue root). Mirrors
 * the webhook path's `<host>:<id>` shape (`src/webhook/inbound.ts`
 * `buildAuthor`) using `BacklogUserRef.id`, the same numeric identity §2
 * specifies for every user id in this adapter.
 */
export function buildRestAuthor(
  host: string,
  botUserId: number,
  createdUser: { id: number; userId: string | null; name: string }
): Author {
  const isMe = createdUser.id === botUserId;
  return {
    userId: `${host}:${createdUser.id}`,
    userName: createdUser.userId ?? createdUser.name,
    fullName: createdUser.name,
    isMe,
    isBot: isMe,
  };
}

function plainTextAst(value: string): MessageData['formatted'] {
  return root([paragraph([textNode(value)])]);
}

/**
 * Attachments added via a comment surface only as `changeLog` entries with
 * `field === "attachment"` and `newValue` set — a removal (`originalValue`
 * set, per docs/specs/adapter.md §6.6) is skipped since it names a file no
 * longer on the issue. `size` is unknown from a changelog entry (only the
 * webhook and the issue's own `attachments[]` carry it).
 */
function toCommentAttachments(
  host: string,
  issueId: number,
  fetchAttachment: (issueId: number, attachmentId: number) => Promise<Buffer>,
  comment: BacklogComment
): Attachment[] {
  const attachments: Attachment[] = [];
  for (const change of comment.changeLog) {
    if (
      change.field !== 'attachment' ||
      change.newValue === null ||
      change.attachmentInfo === null
    ) {
      continue;
    }
    const attachmentId = change.attachmentInfo.id;
    attachments.push({
      type: 'file',
      name: change.newValue,
      url: `https://${host}/api/v2/issues/${issueId}/attachments/${attachmentId}`,
      fetchData: () => fetchAttachment(issueId, attachmentId),
    });
  }
  return attachments;
}

export interface MessageBuilders {
  host: string;
  projectId: number;
  issueId: number;
  botUserId: number;
  fetchAttachment: (issueId: number, attachmentId: number) => Promise<Buffer>;
  MessageCtor: new (
    data: MessageData<BacklogRawMessage>
  ) => Message<BacklogRawMessage>;
}

/**
 * The issue root as a `Message` (docs/specs/adapter.md §7.1). `edited` is
 * always `false`: `issue.updated` moves on any field change (status,
 * assignee, a comment being added) and says nothing about whether the issue
 * *body* itself was edited, so treating it as an edit signal would report a
 * false positive on every unrelated update.
 */
export function buildRootMessage(
  builders: MessageBuilders,
  issue: BacklogIssue
): Message<BacklogRawMessage> {
  const { host, projectId, issueId, botUserId, MessageCtor } = builders;
  const text = [issue.summary, issue.description].filter(Boolean).join('\n\n');
  return new MessageCtor({
    id: encodeMessageId({ kind: 'issue', host, issueId }),
    threadId: `backlog:${host}:${projectId}:${issueId}`,
    text,
    formatted: plainTextAst(text),
    raw: { kind: 'issue', host, issue: toRawIssue(issue), changes: [] },
    author: buildRestAuthor(host, botUserId, issue.createdUser),
    metadata: { dateSent: issue.created, edited: false },
    // The port's `BacklogIssue` (src/client/port.ts, an earlier phase) has no
    // `attachments[]` — `getIssue` never surfaces them — so a REST-derived
    // root message cannot carry the §6.6 "REST issue attachments[]" source;
    // only the webhook path (`src/webhook/inbound.ts`) can.
    attachments: [],
    isMention: false,
  });
}

function toRawIssue(issue: BacklogIssue): {
  id: number;
  issueKey: string;
  projectId: number;
  summary: string;
  description: string;
  createdUser: { id: number; name: string; userId?: string | null };
  created: string;
  updated: string;
} {
  return {
    id: issue.id,
    issueKey: issue.issueKey,
    projectId: issue.projectId,
    summary: issue.summary,
    description: issue.description,
    createdUser: {
      id: issue.createdUser.id,
      name: issue.createdUser.name,
      userId: issue.createdUser.userId,
    },
    created: issue.created.toISOString(),
    updated: issue.updated.toISOString(),
  };
}

/**
 * A comment as a `Message` (docs/specs/adapter.md §7.1). `edited` is derived
 * from `updated !== created`, unlike the always-`false` root — a comment
 * genuinely reports its own edit history, and Backlog fires no webhook for a
 * comment edit (`.claude/rules/backlog-webhook-facts.md`), so this REST path
 * is the only way a consumer learns of one at all.
 */
export function buildCommentMessage(
  builders: MessageBuilders,
  comment: BacklogComment
): Message<BacklogRawMessage> {
  const { host, projectId, issueId, botUserId, fetchAttachment, MessageCtor } =
    builders;
  const text = comment.content ?? '';
  const edited = comment.updated.getTime() !== comment.created.getTime();
  const metadata: MessageData['metadata'] = edited
    ? { dateSent: comment.created, edited, editedAt: comment.updated }
    : { dateSent: comment.created, edited };
  return new MessageCtor({
    id: encodeMessageId({
      kind: 'comment',
      host,
      issueId,
      commentId: comment.id,
    }),
    threadId: `backlog:${host}:${projectId}:${issueId}`,
    text,
    formatted: plainTextAst(text),
    raw: {
      kind: 'comment',
      host,
      projectId,
      comment: toRawCommentForRead(comment),
      changes: comment.changeLog.map((change) => ({
        field: change.field,
        newValue: change.newValue,
        oldValue: change.oldValue,
      })),
    },
    author: buildRestAuthor(host, botUserId, comment.createdUser),
    metadata,
    attachments: toCommentAttachments(host, issueId, fetchAttachment, comment),
    isMention: false,
  });
}

function toRawCommentForRead(comment: BacklogComment): {
  id: number;
  content: string | null;
  createdUser: { id: number; name: string; userId?: string | null };
  created: string;
  updated: string;
  changeLog: {
    field: string;
    newValue: string | null;
    oldValue: string | null;
  }[];
  stars: { id: number; presenter: { id: number } }[];
} {
  return {
    id: comment.id,
    content: comment.content,
    createdUser: {
      id: comment.createdUser.id,
      name: comment.createdUser.name,
      userId: comment.createdUser.userId,
    },
    created: comment.created.toISOString(),
    updated: comment.updated.toISOString(),
    changeLog: comment.changeLog.map((change) => ({
      field: change.field,
      newValue: change.newValue,
      oldValue: change.oldValue,
    })),
    stars: comment.stars.map((star) => ({
      id: star.id,
      presenter: { id: star.presenter.id },
    })),
  };
}

export interface FetchMessagesInput {
  threadId: string;
  options: FetchOptions | undefined;
  api: BacklogApi;
  builders: Omit<MessageBuilders, 'projectId' | 'issueId'>;
}

/**
 * `fetchMessages` (docs/specs/adapter.md §7.1). The algorithm is specified
 * exactly, including its off-by-one behaviour:
 *
 * - `minId`/`maxId` are exclusive and `count` cuts from the head of `order`
 *   (measured 2026-09-03, `.claude/rules/backlog-api-facts.md`), so the
 *   previous page's edge id is passed straight through as the cursor with
 *   no `±1` correction.
 * - `commentLimit` reserves one slot for the root message only on the very
 *   first forward page (`startsWithRoot`); every other page's `commentLimit`
 *   equals `limit`.
 * - `hasMore = comments.length >= count`: requesting one more than
 *   `commentLimit` would need is not how Backlog's `count` param works
 *   (there is no "count + 1" probe), so "did we get a full page" is the only
 *   signal available, and a full final page reads as "more" until the next
 *   page comes back empty — the documented root-only final page.
 */
export async function fetchMessages(
  input: FetchMessagesInput
): Promise<FetchResult<BacklogRawMessage>> {
  const { threadId, options, api, builders } = input;
  const { projectId, issueId } = decodeThreadId(threadId);
  const direction: FetchDirection = options?.direction ?? 'backward';
  const limit = clampLimit(options?.limit);
  const cursor = parseCursor(options?.cursor);

  const startsWithRoot = direction === 'forward' && cursor === undefined;
  const commentLimit = startsWithRoot ? limit - 1 : limit;
  const count = Math.max(commentLimit, 1);

  const comments =
    direction === 'backward'
      ? await api.listComments(
          issueId,
          cursor === undefined
            ? { count, order: 'desc' }
            : { count, order: 'desc', maxId: cursor }
        )
      : await api.listComments(
          issueId,
          cursor === undefined
            ? { count, order: 'asc' }
            : { count, order: 'asc', minId: cursor }
        );

  const hasMore = comments.length >= count;
  const page = [...comments].sort((a, b) => a.id - b.id).slice(0, commentLimit);

  const messageBuilders: MessageBuilders = { ...builders, projectId, issueId };
  const prependRoot = startsWithRoot || (direction === 'backward' && !hasMore);

  const messages: Message<BacklogRawMessage>[] = [];
  if (prependRoot) {
    const issue = await api.getIssue(issueId);
    messages.push(buildRootMessage(messageBuilders, issue));
  }
  for (const comment of page) {
    messages.push(buildCommentMessage(messageBuilders, comment));
  }

  let nextCursor: string | undefined;
  if (hasMore) {
    const firstPageId = page[0]?.id;
    const lastPageId = page[page.length - 1]?.id;
    if (direction === 'backward') {
      nextCursor = firstPageId !== undefined ? String(firstPageId) : undefined;
    } else {
      nextCursor = lastPageId !== undefined ? String(lastPageId) : '0';
    }
  }

  const result: FetchResult<BacklogRawMessage> = { messages };
  if (nextCursor !== undefined) {
    result.nextCursor = nextCursor;
  }
  return result;
}

export interface FetchMessageInput {
  threadId: string;
  messageId: string;
  api: BacklogApi;
  builders: Omit<MessageBuilders, 'projectId' | 'issueId'>;
}

/**
 * `fetchMessage` (docs/specs/adapter.md §7.2). Returns `null` without an API
 * call for a message id that cannot possibly belong to `threadId` (a
 * different host or issue) and for `:u:` ids — Backlog has no single-fetch
 * endpoint for a fieldchange update with no comment (D12) — rather than
 * spending a call that could only ever come back empty-handed.
 */
export async function fetchMessage(
  input: FetchMessageInput
): Promise<Message<BacklogRawMessage> | null> {
  const { threadId, messageId, api, builders } = input;
  const thread = decodeThreadId(threadId);
  const decoded = decodeMessageId(messageId);

  if (decoded.host !== thread.host || decoded.issueId !== thread.issueId) {
    return null;
  }
  if (decoded.kind === 'update') {
    return null;
  }

  const messageBuilders: MessageBuilders = {
    ...builders,
    projectId: thread.projectId,
    issueId: thread.issueId,
  };

  try {
    if (decoded.kind === 'issue') {
      const issue = await api.getIssue(thread.issueId);
      return buildRootMessage(messageBuilders, issue);
    }
    const comment = await api.getComment(thread.issueId, decoded.commentId);
    return buildCommentMessage(messageBuilders, comment);
  } catch (cause) {
    if (cause instanceof ResourceNotFoundError) {
      return null;
    }
    throw cause;
  }
}

export interface FetchThreadInput {
  threadId: string;
  api: BacklogApi;
}

/**
 * `fetchThread` (docs/specs/adapter.md §7.3). `channelName` is the project
 * key: `issueKey` is `<projectKey>-<number>`, so it is derived by trimming
 * from the issue key's last `-` rather than round-tripping through
 * `getProject` for a value the issue response already carries.
 */
export async function fetchThread(
  input: FetchThreadInput
): Promise<ThreadInfo> {
  const { threadId, api } = input;
  const { host, projectId, issueId } = decodeThreadId(threadId);
  const issue = await api.getIssue(issueId);
  const lastDash = issue.issueKey.lastIndexOf('-');
  const channelName =
    lastDash === -1 ? issue.issueKey : issue.issueKey.slice(0, lastDash);

  return {
    id: threadId,
    channelId: `backlog:${host}:${projectId}`,
    channelName,
    isDM: false,
    metadata: {
      host,
      issueId,
      issueKey: issue.issueKey,
      projectId,
      summary: issue.summary,
      description: issue.description,
      status: issue.status,
      assignee:
        issue.assignee === null
          ? null
          : { id: issue.assignee.id, name: issue.assignee.name },
      issueType: issue.issueType,
      priority: issue.priority,
      createdUserId: issue.createdUser.id,
      created: issue.created,
      updated: issue.updated,
      url: `https://${host}/view/${issue.issueKey}`,
    },
  };
}
