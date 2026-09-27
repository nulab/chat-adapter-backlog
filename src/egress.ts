import { extractFiles, ValidationError } from '@chat-adapter/shared';
import { z } from 'zod';

import {
  decodeMessageId,
  decodeThreadId,
  encodeMessageId,
  encodeThreadId,
} from './ids';
import { addressesSameSubject } from './reads';
import { toRawComment } from './subject/raw';

import type { SubjectClient } from './subject/client';
import type { AddCommentInput, BacklogApi } from './client/port';
import type { BacklogRawMessage, BacklogSubjectRef } from './types';
import type {
  AdapterPostableMessage,
  BaseFormatConverter,
  FileUpload,
  RawMessage,
  StreamChunk,
} from 'chat';

/**
 * The comment `messageId` names inside `threadId`, for any operation that maps
 * to a Backlog comment endpoint (docs/specs/adapter.md §6). Two ids in, one
 * set of coordinates out:
 *
 * - A message id naming another host or another subject is a
 *   `ValidationError`. The two ids are independent inputs from the caller and
 *   nothing outside the caller guarantees they agree, so the disagreement is
 *   reported rather than resolved — `fetchMessage` answers the same question
 *   with `null` (§7.2) through the same predicate.
 * - `:r` (the issue or pull-request body) and `:u:` (a fieldchange update with
 *   no comment) are rejected (§6 "Non-comment message ids", D12). Backlog
 *   *can* edit an issue body through a different endpoint, but "edit what the
 *   bot posted" must never silently rewrite a human's issue.
 *
 * The subject travels out from the **thread**, never from the message id, even
 * though the two are now known to agree: §6's preamble picks the subject
 * client the thread id's `subject` selects, and taking it from the message id
 * is what let `deleteMessage` on a pull-request thread reach the issue
 * endpoints and slip past the D-PR3 guard that lives inside the pull-request
 * subject client. It travels whole rather than as the coordinates of one kind,
 * so the caller reaches its `SubjectClient` without re-deriving what it is
 * holding (D-PR2).
 */
export function requireCommentInThread(
  threadId: string,
  messageId: string,
  action: 'edited' | 'deleted' | 'starred'
): {
  host: string;
  projectId: number;
  subject: BacklogSubjectRef;
  commentId: number;
} {
  const thread = decodeThreadId(threadId);
  const decoded = decodeMessageId(messageId);
  if (
    decoded.host !== thread.host ||
    !addressesSameSubject(thread, decoded.subject)
  ) {
    throw new ValidationError(
      'backlog',
      `${messageId} does not name a message in thread ${threadId} and cannot be ${action}`
    );
  }
  if (decoded.part !== 'comment') {
    throw new ValidationError(
      'backlog',
      `${messageId} is not a comment and cannot be ${action}`
    );
  }
  return {
    host: thread.host,
    projectId: thread.projectId,
    subject: thread.subject,
    commentId: decoded.commentId,
  };
}

/**
 * `.strict()` rather than zod's default `.strip()`: a misspelt extra would
 * otherwise be dropped without a word and the notification silently lost.
 * Membership is not checked: Backlog drops a non-member id without failing
 * the request (measured).
 */
const backlogPostableExtrasSchema = z
  .object({
    notifiedUserId: z.array(z.number().int().positive()).optional(),
  })
  .strict();

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

export interface PostCommentInput {
  host: string;
  projectId: number;
  subject: SubjectClient;
  /**
   * Only `POST /space/attachment` is reached through the port here: uploading
   * is space-level and has no per-subject endpoint, while the comment itself
   * goes through `subject` so this function has one code path for both kinds.
   */
  api: BacklogApi;
  converter: BaseFormatConverter;
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
  const { host, projectId, subject, api, converter, message, toBuffer } = input;

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

  const comment = await subject.addComment(commentInput);

  return {
    id: encodeMessageId({
      host,
      subject: subject.ref,
      part: 'comment',
      commentId: comment.id,
    }),
    threadId: encodeThreadId({ host, projectId, subject: subject.ref }),
    raw: {
      kind: 'comment',
      host,
      projectId,
      subject: subject.ref,
      comment: toRawComment(comment),
      changes: [],
    },
  };
}

export interface EditCommentInput {
  host: string;
  projectId: number;
  subject: SubjectClient;
  commentId: number;
  converter: BaseFormatConverter;
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
  const { host, projectId, subject, commentId, converter, message } = input;

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
  const comment = await subject.updateComment(commentId, content);

  return {
    id: encodeMessageId({
      host,
      subject: subject.ref,
      part: 'comment',
      commentId: comment.id,
    }),
    threadId: encodeThreadId({ host, projectId, subject: subject.ref }),
    raw: {
      kind: 'comment',
      host,
      projectId,
      subject: subject.ref,
      comment: toRawComment(comment),
      changes: [],
    },
  };
}

export interface AddReactionInput {
  api: BacklogApi;
  subject: SubjectClient;
  commentId: number;
  botUserId: number;
}

/**
 * `addReaction` (docs/specs/adapter.md §6.5): the emoji is ignored (Backlog
 * has one star kind). Reads the comment before starring so a second call is
 * a no-op — Backlog allows unlimited stars per user, so without this read
 * every retry or duplicate reaction would add another star.
 */
export async function addReaction(input: AddReactionInput): Promise<void> {
  const { api, subject, commentId, botUserId } = input;
  const comment = await subject.getComment(commentId);
  const alreadyStarred = comment.stars.some(
    (star) => star.presenter.id === botUserId
  );
  if (alreadyStarred) {
    return;
  }
  await api.addStar(subject.starTarget(commentId));
}

export interface RemoveReactionInput {
  api: BacklogApi;
  subject: SubjectClient;
  commentId: number;
  botUserId: number;
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
  const { api, subject, commentId, botUserId } = input;
  const comment = await subject.getComment(commentId);
  const ownStars = comment.stars.filter(
    (star) => star.presenter.id === botUserId
  );
  for (const star of ownStars) {
    await api.deleteStar(star.id);
  }
}

/**
 * Only the text chunks: `task_update` and `plan_update` carry nothing a
 * comment can show. An abort needs no handling here — the core stops the
 * iterable it hands `stream()` when its signal aborts.
 */
export async function bufferStream(
  textStream: AsyncIterable<string | StreamChunk>
): Promise<string> {
  let buffered = '';
  for await (const chunk of textStream) {
    if (typeof chunk === 'string') {
      buffered += chunk;
    } else if (chunk.type === 'markdown_text') {
      buffered += chunk.text;
    }
  }
  return buffered;
}
