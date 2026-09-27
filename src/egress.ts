import { extractFiles, ValidationError } from '@chat-adapter/shared';
import { z } from 'zod';

import {
  decodeMessageId,
  decodeThreadId,
  encodeMessageId,
  encodeThreadId,
  isMessageInThread,
} from './ids';
import { readUploadedFile, send } from './client/responses';
import { converter } from './format';

import type { AddCommentInput, SubjectClient } from './subject/client';
import type {
  BacklogRawComment,
  BacklogRawMessage,
  BacklogSubjectRef,
} from './types';
import type { Backlog } from 'backlog-js';
import type {
  AdapterPostableMessage,
  FileUpload,
  RawMessage,
  StreamChunk,
} from 'chat';

/**
 * A message id naming another host or subject is refused rather than
 * followed: the two ids are independent inputs, and nothing outside the
 * caller guarantees they agree. The body and a field-change update are
 * refused too (D12): "edit what the bot posted" must never rewrite a human's
 * issue.
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
  if (!isMessageInThread(decoded, thread)) {
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
 * Membership is not checked: Backlog drops a non-member id without failing
 * the request (measured).
 */
const backlogPostableExtrasSchema = z.object({
  notifiedUserId: z.array(z.number().int().positive()).optional(),
});

function extractNotifiedUserId(
  message: AdapterPostableMessage
): number[] | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  if (!('notifiedUserId' in message)) {
    return undefined;
  }
  const result = backlogPostableExtrasSchema.safeParse({
    notifiedUserId: message.notifiedUserId,
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
 * Awaited in sequence rather than in parallel: a partial failure must
 * abandon only the uploads that already succeeded (Backlog deletes an
 * unattached upload after an hour) without racing a later one that would
 * otherwise still be in flight.
 */
async function uploadFiles(
  client: Backlog,
  files: FileUpload[],
  toBuffer: (file: FileUpload) => Promise<Buffer>
): Promise<number[]> {
  const attachmentIds: number[] = [];
  for (const file of files) {
    const form = new FormData();
    // A `Buffer` may sit on a `SharedArrayBuffer`, which `BlobPart` refuses.
    const bytes = Uint8Array.from(await toBuffer(file));
    form.set(
      'file',
      new Blob(
        [bytes],
        file.mimeType === undefined ? {} : { type: file.mimeType }
      ),
      file.filename
    );
    const uploaded = await readUploadedFile(client.postSpaceAttachment(form));
    attachmentIds.push(uploaded.id);
  }
  return attachmentIds;
}

export interface PostCommentInput {
  host: string;
  projectId: number;
  subject: SubjectClient;
  /** For `POST /space/attachment`, which is space-level rather than per subject. */
  client: Backlog;
  message: AdapterPostableMessage;
  toBuffer: (file: FileUpload) => Promise<Buffer>;
}

/**
 * Upload, render, comment, in that order, so a render failure never spends
 * the update-bucket call.
 */
export async function postComment(
  input: PostCommentInput
): Promise<RawMessage<BacklogRawMessage>> {
  const { host, projectId, subject, client, message, toBuffer } = input;

  const notifiedUserId = extractNotifiedUserId(message);
  const files = extractFiles(message);
  const attachmentId =
    files.length > 0 ? await uploadFiles(client, files, toBuffer) : undefined;

  const content = converter.renderPostable(message);

  const commentInput: AddCommentInput = { content };
  if (notifiedUserId !== undefined) {
    commentInput.notifiedUserId = notifiedUserId;
  }
  if (attachmentId !== undefined) {
    commentInput.attachmentId = attachmentId;
  }

  return sentComment(
    host,
    projectId,
    subject,
    await subject.addComment(commentInput)
  );
}

function sentComment(
  host: string,
  projectId: number,
  subject: SubjectClient,
  comment: BacklogRawComment
): RawMessage<BacklogRawMessage> {
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
      comment,
      changes: [],
    },
  };
}

export interface EditCommentInput {
  host: string;
  projectId: number;
  subject: SubjectClient;
  commentId: number;
  message: AdapterPostableMessage;
}

/**
 * Update Comment takes `content` only, so files or extras on the edit are a
 * `ValidationError` rather than a silent drop.
 */
export async function editComment(
  input: EditCommentInput
): Promise<RawMessage<BacklogRawMessage>> {
  const { host, projectId, subject, commentId, message } = input;

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
  return sentComment(
    host,
    projectId,
    subject,
    await subject.updateComment(commentId, content)
  );
}

export interface ReactionInput {
  client: Backlog;
  subject: SubjectClient;
  commentId: number;
  botUserId: number;
}

/**
 * Reads the comment before starring: `POST /stars` is not idempotent
 * (measured), so without the read every retry would add another star.
 */
export async function addReaction(input: ReactionInput): Promise<void> {
  const { client, subject, commentId, botUserId } = input;
  const comment = await subject.getComment(commentId);
  const alreadyStarred = comment.stars.some(
    (star) => star.presenter.id === botUserId
  );
  if (alreadyStarred) {
    return;
  }
  await send(client.postStar(subject.starTarget(commentId)));
}

/**
 * Re-reads the comment rather than trusting a prior snapshot, because a star
 * is removed by its own id.
 */
export async function removeReaction(input: ReactionInput): Promise<void> {
  const { client, subject, commentId, botUserId } = input;
  const comment = await subject.getComment(commentId);
  const ownStars = comment.stars.filter(
    (star) => star.presenter.id === botUserId
  );
  for (const star of ownStars) {
    await send(client.removeStar(star.id));
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
