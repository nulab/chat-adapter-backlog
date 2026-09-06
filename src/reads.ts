import { ResourceNotFoundError, ValidationError } from '@chat-adapter/shared';
import { paragraph, root, text as textNode } from 'chat';

import {
  decodeChannelId,
  decodeMessageId,
  decodeThreadId,
  decodeUserId,
  encodeMessageId,
} from './ids';

import type {
  BacklogApi,
  BacklogComment,
  BacklogIssue,
  BacklogIssueComment,
  TextFormattingRule,
} from './client/port';
import type { BacklogRawMessage } from './types';
import type {
  Attachment,
  Author,
  ChannelInfo,
  FetchDirection,
  FetchOptions,
  FetchResult,
  ListThreadsOptions,
  ListThreadsResult,
  Message,
  MessageData,
  MessageSubject,
  ThreadInfo,
  UserInfo,
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

/**
 * Shared with `createChannelIssue` (`src/egress.ts`): both a REST-fetched
 * issue (this file) and a freshly created one (`postChannelMessage`) become
 * the same `BacklogRawMessage` `{ kind: "issue" }` shape, so the port ->
 * types.ts field mapping has exactly one implementation.
 */
export function toRawIssue(issue: BacklogIssue): {
  id: number;
  issueKey: string;
  projectId: number;
  summary: string;
  description: string;
  status: { id: number; name: string };
  issueType: { id: number; name: string };
  priority: { id: number; name: string };
  assignee: { id: number; name: string } | null;
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
    status: { id: issue.status.id, name: issue.status.name },
    issueType: { id: issue.issueType.id, name: issue.issueType.name },
    priority: { id: issue.priority.id, name: issue.priority.name },
    assignee:
      issue.assignee === null
        ? null
        : { id: issue.assignee.id, name: issue.assignee.name },
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
  comment: BacklogIssueComment
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

function toRawCommentForRead(comment: BacklogIssueComment): {
  id: number;
  issueId: number;
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
    issueId: comment.issueId,
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

/**
 * `<host>, <issueId>` a `BacklogRawMessage` belongs to, for every `kind`
 * (docs/specs/adapter.md §7.4). `fetchSubject` uses this to decide whether it
 * can skip the Get Issue call entirely: `kind: "issue"` already carries the
 * issue, so there is nothing left to resolve.
 */
function issueRefOf(raw: BacklogRawMessage): { host: string; issueId: number } {
  switch (raw.kind) {
    case 'webhook':
      return { host: raw.host, issueId: raw.payload.content.id };
    case 'comment':
      return { host: raw.host, issueId: raw.comment.issueId };
    case 'issue':
      return { host: raw.host, issueId: raw.issue.id };
  }
}

export interface FetchSubjectInput {
  raw: BacklogRawMessage;
  api: BacklogApi;
}

/**
 * `fetchSubject` (docs/specs/adapter.md §7.4). Called lazily from
 * `message.subject` and its errors are turned into `null` by the core
 * (`.claude/rules/chat-sdk-core-facts.md` "`fetchSubject` is called lazily by
 * the `Message.subject` getter, errors -> `null`"), so every access — not
 * just the first — spends a Get Issue call unless `raw.kind === "issue"`
 * already carries it; document this cost to a caller that reads
 * `message.subject` in a loop.
 */
export async function fetchSubject(
  input: FetchSubjectInput
): Promise<MessageSubject> {
  const { raw, api } = input;
  const { host, issueId } = issueRefOf(raw);
  const issue = raw.kind === 'issue' ? raw.issue : await api.getIssue(issueId);

  const subject: MessageSubject = {
    id: `backlog:${host}:${issue.projectId}:${issueId}`,
    type: 'issue',
    title: issue.summary,
    description: issue.description,
    status: issue.status.name,
    url: `https://${host}/view/${issue.issueKey}`,
    author: {
      id: `${host}:${issue.createdUser.id}`,
      name: issue.createdUser.name,
    },
    labels: [issue.issueType.name, issue.priority.name],
    raw: issue,
  };
  if (issue.assignee !== null) {
    subject.assignee = {
      id: `${host}:${issue.assignee.id}`,
      name: issue.assignee.name,
    };
  }
  return subject;
}

export interface FetchChannelInfoInput {
  channelId: string;
  api: BacklogApi;
}

/**
 * `fetchChannelInfo` (docs/specs/adapter.md §7.5). Returns the project's
 * `textFormattingRule` alongside the `ChannelInfo` (not just inside
 * `metadata`, whose type is `Record<string, unknown>`) so the caller
 * (`adapter.ts`) can replace the §9.1 formatting-rule cache entry — the one
 * documented way to pick up a changed project setting without restarting,
 * since that cache is otherwise permanent (D14) — without a runtime cast.
 */
export async function fetchChannelInfo(
  input: FetchChannelInfoInput
): Promise<{ info: ChannelInfo; textFormattingRule: TextFormattingRule }> {
  const { channelId, api } = input;
  const { host, projectId } = decodeChannelId(channelId);
  const project = await api.getProject(projectId);

  return {
    info: {
      id: channelId,
      name: project.name,
      isDM: false,
      metadata: {
        host,
        projectId,
        projectKey: project.projectKey,
        textFormattingRule: project.textFormattingRule,
      },
    },
    textFormattingRule: project.textFormattingRule,
  };
}

export interface ListThreadsInput {
  channelId: string;
  options: ListThreadsOptions | undefined;
  api: BacklogApi;
  builders: Omit<MessageBuilders, 'projectId' | 'issueId'>;
}

/**
 * `listThreads` (docs/specs/adapter.md §7.6). Deliberately does not sort or
 * filter the port's response: Get Issue List draws on the **search** bucket
 * (a documented example 150/min, far lower than `read`'s 600), so silently
 * re-sorting or dropping closed issues here would hide that cost from a
 * caller who asked for one page and would also disagree with what Backlog's
 * own UI shows for the same call. `nextCursor` is only set on a full page —
 * a short final page and a documented trailing empty page are both possible,
 * per §7.6.
 */
export async function listThreads(
  input: ListThreadsInput
): Promise<ListThreadsResult<BacklogRawMessage>> {
  const { channelId, options, api, builders } = input;
  const { host, projectId } = decodeChannelId(channelId);
  const limit = clampLimit(options?.limit);
  const offset = parseOffset(options?.cursor);

  const issues = await api.listIssues(projectId, { count: limit, offset });

  const messageBuilders: MessageBuilders = {
    ...builders,
    projectId,
    issueId: 0,
  };
  const threads = issues.map((issue) => ({
    id: `backlog:${host}:${projectId}:${issue.id}`,
    rootMessage: buildRootMessage(
      { ...messageBuilders, issueId: issue.id },
      issue
    ),
    lastReplyAt: issue.updated,
  }));

  const result: ListThreadsResult<BacklogRawMessage> = { threads };
  if (issues.length >= limit) {
    result.nextCursor = String(offset + issues.length);
  }
  return result;
}

function parseOffset(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!CURSOR_PATTERN.test(cursor)) {
    throw new ValidationError('backlog', `"${cursor}" is not a valid cursor`);
  }
  return Number(cursor);
}

export interface GetUserInput {
  userId: string;
  api: BacklogApi;
  botUserId: number;
}

/**
 * `getUser` (docs/specs/adapter.md §7.7). `chat.getUser()` cannot route here
 * — the core infers an adapter from id shape and does not recognise
 * `<host>:<id>` (`.claude/rules/chat-sdk-core-facts.md` "`openDM`/`getUser`
 * absent -> `chat.openDM`/`chat.getUser` throw") — so this is reached only by
 * calling `adapter.getUser()` directly; README documents that.
 */
export async function getUser(input: GetUserInput): Promise<UserInfo | null> {
  const { userId, api, botUserId } = input;
  const { host, userId: id } = decodeUserId(userId);
  try {
    const user = await api.getUser(id);
    const info: UserInfo = {
      userId: `${host}:${user.id}`,
      userName: user.userId ?? user.name,
      fullName: user.name,
      isBot: user.id === botUserId,
    };
    if (user.mailAddress !== null) {
      info.email = user.mailAddress;
    }
    return info;
  } catch (cause) {
    if (cause instanceof ResourceNotFoundError) {
      return null;
    }
    throw cause;
  }
}

export interface MarkAsReadInput {
  messageId: string;
  message: Message<BacklogRawMessage> | undefined;
  api: BacklogApi;
  logger: {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
  };
}

const MARK_AS_READ_PAGE_SIZE = 100;
const MARK_AS_READ_MAX_PAGES = 3;

/**
 * Comment id `markAsRead` looks for, from `messageId` and — when a `message`
 * is given — cross-checked against `message.raw` (docs/specs/adapter.md
 * §7.8 "comment id from `messageId` (or `message.raw` when given — they must
 * agree)"). `:i`/`:u:` ids have no notification-worthy comment and return
 * `undefined`, which the caller turns into a no-call debug log.
 */
function commentIdForMarkAsRead(
  messageId: string,
  message: Message<BacklogRawMessage> | undefined
): number | undefined {
  const decoded = decodeMessageId(messageId);
  if (decoded.kind !== 'comment') {
    return undefined;
  }
  if (message !== undefined && message.raw.kind === 'comment') {
    if (message.raw.comment.id !== decoded.commentId) {
      throw new ValidationError(
        'backlog',
        `messageId "${messageId}" and message.raw disagree on the comment id`
      );
    }
  }
  return decoded.commentId;
}

/**
 * `markAsRead` (docs/specs/adapter.md §7.8): notifications are the **bot
 * user's own** feed, paged newest-first at most 3 times
 * (`GET /notifications?count=100[&maxId=]`) looking for `comment.id ===
 * commentId`. Capped at 3 pages (300 notifications) rather than paging until
 * exhausted because this is meant to be called per-message, not swept
 * unboundedly — an old comment that has scrolled off the bot's most recent
 * 300 notifications is treated the same as "no notification exists for this
 * comment", which is the common case for a bot that was not itself notified.
 */
export async function markAsRead(input: MarkAsReadInput): Promise<void> {
  const { messageId, message, api, logger } = input;
  const commentId = commentIdForMarkAsRead(messageId, message);
  if (commentId === undefined) {
    logger.debug('markAsRead: not a comment id, nothing to mark', {
      messageId,
    });
    return;
  }

  let maxId: number | undefined;
  for (let page = 0; page < MARK_AS_READ_MAX_PAGES; page += 1) {
    const options =
      maxId === undefined
        ? { count: MARK_AS_READ_PAGE_SIZE }
        : { count: MARK_AS_READ_PAGE_SIZE, maxId };
    const notifications = await api.listNotifications(options);
    if (notifications.length === 0) {
      break;
    }

    const found = notifications.find((n) => n.comment?.id === commentId);
    if (found !== undefined) {
      if (!found.alreadyRead) {
        await api.markNotificationAsRead(found.id);
      }
      return;
    }

    const last = notifications[notifications.length - 1];
    if (last === undefined) {
      break;
    }
    maxId = last.id;
  }

  logger.info('markAsRead: no matching notification found within 3 pages', {
    messageId,
    commentId,
  });
}

const ATTACHMENT_URL_PATTERN =
  /^\/api\/v2\/issues\/([1-9]\d*)\/attachments\/([1-9]\d*)$/;

export interface RehydrateAttachmentInput {
  attachment: Attachment;
  configuredHosts: ReadonlySet<string>;
  fetchAttachment: (
    host: string,
    issueId: number,
    attachmentId: number
  ) => Promise<Buffer>;
}

/**
 * `rehydrateAttachment` (docs/specs/adapter.md §6.6): synchronous, and a
 * security boundary — it accepts only a URL whose host is one of this
 * adapter's **configured** installations and whose path matches
 * `/api/v2/issues/<posint>/attachments/<posint>`; anything else (a foreign
 * host, a malformed path, no URL at all) is returned unchanged, without
 * `fetchData`, which is what keeps a rehydrated attachment from ever
 * downloading through a host this adapter was not configured for (§11).
 */
export function rehydrateAttachment(
  input: RehydrateAttachmentInput
): Attachment {
  const { attachment, configuredHosts, fetchAttachment } = input;
  if (attachment.url === undefined) {
    return attachment;
  }

  let parsed: URL;
  try {
    parsed = new URL(attachment.url);
  } catch {
    return attachment;
  }

  if (!configuredHosts.has(parsed.hostname)) {
    return attachment;
  }
  const match = ATTACHMENT_URL_PATTERN.exec(parsed.pathname);
  if (match === null) {
    return attachment;
  }
  const issueIdSegment = match[1];
  const attachmentIdSegment = match[2];
  if (issueIdSegment === undefined || attachmentIdSegment === undefined) {
    return attachment;
  }
  const issueId = Number(issueIdSegment);
  const attachmentId = Number(attachmentIdSegment);
  const host = parsed.hostname;

  return {
    ...attachment,
    fetchData: () => fetchAttachment(host, issueId, attachmentId),
  };
}
