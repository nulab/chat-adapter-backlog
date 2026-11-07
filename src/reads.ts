import { ResourceNotFoundError, ValidationError } from '@chat-adapter/shared';
import {
  decodeChannelId,
  decodeMessageId,
  decodeThreadId,
  decodeUserId,
  encodeChannelId,
  encodeMessageId,
  encodeThreadId,
  encodeUserId,
  isMessageInThread,
} from './ids';
import { readProject, readUser } from './client/responses';
import { parseAttachmentPath } from './subject/url';

import type {
  SubjectClient,
  SubjectNames,
  SubjectRoot,
} from './subject/client';
import type {
  BacklogChange,
  BacklogRawComment,
  BacklogRawMessage,
} from './types';
import type { Backlog } from 'backlog-js';
import type {
  Attachment,
  Author,
  ChannelInfo,
  FetchDirection,
  FetchOptions,
  FetchResult,
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
 * A non-integer is rejected rather than rounded: a caller asking for 2.5
 * messages has a bug, and `NaN` would survive `Math.min`/`Math.max` to fail
 * at Backlog with Backlog's message instead of the adapter's.
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
 * Keyed on the numeric `id`, never on `userId`: that is a login handle, and
 * `null` for a user signed in with a Nulab account. `isBot` mirrors `isMe`:
 * Backlog has no bot attribute, and the `"unknown"` the type allows would make
 * the core's `getParticipants` drop the author.
 */
export function authorOf(
  host: string,
  botUserId: number,
  user: { id: number; name: string; userId?: string | null | undefined }
): Author {
  const isMe = user.id === botUserId;
  return {
    userId: encodeUserId({ host, userId: user.id }),
    userName: user.userId ?? user.name,
    fullName: user.name,
    isMe,
    isBot: isMe,
  };
}

/** Everything a `Message` needs beyond the record it is built from. */
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
 * `edited` is always `false`: a root's `updated` moves on any field change
 * and says nothing about whether the body itself was edited.
 */
function buildRootMessage(
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
    author: authorOf(host, botUserId, root.createdUser),
    metadata: { dateSent: new Date(root.created), edited: false },
    // Empty by decision (D11): the webhook path carries a body's files
    // because the payload names them, and reading them here would cost a
    // call per root message.
    attachments: [],
    isMention: false,
  });
}

/**
 * Unlike a root, a comment's `updated` is its own edit history, and the only
 * one a consumer gets: a comment edit fires no webhook (measured).
 */
function buildCommentMessage(
  builders: MessageBuilders,
  comment: BacklogRawComment
): Message<BacklogRawMessage> {
  const { host, projectId, subject, botUserId, format, MessageCtor } = builders;
  const text = comment.content ?? '';
  const dateSent = new Date(comment.created);
  // Timestamps are second-granular, so an edit in the posting second reads as
  // unedited; nothing in the response can tell the two apart (measured).
  const metadata: MessageData['metadata'] =
    comment.updated === comment.created
      ? { dateSent, edited: false }
      : { dateSent, edited: true, editedAt: new Date(comment.updated) };
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
      comment,
      changes: comment.changeLog.map((change): BacklogChange => ({
        field: change.field,
        newValue: change.newValue,
        oldValue: change.originalValue,
      })),
    },
    author: authorOf(host, botUserId, comment.createdUser),
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
 * One algorithm for both kinds: pull-request comments page with the same
 * exclusive `minId`/`maxId` and head-cut `count` as issue comments
 * (measured), so the previous page's edge id is the cursor with no `±1`.
 *
 * `hasMore` is the page's own length reaching `count`, so a full final page
 * reads as "more" until the next one comes back empty. The comment-count
 * endpoints would answer a different question — the total, not whether
 * anything lies past this cursor — for a call of the same cost.
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
  // Not skipped when `commentLimit` is 0: on a forward `limit: 1` page, which
  // holds only the root, the one comment fetched is what tells "come back
  // with cursor 0" from "this thread has none".
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

export interface FetchMessageInput {
  threadId: string;
  messageId: string;
  subject: SubjectClient;
  builders: Omit<MessageBuilders, 'projectId' | 'subject'>;
}

/**
 * `null` without a call for an id of another host or subject, and for an
 * update id, which no endpoint fetches (D12).
 */
export async function fetchMessage(
  input: FetchMessageInput
): Promise<Message<BacklogRawMessage> | null> {
  const { threadId, messageId, subject, builders } = input;
  const thread = decodeThreadId(threadId);
  const decoded = decodeMessageId(messageId);

  if (!isMessageInThread(decoded, thread) || decoded.part === 'update') {
    return null;
  }

  const messageBuilders: MessageBuilders = {
    ...builders,
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
 * `url` is omitted rather than set to `undefined` when a pull request's names
 * are unresolved: a present-but-empty key reads as "this subject has no page".
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
      id: encodeUserId({ host: raw.host, userId: root.createdUser.id }),
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
      id: encodeUserId({ host: raw.host, userId: root.assignee.id }),
      name: root.assignee.name,
    };
  }
  return messageSubject;
}

export interface FetchChannelInfoInput {
  channelId: string;
  client: Backlog;
}

export async function fetchChannelInfo(
  input: FetchChannelInfoInput
): Promise<ChannelInfo> {
  const { channelId, client } = input;
  const { host, projectId } = decodeChannelId(channelId);
  const project = await readProject(client.getProject(projectId));
  return {
    id: channelId,
    name: project.name,
    isDM: false,
    metadata: {
      host,
      projectId,
      projectKey: project.projectKey,
    },
  };
}

export interface GetUserInput {
  userId: string;
  client: Backlog;
  botUserId: number;
}

export async function getUser(input: GetUserInput): Promise<UserInfo | null> {
  const { userId, client, botUserId } = input;
  const { host, userId: id } = decodeUserId(userId);
  try {
    const user = await readUser(client.getUser(id));
    const info: UserInfo = {
      userId: encodeUserId({ host, userId: user.id }),
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

export interface RehydrateAttachmentInput {
  attachment: Attachment;
  host: string;
  client: Backlog;
}

/**
 * A security boundary: only a URL on the configured host with a path this
 * adapter builds regains `fetchData`, so a rehydrated attachment never
 * downloads through a host the adapter was not configured for.
 */
export function rehydrateAttachment(
  input: RehydrateAttachmentInput
): Attachment {
  const { attachment, host, client } = input;
  if (attachment.url === undefined) {
    return attachment;
  }

  let parsed: URL;
  try {
    parsed = new URL(attachment.url);
  } catch {
    return attachment;
  }

  if (parsed.hostname !== host) {
    return attachment;
  }
  const download = parseAttachmentPath(parsed.pathname);
  if (download === null) {
    return attachment;
  }
  return { ...attachment, fetchData: () => download(client) };
}
