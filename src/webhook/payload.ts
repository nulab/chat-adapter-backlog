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
 * `notifications`, `shared_files`, `status`, `priority`, …) pass validation
 * without being named — the tolerance §5.2 requires is zod's default
 * behaviour, not something added on top of it. `raw.payload` is built from
 * the parsed JSON directly, never from a schema's output, so those unnamed
 * keys still reach the message as received.
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

const createdUserSchema = z.object({
  id: identitySchema,
  name: z.string(),
  userId: z.string().nullable().optional(),
});

/** `createdUser` shape shared by every activity type §5.2 requires it on. */
export type ActivityCreatedUser = z.infer<typeof createdUserSchema>;

const changeSchema = z.object({
  field: z.string(),
  new_value: z.union([z.string(), z.number()]).nullable().optional(),
  old_value: z.union([z.string(), z.number()]).nullable().optional(),
});

/** One `content.changes[]` entry (docs/specs/adapter.md §5.2). */
export type ActivityChange = z.infer<typeof changeSchema>;

const attachmentSchema = z.object({
  id: z.number(),
  name: z.string(),
  size: z.number(),
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
 * Shared by types 1–4 and 18–20: every mapped activity type carries
 * `project.id`, `createdUser` and `content.id` (docs/specs/adapter.md §5.2
 * "Required").
 * `project.projectKey` and `content.key_id` are display data, so they stay
 * optional even though every measured payload carries them.
 */
const baseActivitySchema = z.object({
  created: z.string(),
  project: z.object({
    id: identitySchema,
    projectKey: z.string().optional(),
  }),
  createdUser: createdUserSchema,
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
 * `content` of a pull-request activity, shared by types 18, 19 and 20 —
 * one key set, measured on 17 activities of all three types (2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md` "What each pull-request
 * operation emits").
 *
 * That measurement is of the **activity API** form; the webhook form of
 * 18–20 is UNMEASURED (the same rules file, "Unmeasured"). Only the three
 * fields that address a pull request — `id`, `number` and `repository.id` —
 * are therefore required: a webhook body carrying more than the activity
 * form still parses, while one that cannot be addressed is the 400 it should
 * be. `assignee` and `attachments` are named although the activity form
 * carries neither, so a webhook that adds them (as the type-1 webhook adds
 * `assignee`) is read rather than stripped.
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
  assignee: z
    .object({ id: z.number(), name: z.string() })
    .nullable()
    .optional(),
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
export type PullRequestAddedActivity = z.infer<typeof pullRequestAddedSchema>;
export type PullRequestUpdatedOrCommentedActivity = z.infer<
  typeof pullRequestUpdatedOrCommentedSchema
>;

export type RecognisedActivity =
  | IssueCreatedActivity
  | IssueUpdatedOrCommentedActivity
  | IssueDeletedActivity
  | PullRequestAddedActivity
  | PullRequestUpdatedOrCommentedActivity;

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
 * step 8); every other type — including the documented 12, 13, 14 and 17 —
 * is 200 Ignored before a type-specific schema ever runs.
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
export const DISPATCHED_ACTIVITY_TYPES = [1, 2, 3, 4, 18, 19, 20] as const;

/**
 * Validates the body against the schema for its `type`. Returns `null` on
 * schema failure with the zod issue paths (never values, per §5.1 step 9)
 * so a caller can log without risking a value that might carry user text.
 */
export function parseActivity(
  type: number,
  value: object
): { activity: RecognisedActivity } | { issuePaths: string[] } {
  // Each branch parses rather than returning its schema: the schemas have
  // different output types, and a union of them has no callable `safeParse`.
  const result =
    type === 1
      ? issueCreatedSchema.safeParse(value)
      : type === 2 || type === 3
        ? issueUpdatedOrCommentedSchema.safeParse(value)
        : type === 4
          ? issueDeletedSchema.safeParse(value)
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
