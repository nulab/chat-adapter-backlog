import { AdapterError } from '@chat-adapter/shared';
import { z } from 'zod';

import { mapTransportError } from './errors.js';

import type {
  BacklogRawComment,
  BacklogRawIssue,
  BacklogRawPullRequest,
  BacklogUser,
} from '../types';
import type { Entity } from 'backlog-js';

/**
 * What a schema below may produce for a `T`: any subset of its fields, each
 * with `T`'s type. It is what keeps the fields the adapter validates in step
 * with the type it publishes, and because any subset passes, a schema is
 * paired with its type once, in the readers at the bottom, rather than at
 * each call site.
 */
type Validated<T> = T extends readonly (infer E)[]
  ? Validated<E>[]
  : T extends object
    ? { [K in keyof T]?: Validated<T[K]> }
    : T;

export type BacklogIssueComment = BacklogRawComment & { issueId: number };

export type BacklogProject = Pick<
  Entity.Project.Project,
  'id' | 'projectKey' | 'name' | 'textFormattingRule'
>;

const userSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  userId: z.string().nullable().default(null),
});

export type BacklogUserInfo = Omit<BacklogUser, 'mailAddress'> & {
  mailAddress: string | null;
};

const userInfoSchema = userSchema.extend({
  mailAddress: z
    .string()
    .nullish()
    .transform((mailAddress) => mailAddress ?? null),
});

const nullableUserSchema = userSchema
  .nullish()
  .transform((user) => user ?? null);

const namedSchema = z.looseObject({ id: z.number(), name: z.string() });

const starsSchema = z
  .array(z.looseObject({ id: z.number(), presenter: userSchema }))
  .nullish()
  .transform((stars) => stars ?? []);

const descriptionSchema = z
  .string()
  .nullish()
  .transform((description) => description ?? '');

const commentSchema = z.looseObject({
  id: z.number(),
  content: z.string().nullable().default(null),
  changeLog: z
    .array(
      z.looseObject({
        field: z.string(),
        newValue: z.string().nullable().default(null),
        originalValue: z.string().nullable().default(null),
        attachmentInfo: z
          .looseObject({ id: z.number() })
          .nullish()
          .transform((attachmentInfo) => attachmentInfo ?? null),
      })
    )
    .nullish()
    .transform((changeLog) => changeLog ?? []),
  createdUser: userSchema,
  created: z.string(),
  updated: z.string(),
  stars: starsSchema,
});

const issueCommentSchema = commentSchema.extend({
  issueId: z.number(),
});

const issueSchema = z.looseObject({
  id: z.number(),
  projectId: z.number(),
  issueKey: z.string(),
  summary: z.string(),
  description: descriptionSchema,
  issueType: namedSchema,
  priority: namedSchema,
  status: namedSchema,
  assignee: nullableUserSchema,
  createdUser: userSchema,
  created: z.string(),
  updated: z.string(),
});

const pullRequestSchema = z.looseObject({
  id: z.number(),
  projectId: z.number(),
  repositoryId: z.number(),
  number: z.number(),
  summary: z.string(),
  description: descriptionSchema,
  base: z.string(),
  branch: z.string(),
  status: namedSchema,
  assignee: nullableUserSchema,
  createdUser: userSchema,
  created: z.string(),
  updated: z.string(),
});

const pullRequestAttachmentSchema = z.looseObject({
  id: z.number(),
  name: z.string(),
  created: z.string(),
});

const projectSchema = z.looseObject({
  id: z.number(),
  projectKey: z.string(),
  name: z.string(),
  textFormattingRule: z.enum(['markdown', 'backlog']),
});

const gitRepositorySchema = z.looseObject({
  id: z.number(),
  name: z.string(),
});

const uploadedFileSchema = z.looseObject({
  id: z.number(),
});

/**
 * The one place a Backlog response is parsed. Keys the schema names are
 * validated and the rest are carried as Backlog sent them, typed from
 * `backlog-js`, which is as far as `T` can promise. A 2xx body that is not
 * JSON reaches here as `backlog-js`'s own `SyntaxError`, which is a transport
 * failure like any other.
 */
async function parse(
  schema: z.ZodType,
  request: Promise<unknown>
): Promise<unknown> {
  let body: unknown;
  try {
    body = await request;
  } catch (cause) {
    throw cause instanceof AdapterError ? cause : mapTransportError(cause);
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new AdapterError(
      `Backlog response failed schema validation: ${z.prettifyError(result.error)}`,
      'backlog',
      'SCHEMA'
    );
  }
  return result.data;
}

function reader<T>(
  schema: z.ZodType<Validated<T>>
): (request: Promise<unknown>) => Promise<T> {
  return (request) => parse(schema, request) as Promise<T>;
}

function listReader<T>(
  schema: z.ZodType<Validated<T>>
): (request: Promise<unknown>) => Promise<T[]> {
  return (request) => parse(z.array(schema), request) as Promise<T[]>;
}

export type PullRequestAttachment = Pick<
  Entity.File.PullRequestFileInfo,
  'id' | 'name' | 'created'
>;

export const readUser = reader<BacklogUserInfo>(userInfoSchema);
export const readProject = reader<BacklogProject>(projectSchema);
export const readGitRepository =
  reader<Entity.Git.GitRepository>(gitRepositorySchema);
export const readUploadedFile =
  reader<Entity.File.FileInfo>(uploadedFileSchema);
export const readIssue = reader<BacklogRawIssue>(issueSchema);
export const readIssues = listReader<BacklogRawIssue>(issueSchema);
export const readIssueComment = reader<BacklogIssueComment>(issueCommentSchema);
export const readIssueComments =
  listReader<BacklogIssueComment>(issueCommentSchema);
export const readPullRequest = reader<BacklogRawPullRequest>(pullRequestSchema);
export const readPullRequestComment = reader<BacklogRawComment>(commentSchema);
export const readPullRequestComments =
  listReader<BacklogRawComment>(commentSchema);
export const readPullRequestAttachments = listReader<PullRequestAttachment>(
  pullRequestAttachmentSchema
);

/**
 * For a call whose answer the adapter does not read: a delete's body is the
 * thing already deleted, and failing on its shape would report a success as
 * a failure.
 */
export async function send(request: Promise<unknown>): Promise<void> {
  try {
    await request;
  } catch (cause) {
    throw cause instanceof AdapterError ? cause : mapTransportError(cause);
  }
}

/** The body of a download, read under the same request timeout. */
export async function download(
  request: Promise<Entity.File.FileData>
): Promise<Buffer> {
  try {
    const file = await request;
    return Buffer.from(await new Response(file.body).arrayBuffer());
  } catch (cause) {
    throw cause instanceof AdapterError ? cause : mapTransportError(cause);
  }
}
