import { Message } from 'chat';

import {
  encodeMessageId,
  encodeThreadId,
  mentionPattern,
  mentionUser,
} from '../ids';
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
  botUserName?: string | undefined;
  format: (text: string) => MessageData['formatted'];
}

type Notification = WebhookActivity['notifications'][number];

interface MentionEvidence {
  /** Unset turns off the two rules that match the name; the id rules remain. */
  botUserName: string | undefined;
  botUserId: number;
  text: string;
  /**
   * Only a root activity's `content.assignee`. On every other type the key is
   * the standing assignee, repeated whether or not it changed (measured), so
   * reading it there turns an unrelated edit into a mention.
   */
  assigneeId: number | undefined;
  changes: readonly BacklogChange[];
  notifications: readonly Notification[];
  /**
   * A pull request's summary is stored without `<@U<id>>` being rewritten to
   * `@<display name>` (measured); everywhere else a literal `<@U…>` is a
   * mention that notified nobody.
   */
  rawMentionSurvives: boolean;
}

// An issue reports a new assignee as `assigner`, a pull request as `assignee`,
// both by display name (measured).
const ASSIGNMENT_CHANGE_FIELDS: readonly string[] = ['assigner', 'assignee'];

function detectMention(evidence: MentionEvidence): boolean {
  const { botUserName, botUserId, text, assigneeId, changes } = evidence;
  // Not narrowed to one `reason`: an allowlist could only drop a directed
  // notification whose code nobody has measured yet.
  if (evidence.notifications.some((entry) => entry.user.id === botUserId)) {
    return true;
  }
  if (botUserName !== undefined && mentionPattern(botUserName).test(text)) {
    return true;
  }
  if (evidence.rawMentionSurvives && text.includes(mentionUser(botUserId))) {
    return true;
  }
  if (assigneeId === botUserId) {
    return true;
  }
  // Kept beside the notification rule for a body replayed from the activity
  // API, whose `notifications[]` is always empty (measured).
  return (
    botUserName !== undefined &&
    changes.some(
      (change) =>
        ASSIGNMENT_CHANGE_FIELDS.includes(change.field) &&
        change.newValue === botUserName
    )
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
  rawMentionSurvives: boolean;
}

// Comment edits emit no webhook (measured), so a webhook message is never
// `edited`.
function assemble(
  activity: WebhookActivity,
  context: InboundContext,
  parts: MessageParts,
  raw: BacklogRawMessage
): Message<BacklogRawMessage> {
  const { host, botUserId, botUserName } = context;
  const { subject, text, changes } = parts;
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
      botUserName,
      botUserId,
      text,
      assigneeId: parts.assigneeId,
      changes,
      notifications: activity.notifications,
      rawMentionSurvives: parts.rawMentionSurvives,
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
    rawMentionSurvives: activity.type === 18,
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
    rawMentionSurvives: false,
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
      rawMentionSurvives: false,
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
