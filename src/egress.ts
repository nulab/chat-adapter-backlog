import { extractFiles, ValidationError } from '@chat-adapter/shared';

import { decodeMessageId, encodeMessageId } from './ids';
import { backlogPostableExtrasSchema } from './types';

import type { FallbackFormatConverter } from './format/fallback';
import type {
  AddCommentInput,
  BacklogApi,
  BacklogComment,
} from './client/port';
import type { BacklogRawMessage } from './types';
import type {
  AdapterPostableMessage,
  FileUpload,
  RawMessage,
  StreamChunk,
} from 'chat';

/**
 * Rejects `:i` (the issue body) and `:u:` (a fieldchange update with no
 * comment) for any operation that maps to a Backlog comment endpoint
 * (docs/specs/adapter.md §6 "Non-comment message ids", D12). Backlog *can*
 * edit an issue body through a different endpoint, but "edit what the bot
 * posted" must never silently rewrite a human's issue.
 */
export function requireCommentId(
  messageId: string,
  action: 'edited' | 'deleted' | 'starred'
): { host: string; issueId: number; commentId: number } {
  const decoded = decodeMessageId(messageId);
  if (decoded.kind !== 'comment') {
    throw new ValidationError(
      'backlog',
      `${messageId} is not a comment and cannot be ${action}`
    );
  }
  return {
    host: decoded.host,
    issueId: decoded.issueId,
    commentId: decoded.commentId,
  };
}

/**
 * Reads `BacklogPostableExtras` off a postable with the strict §3.4 schema: a
 * present-but-mistyped `notifiedUserId` is a `ValidationError`, never a
 * silently dropped value. Non-object postables (`string`, an
 * `AsyncIterable`, a `CardElement`) carry no extras.
 */
export function extractNotifiedUserId(
  message: AdapterPostableMessage
): number[] | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  if (!('notifiedUserId' in message)) {
    return undefined;
  }
  const result = backlogPostableExtrasSchema.safeParse({
    notifiedUserId: (message as { notifiedUserId?: unknown }).notifiedUserId,
  });
  if (!result.success) {
    throw new ValidationError(
      'backlog',
      `notifiedUserId must be an array of positive integers: ${result.error.message}`
    );
  }
  return result.data.notifiedUserId;
}

/**
 * Uploads every `extractFiles(message)` entry (docs/specs/adapter.md §6.1
 * step 1). Each upload is awaited in sequence rather than in parallel: a
 * partial failure must abandon only the uploads that already succeeded
 * (Backlog deletes an unattached upload after an hour) without racing a
 * later one that would otherwise still be in flight.
 */
export async function uploadFiles(
  api: BacklogApi,
  files: FileUpload[],
  toBuffer: (file: FileUpload) => Promise<Buffer>
): Promise<number[]> {
  const attachmentIds: number[] = [];
  for (const file of files) {
    const data = await toBuffer(file);
    const uploaded = await api.uploadAttachment(
      file.filename,
      data,
      file.mimeType
    );
    attachmentIds.push(uploaded.id);
  }
  return attachmentIds;
}

function toRawComment(
  projectId: number,
  host: string,
  comment: BacklogComment
): BacklogRawMessage {
  return {
    kind: 'comment',
    host,
    projectId,
    comment: {
      id: comment.id,
      content: comment.content,
      createdUser: {
        // The port's `BacklogUserRef` (src/client/port.ts) carries no numeric
        // user id — only the login `userId` string, `name` and
        // `mailAddress` — so a REST-derived `BacklogRawMessage.comment` can
        // never populate the numeric `id` this repo's inbound (webhook) path
        // carries. `0` is a documented placeholder, not a real id; nothing
        // reads it (author identity for REST-derived raws is resolved from
        // `createdUser.userId`/`name`, never `.id`).
        id: 0,
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
        // Same placeholder as `createdUser.id` above, and for the same
        // reason: `BacklogStar.presenter` is a `BacklogUserRef`.
        presenter: { id: 0 },
      })),
    },
    changes: [],
  };
}

export interface PostCommentInput {
  host: string;
  projectId: number;
  issueId: number;
  api: BacklogApi;
  converter: FallbackFormatConverter;
  message: AdapterPostableMessage;
  toBuffer: (file: FileUpload) => Promise<Buffer>;
}

/**
 * `postMessage` (docs/specs/adapter.md §6.1): upload, render, comment, in
 * that order, so a render failure never spends the update-bucket call and a
 * comment failure never fabricates a return value. The caller's message
 * object is read, never mutated — `content`/`notifiedUserId`/`attachmentId`
 * are assembled into a fresh `AddCommentInput` rather than written back onto
 * `message`.
 */
export async function postComment(
  input: PostCommentInput
): Promise<RawMessage<BacklogRawMessage>> {
  const { host, projectId, issueId, api, converter, message, toBuffer } = input;

  const notifiedUserId = extractNotifiedUserId(message);
  const files = extractFiles(message);
  const attachmentId =
    files.length > 0 ? await uploadFiles(api, files, toBuffer) : undefined;

  const content = converter.renderPostable(message);

  const commentInput: AddCommentInput = { content };
  if (notifiedUserId !== undefined) {
    commentInput.notifiedUserId = notifiedUserId;
  }
  if (attachmentId !== undefined) {
    commentInput.attachmentId = attachmentId;
  }

  const comment = await api.addComment(issueId, commentInput);

  return {
    id: encodeMessageId({
      kind: 'comment',
      host,
      issueId,
      commentId: comment.id,
    }),
    threadId: `backlog:${host}:${projectId}:${issueId}`,
    raw: toRawComment(projectId, host, comment),
  };
}

export interface EditCommentInput {
  host: string;
  projectId: number;
  issueId: number;
  commentId: number;
  api: BacklogApi;
  converter: FallbackFormatConverter;
  message: AdapterPostableMessage;
}

/**
 * `editMessage` (docs/specs/adapter.md §6.2): Backlog's Update Comment takes
 * `content` only, so files or extras on the edit are a `ValidationError`
 * rather than a silent drop — an edit that appears to accept a file but never
 * attaches it would be a worse surprise than a loud rejection.
 */
export async function editComment(
  input: EditCommentInput
): Promise<RawMessage<BacklogRawMessage>> {
  const { host, projectId, issueId, commentId, api, converter, message } =
    input;

  if (extractFiles(message).length > 0) {
    throw new ValidationError(
      'backlog',
      'editMessage cannot attach files: Backlog Update Comment accepts content only'
    );
  }
  if (extractNotifiedUserId(message) !== undefined) {
    throw new ValidationError(
      'backlog',
      'editMessage does not accept notifiedUserId: Backlog Update Comment accepts content only'
    );
  }

  const content = converter.renderPostable(message);
  const comment = await api.updateComment(issueId, commentId, content);

  return {
    id: encodeMessageId({
      kind: 'comment',
      host,
      issueId,
      commentId: comment.id,
    }),
    threadId: `backlog:${host}:${projectId}:${issueId}`,
    raw: toRawComment(projectId, host, comment),
  };
}

/**
 * Resolves whether `presenter` is the bot's own star. The port's
 * `BacklogUserRef` (src/client/port.ts, owned by an earlier phase) has no
 * numeric user id — only the login `userId` string — so `botUserId` (a
 * number) cannot be compared to it directly the way §6.5 describes
 * (`presenter.id === botUserId`). `botUserRef.userId` is resolved once (via
 * `api.getUser(botUserId)`, cached by the caller) and compared as a string
 * instead: both values come from the same account's `userId` field, so they
 * agree regardless of whether that field holds a login handle or looks
 * numeric.
 */
function isBotPresenter(
  presenterUserId: string | null,
  botUserIdString: string | null
): boolean {
  return (
    botUserIdString !== null &&
    presenterUserId !== null &&
    presenterUserId === botUserIdString
  );
}

export interface AddReactionInput {
  issueId: number;
  commentId: number;
  api: BacklogApi;
  botUserIdString: string | null;
}

/**
 * `addReaction` (docs/specs/adapter.md §6.5): the emoji is ignored (Backlog
 * has one star kind). Reads the comment before starring so a second call is
 * a no-op — Backlog allows unlimited stars per user, so without this read
 * every retry or duplicate reaction would add another star.
 */
export async function addReaction(input: AddReactionInput): Promise<void> {
  const { issueId, commentId, api, botUserIdString } = input;
  const comment = await api.getComment(issueId, commentId);
  const alreadyStarred = comment.stars.some((star) =>
    isBotPresenter(star.presenter.userId, botUserIdString)
  );
  if (alreadyStarred) {
    return;
  }
  await api.addStar(commentId);
}

export interface RemoveReactionInput {
  issueId: number;
  commentId: number;
  api: BacklogApi;
  botUserIdString: string | null;
}

/**
 * `removeReaction` (docs/specs/adapter.md §6.5): deletes every star the bot
 * itself presented on the comment, never another user's — the comment is
 * re-read for its current stars rather than trusting a prior snapshot, since
 * `deleteStar` addresses stars individually by id.
 */
export async function removeReaction(
  input: RemoveReactionInput
): Promise<void> {
  const { issueId, commentId, api, botUserIdString } = input;
  const comment = await api.getComment(issueId, commentId);
  const ownStars = comment.stars.filter((star) =>
    isBotPresenter(star.presenter.userId, botUserIdString)
  );
  for (const star of ownStars) {
    await api.deleteStar(star.id);
  }
}

/**
 * Buffers a `stream()` textStream into one string (docs/specs/adapter.md
 * §6.4, D4, CLAUDE.md "`stream()` must be overridden"): concatenates `string`
 * chunks and `markdown_text` chunks, ignores `task_update`/`plan_update`.
 * Consumption stops when `signal` aborts, returning whatever was buffered so
 * far — never throwing — because an abort must still produce the "post what
 * we have" behaviour §6.4 requires, not a rejection that skips posting
 * entirely.
 */
export async function bufferStream(
  textStream: AsyncIterable<string | StreamChunk>,
  signal: AbortSignal | undefined
): Promise<string> {
  let buffered = '';
  for await (const chunk of textStream) {
    if (signal?.aborted === true) {
      break;
    }
    if (typeof chunk === 'string') {
      buffered += chunk;
    } else if (chunk.type === 'markdown_text') {
      buffered += chunk.text;
    }
    // `task_update` and `plan_update` chunks carry no text (§6.4) and are
    // ignored.
  }
  return buffered;
}
