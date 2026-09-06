import { root, paragraph, text as textNode } from 'chat';

import { encodeMessageId, encodeThreadId, mentionPattern } from '../ids';

import type {
  ActivityAttachment,
  ActivityChange,
  ActivityCreatedUser,
  IssueCreatedActivity,
  IssueUpdatedOrCommentedActivity,
} from './payload';
import type { SubjectClient } from '../subject/client';
import type {
  BacklogChange,
  BacklogRawMessage,
  BacklogWebhookPayload,
} from '../types';
import type { Attachment, Author, Message, MessageData } from 'chat';

/**
 * One §5.3 row's outcome before it becomes a `Message`: everything the
 * Message/Author shapes need, kept separate from `Message` construction so
 * a test can assert on the mapping without also depending on the `formatted`
 * AST the caller's converter produces.
 */
export interface InboundMessageFields {
  messageId: string;
  text: string;
  attachments: Attachment[];
  isMention: boolean;
  changes: BacklogChange[];
  dateSent: Date;
}

function toAttachments(
  subject: SubjectClient,
  raw: ActivityAttachment[] | undefined
): Attachment[] {
  return (raw ?? []).map((attachment) => subject.webhookAttachment(attachment));
}

function normaliseChanges(raw: ActivityChange[] | undefined): BacklogChange[] {
  return (raw ?? []).map((change) => ({
    field: change.field,
    newValue: change.new_value === undefined ? null : String(change.new_value),
    oldValue: change.old_value === undefined ? null : String(change.old_value),
  }));
}

/**
 * Textual plus assignment mention detection (docs/specs/adapter.md §5.4).
 * `mentionPattern` alone only proves a hand-typed `@name` is present in
 * `text`; the assignment checks below catch the case Backlog signals
 * structurally instead of textually — assigning the bot to an issue, or
 * changing its assignee, mentions nobody in `text` at all.
 */
function detectMention(
  botUserName: string,
  botUserId: number,
  text: string,
  assigneeId: number | undefined,
  changes: BacklogChange[]
): boolean {
  if (mentionPattern(botUserName).test(text)) {
    return true;
  }
  if (assigneeId === botUserId) {
    return true;
  }
  return changes.some(
    (change) => change.field === 'assigner' && change.newValue === botUserName
  );
}

export interface BuildInboundMessageInput {
  host: string;
  botUserId: number;
  botUserName: string;
  /**
   * The subject the activity is about, already resolved by the caller through
   * `subjectOfActivity` (docs/plans/pull-request-support.md §3.4). It supplies
   * both the ref every id is built from and the attachment mapping, which
   * differs per kind: an issue attachment carries its id, a pull-request one
   * resolves it by name (D-PR10).
   */
  subject: SubjectClient;
}

/**
 * Type 1 — Issue Created (docs/specs/adapter.md §5.3 row 1). The message id
 * is the subject's root (`<host>:issue:<issueId>:r`); mention text is
 * `summary + description`, so a mention placed in the summary counts.
 */
function buildIssueCreatedFields(
  activity: IssueCreatedActivity,
  input: BuildInboundMessageInput
): InboundMessageFields {
  const { host, botUserId, botUserName, subject } = input;
  const text = [activity.content.summary, activity.content.description ?? '']
    .filter((part) => part.length > 0)
    .join('\n\n')
    .trim();
  const changes: BacklogChange[] = [];
  return {
    messageId: encodeMessageId({
      host,
      subject: subject.ref,
      part: 'root',
    }),
    text,
    attachments: toAttachments(subject, activity.content.attachments),
    isMention: detectMention(
      botUserName,
      botUserId,
      text,
      activity.content.assignee?.id,
      changes
    ),
    changes,
    dateSent: new Date(activity.created),
  };
}

/**
 * Types 2 and 3 (docs/specs/adapter.md §5.3 rows 2–4). A **changelog**
 * comment (a status-only change, an assignee change, a description edit, an
 * attachment add) arrives as type 2 with `content.comment.id` set and
 * `comment.content` `null` or `""`; handlers must key on `raw.changes`
 * having entries, never on "a comment is present", because a comment posted
 * together with a field change is one type-2 event with both
 * (`.claude/rules/backlog-webhook-facts.md` "Changelog comments").
 */
function buildIssueUpdatedOrCommentedFields(
  activity: IssueUpdatedOrCommentedActivity,
  input: BuildInboundMessageInput
): InboundMessageFields {
  const { host, botUserId, botUserName, subject } = input;
  const changes = normaliseChanges(activity.content.changes);
  const comment = activity.content.comment;

  const messageId =
    comment !== null && comment !== undefined
      ? encodeMessageId({
          host,
          subject: subject.ref,
          part: 'comment',
          commentId: comment.id,
        })
      : encodeMessageId({
          host,
          subject: subject.ref,
          part: 'update',
          created: activity.created,
        });

  const text = comment?.content ?? '';

  return {
    messageId,
    text,
    attachments: toAttachments(subject, activity.content.attachments),
    isMention: detectMention(botUserName, botUserId, text, undefined, changes),
    changes,
    dateSent: new Date(activity.created),
  };
}

export function buildInboundMessageFields(
  activity: IssueCreatedActivity | IssueUpdatedOrCommentedActivity,
  input: BuildInboundMessageInput
): InboundMessageFields {
  if (activity.type === 1) {
    return buildIssueCreatedFields(activity, input);
  }
  return buildIssueUpdatedOrCommentedFields(activity, input);
}

/**
 * Author mapping (docs/specs/adapter.md §5.3 "Author"). `isBot` mirrors
 * `isMe` because Backlog has no bot attribute on `createdUser`; the generic
 * `"unknown"` the `Author` type also allows would make the core's
 * `getParticipants` drop the author entirely, which is worse than a false
 * `isBot` for a human co-worker sharing the bot's account.
 */
export function buildAuthor(
  host: string,
  botUserId: number,
  createdUser: ActivityCreatedUser
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

export interface BuildMessageInput extends BuildInboundMessageInput {
  payload: BacklogWebhookPayload;
}

/**
 * A one-paragraph AST carrying `text` verbatim. `parseMessage` builds every
 * webhook message this way regardless of the project's cached formatting
 * rule (docs/plans/adapter-implementation.md P3 scope note: "parseMessage
 * uses the Markdown converter from `chat` directly in this phase; P4
 * replaces it with the rule-aware selection") — kept as its own function so
 * P4 has one call site to replace with `converterFor(rule, ...).toAst(text)`.
 */
export function plainTextAst(text: string): MessageData['formatted'] {
  return root([paragraph([textNode(text)])]);
}

/**
 * Assembles the `Message` instance for types 1–3. `raw.payload` carries the
 * envelope exactly as parsed (docs/specs/adapter.md §5.2 "not a stripped
 * copy") so a handler can read a key the schema does not name.
 * `edited: false` and `dateSent: new Date(created)` are constant for every
 * webhook message because comment edits fire no webhook at all (measured
 * 2026-09-03, `.claude/rules/backlog-webhook-facts.md`).
 */
export function buildInboundMessage(
  activity: IssueCreatedActivity | IssueUpdatedOrCommentedActivity,
  input: BuildMessageInput,
  MessageCtor: new (
    data: MessageData<BacklogRawMessage>
  ) => Message<BacklogRawMessage>
): Message<BacklogRawMessage> {
  const fields = buildInboundMessageFields(activity, input);
  const author = buildAuthor(input.host, input.botUserId, activity.createdUser);
  const raw: BacklogRawMessage = {
    kind: 'webhook',
    host: input.host,
    payload: input.payload,
    changes: fields.changes,
  };

  return new MessageCtor({
    id: fields.messageId,
    threadId: encodeThreadId({
      host: input.host,
      projectId: activity.project.id,
      subject: input.subject.ref,
    }),
    text: fields.text,
    formatted: plainTextAst(fields.text),
    raw,
    author,
    metadata: { dateSent: fields.dateSent, edited: false },
    attachments: fields.attachments,
    isMention: fields.isMention,
  });
}
