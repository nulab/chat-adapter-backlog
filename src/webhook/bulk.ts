import { encodeMessageId, encodeThreadId } from '../ids';

import {
  buildAuthor,
  detectMention,
  normaliseChanges,
  plainTextAst,
} from './inbound';

import { issueMultiUpdatedSchema } from './payload';

import type { ActivityBulkLink, IssueMultiUpdatedActivity } from './payload';
import type {
  BacklogBulkUpdatePayload,
  BacklogChange,
  BacklogRawMessage,
  BacklogSubjectRef,
} from '../types';
import type { Message, MessageData } from 'chat';

/**
 * Type 14 — Issue Multi Updated, expanded into the per-issue messages it
 * stands for (docs/specs/adapter.md §5.3, D22).
 *
 * A bulk update from the issue list arrives as **one** delivery whatever it
 * touched, and Backlog emits no type 2 or 3 for the issues in it (measured on
 * a development space, 2026-09-06). The comments, however, are real: every
 * `content.link[]` entry names an issue and the id of a comment that now
 * exists on it, changelog and all, and `fetchMessages` returns that comment
 * like any other. So this file is not synthesising events — it is unpacking
 * events Backlog batched.
 *
 * Nothing here dispatches on a subject kind: a bulk update is an issue-list
 * operation and `link[]` holds issues only (there is no bulk update of pull
 * requests in the UI or the API), so the subject is built literally rather
 * than through the subject layer (D-PR2 allows this file no `.kind` dispatch,
 * and it makes none).
 */

/** One issue a bulk update touched, as the ids a message is built from. */
export interface BulkUpdateTarget {
  issueId: number;
  /**
   * The comment the bulk update wrote on this issue, when the delivery names
   * one. Read from `content.link[].comment.id` and **not** from
   * `content.comment`, which is the text typed into the bulk comment box and
   * carries no `id` at all — one batch writes one comment per issue, so there
   * is no single id for the batch to carry.
   */
  commentId: number | undefined;
  text: string;
}

function targetOf(link: ActivityBulkLink): BulkUpdateTarget {
  const comment = link.comment;
  return {
    issueId: link.id,
    commentId: comment?.id,
    text: comment?.content ?? '',
  };
}

/**
 * The issues one bulk update produced a message for, in delivery order.
 *
 * No cap and no deduplication: `content.link[]` is what Backlog says the
 * transaction covered, and an adapter that silently truncated it would put a
 * handler back in the position this whole change exists to fix. Handlers are
 * already required to be idempotent on the message id, which is what a
 * redelivered batch collides on.
 */
export function bulkUpdateTargets(
  activity: IssueMultiUpdatedActivity
): BulkUpdateTarget[] {
  return activity.content.link.map(targetOf);
}

export interface BuildBulkUpdateMessageInput {
  host: string;
  botUserId: number;
  botUserName: string;
  /**
   * The delivery exactly as Backlog sent it, which is what reaches
   * `raw.payload` (docs/specs/adapter.md §5.2 "not a stripped copy"). It is
   * a separate argument from the validated `activity` because the two are
   * different objects: zod strips the keys no schema names, and every other
   * `raw` variant carries the unstripped one.
   */
  payload: BacklogBulkUpdatePayload;
}

/**
 * Re-validates a `raw.payload` that arrived as a `bulkUpdate`, returning the
 * view the mapping reads.
 *
 * `raw.payload` is the body as received and its declared type is reached by a
 * cast, so no activity type may be read through it — `parseMessage` parses
 * every kind again for that reason. What is peculiar to this one is only how
 * loudly it fails: `content.link[].id` is a decimal string over the webhook
 * (measured 2026-09-06), so reading it through the cast would hand a string
 * to a codec that requires a number and build
 * `backlog:<host>:<projectId>:issue:8001` out of luck rather than out of a
 * checked value. `parseMessage(raw)` parses again to make those ids ids; the
 * webhook dispatcher instead closes each factory over the activity and target
 * already validated by the §5.1 step 9 gate, so ingress does not repeat this
 * pass for every issue in the batch.
 */
export function parseBulkUpdatePayload(
  payload: BacklogBulkUpdatePayload
): IssueMultiUpdatedActivity | null {
  const result = issueMultiUpdatedSchema.safeParse(payload);
  return result.success ? result.data : null;
}

/**
 * The message id of one issue in a batch: the comment the batch wrote on it,
 * falling back to the `part: 'update'` form types 2 and 19 use when a
 * delivery names no comment. `created` is the batch's, so every issue in a
 * commentless batch gets a distinct id anyway — the issue id is already in
 * the subject half of the message id.
 *
 * Exported because the dispatcher logs the id of a message whose construction
 * failed, and a log line naming a different id than the message would have
 * carried is worse than no log line.
 */
export function bulkMessageId(
  host: string,
  subject: BacklogSubjectRef,
  target: BulkUpdateTarget,
  created: string
): string {
  return target.commentId === undefined
    ? encodeMessageId({ host, subject, part: 'update', created })
    : encodeMessageId({
        host,
        subject,
        part: 'comment',
        commentId: target.commentId,
      });
}

/**
 * One issue of a batch as a `Message`.
 *
 * `changes` is the batch's `content.changes[]` copied onto every message: the
 * payload describes the transaction, not any one issue, and every issue in it
 * did receive every change. Their value system is the webhook's, so a
 * `status` entry is a status **id** written as a string (`"4"`) while an
 * `assigner` entry is a display name — the asymmetry §3.5 already documents
 * for types 2 and 3, unchanged here because these are the same
 * `content.changes[]` entries.
 *
 * `attachments` is always empty: a bulk update has no attachment field, and
 * the comment it writes carries none (measured 2026-09-06). Nothing is
 * fetched to find out, so this needs no `SubjectClient` — which is also why
 * the caller does not have to build one per issue in the batch.
 *
 * The delivery's `notifications[]` reaches §5.4 rule 6 whole, on every message
 * the batch produced, and is **not** divided between them. A batch that
 * changed the assignee carries one reason-1 entry per issue (measured
 * 2026-09-06), so the array looks like it pairs with `link[]` positionally —
 * but an entry holds only `id`, `alreadyRead`, `reason`,
 * `resourceAlreadyRead` and `user`, names no issue, and repeats the same user
 * unchanged, so a pairing would be an ordering assumption Backlog documents
 * nowhere and a redelivery could break silently. Passing it whole is what
 * that costs: a batch that assigned the bot one of its issues marks every
 * message of the batch a mention. Over-reporting the mention is the safe half
 * of that trade — the bot really was notified by this delivery — and the
 * array also stays reachable on every message through `raw.payload`, where it
 * means what it is: something about the batch (docs/specs/adapter.md §5.3,
 * §5.4 rule 6, D22).
 */
export function buildBulkUpdateMessage(
  activity: IssueMultiUpdatedActivity,
  target: BulkUpdateTarget,
  input: BuildBulkUpdateMessageInput,
  MessageCtor: new (
    data: MessageData<BacklogRawMessage>
  ) => Message<BacklogRawMessage>
): Message<BacklogRawMessage> {
  const { host, botUserId, botUserName, payload } = input;
  const subject: BacklogSubjectRef = {
    kind: 'issue',
    issueId: target.issueId,
  };
  const changes: BacklogChange[] = normaliseChanges(activity.content.changes);
  const raw: BacklogRawMessage = {
    kind: 'bulkUpdate',
    host,
    payload,
    issueId: target.issueId,
    changes,
  };

  return new MessageCtor({
    id: bulkMessageId(host, subject, target, activity.created),
    threadId: encodeThreadId({
      host,
      projectId: activity.project.id,
      subject,
    }),
    text: target.text,
    formatted: plainTextAst(target.text),
    raw,
    author: buildAuthor(host, botUserId, activity.createdUser),
    metadata: { dateSent: new Date(activity.created), edited: false },
    attachments: [],
    isMention: detectMention({
      botUserName,
      botUserId,
      text: target.text,
      assigneeId: undefined,
      changes,
      notifications: activity.notifications,
      rawMentionNotationSurvives: false,
    }),
  });
}
