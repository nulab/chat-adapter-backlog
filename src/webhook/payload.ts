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

const createdUserSchema = z.object({
  id: z.number(),
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
    id: z.number(),
    content: z.string().nullable(),
  })
  .nullable();

/**
 * Shared by types 1–4: every mapped activity type carries `project.id`,
 * `createdUser` and `content.id` (docs/specs/adapter.md §5.2 "Required").
 * `project.projectKey` and `content.key_id` are display data, so they stay
 * optional even though every measured payload carries them.
 */
const baseActivitySchema = z.object({
  created: z.string(),
  project: z.object({
    id: z.number(),
    projectKey: z.string().optional(),
  }),
  createdUser: createdUserSchema,
});

/** Type 1 — Issue Created. `assignee` is webhook-only (§5.3 "measured 2026-08-28"). */
export const issueCreatedSchema = baseActivitySchema.extend({
  type: z.literal(1),
  content: z.object({
    id: z.number(),
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
    id: z.number(),
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
    id: z.number(),
    key_id: z.number().optional(),
  }),
});

export type IssueCreatedActivity = z.infer<typeof issueCreatedSchema>;
export type IssueUpdatedOrCommentedActivity = z.infer<
  typeof issueUpdatedOrCommentedSchema
>;
export type IssueDeletedActivity = z.infer<typeof issueDeletedSchema>;

export type RecognisedActivity =
  | IssueCreatedActivity
  | IssueUpdatedOrCommentedActivity
  | IssueDeletedActivity;

/**
 * Which issue or pull request an activity is about. This is the single place
 * that knows which `content` fields identify a subject: for types 1-4 that is
 * `content.id`, the issue's space-wide numeric id
 * (`.claude/rules/backlog-webhook-facts.md`). Types 18-20 join it in P3, where
 * `content.repository.id` and `content.number` identify the pull request while
 * `content.id` — its space-wide id — addresses no endpoint at all
 * (`.claude/rules/backlog-pull-request-facts.md`, docs/specs/adapter.md §5.3).
 *
 * This maps an activity type to a ref, which is the opposite direction from
 * `subjectClientFor`'s dispatch on a ref's kind, so it does not belong on
 * `SubjectClient`.
 */
export function subjectOfActivity(
  payload: RecognisedActivity
): BacklogSubjectRef {
  return { kind: 'issue', issueId: payload.content.id };
}

/**
 * The four activity types the adapter dispatches (docs/specs/adapter.md
 * §5.1 step 8); every other type — including the documented 14 and 17 — is
 * 200 Ignored before a type-specific schema ever runs.
 */
export const DISPATCHED_ACTIVITY_TYPES = [1, 2, 3, 4] as const;

/**
 * Validates the body against the schema for its `type`. Returns `null` on
 * schema failure with the zod issue paths (never values, per §5.1 step 9)
 * so a caller can log without risking a value that might carry user text.
 */
export function parseActivity(
  type: number,
  value: object
): { activity: RecognisedActivity } | { issuePaths: string[] } {
  const schema =
    type === 1
      ? issueCreatedSchema
      : type === 2 || type === 3
        ? issueUpdatedOrCommentedSchema
        : type === 4
          ? issueDeletedSchema
          : null;

  if (schema === null) {
    // Unreachable when called after the §5.1 step 8 gate, which already
    // narrows `type` to {1,2,3,4}; kept as a schema-selection failure rather
    // than a cast so a future caller that skips the gate fails safely.
    return { issuePaths: ['type'] };
  }

  const result = schema.safeParse(value);
  if (result.success) {
    return { activity: result.data };
  }
  return {
    issuePaths: result.error.issues.map((issue) => issue.path.join('.')),
  };
}
