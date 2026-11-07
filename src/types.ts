import type { Entity } from 'backlog-js';
import type { Logger } from 'chat';

/**
 * Which issue or pull request a thread, message or raw message is about.
 * `kind` is explicit on both: issue and pull-request comment ids come from
 * separate sequences that may overlap, so the kind is never inferred from
 * which fields are present (D-PR2). A pull request is addressed by
 * `repositoryId` + `number`; its space-wide `id` addresses no endpoint.
 */
export type BacklogSubjectRef =
  | { kind: 'issue'; issueId: number }
  | { kind: 'pullRequest'; repositoryId: number; number: number };

/**
 * A thread is a Backlog issue or pull request:
 * `backlog:<host>:<projectId>:issue:<issueId>` or
 * `backlog:<host>:<projectId>:pr:<repositoryId>:<number>`. Numeric ids
 * throughout: renaming a project's key rewrites every issue key under it,
 * and a repository can be renamed too (D8).
 */
export interface BacklogThreadId {
  host: string;
  projectId: number;
  subject: BacklogSubjectRef;
}

/** A channel is a Backlog project: `backlog:<host>:<projectId>`. */
export interface BacklogChannelId {
  host: string;
  projectId: number;
}

/**
 * A user, `<host>:<userId>`: user ids are unique only within one Backlog
 * space.
 */
export interface BacklogUserId {
  host: string;
  userId: number;
}

/**
 * Which part of a subject a message is: its body, one comment, or a
 * field-change update that carried no comment.
 */
export type BacklogMessagePart =
  | { part: 'root' }
  | { part: 'comment'; commentId: number }
  | { part: 'update'; created: string };

/**
 * A message id: `<host>:<subject>:<part>`. The core dedupes on the message id
 * alone, with no thread in the key, so the id names its host and its
 * subject's kind as well as the comment.
 */
export type BacklogMessageId = {
  host: string;
  subject: BacklogSubjectRef;
} & BacklogMessagePart;

/**
 * A normalised field change, shared by webhook `content.changes[]` and REST
 * `changeLog[]`. Value systems are not unified across the two sources — see
 * `BacklogRawMessage`.
 */
export interface BacklogChange {
  field: string;
  newValue: string | null;
  oldValue: string | null;
}

/**
 * A dispatched delivery as `raw.payload` carries it, discriminated on `type`,
 * so `payload.type === 3` narrows `content`. It is `backlog-js`'s activity
 * shape with what a webhook measurably sends differently laid over it: the
 * normalisations the adapter applies (link ids as numbers, change values as
 * strings or `null`, a changelog comment's text as `""`, absent arrays as
 * `[]`), the fields that arrive `null`, the populated `notifications[]` and
 * the keys a webhook adds to a pull request. Keys neither names are carried
 * as Backlog sent them.
 */
export type BacklogWebhookPayload = Omit<
  Entity.Activity.Activity,
  'type' | 'content' | 'notifications' | 'createdUser'
> & {
  createdUser: Pick<
    Entity.User.User,
    'id' | 'name' | 'roleType' | 'lang' | 'mailAddress'
  > & { userId: string | null };
  notifications: (Pick<
    Entity.Notification.Notification,
    'id' | 'alreadyRead' | 'reason' | 'resourceAlreadyRead'
  > & {
    user: Pick<Entity.User.User, 'id' | 'name' | 'roleType' | 'lang'> & {
      userId: string | null;
    };
  })[];
} & (
    | {
        type: 1;
        content: Omit<Entity.Activity.IssueCreatedContent, 'description'> & {
          description: string | null;
          assignee:
            | (Pick<Entity.User.User, 'id' | 'name' | 'roleType' | 'lang'> & {
                userId: string | null;
              })
            | null;
          attachments: Entity.Activity.ActivityAttachment[];
        };
      }
    | {
        type: 2 | 3;
        content: Omit<Entity.Activity.IssueContent, 'comment' | 'changes'> & {
          comment: Entity.Activity.ActivityComment | null;
          changes: (Omit<
            Entity.Activity.ActivityChange,
            'field_text' | 'new_value' | 'old_value'
          > & { new_value: string | null; old_value: string | null })[];
        };
      }
    | { type: 4; content: Entity.Activity.IssueDeletedContent }
    | {
        type: 14;
        content: Omit<
          Entity.Activity.IssueMultiUpdateContent,
          'tx_id' | 'link' | 'changes'
        > & {
          tx_id: string | number;
          individual_update?: boolean;
          link: (Omit<Entity.Activity.MultiUpdateLink, 'key_id' | 'comment'> & {
            key_id: string | number;
            comment: Entity.Activity.ActivityComment | null;
          })[];
          changes: (Omit<Entity.Activity.MultiUpdateChange, 'new_value'> & {
            new_value: string | null;
            old_value: string | null;
          })[];
        };
      }
    | {
        type: 18 | 19 | 20;
        content: Omit<
          Entity.Activity.PullRequestContent,
          'description' | 'changes' | 'repository'
        > & {
          description: string | null;
          changes: (Omit<
            Entity.Activity.ActivityChange,
            'field_text' | 'new_value' | 'old_value'
          > & { new_value: string | null; old_value: string | null })[];
          repository: Omit<Entity.Activity.GitRepository, 'description'> & {
            description: string | null;
          };
          assignee:
            | (Pick<Entity.User.User, 'id' | 'name' | 'roleType' | 'lang'> & {
                userId: string | null;
              })
            | null;
          base: string;
          branch: string;
          diff: string | null;
          attachments: Entity.Activity.ActivityAttachment[];
        };
      }
  );

/**
 * A user as a REST response carries it: `userId` is `null` for a user who
 * signs in with a Nulab account (measured).
 */
export type BacklogUser = Omit<Entity.User.User, 'userId'> & {
  userId: string | null;
};

/** `comment` arrives as `null`, not absent (measured). */
export type BacklogStar = Omit<Entity.Star.Star, 'comment' | 'presenter'> & {
  comment: string | null;
  presenter: BacklogUser;
};

/**
 * A REST `changeLog[]` entry, under `backlog-js`'s own `originalValue` name;
 * `raw.changes` is where it reads `oldValue`, like a webhook change.
 * `attachmentInfo` is `null` on a pull-request comment, which names a file by
 * name alone (measured).
 */
export type BacklogChangeLog = Omit<
  Entity.ChangeLog.ChangeLog,
  'newValue' | 'originalValue'
> & {
  newValue: string | null;
  originalValue: string | null;
  attachmentInfo: { id: number } | null;
};

/**
 * A comment of either kind. The parent is not a field of its own: a
 * pull-request comment carries no parent reference (measured), so the
 * enclosing raw variant names the `subject`.
 */
export type BacklogRawComment = Omit<
  Entity.PullRequest.Comment,
  'content' | 'changeLog' | 'createdUser' | 'stars'
> & {
  /** `null` for a system comment, such as an assignee change. */
  content: string | null;
  changeLog: BacklogChangeLog[];
  createdUser: BacklogUser;
  stars: BacklogStar[];
};

export type BacklogRawIssue = Omit<
  Entity.Issue.Issue,
  'description' | 'assignee' | 'createdUser' | 'updatedUser' | 'stars'
> & {
  description: string;
  assignee: BacklogUser | null;
  createdUser: BacklogUser;
  updatedUser: BacklogUser;
  stars: BacklogStar[];
};

/**
 * `issue` is a full issue object on every endpoint, the list included
 * (measured); the commits and dates are `null` until the pull request is
 * merged or closed.
 */
export type BacklogRawPullRequest = Omit<
  Entity.PullRequest.PullRequest,
  | 'description'
  | 'assignee'
  | 'issue'
  | 'baseCommit'
  | 'branchCommit'
  | 'mergeCommit'
  | 'closeAt'
  | 'mergeAt'
  | 'createdUser'
  | 'updatedUser'
  | 'stars'
> & {
  description: string;
  assignee: BacklogUser | null;
  issue: Entity.Issue.Issue | null;
  baseCommit: string | null;
  branchCommit: string | null;
  mergeCommit: string | null;
  closeAt: string | null;
  mergeAt: string | null;
  createdUser: BacklogUser;
  updatedUser: BacklogUser;
  stars: BacklogStar[];
};

/**
 * `changes` is normalised, but its value systems are not unified: a webhook
 * `status` change carries an id where the REST `changeLog` carries a display
 * name, so read `kind` before interpreting it.
 */
export type BacklogRawMessage =
  | {
      kind: 'webhook';
      host: string;
      payload: BacklogWebhookPayload;
      changes: BacklogChange[];
    }
  | {
      /** One issue of a type-14 bulk update, which names several (D22). */
      kind: 'bulkUpdate';
      host: string;
      payload: BacklogWebhookPayload;
      issueId: number;
      changes: BacklogChange[];
    }
  | {
      kind: 'comment';
      host: string;
      projectId: number;
      subject: BacklogSubjectRef;
      comment: BacklogRawComment;
      changes: BacklogChange[];
    }
  | { kind: 'issue'; host: string; issue: BacklogRawIssue; changes: [] }
  | {
      kind: 'pullRequest';
      host: string;
      pullRequest: BacklogRawPullRequest;
      changes: [];
    };

/**
 * Extras a caller intersects with a Chat SDK postable to reach Backlog-only
 * behaviour on `postMessage`.
 */
export interface BacklogPostableExtras {
  notifiedUserId?: number[];
}

/**
 * Replaces the `?token=` check: a request is accepted when this returns or
 * resolves a truthy value, and answered 401 otherwise or when it throws.
 * Backlog signs no webhook, so this is where a reverse-proxy assertion, mTLS
 * or an IP allowlist plugs in.
 */
export type BacklogWebhookVerifier = (
  request: Request,
  rawBody: string
) => unknown | Promise<unknown>;

/**
 * A credential given as a string or as a function the adapter calls before
 * every request, never caching its result, so an OAuth access token can be
 * refreshed without reconstructing the adapter.
 */
export type Resolvable = string | (() => string | Promise<string>);

/**
 * Configuration for one Backlog space. Every field but `webhookVerifier` and
 * `logger` falls back to its `BACKLOG_*` environment variable when absent, so
 * `createBacklogAdapter()` with no argument works from the environment alone.
 * The constructor throws `ValidationError` for a value it cannot use.
 *
 * - Exactly one of `apiKey` and `accessToken`.
 * - `webhookSecret` is required unless `webhookVerifier` is set.
 * - `botUserId` is required, from config or the environment.
 */
export interface BacklogAdapterConfig {
  host?: string;
  apiKey?: Resolvable;
  accessToken?: Resolvable;
  botUserId?: number;
  webhookSecret?: string;
  webhookVerifier?: BacklogWebhookVerifier;
  logger?: Logger;
}
