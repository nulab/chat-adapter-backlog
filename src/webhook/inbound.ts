import { root, paragraph, text as textNode } from 'chat';

import {
  encodeMessageId,
  encodeThreadId,
  mentionPattern,
  mentionUser,
} from '../ids';

import type {
  ActivityAttachment,
  ActivityChange,
  ActivityCreatedUser,
  ActivityNotification,
  IssueCreatedActivity,
  IssueUpdatedOrCommentedActivity,
  PullRequestAddedActivity,
  PullRequestUpdatedOrCommentedActivity,
} from './payload';
import type { SubjectClient } from '../subject/client';
import type {
  BacklogChange,
  BacklogRawMessage,
  BacklogWebhookPayload,
} from '../types';
import type { Attachment, Author, Message, MessageData } from 'chat';

/**
 * The activity types whose message is a subject's **root**: an issue's
 * creation (1) and a pull request's (18). Both carry `summary`,
 * `description`, `attachments[]` and — on a webhook body, not on the activity
 * form — the `assignee` the subject was opened for (docs/specs/adapter.md
 * §5.3; measured 2026-08-28 for type 1 and 2026-09-06 for type 18).
 */
type RootActivity = IssueCreatedActivity | PullRequestAddedActivity;

/**
 * The activity types whose message is a **comment** — or a field change whose
 * changelog comment Backlog left out: issues (2, 3) and pull requests
 * (19, 20).
 */
type CommentOrUpdateActivity =
  | IssueUpdatedOrCommentedActivity
  | PullRequestUpdatedOrCommentedActivity;

/** Every activity type §5.3 maps to a `Message`; type 4 is a deletion, not one. */
export type InboundActivity = RootActivity | CommentOrUpdateActivity;

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

/**
 * The `content` fields the mapping reads off an activity of either kind, as
 * the widest shape that carries them. Written structurally rather than as a
 * union of the schemas' types so a field one schema does not declare — the
 * standing `assignee` a webhook puts on issue types 2 and 3, which the issue
 * schemas do not name because nothing reads it (measured 2026-09-07) — costs
 * a `undefined` here instead of a second builder.
 */
interface OptionalContent {
  assignee?: { id: number } | null | undefined;
  attachments?: ActivityAttachment[] | undefined;
}

function assigneeIdOf(content: OptionalContent): number | undefined {
  return content.assignee?.id;
}

function toAttachments(
  subject: SubjectClient,
  content: OptionalContent
): Attachment[] {
  return (content.attachments ?? []).map((attachment) =>
    subject.webhookAttachment(attachment)
  );
}

/**
 * The files a comment's `changes[]` names, for the kind that names any there
 * (§6.6). A pull-request comment posted with `attachmentId[]` arrives as type
 * 20 with `changes: [{ field: "attachment", new_value: "<file name>" }]` and
 * **no `content.attachments` key at all** (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md` "What each pull-request
 * operation emits"), so a webhook message that read only `content.attachments`
 * would drop the file the same comment hands back through `fetchMessages`.
 * An empty `newValue` is a removal, which names a file the subject no longer
 * has.
 */
function changeAttachments(
  subject: SubjectClient,
  changes: readonly BacklogChange[]
): Attachment[] {
  const attachments: Attachment[] = [];
  for (const change of changes) {
    if (
      change.field !== 'attachment' ||
      change.newValue === null ||
      change.newValue.length === 0
    ) {
      continue;
    }
    const attachment = subject.webhookChangeAttachment(change);
    if (attachment !== undefined) {
      attachments.push(attachment);
    }
  }
  return attachments;
}

export function normaliseChanges(
  raw: ActivityChange[] | undefined
): BacklogChange[] {
  return (raw ?? []).map((change) => ({
    field: change.field,
    newValue: change.new_value === undefined ? null : String(change.new_value),
    oldValue: change.old_value === undefined ? null : String(change.old_value),
  }));
}

/**
 * The `changes[]` field name reporting a new assignee is `assigner` on an
 * issue (measured 2026-08-02) and `assignee` on a pull request (measured
 * 2026-09-06); both carry the new assignee's **display name**, not an id.
 * Neither name is used for anything else, so both are read for every activity
 * type rather than branching on which one is being mapped.
 */
const ASSIGNMENT_CHANGE_FIELDS: readonly string[] = ['assigner', 'assignee'];

/** What §5.4 decides `isMention` from. */
export interface MentionEvidence {
  botUserName: string;
  botUserId: number;
  text: string;
  /**
   * An assignee id only where it is evidence that an **assignment happened**:
   * `content.assignee` on a root activity, and nowhere else. `undefined`
   * means "this activity says nothing about an assignment", never
   * "unassigned".
   *
   * Types 2, 3, 19 and 20 all carry the same key as the **standing**
   * assignee, repeated on every delivery whether or not the assignment
   * changed (measured 2026-09-07 on both kinds), so it is not read there: a
   * multi-field `PATCH` on a bot-assigned pull request carries the bot in
   * `content.assignee` and notified nobody. An assignment on those types
   * reports itself in `changes[]` instead, which the rule below reads, so the
   * two kinds answer the same operation the same way.
   */
  assigneeId: number | undefined;
  changes: BacklogChange[];
  /** The activity's top-level `notifications[]`: who Backlog notified. */
  notifications: readonly ActivityNotification[];
  /**
   * Whether `text` was assembled from a field Backlog stores **without**
   * rewriting `<@U<id>>` into `@<display name>` — a pull request's summary,
   * and nothing else measured so far (§5.4 rule 5, measured 2026-09-06).
   */
  rawMentionNotationSurvives: boolean;
}

/**
 * Notification, textual and assignment mention detection
 * (docs/specs/adapter.md §5.4). `notifications[]` is the one rule that reads
 * what Backlog decided rather than guessing from text: `mentionPattern` only
 * proves a hand-typed `@name` is present, and the assignment checks only
 * cover the two events Backlog signals structurally. A comment whose
 * recipients were picked in the notification field carries neither — no
 * `@name` survives in `text` at all — so without this rule it reads as an
 * unaddressed comment.
 */
export function detectMention(evidence: MentionEvidence): boolean {
  const {
    botUserName,
    botUserId,
    text,
    assigneeId,
    changes,
    notifications,
    rawMentionNotationSurvives,
  } = evidence;

  // Not narrowed to `reason: 2` (Issue Commented). An assignment (reason 1)
  // is already a mention through the rules below, so a reason allowlist
  // could only ever drop a directed notification whose code this adapter has
  // not measured — the pull-request codes 12-13 and the document ones among
  // them — while adding a second place that has to be kept in step with
  // Backlog's reason table.
  if (
    notifications.some((notification) => notification.user.id === botUserId)
  ) {
    return true;
  }
  if (mentionPattern(botUserName).test(text)) {
    return true;
  }
  // Not applied to every text: everywhere but a pull request's summary the
  // server has already rewritten the notation, so a literal `<@U999>` there is
  // an unresolvable mention that notified nobody (§5.4 rule 1's negative case)
  // rather than a mention of the bot.
  if (rawMentionNotationSurvives && text.includes(mentionUser(botUserId))) {
    return true;
  }
  if (assigneeId === botUserId) {
    return true;
  }
  // A pull-request `PATCH` touching several fields at once was measured once
  // to omit the `assignee` entry while still notifying the new assignee, so
  // this rule under-reports on its own; the notification rule above is what
  // covers that case, and it is kept for a delivery whose `notifications[]`
  // is empty (every `GET /space/activities` body replayed as a webhook).
  return changes.some(
    (change) =>
      ASSIGNMENT_CHANGE_FIELDS.includes(change.field) &&
      change.newValue === botUserName
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
 * Types 1 and 18 — Issue Created and Pull Request Added (docs/specs/adapter.md
 * §5.3 rows 1 and 18). The message id is the subject's root
 * (`<host>:issue:<issueId>:r`, `<host>:pr:<repositoryId>:<number>:r`); mention
 * text is `summary + description`, so a mention placed in the summary counts.
 */
function buildRootFields(
  activity: RootActivity,
  input: BuildInboundMessageInput
): InboundMessageFields {
  const { host, botUserId, botUserName, subject } = input;
  const text = [
    activity.content.summary ?? '',
    activity.content.description ?? '',
  ]
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
    attachments: toAttachments(subject, activity.content),
    isMention: detectMention({
      botUserName,
      botUserId,
      text,
      assigneeId: assigneeIdOf(activity.content),
      changes,
      notifications: activity.notifications,
      rawMentionNotationSurvives: activity.type === 18,
    }),
    changes,
    dateSent: new Date(activity.created),
  };
}

/**
 * Types 2, 3, 19 and 20 (docs/specs/adapter.md §5.3). A **changelog** comment
 * (a status-only change, an assignee change, a description edit, an
 * attachment add, a merge, a close) arrives with `content.comment.id` set and
 * `comment.content` `null` or `""`; handlers must key on `raw.changes` having
 * entries, never on "a comment is present", because a comment posted together
 * with a field change is one event with both
 * (`.claude/rules/backlog-webhook-facts.md` "Changelog comments",
 * `.claude/rules/backlog-pull-request-facts.md` "What each pull-request
 * operation emits").
 */
function buildCommentOrUpdateFields(
  activity: CommentOrUpdateActivity,
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
    attachments: [
      ...toAttachments(subject, activity.content),
      ...changeAttachments(subject, changes),
    ],
    isMention: detectMention({
      botUserName,
      botUserId,
      text,
      assigneeId: undefined,
      changes,
      notifications: activity.notifications,
      rawMentionNotationSurvives: false,
    }),
    changes,
    dateSent: new Date(activity.created),
  };
}

export function buildInboundMessageFields(
  activity: InboundActivity,
  input: BuildInboundMessageInput
): InboundMessageFields {
  if (activity.type === 1 || activity.type === 18) {
    return buildRootFields(activity, input);
  }
  return buildCommentOrUpdateFields(activity, input);
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
 * Assembles the `Message` instance for every type §5.3 maps to a message
 * (1, 2, 3, 18, 19, 20). `raw.payload` carries the envelope exactly as
 * parsed (docs/specs/adapter.md §5.2 "not a stripped copy") so a handler can
 * read a key the schema does not name.
 * `edited: false` and `dateSent: new Date(created)` are constant for every
 * webhook message because comment edits fire no webhook at all (measured
 * 2026-09-03, `.claude/rules/backlog-webhook-facts.md`).
 */
export function buildInboundMessage(
  activity: InboundActivity,
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
