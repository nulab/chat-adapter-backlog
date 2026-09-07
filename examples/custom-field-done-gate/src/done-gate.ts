import { mentionUser } from '@nulab/chat-adapter-backlog';
import { z } from 'zod';

const change = z.object({
  field: z.string(),
  newValue: z.string().nullable(),
});

/**
 * The two kinds of delivery that can carry a status change, parsed out of
 * `message.raw` — which reaches a handler as `unknown`, so it is parsed rather
 * than asserted.
 *
 * A bulk update names its issue on the message: one delivery covers every
 * issue in the batch, and the adapter fans it out into a message per issue.
 * A plain webhook is narrowed to type 2 because the union also holds
 * pull-request activity, whose `content.id` is a pull request id and whose
 * status ids come from a different, three-value system.
 */
const closingDelivery = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('bulkUpdate'),
    issueId: z.number().int().positive(),
    changes: z.array(change),
  }),
  z.object({
    kind: z.literal('webhook'),
    payload: z.object({
      type: z.literal(2),
      content: z.object({ id: z.number().int().positive() }),
    }),
    changes: z.array(change),
  }),
]);

/**
 * The issue this delivery moved into the done status, or `null` for every
 * other delivery.
 *
 * The comparison is against a status **id**, which is what a webhook writes
 * into `newValue` for `status` — unlike most fields, which carry a display
 * name. That is also why only these two webhook-sourced kinds are considered:
 * the REST `changeLog` a `comment` message carries writes the status's
 * display name into the same field, so it would match nothing in the ordinary
 * case and match the wrong thing in a project that named a status "4".
 */
export function closedIssueId(
  raw: unknown,
  doneStatusId: number
): number | null {
  const parsed = closingDelivery.safeParse(raw);
  if (!parsed.success) {
    return null;
  }

  const delivery = parsed.data;
  const closed = delivery.changes.some(
    (entry) =>
      entry.field === 'status' && entry.newValue === String(doneStatusId)
  );
  if (!closed) {
    return null;
  }

  return delivery.kind === 'bulkUpdate'
    ? delivery.issueId
    : delivery.payload.content.id;
}

/** A custom field as Get Issue serialises it, in the shape this bot reads. */
export interface CustomField {
  id: number;
  name: string;
  value: unknown;
}

/** Whether the field is filled, blank, or not on the issue at all. */
export type RequiredFieldState =
  | { state: 'absent' }
  | { state: 'empty'; name: string }
  | { state: 'filled'; name: string };

/**
 * `absent` is a configuration error, not a blank field: the id names a custom
 * field of another project, or none at all. It is reported separately so the
 * bot can say so instead of accusing everybody of leaving a field empty.
 */
export function requiredFieldState(
  customFields: readonly CustomField[],
  fieldId: number
): RequiredFieldState {
  const field = customFields.find((candidate) => candidate.id === fieldId);
  if (field === undefined) {
    return { state: 'absent' };
  }
  return isBlank(field.value)
    ? { state: 'empty', name: field.name }
    : { state: 'filled', name: field.name };
}

/**
 * Blankness is decided per shape rather than by falsiness: a number field
 * holding `0` and a text field holding `"0"` are filled in, and both are
 * falsy.
 */
function isBlank(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim() === '';
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  // A selection Backlog has no value for still arrives as an object; it is the
  // absent `id` that distinguishes it from a chosen item.
  if (typeof value === 'object') {
    return !('id' in value);
  }
  return false;
}

/** What the bot says when it hands the issue back. */
export function handBackComment(
  closedByUserId: number,
  fieldName: string
): string {
  return `${mentionUser(closedByUserId)} ${fieldName} is still empty. Please fill it in before closing.`;
}

/**
 * Whether the bot has already said this on the issue.
 *
 * Deduplication by `message.id` lives in state that expires after ten minutes
 * and Backlog delivery is at-least-once, so the issue's own recent comments
 * are the durable record of whether the bot has spoken. Matching on the
 * sentence rather than on an id keeps a redelivery from posting a second copy
 * without the bot having to store anything.
 */
export function alreadyHandedBack(
  recent: readonly { text: string; author: { isMe: boolean } }[],
  comment: string
): boolean {
  return recent.some(
    (message) => message.author.isMe && message.text.trim() === comment
  );
}
