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

/**
 * Only `id` is read (`src/reads.ts` builds the download URL from it), and the
 * two doc pages disagree about the rest: Get Comment List shows
 * `attachmentInfo: { id, type }` while the attachment endpoints return
 * `{ id, name, size }`. Requiring `name` and `size` would turn a comment page
 * carrying the documented shape into an `AdapterError("SCHEMA")` for the whole
 * page, so they are optional until one form is measured.
 */
const attachmentInfoSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  size: z.number().optional(),
});

/**
 * A REST `changeLog[]` entry. The previous value arrives as **`originalValue`**
 * here, not `oldValue` — the webhook's `changes[]` is the one that says
 * `old_value` (measured, `.claude/rules/backlog-webhook-facts.md` "the REST
 * comment `changeLog` is different (camelCase `newValue`/`originalValue`…)";
 * `.claude/rules/backlog-pull-request-facts.md` "`changeLog` entries are
 * `{ field, newValue, originalValue }` only"). It is renamed to `oldValue` on
 * the way out so the port's `BacklogChange` reads the same whichever source
 * filled it, which is what `docs/specs/adapter.md` §3.5 promises.
 */
const changeLogEntrySchema = z
  .object({
    field: z.string(),
    newValue: z.string().nullable().default(null),
    originalValue: z.string().nullable().default(null),
    attachmentInfo: attachmentInfoSchema.nullable().default(null),
  })
  .transform((entry) => ({
    field: entry.field,
    newValue: entry.newValue,
    oldValue: entry.originalValue,
    attachmentInfo: entry.attachmentInfo,
  }));

/**
 * The comment shape both endpoint families return. A pull-request comment
 * carries no parent reference at all (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md`), so `issueId` lives on
 * `issueCommentSchema` below rather than here.
 */
export const commentSchema = z.object({
  id: z.number(),
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

export const issueCommentSchema = commentSchema.extend({
  issueId: z.number(),
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

export const gitRepositorySchema = z.object({
  id: z.number(),
  projectId: z.number(),
  name: z.string(),
  description: z
    .string()
    .nullable()
    .default('')
    .transform((value) => value ?? ''),
});

/**
 * A pull request's linked issue. Backlog returns a full Issue object here on
 * every endpoint, while
 * [Get Pull Request List](https://developer.nulab.com/docs/backlog/api/2/get-pull-request-list/)
 * still shows a bare `{ "id" }` example; both parse.
 */
const pullRequestIssueSchema = z
  .object({
    id: z.number(),
    issueKey: z.string().nullable().default(null),
  })
  // Why not keep the whole Issue object: it is a copy taken when the pull
  // request was read, so a caller trusting its `status` or `summary` would be
  // reading a value nothing here refreshes, and it would be a second
  // `BacklogIssue` that ages differently from `getIssue`'s. Only `id` and
  // `issueKey` identify the issue, so the transform drops the rest on
  // purpose; widening it later means deciding what keeps it fresh.
  .transform((issue) => ({ id: issue.id, issueKey: issue.issueKey }));

export const pullRequestSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  repositoryId: z.number(),
  number: z.number(),
  summary: z.string(),
  description: z
    .string()
    .nullable()
    .default('')
    .transform((value) => value ?? ''),
  base: z.string(),
  branch: z.string(),
  status: namedRefSchema,
  assignee: userSchema.nullable().default(null),
  issue: pullRequestIssueSchema.nullable().default(null),
  baseCommit: z.string().nullable().default(null),
  branchCommit: z.string().nullable().default(null),
  mergeCommit: z.string().nullable().default(null),
  closeAt: z.coerce.date().nullable().default(null),
  mergeAt: z.coerce.date().nullable().default(null),
  createdUser: userSchema,
  created: z.coerce.date(),
  updated: z.coerce.date(),
  stars: z
    .array(starSchema)
    .nullable()
    .default([])
    .transform((value) => value ?? []),
});

export const pullRequestAttachmentSchema = z.object({
  id: z.number(),
  name: z.string(),
  size: z.number(),
  created: z.coerce.date(),
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
  resourceAlreadyRead: z.boolean(),
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
  pullRequest: z
    .object({ id: z.number(), number: z.number(), repositoryId: z.number() })
    .nullable()
    .default(null),
  pullRequestComment: z.object({ id: z.number() }).nullable().default(null),
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
export const issueCommentListSchema = z.array(issueCommentSchema);
export const gitRepositoryListSchema = z.array(gitRepositorySchema);
export const pullRequestListSchema = z.array(pullRequestSchema);
export const pullRequestAttachmentListSchema = z.array(
  pullRequestAttachmentSchema
);
export const issueTypeListSchema = z.array(issueTypeSchema);
export const priorityListSchema = z.array(prioritySchema);
export const notificationListSchema = z.array(notificationSchema);
