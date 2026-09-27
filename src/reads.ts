import {
  AdapterError,
  ResourceNotFoundError,
  ValidationError,
} from '@chat-adapter/shared';
import {
  decodeChannelId,
  decodeMessageId,
  decodeThreadId,
  decodeUserId,
  encodeChannelId,
  encodeMessageId,
  encodeThreadId,
} from './ids';
import { toRawChanges, toRawComment, toRawIssue } from './subject/raw';
import { parseAttachmentPath } from './subject/url';

import type {
  BacklogApi,
  BacklogComment,
  BacklogIssue,
  TextFormattingRule,
} from './client/port';
import type {
  SubjectClient,
  SubjectNames,
  SubjectRoot,
} from './subject/client';
import type { AttachmentLocation } from './subject/url';
import type {
  BacklogRawMessage,
  BacklogSubjectRef,
  BacklogThreadId,
} from './types';
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

/**
 * `limit` is clamped into `[1, 100]` but a non-integer is **rejected** rather
 * than rounded (docs/specs/adapter.md §7.1): it reaches Backlog as the `count`
 * parameter, which answers 400 for `2.5`, and `NaN` survives
 * `Math.min`/`Math.max` untouched — so both used to leave this function and
 * fail at the API with Backlog's message instead of the adapter's. Rounding
 * would be the other option; a caller asking for 2.5 messages has a bug, and
 * silently answering with 2 or 3 hides it.
 */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LIMIT;
  }
  if (!Number.isInteger(limit)) {
    throw new ValidationError('backlog', `"${limit}" is not a valid limit`);
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
 * Author for a REST-derived message (a comment or a thread's root). Mirrors
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

/**
 * Everything a `Message` needs beyond the record it is built from. `subject`
 * carries both the addressing (`subject.ref`) and every call the two kinds
 * answer differently, so nothing below this line names an issue or a pull
 * request (D-PR2).
 */
export interface MessageBuilders {
  host: string;
  projectId: number;
  subject: SubjectClient;
  botUserId: number;
  format: (text: string) => MessageData['formatted'];
  MessageCtor: new (
    data: MessageData<BacklogRawMessage>
  ) => Message<BacklogRawMessage>;
}

/**
 * A thread's root — the issue body or the pull-request body — as a `Message`
 * (docs/specs/adapter.md §7.1). `edited` is always `false`: a root's `updated`
 * moves on any field change (status, assignee, a comment being added) and says
 * nothing about whether the *body* itself was edited, so treating it as an
 * edit signal would report a false positive on every unrelated update.
 */
export function buildRootMessage(
  builders: MessageBuilders,
  root: SubjectRoot
): Message<BacklogRawMessage> {
  const { host, projectId, subject, botUserId, format, MessageCtor } = builders;
  const text = [root.title, root.body].filter(Boolean).join('\n\n');
  return new MessageCtor({
    id: encodeMessageId({ host, subject: subject.ref, part: 'root' }),
    threadId: encodeThreadId({ host, projectId, subject: subject.ref }),
    text,
    formatted: format(text),
    raw: subject.rootRaw(root),
    author: buildRestAuthor(host, botUserId, root.createdUser),
    metadata: { dateSent: root.created, edited: false },
    // A root message carries no attachments, by decision rather than
    // omission (§6.6): neither `getIssue` nor `getPullRequest` surfaces
    // `attachments[]` through the port, and listing them would cost a read per
    // root message for a source that only matters when a body has files. The
    // webhook path (`src/webhook/inbound.ts`) is the one that can, because the
    // payload already carries them.
    attachments: [],
    isMention: false,
  });
}

/**
 * A comment as a `Message` (docs/specs/adapter.md §7.1). `edited` is derived
 * from `updated !== created`, unlike the always-`false` root — a comment
 * genuinely reports its own edit history, and Backlog fires no webhook for a
 * comment edit of either kind (`.claude/rules/backlog-webhook-facts.md`,
 * `.claude/rules/backlog-pull-request-facts.md`), so this REST path is the
 * only way a consumer learns of one at all.
 */
export function buildCommentMessage(
  builders: MessageBuilders,
  comment: BacklogComment
): Message<BacklogRawMessage> {
  const { host, projectId, subject, botUserId, format, MessageCtor } = builders;
  const text = comment.content ?? '';
  const edited = comment.updated.getTime() !== comment.created.getTime();
  const metadata: MessageData['metadata'] = edited
    ? { dateSent: comment.created, edited, editedAt: comment.updated }
    : { dateSent: comment.created, edited };
  return new MessageCtor({
    id: encodeMessageId({
      host,
      subject: subject.ref,
      part: 'comment',
      commentId: comment.id,
    }),
    threadId: encodeThreadId({ host, projectId, subject: subject.ref }),
    text,
    formatted: format(text),
    raw: {
      kind: 'comment',
      host,
      projectId,
      subject: subject.ref,
      comment: toRawComment(comment),
      changes: toRawChanges(comment.changeLog),
    },
    author: buildRestAuthor(host, botUserId, comment.createdUser),
    metadata,
    attachments: subject.commentAttachments(comment),
    isMention: false,
  });
}

export interface FetchMessagesInput {
  threadId: string;
  options: FetchOptions | undefined;
  subject: SubjectClient;
  builders: Omit<MessageBuilders, 'projectId' | 'subject'>;
}

/**
 * `fetchMessages` (docs/specs/adapter.md §7.1). One algorithm for both kinds:
 * pull-request comments page through the same `minId`/`maxId`/`count`/`order`
 * parameters with the same exclusive bounds and the same head-cut `count`
 * (measured 2026-09-06, `.claude/rules/backlog-pull-request-facts.md`
 * "Paging"). The algorithm is specified exactly, including its off-by-one
 * behaviour:
 *
 * - `minId`/`maxId` are exclusive and `count` cuts from the head of `order`,
 *   so the previous page's edge id is passed straight through as the cursor
 *   with no `±1` correction.
 * - `commentLimit` reserves one slot for the root message only on the very
 *   first forward page (`startsWithRoot`); every other page's `commentLimit`
 *   equals `limit`.
 * - `hasMore = comments.length >= count`: `count` has no "one more than I
 *   need" form, so the page's own length is the signal, and a full final page
 *   reads as "more" until the next page comes back empty — the documented
 *   root-only final page. A comment *count* endpoint does exist for both
 *   kinds (`getIssueCommentsCount`, `getPullRequestCommentsCount`, `read`
 *   bucket), so the alternative is a second call of the same cost answering a
 *   different question: the total, not whether anything lies past this
 *   cursor. Only the very first forward page could use it — see
 *   `startsWithRoot` below.
 */
export async function fetchMessages(
  input: FetchMessagesInput
): Promise<FetchResult<BacklogRawMessage>> {
  const { threadId, options, subject, builders } = input;
  const { projectId } = decodeThreadId(threadId);
  const direction: FetchDirection = options?.direction ?? 'backward';
  const limit = clampLimit(options?.limit);
  const cursor = parseCursor(options?.cursor);

  const startsWithRoot = direction === 'forward' && cursor === undefined;
  const commentLimit = startsWithRoot ? limit - 1 : limit;
  // `max(…, 1)` rather than skipping the request when `commentLimit` is 0: a
  // forward `limit: 1` page holds only the root, and the single comment
  // fetched here is what separates "there are comments, come back with cursor
  // 0" from "this thread has none, you are done". Skipping it would leave
  // `nextCursor` always defined on that page and move the same request into
  // the caller's next round trip (confirmed 2026-09-08, §7.1).
  const count = Math.max(commentLimit, 1);

  const comments =
    direction === 'backward'
      ? await subject.listComments(
          cursor === undefined
            ? { count, order: 'desc' }
            : { count, order: 'desc', maxId: cursor }
        )
      : await subject.listComments(
          cursor === undefined
            ? { count, order: 'asc' }
            : { count, order: 'asc', minId: cursor }
        );

  const hasMore = comments.length >= count;
  const page = [...comments].sort((a, b) => a.id - b.id).slice(0, commentLimit);

  const messageBuilders: MessageBuilders = { ...builders, projectId, subject };
  const prependRoot = startsWithRoot || (direction === 'backward' && !hasMore);

  const messages: Message<BacklogRawMessage>[] = [];
  if (prependRoot) {
    messages.push(buildRootMessage(messageBuilders, await subject.fetchRoot()));
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

/**
 * Whether a decoded message id addresses the thread's own subject. Compared
 * through the grammar rather than field by field because a field-by-field
 * comparison needs a `kind` branch, and `subjectClientFor` is the only place
 * in `src/` allowed to have one (D-PR2); the
 * encoding is injective over subjects, so string equality is a total
 * comparison with no branch to keep in step with `BacklogSubjectRef`.
 *
 * Exported because every egress member that takes a thread id and a message
 * id owes the caller the same answer (`src/egress.ts`). A second copy of the
 * rule is what let egress take the subject from the message id while reads
 * took it from the thread id, so there is deliberately one implementation and
 * `src/egress.ts` imports it rather than restating it.
 */
export function addressesSameSubject(
  thread: BacklogThreadId,
  subject: BacklogSubjectRef
): boolean {
  return encodeThreadId({ ...thread, subject }) === encodeThreadId(thread);
}

export interface FetchMessageInput {
  threadId: string;
  messageId: string;
  subject: SubjectClient;
  /**
   * Deferred rather than passed as a value, because completing it resolves
   * the project's §9.1 converter and that costs a cached Get Project. §7.2
   * answers `null` without an API call for an id that cannot name a message
   * in this thread; taking the builders up front would spend a call on
   * exactly the ids that guarantee exists to keep free.
   */
  builders: () => Promise<Omit<MessageBuilders, 'projectId' | 'subject'>>;
}

/**
 * `fetchMessage` (docs/specs/adapter.md §7.2). Returns `null` without an API
 * call for a message id that cannot possibly belong to `threadId` (a
 * different host or a different subject) and for `u:` ids — Backlog has no
 * single-fetch endpoint for a fieldchange update with no comment (D12) —
 * rather than spending a call that could only ever come back empty-handed.
 * `subject.getComment` is one endpoint for an issue and a one-element list
 * window for a pull request (`src/subject/pull-request.ts`); both raise
 * `ResourceNotFoundError`, which is `null` here.
 */
export async function fetchMessage(
  input: FetchMessageInput
): Promise<Message<BacklogRawMessage> | null> {
  const { threadId, messageId, subject, builders } = input;
  const thread = decodeThreadId(threadId);
  const decoded = decodeMessageId(messageId);

  if (
    decoded.host !== thread.host ||
    !addressesSameSubject(thread, decoded.subject)
  ) {
    return null;
  }
  if (decoded.part === 'update') {
    return null;
  }

  const messageBuilders: MessageBuilders = {
    ...(await builders()),
    projectId: thread.projectId,
    subject,
  };

  try {
    if (decoded.part === 'root') {
      return buildRootMessage(messageBuilders, await subject.fetchRoot());
    }
    const comment = await subject.getComment(decoded.commentId);
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
  subject: SubjectClient;
  names: SubjectNames;
}

/**
 * `fetchThread` (docs/specs/adapter.md §7.3): one Get Issue or one Get Pull
 * Request, then `channelName` and `metadata` off the subject client — an
 * issue derives both from the object it just read, a pull request needs the
 * project key and repository name its object does not carry, which is what
 * `names` supplies. `url` lives inside `metadata` and is omitted there when a
 * name could not be resolved, so an unresolvable URL costs the thread its
 * link rather than the read.
 */
export async function fetchThread(
  input: FetchThreadInput
): Promise<ThreadInfo> {
  const { threadId, subject, names } = input;
  const { host, projectId } = decodeThreadId(threadId);
  const root = await subject.fetchRoot();

  const info: ThreadInfo = {
    id: threadId,
    channelId: encodeChannelId({ host, projectId }),
    isDM: false,
    metadata: subject.threadMetadata(root, names),
  };
  const channelName = subject.channelName(root, names);
  if (channelName !== undefined) {
    info.channelName = channelName;
  }
  return info;
}

export interface FetchSubjectInput {
  raw: BacklogRawMessage;
  subject: SubjectClient;
  names: SubjectNames;
  threadId: string;
}

/**
 * `fetchSubject` (docs/specs/adapter.md §7.4). Called lazily from
 * `message.subject` and its errors are turned into `null` by the core
 * (`.claude/rules/chat-sdk-core-facts.md` "`fetchSubject` is called lazily by
 * the `Message.subject` getter, errors -> `null`"), so every access — not
 * just the first — spends a read unless the raw already carries the object;
 * document this cost to a caller that reads `message.subject` in a loop.
 * `url` is omitted rather than set to `undefined` when a pull request's names
 * are unresolved: `MessageSubject.url` is optional, and a present-but-empty
 * key reads as "this subject has no page".
 */
export async function fetchSubject(
  input: FetchSubjectInput
): Promise<MessageSubject> {
  const { raw, subject, names, threadId } = input;
  const root = subject.rootFrom(raw) ?? (await subject.fetchRoot());

  const messageSubject: MessageSubject = {
    id: threadId,
    type: subject.subjectType,
    title: root.title,
    description: root.body,
    status: root.status.name,
    author: {
      id: `${raw.host}:${root.createdUser.id}`,
      name: root.createdUser.name,
    },
    labels: subject.subjectLabels(root),
    raw: subject.subjectRaw(root),
  };

  const url = subject.webUrl(root, names);
  if (url !== undefined) {
    messageSubject.url = url;
  }
  if (root.assignee !== null) {
    messageSubject.assignee = {
      id: `${raw.host}:${root.assignee.id}`,
      name: root.assignee.name,
    };
  }
  return messageSubject;
}

export interface FetchChannelInfoInput {
  channelId: string;
  api: BacklogApi;
}

/**
 * `fetchChannelInfo` (docs/specs/adapter.md §7.5). Returns the project's
 * `projectKey` and `textFormattingRule` alongside the `ChannelInfo` (not just
 * inside `metadata`, whose type is `Record<string, unknown>`) so the caller
 * (`adapter.ts`) can replace its §9.1 project cache entry — the one
 * documented way to pick up a changed project setting without restarting,
 * since that cache is otherwise permanent (D14) — without a runtime cast. The
 * project key is in that cache because a pull request's web URL needs it and
 * its own object does not carry it (§7.3).
 */
export async function fetchChannelInfo(input: FetchChannelInfoInput): Promise<{
  info: ChannelInfo;
  projectKey: string;
  textFormattingRule: TextFormattingRule;
}> {
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
    projectKey: project.projectKey,
    textFormattingRule: project.textFormattingRule,
  };
}

export interface ListThreadsInput {
  channelId: string;
  options: ListThreadsOptions | undefined;
  api: BacklogApi;
  builders: Omit<MessageBuilders, 'projectId' | 'subject'>;
  subjectFor: (issueId: number) => SubjectClient;
}

/**
 * The `SubjectRoot` for an issue `listThreads` already holds. Get Issue List
 * returns whole issues, so asking each row's client to `fetchRoot()` would
 * spend one Get Issue per thread for data the page already carries; the root
 * is shaped by the subject client rather than here so `fetchRoot` and this
 * path cannot disagree about what a root is (§3.4).
 */
function listedIssueRoot(
  host: string,
  subject: SubjectClient,
  issue: BacklogIssue
): SubjectRoot {
  const root = subject.rootFrom({
    kind: 'issue',
    host,
    issue: toRawIssue(issue),
    changes: [],
  });
  if (root === undefined) {
    // Unreachable: `subjectFor` builds an issue client keyed by this very
    // issue, and an issue client reads an `{ kind: "issue" }` raw. Throwing
    // rather than falling back to `fetchRoot()` keeps a mistake here loud
    // instead of quietly spending one read per row of a page the caller
    // already paid a search-bucket call for.
    throw new AdapterError(
      'a listed issue did not describe its own thread root',
      'backlog',
      'INVALID_SUBJECT_ROOT'
    );
  }
  return root;
}

/**
 * `listThreads` (docs/specs/adapter.md §7.6). Lists the project's **issues**
 * and deliberately not its pull requests (D-PR7): a pull-request list is per
 * repository, a coordinate a channel id does not carry, and
 * `client(host).getPullRequests(projectId, repositoryId, …)` is the route to
 * one — a `read`-bucket call, not a `search` one (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md` "Rate limit"), so merging the
 * two lists here would also mix two budgets behind one cursor.
 *
 * Deliberately does not sort or filter the port's response either: Get Issue
 * List draws on the **search** bucket (a documented example 150/min, far
 * lower than `read`'s 600), so silently re-sorting or dropping closed issues
 * here would hide that cost from a caller who asked for one page and would
 * also disagree with what Backlog's own UI shows for the same call.
 * `nextCursor` is only set on a full page — a short final page and a
 * documented trailing empty page are both possible, per §7.6.
 */
export async function listThreads(
  input: ListThreadsInput
): Promise<ListThreadsResult<BacklogRawMessage>> {
  const { channelId, options, api, builders, subjectFor } = input;
  const { host, projectId } = decodeChannelId(channelId);
  const limit = clampLimit(options?.limit);
  const offset = parseOffset(options?.cursor);

  const issues = await api.listIssues(projectId, { count: limit, offset });

  const threads = issues.map((issue) => {
    const subject = subjectFor(issue.id);
    const messageBuilders: MessageBuilders = {
      ...builders,
      projectId,
      subject,
    };
    return {
      id: encodeThreadId({ host, projectId, subject: subject.ref }),
      rootMessage: buildRootMessage(
        messageBuilders,
        listedIssueRoot(host, subject, issue)
      ),
      lastReplyAt: issue.updated,
    };
  });

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
  threadId: string;
  messageId: string;
  message: Message<BacklogRawMessage> | undefined;
  api: BacklogApi;
  subject: SubjectClient;
  logger: {
    debug: (message: string, ...args: unknown[]) => void;
    info: (message: string, ...args: unknown[]) => void;
  };
}

const MARK_AS_READ_PAGE_SIZE = 100;
const MARK_AS_READ_MAX_PAGES = 3;

/**
 * Comment id **and subject** `markAsRead` looks for, from `threadId` and
 * `messageId` and — when a `message` is given — cross-checked against
 * `message.raw` (docs/specs/adapter.md §7.8 "comment id and kind from
 * `messageId` (or `message.raw` when given — they must agree)"). `:r`/`:u:`
 * ids have no notification-worthy comment and return `undefined`, which the
 * caller turns into a no-call debug log.
 *
 * The subject is compared as well as the number, in both directions, because
 * an issue comment id and a pull-request comment id come from different
 * sequences and may collide (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md`): a numeric match alone would
 * let a notification about another subject's comment be marked read, and
 * which field carries it (`comment.id` or `pullRequestComment.id`) is chosen
 * by the thread's subject client.
 */
function commentIdForMarkAsRead(
  threadId: string,
  messageId: string,
  message: Message<BacklogRawMessage> | undefined
): number | undefined {
  const thread = decodeThreadId(threadId);
  const decoded = decodeMessageId(messageId);
  if (
    decoded.host !== thread.host ||
    !addressesSameSubject(thread, decoded.subject)
  ) {
    throw new ValidationError(
      'backlog',
      `messageId "${messageId}" does not name a message in thread "${threadId}"`
    );
  }
  if (decoded.part !== 'comment') {
    return undefined;
  }
  if (message !== undefined && message.raw.kind === 'comment') {
    if (
      message.raw.comment.id !== decoded.commentId ||
      !addressesSameSubject(thread, message.raw.subject)
    ) {
      throw new ValidationError(
        'backlog',
        `messageId "${messageId}" and message.raw disagree on which comment to mark read`
      );
    }
  }
  return decoded.commentId;
}

/**
 * `markAsRead` (docs/specs/adapter.md §7.8): notifications are the **bot
 * user's own** feed, paged newest-first at most 3 times
 * (`GET /notifications?count=100[&maxId=]`) looking for the entry about this
 * comment. Which field that is belongs to the subject
 * (`subject.notificationCommentId`): an issue's comment id is read from
 * `comment.id` and a pull request's from `pullRequestComment.id`, never the
 * other way round, because the two id sequences are distinct and may overlap
 * (measured 2026-09-06).
 *
 * Capped at 3 pages (300 notifications) rather than paging until exhausted
 * because this is meant to be called per-message, not swept unboundedly — an
 * old comment that has scrolled off the bot's most recent 300 notifications
 * is treated the same as "no notification exists for this comment", which is
 * the common case for a bot that was not itself notified.
 */
export async function markAsRead(input: MarkAsReadInput): Promise<void> {
  const { threadId, messageId, message, api, subject, logger } = input;
  const commentId = commentIdForMarkAsRead(threadId, messageId, message);
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

    const found = notifications.find(
      (notification) =>
        subject.notificationCommentId(notification) === commentId
    );
    if (found !== undefined) {
      if (!found.resourceAlreadyRead) {
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

export interface RehydrateAttachmentInput {
  attachment: Attachment;
  configuredHosts: ReadonlySet<string>;
  download: (host: string, location: AttachmentLocation) => Promise<Buffer>;
}

/**
 * `rehydrateAttachment` (docs/specs/adapter.md §6.6): synchronous, and a
 * security boundary — it accepts only a URL whose host is one of this
 * adapter's **configured** installations and whose path is one this adapter
 * builds (`src/subject/url.ts`, which owns both directions of the grammar);
 * anything else (a foreign host, a malformed path, no URL at all) is returned
 * unchanged, without `fetchData`, which is what keeps a rehydrated attachment
 * from ever downloading through a host this adapter was not configured for
 * (§11).
 */
export function rehydrateAttachment(
  input: RehydrateAttachmentInput
): Attachment {
  const { attachment, configuredHosts, download } = input;
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
  const location = parseAttachmentPath(parsed.pathname);
  if (location === null) {
    return attachment;
  }
  const host = parsed.hostname;

  return {
    ...attachment,
    fetchData: () => download(host, location),
  };
}
