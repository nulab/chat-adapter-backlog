import { z } from 'zod';

import type { BacklogSubjectRef, BacklogWebhookPayload } from '../types';

const userSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  userId: z.string().nullish(),
});

// A value in a shape nobody has measured (a checkbox custom attribute, say)
// reads as "no value" rather than costing the comment the delivery carries.
const changeValueSchema = z
  .union([z.string(), z.number()])
  .nullish()
  .catch(null)
  .transform((value) =>
    value === null || value === undefined ? null : String(value)
  );

const changesSchema = z
  .array(
    z.looseObject({
      field: z.string(),
      new_value: changeValueSchema,
      old_value: changeValueSchema,
    })
  )
  .default([]);

const attachmentsSchema = z
  .array(
    z.looseObject({
      id: z.number(),
      name: z.string(),
      size: z.number().optional(),
    })
  )
  .default([]);

// A changelog comment's text is `null` over the webhook and `""` over REST
// (measured); both read as `""`.
const commentSchema = z
  .looseObject({
    id: z.number(),
    content: z
      .string()
      .nullable()
      .transform((content) => content ?? ''),
  })
  .nullish()
  .transform((comment) => comment ?? null);

const assigneeSchema = z
  .looseObject({ id: z.number(), name: z.string() })
  .nullish()
  .transform((assignee) => assignee ?? null);

const envelope = {
  created: z.string(),
  project: z.looseObject({ id: z.number() }),
  createdUser: userSchema,
  // Absent on a body replayed from `GET /space/activities` (measured).
  notifications: z
    .array(z.looseObject({ user: z.looseObject({ id: z.number() }) }))
    .catch([]),
};

const activitySchema = z.discriminatedUnion('type', [
  z.looseObject({
    ...envelope,
    type: z.literal(1),
    content: z.looseObject({
      id: z.number(),
      summary: z.string(),
      description: z.string().nullable(),
      assignee: assigneeSchema,
      attachments: attachmentsSchema,
    }),
  }),
  z.looseObject({
    ...envelope,
    type: z.literal([2, 3]),
    content: z.looseObject({
      id: z.number(),
      comment: commentSchema,
      changes: changesSchema,
      attachments: attachmentsSchema,
    }),
  }),
  z.looseObject({
    ...envelope,
    type: z.literal(4),
    content: z.looseObject({ id: z.number() }),
  }),
  z.looseObject({
    ...envelope,
    type: z.literal(14),
    content: z.looseObject({
      link: z.array(
        z.looseObject({
          // A decimal string over the webhook, a number from the activity API
          // (measured).
          id: z.coerce.number(),
          comment: commentSchema,
        })
      ),
      changes: changesSchema,
    }),
  }),
  z.looseObject({
    ...envelope,
    type: z.literal([18, 19, 20]),
    content: z.looseObject({
      number: z.number(),
      repository: z.looseObject({
        id: z.number(),
        name: z.string().optional(),
      }),
      summary: z.string().optional(),
      description: z.string().nullish(),
      comment: commentSchema,
      changes: changesSchema,
      assignee: assigneeSchema,
      attachments: attachmentsSchema,
    }),
  }),
]);

export type WebhookActivity = z.output<typeof activitySchema>;

const dispatchedTypes: ReadonlySet<number> = new Set(
  activitySchema.options.flatMap((option) => [...option.shape.type.values])
);

const envelopeSchema = z.object({ type: z.number() });

export type ParsedDelivery =
  | { ok: true; activity: WebhookActivity }
  | { ok: true; ignoredType: number }
  | { ok: false; issuePaths: string[] };

/**
 * A type the adapter does not dispatch is ignored before its body is looked
 * at, so a delivery of an unmeasured type is never a 400.
 */
export function parseDelivery(body: unknown): ParsedDelivery {
  const envelopeResult = envelopeSchema.safeParse(body);
  if (!envelopeResult.success) {
    return { ok: false, issuePaths: issuePathsOf(envelopeResult.error) };
  }
  if (!dispatchedTypes.has(envelopeResult.data.type)) {
    return { ok: true, ignoredType: envelopeResult.data.type };
  }
  const result = activitySchema.safeParse(body);
  return result.success
    ? { ok: true, activity: result.data }
    : { ok: false, issuePaths: issuePathsOf(result.error) };
}

function issuePathsOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => issue.path.join('.'));
}

/**
 * The keys the schema names are validated; the rest are typed from
 * `backlog-js` and carried as Backlog sent them, which is as far as the
 * published type can promise.
 */
export function payloadOf(activity: WebhookActivity): BacklogWebhookPayload {
  return activity as unknown as BacklogWebhookPayload;
}

/**
 * `raw.payload` is built from `parseDelivery`'s output and nothing else, and
 * that output survives the core's JSON round trip unchanged, so it is not
 * parsed a second time.
 */
export function activityOf(payload: BacklogWebhookPayload): WebhookActivity {
  return payload as unknown as WebhookActivity;
}

export type SubjectActivity = Exclude<WebhookActivity, { type: 14 }>;

/**
 * A pull request is addressed by repository and number: its space-wide
 * `content.id` addresses no endpoint (measured).
 */
export function subjectOfActivity(
  activity: SubjectActivity
): BacklogSubjectRef {
  switch (activity.type) {
    case 18:
    case 19:
    case 20:
      return {
        kind: 'pullRequest',
        repositoryId: activity.content.repository.id,
        number: activity.content.number,
      };
    default:
      return { kind: 'issue', issueId: activity.content.id };
  }
}

/**
 * The REST pull-request object carries no repository name, and a pull
 * request's web URL needs one; every pull-request delivery carries it
 * (measured).
 */
export function repositoryNameOf(
  activity: SubjectActivity
): { repositoryId: number; name: string } | undefined {
  switch (activity.type) {
    case 18:
    case 19:
    case 20: {
      const { id, name } = activity.content.repository;
      return name === undefined ? undefined : { repositoryId: id, name };
    }
    default:
      return undefined;
  }
}
