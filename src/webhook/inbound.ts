import { Message } from 'chat';

import { encodeMessageId, encodeThreadId } from '../ids';
import { authorOf } from '../reads';

import { payloadOf } from './payload';

import type { WebhookActivity } from './payload';
import type { SubjectClient } from '../subject/client';
import type {
  BacklogChange,
  BacklogMessagePart,
  BacklogRawMessage,
  BacklogSubjectRef,
} from '../types';
import type { Attachment, MessageData } from 'chat';

export type MessageActivity = Exclude<WebhookActivity, { type: 4 | 14 }>;
export type BulkUpdateActivity = Extract<WebhookActivity, { type: 14 }>;
type PullRequestActivity = Extract<WebhookActivity, { type: 18 | 19 | 20 }>;
export type BulkUpdateLink = BulkUpdateActivity['content']['link'][number];

export interface InboundContext {
  host: string;
  botUserId: number;
  format: (text: string) => MessageData['formatted'];
}

type Notification = WebhookActivity['notifications'][number];

interface MentionEvidence {
  botUserId: number;
  /**
   * Only a root activity's `content.assignee`. On every other type the key is
   * the standing assignee, repeated whether or not it changed (measured), so
   * reading it there turns an unrelated edit into a mention.
   */
  assigneeId: number | undefined;
  notifications: readonly Notification[];
}

function detectMention(evidence: MentionEvidence): boolean {
  const { botUserId, assigneeId } = evidence;
  // Not narrowed to one `reason`: an allowlist could only drop a directed
  // notification whose code nobody has measured yet.
  return (
    evidence.notifications.some((entry) => entry.user.id === botUserId) ||
    assigneeId === botUserId
  );
}

function normaliseChanges(
  changes: {
    field: string;
    new_value: string | null;
    old_value: string | null;
  }[]
): BacklogChange[] {
  return changes.map((change) => ({
    field: change.field,
    newValue: change.new_value,
    oldValue: change.old_value,
  }));
}

/**
 * A pull-request comment posted with files names them only in `changes[]`,
 * with no `content.attachments` key (measured). An empty value is a removal.
 */
function changeAttachments(
  subject: SubjectClient,
  changes: readonly BacklogChange[]
): Attachment[] {
  return changes
    .filter((change) => change.field === 'attachment' && change.newValue)
    .flatMap((change) => subject.webhookChangeAttachment(change) ?? []);
}

function commentPart(
  comment: { id: number } | null,
  created: string
): BacklogMessagePart {
  return comment === null
    ? { part: 'update', created }
    : { part: 'comment', commentId: comment.id };
}

interface MessageParts {
  subject: BacklogSubjectRef;
  part: BacklogMessagePart;
  text: string;
  attachments: Attachment[];
  assigneeId: number | undefined;
  changes: BacklogChange[];
}

// Comment edits emit no webhook (measured), so a webhook message is never
// `edited`.
function assemble(
  activity: WebhookActivity,
  context: InboundContext,
  parts: MessageParts,
  raw: BacklogRawMessage
): Message<BacklogRawMessage> {
  const { host, botUserId } = context;
  const { subject, text } = parts;
  return new Message<BacklogRawMessage>({
    id: encodeMessageId({ host, subject, ...parts.part }),
    threadId: encodeThreadId({ host, projectId: activity.project.id, subject }),
    text,
    formatted: context.format(text),
    raw,
    author: authorOf(host, botUserId, activity.createdUser),
    metadata: { dateSent: new Date(activity.created), edited: false },
    attachments: parts.attachments,
    isMention: detectMention({
      botUserId,
      assigneeId: parts.assigneeId,
      notifications: activity.notifications,
    }),
  });
}

function rootParts(
  activity: Extract<WebhookActivity, { type: 1 }> | PullRequestActivity,
  subject: SubjectClient
): MessageParts {
  const { summary, description, attachments, assignee } = activity.content;
  return {
    subject: subject.ref,
    part: { part: 'root' },
    text: [summary ?? '', description ?? '']
      .filter((part) => part.length > 0)
      .join('\n\n')
      .trim(),
    attachments: attachments.map((file) => subject.webhookAttachment(file)),
    assigneeId: assignee?.id,
    changes: [],
  };
}

/**
 * A changelog comment (a status change, an attachment, a merge) arrives with
 * a comment id and empty text, so a handler keys on `raw.changes`, never on
 * whether a comment is present.
 */
function commentParts(
  activity: Extract<WebhookActivity, { type: 2 | 3 }> | PullRequestActivity,
  subject: SubjectClient
): MessageParts {
  const { comment, attachments } = activity.content;
  const changes = normaliseChanges(activity.content.changes);
  return {
    subject: subject.ref,
    part: commentPart(comment, activity.created),
    text: comment === null ? '' : comment.content,
    attachments: [
      ...attachments.map((file) => subject.webhookAttachment(file)),
      ...changeAttachments(subject, changes),
    ],
    assigneeId: undefined,
    changes,
  };
}

export function buildInboundMessage(
  activity: MessageActivity,
  context: InboundContext,
  subject: SubjectClient
): Message<BacklogRawMessage> {
  const parts =
    activity.type === 1 || activity.type === 18
      ? rootParts(activity, subject)
      : commentParts(activity, subject);
  return assemble(activity, context, parts, {
    kind: 'webhook',
    host: context.host,
    payload: payloadOf(activity),
    changes: parts.changes,
  });
}

/**
 * One issue of a bulk update. The batch's `changes[]` and `notifications[]`
 * go on every message whole: neither names an issue, so pairing entries with
 * `link[]` by position would be an ordering Backlog does not document (D22).
 * A bulk update carries no attachments (measured), and `link[]` holds issues
 * only, so no subject client is needed.
 */
export function buildBulkUpdateMessage(
  activity: BulkUpdateActivity,
  link: BulkUpdateLink,
  context: InboundContext
): Message<BacklogRawMessage> {
  const changes = normaliseChanges(activity.content.changes);
  return assemble(
    activity,
    context,
    {
      subject: { kind: 'issue', issueId: link.id },
      part: commentPart(link.comment, activity.created),
      text: link.comment === null ? '' : link.comment.content,
      attachments: [],
      assigneeId: undefined,
      changes,
    },
    {
      kind: 'bulkUpdate',
      host: context.host,
      payload: payloadOf(activity),
      issueId: link.id,
      changes,
    }
  );
}
