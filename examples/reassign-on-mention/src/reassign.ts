import { mentionUser } from '@nulab/chat-adapter-backlog';
import { z } from 'zod';

/** A person this bot could hand the issue to: the two fields it needs of one. */
const notifiedUser = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
});

export type NotifiedUser = z.infer<typeof notifiedUser>;

/**
 * What this bot reads out of `message.raw`.
 *
 * `raw` reaches a handler as `unknown`, so it is parsed rather than asserted —
 * and parsing is what makes `notifications[].user.name` reachable at all: the
 * payload is the body Backlog sent with its unknown keys intact, and the name
 * is there at run time even though the adapter's own schema names only
 * `user.id`.
 *
 * Every branch falls back instead of throwing, because a delivery this cannot
 * read is a mention that deserves "give me some candidates" rather than a
 * failed webhook.
 */
const deliverySchema = z
  .object({
    payload: z.object({
      // An unreadable entry is dropped on its own rather than taking the array
      // down with it: the other people named are still candidates.
      notifications: z
        .array(z.object({ user: notifiedUser }).nullable().catch(null))
        .catch([]),
      // The assignee at the moment the delivery was sent. Present on every
      // issue delivery, types 2 and 3 included, even though only the type-1
      // schema names it (measured on a development space, 2026-09-06) — so
      // reading it here costs nothing where a GET /issues/:id would cost a
      // request to answer what the body already answered.
      content: z
        .object({ assignee: notifiedUser.nullable() })
        .catch({ assignee: null }),
    }),
  })
  .catch({ payload: { notifications: [], content: { assignee: null } } });

export interface Delivery {
  /** Everyone the activity notified, in delivery order, deduplicated by id. */
  notified: NotifiedUser[];
  currentAssigneeId: number | null;
}

export function readDelivery(raw: unknown): Delivery {
  const { payload } = deliverySchema.parse(raw);
  const byId = new Map<number, NotifiedUser>();
  for (const entry of payload.notifications) {
    if (entry !== null && !byId.has(entry.user.id)) {
      byId.set(entry.user.id, entry.user);
    }
  }
  return {
    notified: [...byId.values()],
    currentAssigneeId: payload.content.assignee?.id ?? null,
  };
}

export type Reassignment =
  | { kind: 'reassign'; to: NotifiedUser; candidateCount: number }
  | { kind: 'noCandidates' };

/**
 * Picks who gets the issue: everyone the delivery notified except the bot, and
 * except the current assignee — that one only while somebody else is left, so
 * that mentioning the bot on an issue already yours hands it back to you
 * rather than reporting nobody.
 */
export function chooseAssignee(
  delivery: Delivery,
  botUserId: number
): Reassignment {
  const others = delivery.notified.filter((user) => user.id !== botUserId);
  const withoutAssignee = others.filter(
    (user) => user.id !== delivery.currentAssigneeId
  );
  const candidates = withoutAssignee.length > 0 ? withoutAssignee : others;

  const to = candidates[Math.floor(Math.random() * candidates.length)];
  return to === undefined
    ? { kind: 'noCandidates' }
    : { kind: 'reassign', to, candidateCount: candidates.length };
}

/**
 * `mentionUser` builds Backlog's `<@U<id>>` notation, which notifies the user
 * on its own — no `notifiedUserId` needed — and survives both outbound
 * converters unchanged, so a plain string is all `thread.post` needs.
 */
export function reassignmentComment(decision: Reassignment): string {
  if (decision.kind === 'noCandidates') {
    return NO_CANDIDATES_COMMENT;
  }
  const people =
    decision.candidateCount === 1
      ? '1 person'
      : `${decision.candidateCount} people`;
  return `Assigned to ${mentionUser(decision.to.id)} (picked from ${people} you notified).`;
}

export const NO_CANDIDATES_COMMENT =
  'I need somebody to hand this to. Mention me together with the people to ' +
  'choose from — pick them in the notification field, or write @Name in the ' +
  'comment — and I will assign this issue to one of them at random.';

/**
 * A pull request's assignee is set through a different endpoint than an
 * issue's, so this example declines rather than guessing (see Limits in the
 * README).
 */
export const PULL_REQUEST_COMMENT =
  'I only reassign issues — a pull request needs a different Backlog ' +
  'endpoint, which this example does not call.';
