import { z } from 'zod';

/**
 * Response validation schemas, kept out of `port.ts` so no zod type ever
 * appears in the port's public surface (docs/specs/adapter.md §8.1): a
 * caller of `BacklogApi` should never need to know this module, let alone
 * zod, exists. `backlog-js`'s own typings diverge from the live API (§8.1),
 * so every response is validated here rather than trusted as-typed.
 */

const userSchema = z.object({
  id: z.number(),
  userId: z.string().nullable().default(null),
  name: z.string(),
  mailAddress: z.string().nullable().default(null),
});

const starSchema = z.object({
  id: z.number(),
  comment: z.string().nullable().default(null),
  url: z.string(),
  title: z.string(),
  presenter: userSchema,
  created: z.coerce.date(),
});

const attachmentInfoSchema = z.object({
  id: z.number(),
  name: z.string(),
  size: z.number(),
});

const changeLogEntrySchema = z.object({
  field: z.string(),
  newValue: z.string().nullable().default(null),
  oldValue: z.string().nullable().default(null),
  attachmentInfo: attachmentInfoSchema.nullable().default(null),
});

export const commentSchema = z.object({
  id: z.number(),
  issueId: z.number(),
  content: z.string().nullable().default(null),
  changeLog: z
    .array(changeLogEntrySchema)
    .nullable()
    .default([])
    .transform((value) => value ?? []),
  createdUser: userSchema,
  created: z.coerce.date(),
  updated: z.coerce.date(),
  stars: z
    .array(starSchema)
    .nullable()
    .default([])
    .transform((value) => value ?? []),
});

const namedRefSchema = z.object({ id: z.number(), name: z.string() });

export const issueSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  issueKey: z.string(),
  summary: z.string(),
  description: z
    .string()
    .nullable()
    .default('')
    .transform((value) => value ?? ''),
  issueType: namedRefSchema,
  priority: namedRefSchema,
  status: namedRefSchema,
  assignee: userSchema.nullable().default(null),
  createdUser: userSchema,
  created: z.coerce.date(),
  updated: z.coerce.date(),
});

export const projectSchema = z.object({
  id: z.number(),
  projectKey: z.string(),
  name: z.string(),
  textFormattingRule: z.enum(['markdown', 'backlog']),
});

export const issueTypeSchema = z.object({ id: z.number(), name: z.string() });

export const prioritySchema = z.object({ id: z.number(), name: z.string() });

export const notificationSchema = z.object({
  id: z.number(),
  alreadyRead: z.boolean(),
  project: z.object({
    id: z.number(),
    projectKey: z.string(),
    name: z.string(),
  }),
  issue: z
    .object({ id: z.number(), issueKey: z.string(), summary: z.string() })
    .nullable()
    .default(null),
  comment: z.object({ id: z.number() }).nullable().default(null),
  sender: userSchema,
  created: z.coerce.date(),
});

export const uploadedFileSchema = z.object({
  id: z.number(),
  name: z.string(),
  size: z.number(),
});

export const userResponseSchema = userSchema;

export const issueListSchema = z.array(issueSchema);
export const commentListSchema = z.array(commentSchema);
export const issueTypeListSchema = z.array(issueTypeSchema);
export const priorityListSchema = z.array(prioritySchema);
export const notificationListSchema = z.array(notificationSchema);
