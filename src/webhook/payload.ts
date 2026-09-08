import { z } from 'zod';

import type { BacklogSubjectRef } from '../types';

/**
 * Zod schemas for the Backlog webhook body (docs/specs/adapter.md §5.2).
 * Backlog publishes no dedicated webhook-payload page; the body is one
 * Activity object as returned by
 * [Get Recent Updates](https://developer.nulab.com/docs/backlog/api/2/get-recent-updates/)
 * (measured 2026-08-28, `.claude/rules/backlog-webhook-facts.md`).
 *
 * Every schema here validates only the fields the adapter reads. `z.object`
 * strips fields it does not know about rather than rejecting the input, so a
 * real payload's extra keys (`field_text`, `type` inside `changes[]`,
 * `shared_files`, `status`, `priority`, …) pass validation without being
 * named — the tolerance §5.2 requires is zod's default behaviour, not
 * something added on top of it. `raw.payload` is built from the parsed JSON
 * directly, never from a schema's output, so those unnamed keys still reach
 * the message as received.
 */

const envelopeSchema = z.object({
  type: z.number(),
});

/** Only the envelope's `type` discriminates which schema below applies. */
export type WebhookEnvelope = z.infer<typeof envelopeSchema>;

export function parseEnvelope(value: object): WebhookEnvelope | null {
  const result = envelopeSchema.safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Every numeric field an id is built from. `z.number()` alone accepts `0`,
 * `-1` and `1.5`, which the id codec (`src/ids.ts`) then rejects — from
 * inside the dispatched factory on one activity type and synchronously on
 * another, so the same body answered 200 or threw where §5.1 step 9 says
 * 400 `Invalid payload`. Validating identity here is what makes the ladder
 * answer that, and it narrows what counts as valid without making anything
 * newly required.
 */
const identitySchema = z.number().int().positive();

/**
 * The delivery's timestamp, which is not display data: an update carrying no
 * comment id has the message id `<host>:<subject>:u:<created>` (`src/ids.ts`)
 * and every message's `metadata.dateSent` is `new Date(created)`. `created: ""`
 * therefore produced an id no `decodeMessageId` could read back and an
 * `Invalid Date` on the envelope, both behind a 200 — so a value the two
 * readers cannot use is a 400 (§5.1 step 9) instead.
 *
 * The check is "names an instant", not a grammar. `z.iso.datetime()` would
 * reject a delivery that added milliseconds or a `+09:00` offset, and Backlog
 * documents no format for this field at all — every measured value is
 * `2026-09-03T04:05:06Z` (`.claude/rules/backlog-webhook-facts.md`), which is
 * a measurement, not a promise. Both readers handle any form `Date` accepts,
 * so rejecting past that would lose real events to buy nothing.
 */
const createdSchema = z
  .string()
  .refine((value) => Number.isFinite(Date.parse(value)));

const createdUserSchema = z.object({
  id: identitySchema,
  name: z.string(),
  userId: z.string().nullable().optional(),
});

/** `createdUser` shape shared by every activity type §5.2 requires it on. */
export type ActivityCreatedUser = z.infer<typeof createdUserSchema>;

/**
 * One `changes[]` value. `.catch(null)` rather than the bare union: the value
 * system is Backlog's own and only partly measured — a status arrives as an
 * id string, an assignee as a display name
 * (`.claude/rules/backlog-webhook-facts.md`) — and a custom attribute whose
 * value serialises as something else (a checkbox, a multiple-choice list)
 * would otherwise fail the field and cost a 400, dropping the real comment
 * the same delivery carries. Nothing identifies a subject here, so "a value
 * in a shape this adapter has not measured" is read as "no value", and
 * `raw.payload` still hands the consumer what Backlog actually sent.
 */
const changeValueSchema = z
  .union([z.string(), z.number()])
  .nullable()
  .catch(null)
  .optional();

const changeSchema = z.object({
  field: z.string(),
  new_value: changeValueSchema,
  old_value: changeValueSchema,
});

/** One `content.changes[]` entry (docs/specs/adapter.md §5.2). */
export type ActivityChange = z.infer<typeof changeSchema>;

/**
 * `size` is optional because it is informational — it reaches
 * `Attachment.size` and nothing else, and the comment's own `changeLog`
 * describes an attachment without one already (`src/client/schemas.ts`).
 * Only `id` addresses the file.
 */
const attachmentSchema = z.object({
  id: z.number(),
  name: z.string(),
  size: z.number().optional(),
});

/** One `content.attachments[]` entry (docs/specs/adapter.md §5.2, §6.6). */
export type ActivityAttachment = z.infer<typeof attachmentSchema>;

const commentSchema = z
  .object({
    id: identitySchema,
    content: z.string().nullable(),
  })
  .nullable();

/**
 * One top-level `notifications[]` entry: a user this activity notified, and
 * the reason code Get Notification documents (1 assigned to the issue, 2 a
 * comment addressed to you, …).
 *
 * Only `user.id` is read — mention detection does not branch on `reason`
 * (docs/specs/adapter.md §5.4 rule 6) — but the code is named here because
 * it is the field a consumer reaching through `raw.payload` needs to tell an
 * assignment apart from a comment, and naming it documents that the array is
 * populated at all.
 */
const notificationSchema = z.object({
  reason: z.number().optional(),
  user: z.object({ id: z.number() }),
});

/** One top-level `notifications[]` entry (docs/specs/adapter.md §5.2). */
export type ActivityNotification = z.infer<typeof notificationSchema>;

/**
 * Shared by types 1–4 and 18–20: every mapped activity type carries
 * `project.id`, `createdUser` and `content.id` (docs/specs/adapter.md §5.2
 * "Required").
 * `project.projectKey` and `content.key_id` are display data, so they stay
 * optional even though every measured payload carries them.
 */
const baseActivitySchema = z.object({
  created: createdSchema,
  project: z.object({
    id: identitySchema,
    projectKey: z.string().optional(),
  }),
  createdUser: createdUserSchema,
  // `.catch([])` rather than `.optional()`: an absent array and an array in a
  // shape this adapter has not measured both mean "no notification evidence",
  // and neither is worth the 400 a failed field would cost. Nothing here is
  // identity data, so a malformed entry must not lose the message — detection
  // falls back to the textual and assignment rules.
  notifications: z.array(notificationSchema).catch([]),
});

/** Type 1 — Issue Created. `assignee` is webhook-only (§5.3 "measured 2026-08-28"). */
export const issueCreatedSchema = baseActivitySchema.extend({
  type: z.literal(1),
  content: z.object({
    id: identitySchema,
    key_id: z.number().optional(),
    summary: z.string(),
    description: z.string().nullable(),
    assignee: z
      .object({ id: z.number(), name: z.string() })
      .nullable()
      .optional(),
    attachments: z.array(attachmentSchema).optional(),
  }),
});

/** Types 2 and 3 — Issue Updated / Issue Commented share one content shape. */
export const issueUpdatedOrCommentedSchema = baseActivitySchema.extend({
  type: z.union([z.literal(2), z.literal(3)]),
  content: z.object({
    id: identitySchema,
    key_id: z.number().optional(),
    comment: commentSchema.optional(),
    changes: z.array(changeSchema).optional(),
    attachments: z.array(attachmentSchema).optional(),
  }),
});

/**
 * An id a bulk update serialises as a decimal **string** where every other
 * activity serialises the same field as a number: `content.link[].id` and
 * `content.link[].key_id` arrive as `"8001"` over the webhook and as `8001`
 * from `GET /space/activities` (measured on a development space, 2026-09-06). Both forms have to parse, so the string is converted rather
 * than the number being rejected — and `identitySchema`'s guarantee is kept
 * afterwards, because `content.link[].id` is the issue id every thread id and
 * message id below is built from.
 */
const coercedIdentitySchema = z
  .union([z.string(), z.number()])
  .transform(Number)
  .pipe(identitySchema);

/**
 * One `content.link[]` entry of a bulk update: the issue that was updated and
 * the comment the update wrote on it.
 *
 * `comment` was present on every measured entry, empty comment box included
 * (`content` `""` rather than `null`), but it is optional here for the same
 * reason it is optional on types 2 and 3 — an entry that carries no comment
 * still addresses an issue, and a message id exists for that case
 * (`part: 'update'`). Requiring it would answer 400 and drop the whole batch,
 * and Backlog's delivery is at-least-once with no way to ask for the batch
 * again.
 */
const bulkLinkSchema = z.object({
  id: coercedIdentitySchema,
  key_id: coercedIdentitySchema.optional(),
  title: z.string().optional(),
  comment: commentSchema.optional(),
});

/** One issue a type-14 bulk update touched (docs/specs/adapter.md §5.2). */
export type ActivityBulkLink = z.infer<typeof bulkLinkSchema>;

/**
 * Type 14 — Issue Multi Updated: one delivery for a bulk update made from the
 * issue list, however many issues it touched, and no type 2 or 3 per issue at
 * all (measured on a development space, 2026-09-06).
 *
 * `content.link[]` is the only place the issues appear — there is no
 * `content.id` and no per-issue snapshot — so it is the one required field
 * here. `content.comment` is the text as typed into the bulk comment box and
 * is **not** a comment object: it has no `id`, and every `link[]` entry
 * repeats the same text with the id of the comment actually written on that
 * issue. `changes[]` describes the whole batch, not any one issue.
 *
 * `individual_update` is webhook-only (the activity API omits it) and was
 * `false` on every measured delivery; it is read as data rather than
 * dispatched on, because no measurement says what a `true` delivery looks
 * like.
 */
export const issueMultiUpdatedSchema = baseActivitySchema.extend({
  type: z.literal(14),
  content: z.object({
    tx_id: z.union([z.string(), z.number()]).optional(),
    comment: z.object({ content: z.string().nullable() }).nullable().optional(),
    link: z.array(bulkLinkSchema),
    individual_update: z.boolean().optional(),
    changes: z.array(changeSchema).optional(),
  }),
});

/** Type 4 — Issue Deleted. */
export const issueDeletedSchema = baseActivitySchema.extend({
  type: z.literal(4),
  content: z.object({
    id: identitySchema,
    key_id: z.number().optional(),
  }),
});

const repositorySchema = z.object({
  id: identitySchema,
  name: z.string().optional(),
  description: z.string().nullable().optional(),
});

/** `content.repository` on types 18–20 (docs/specs/adapter.md §5.2). */
export type ActivityRepository = z.infer<typeof repositorySchema>;

const linkedIssueSchema = z
  .object({
    id: z.number(),
    key_id: z.number().optional(),
    issue_key: z.string().optional(),
    summary: z.string().optional(),
    description: z.string().nullable().optional(),
  })
  .nullable();

/**
 * `content` of a pull-request activity, shared by types 18, 19 and 20 — one
 * key set per form, measured on both forms (2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md` "What each pull-request
 * operation emits"). The **webhook** form is the activity form plus
 * `assignee`, `base`, `branch` and `diff`, on all three types alike; the two
 * forms were diffed on five activities matched by activity id, and the keys
 * they share hold equal values.
 *
 * Only the three fields that address a pull request — `id`, `number` and
 * `repository.id` — are required, so an activity-form body (a replay, a
 * future form dropping a key) still parses while one that cannot be
 * addressed is the 400 it should be. `attachments` is named although neither
 * form was measured to carry it, so a body that adds it is read rather than
 * stripped.
 */
const pullRequestContentSchema = z.object({
  id: identitySchema,
  number: identitySchema,
  repository: repositorySchema,
  summary: z.string().optional(),
  description: z.string().nullable().optional(),
  comment: commentSchema.optional(),
  changes: z.array(changeSchema).optional(),
  issue: linkedIssueSchema.optional(),
  /**
   * The subject's **current** assignee (`{ id, userId, name, roleType, lang }`
   * measured; only the two fields the adapter reads are named). Read as an
   * assignment on type 18 alone — see `src/webhook/inbound.ts`.
   */
  assignee: z
    .object({ id: z.number(), name: z.string() })
    .nullable()
    .optional(),
  /**
   * The pull request's target and source branch names, on every webhook type.
   * Nullable although no measured delivery omitted either: a body Backlog
   * widens is not worth a 400 over a key nothing reads.
   */
  base: z.string().nullable().optional(),
  branch: z.string().nullable().optional(),
  /**
   * A diff(1)-style body of the description edit that produced this activity,
   * `null` on every other delivery — measured on a type 19 that changed the
   * description, and `null` on 18, on 20 and on a 19 that did not. Backlog
   * documents the key nowhere.
   */
  diff: z.string().nullable().optional(),
  attachments: z.array(attachmentSchema).optional(),
});

/** Type 18 — Pull Request Added. */
export const pullRequestAddedSchema = baseActivitySchema.extend({
  type: z.literal(18),
  content: pullRequestContentSchema,
});

/**
 * Types 19 and 20 — Pull Request Updated / Comment Added on Pull Request.
 * They share type 18's content shape; the literals stay distinct so a caller
 * can still tell a creation from an update on the parsed activity.
 */
export const pullRequestUpdatedOrCommentedSchema = baseActivitySchema.extend({
  type: z.union([z.literal(19), z.literal(20)]),
  content: pullRequestContentSchema,
});

export type IssueCreatedActivity = z.infer<typeof issueCreatedSchema>;
export type IssueUpdatedOrCommentedActivity = z.infer<
  typeof issueUpdatedOrCommentedSchema
>;
export type IssueDeletedActivity = z.infer<typeof issueDeletedSchema>;
export type IssueMultiUpdatedActivity = z.infer<typeof issueMultiUpdatedSchema>;

/**
 * A type-14 body as it arrives, before {@link issueMultiUpdatedSchema} has
 * coerced anything — which for this type is not the same shape as
 * {@link IssueMultiUpdatedActivity}: `content.link[].id` and `key_id` are
 * decimal **strings** over the webhook and numbers from `GET
 * /space/activities` (measured on a development space, 2026-09-06), and the
 * schema's output declares only the number half.
 *
 * This is the type `raw.payload` carries, because `raw.payload` is the body
 * verbatim (docs/specs/adapter.md §5.2 "not a stripped copy"). Declaring the
 * output there would tell a consumer reading `link[].id` that it holds a
 * number when a real delivery holds `"8001"`.
 */
export type IssueMultiUpdatedBody = z.input<typeof issueMultiUpdatedSchema>;
export type PullRequestAddedActivity = z.infer<typeof pullRequestAddedSchema>;
export type PullRequestUpdatedOrCommentedActivity = z.infer<
  typeof pullRequestUpdatedOrCommentedSchema
>;

/**
 * The activity types that are about **one** subject, which is every dispatched
 * type but 14. Type 14 stays out of this union rather than being handled by
 * `subjectOfActivity` with a fallback: a bulk update is about as many issues
 * as it lists, so there is no subject to return, and leaving it out is what
 * makes the compiler reject a caller that reaches for one.
 */
export type RecognisedActivity =
  | IssueCreatedActivity
  | IssueUpdatedOrCommentedActivity
  | IssueDeletedActivity
  | PullRequestAddedActivity
  | PullRequestUpdatedOrCommentedActivity;

/** Everything {@link parseActivity} can return: one subject, or a bulk update. */
export type ParsedActivity = RecognisedActivity | IssueMultiUpdatedActivity;

/**
 * Which issue or pull request an activity is about. This is the single place
 * that knows which `content` fields identify a subject: for types 1-4 that is
 * `content.id`, the issue's space-wide numeric id
 * (`.claude/rules/backlog-webhook-facts.md`); for types 18-20 it is
 * `content.repository.id` and `content.number`, because a pull request's own
 * space-wide `content.id` addresses no endpoint at all — `GET
 * …/pullRequests/<global id>` is a 404 (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md` "Addressing"). `content.issue`
 * is never consulted: a pull request linked to an issue is still its own
 * thread, and the link can be repointed (docs/specs/adapter.md §5.3, D-PR6).
 *
 * This maps an activity type to a ref, which is the opposite direction from
 * `subjectClientFor`'s dispatch on a ref's kind, so it does not belong on
 * `SubjectClient`.
 */
export function subjectOfActivity(
  payload: RecognisedActivity
): BacklogSubjectRef {
  if (payload.type === 18 || payload.type === 19 || payload.type === 20) {
    return {
      kind: 'pullRequest',
      repositoryId: payload.content.repository.id,
      number: payload.content.number,
    };
  }
  return { kind: 'issue', issueId: payload.content.id };
}

/**
 * The repository name an activity carries for free, if it carries one.
 *
 * Every measured pull-request activity has `content.repository.name`, while
 * the REST pull-request object has no repository name anywhere — and the web
 * URL §7.3 builds needs one (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md` "Addressing"). Reading it
 * here keeps the caller from having to know which activity types carry a
 * repository; `undefined` means "this activity says nothing about a
 * repository name", never "the repository has none".
 */
export function repositoryNameOf(
  payload: RecognisedActivity
): { repositoryId: number; name: string } | undefined {
  if (payload.type !== 18 && payload.type !== 19 && payload.type !== 20) {
    return undefined;
  }
  const { id, name } = payload.content.repository;
  return name === undefined ? undefined : { repositoryId: id, name };
}

/**
 * The activity types the adapter dispatches (docs/specs/adapter.md §5.1
 * step 8); every other type — including the documented 12, 13 and 17 — is
 * 200 Ignored before a type-specific schema ever runs.
 *
 * 14 is here even though one delivery becomes N messages (D22). The
 * alternative, ignoring it, loses events that exist: a bulk update writes a
 * real comment on every issue it touches, `content.link[].comment.id` is that
 * comment's id, and `fetchMessages` hands the same comment back — so the
 * push view and the read view would disagree, silently, in the direction of
 * having missed a status change. A deployment that cannot absorb the fan-out
 * leaves 14 out of `activityTypeIds[]`, which is a better switch than an
 * adapter option because it stops the delivery instead of discarding it
 * (D-PR4).
 *
 * 21 is deliberately absent (D-PR5). It was never observed: merging (from the
 * UI or by pushing the merge to the base branch) and closing both arrive as
 * type 19 status changes, no operation deleting a pull request exists in the
 * UI or the API, and the whole activity history of the measured project holds
 * no type 21 (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md`). The Get Activity page calls
 * it "Pull Request Deleted" while `backlog-js` 0.20.1 calls it
 * `PullRequestMerged`; the two disagree, which is reason enough not to guess
 * what a delivery would mean. Capture a payload before dispatching it.
 */
export const DISPATCHED_ACTIVITY_TYPES = [1, 2, 3, 4, 14, 18, 19, 20] as const;

/**
 * Validates the body against the schema for its `type`. Returns `null` on
 * schema failure with the zod issue paths (never values, per §5.1 step 9)
 * so a caller can log without risking a value that might carry user text.
 */
export function parseActivity(
  type: number,
  value: object
): { activity: ParsedActivity } | { issuePaths: string[] } {
  // Each branch parses rather than returning its schema: the schemas have
  // different output types, and a union of them has no callable `safeParse`.
  const result =
    type === 1
      ? issueCreatedSchema.safeParse(value)
      : type === 2 || type === 3
        ? issueUpdatedOrCommentedSchema.safeParse(value)
        : type === 4
          ? issueDeletedSchema.safeParse(value)
          : type === 14
            ? issueMultiUpdatedSchema.safeParse(value)
            : type === 18
              ? pullRequestAddedSchema.safeParse(value)
              : type === 19 || type === 20
                ? pullRequestUpdatedOrCommentedSchema.safeParse(value)
                : null;

  if (result === null) {
    // Unreachable when called after the §5.1 step 8 gate, which already
    // narrows `type` to DISPATCHED_ACTIVITY_TYPES; kept as a schema-selection
    // failure rather than a cast so a future caller that skips the gate fails
    // safely.
    return { issuePaths: ['type'] };
  }

  if (result.success) {
    return { activity: result.data };
  }
  return {
    issuePaths: result.error.issues.map((issue) => issue.path.join('.')),
  };
}
