import type { Entity } from 'backlog-js';
import type { Logger } from 'chat';

/**
 * Which issue or pull request a thread, message or raw message is about
 * (docs/specs/adapter.md §2, D-PR2). The kind is an explicit, non-optional
 * coordinate on **both** kinds rather than issues being the unmarked default:
 * Backlog addresses the two through different endpoint families with
 * different coordinates, and their comment ids come from separate sequences
 * that may overlap (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md`), so nothing may infer the
 * kind from a segment count or from which field happens to be present.
 *
 * A pull request is addressed by `repositoryId` + `number`, never by its
 * space-wide `id`: that id addresses no endpoint at all.
 */
export type BacklogSubjectRef =
  | { kind: 'issue'; issueId: number }
  | { kind: 'pullRequest'; repositoryId: number; number: number };

/**
 * A thread is a Backlog issue or pull request:
 * `backlog:<host>:<projectId>:issue:<issueId>` or
 * `backlog:<host>:<projectId>:pr:<repositoryId>:<number>`
 * (docs/specs/adapter.md §2). Numeric ids throughout: renaming a project's key
 * rewrites every issue key under it, and a repository can be renamed too
 * (docs/specs/adapter.md D8, `.claude/rules/backlog-webhook-facts.md`).
 *
 * `subject` is nested rather than flattened into this interface so the same
 * value travels from `decodeThreadId` into the subject layer, into
 * `raw.subject` and back out of `encodeMessageId` without being re-shaped at
 * each boundary (D-PR2).
 */
export interface BacklogThreadId {
  host: string;
  projectId: number;
  subject: BacklogSubjectRef;
}

/**
 * A channel is a Backlog project: `backlog:<host>:<projectId>`
 * (docs/specs/adapter.md §2).
 */
export interface BacklogChannelId {
  host: string;
  projectId: number;
}

/**
 * A user, host-qualified because user ids are unique only within one Backlog
 * space (docs/specs/adapter.md §2).
 */
export interface BacklogUserId {
  host: string;
  userId: number;
}

/**
 * Which part of a subject a message is: its body, one comment, or a
 * fieldchange update that carried no comment (docs/specs/adapter.md §2).
 * The root tag is `r` for both kinds rather than the earlier `i`, which meant
 * "issue" and would mislead on a pull request (D-PR9).
 */
export type BacklogMessagePart =
  | { part: 'root' }
  | { part: 'comment'; commentId: number }
  | { part: 'update'; created: string };

/**
 * A message id: `<host>:<subject>:<part>`. Host-qualified, and without the
 * `backlog:` prefix that thread and channel ids carry, because the core's
 * dedupe key (`dedupe:<adapter.name>:<message.id>`) already carries the
 * adapter name and has no thread component of its own
 * (docs/specs/adapter.md §2, `.claude/rules/chat-sdk-core-facts.md`) — so the
 * message id alone must disambiguate across every configured space, and the
 * subject's kind keeps two comment ids from different sequences apart.
 */
export type BacklogMessageId = {
  host: string;
  subject: BacklogSubjectRef;
} & BacklogMessagePart;

/**
 * A normalised field change, shared by webhook `content.changes[]` and REST
 * `changeLog[]` (docs/specs/adapter.md §3.5). Value systems are not unified
 * across the two sources — see `BacklogRawMessage`.
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
 * A comment as `message.raw` carries it. The parent is **not** a field here:
 * a pull-request comment has no parent reference of its own (measured
 * 2026-09-06, `.claude/rules/backlog-pull-request-facts.md`), so the
 * enclosing raw variant names the `subject` instead and one shape serves both
 * kinds.
 */
export interface BacklogRawComment {
  id: number;
  content: string | null;
  createdUser: { id: number; name: string; userId?: string | null };
  created: string;
  updated: string;
  changeLog: BacklogChange[];
  stars: { id: number; presenter: { id: number } }[];
}

export interface BacklogRawIssue {
  id: number;
  issueKey: string;
  projectId: number;
  summary: string;
  description: string;
  status: { id: number; name: string };
  issueType: { id: number; name: string };
  priority: { id: number; name: string };
  assignee: { id: number; name: string } | null;
  createdUser: { id: number; name: string; userId?: string | null };
  created: string;
  updated: string;
}

/** Mirrors the port's `BacklogPullRequest` with ISO strings; see `src/index.ts`. */
export interface BacklogRawPullRequest {
  id: number;
  projectId: number;
  repositoryId: number;
  number: number;
  summary: string;
  description: string;
  base: string;
  branch: string;
  status: { id: number; name: string };
  assignee: { id: number; name: string } | null;
  issue: { id: number; issueKey: string | null } | null;
  baseCommit: string | null;
  branchCommit: string | null;
  mergeCommit: string | null;
  closeAt: string | null;
  mergeAt: string | null;
  createdUser: { id: number; name: string; userId?: string | null };
  created: string;
  updated: string;
}

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
 * behaviour on `postMessage` (docs/specs/adapter.md §3.4).
 */
export interface BacklogPostableExtras {
  notifiedUserId?: number[];
}

/**
 * A deployment-supplied escape hatch for webhook authenticity. Backlog issues
 * no HMAC signature (docs/specs/adapter.md §11,
 * [Add Webhook](https://developer.nulab.com/docs/backlog/api/2/add-webhook/)
 * accepts only `name`, `description`, `hookUrl`, `allEvent`,
 * `activityTypeIds[]`), so a consumer may plug in a reverse-proxy assertion,
 * mTLS or an IP allowlist instead of (or in addition to) the shared secret.
 */
export type BacklogWebhookVerifier = (
  request: Request,
  rawBody: string
) => unknown | Promise<unknown>;

/**
 * Backlog's per-project text formatting setting
 * ([Get Project](https://developer.nulab.com/docs/backlog/api/2/get-project/)).
 * `"backlog"` notation is a different syntax from `"markdown"`, not a
 * superset (docs/specs/adapter.md §9.1).
 */
export type TextFormattingRule = 'markdown' | 'backlog';

/**
 * A config value that is either a static string or resolved per call. Every
 * outbound request awaits the resolver form and never caches its result, so a
 * consumer can rotate an OAuth access token without reconstructing the
 * adapter (docs/specs/adapter.md §3.2, vendor-official requirement in
 * CLAUDE.md "Conventions to follow").
 */
export type Resolvable = string | (() => string | Promise<string>);

/**
 * One configured Backlog space (shape B of `BacklogAdapterConfig`,
 * docs/specs/adapter.md §3.2). Exactly one of `apiKey`/`accessToken` is
 * required, and `webhookSecret` is required unless
 * `BacklogAdapterConfig.webhookVerifier` is set (D2); the constructor
 * enforces both.
 *
 * Deliberately **not** a union stating "exactly one credential", although
 * that is the rule: config is the shape a consumer assembles, often from
 * `process.env` or JSON the compiler knows nothing about, and every field
 * here is checked at construction anyway. Stating the exclusivity in the
 * input type would turn one uniform `ValidationError` naming the field into a
 * type error a plain-JavaScript consumer never sees and a TypeScript one
 * meets while building the object rather than where the value came from. The
 * strictness belongs on the way out, after the constructor's check.
 */
export interface BacklogInstallation {
  host: string;
  apiKey?: Resolvable;
  accessToken?: Resolvable;
  botUserId?: number;
  botUserName?: string;
  webhookSecret?: string;
}

/**
 * The credential half of a {@link ResolvedInstallation}: **exactly one** of
 * the two, stated as a union rather than as two optional fields. `?: never`
 * is what says "not this one" under `exactOptionalPropertyTypes` — the key
 * may be omitted and may not be written, `undefined` included — so an
 * installation carrying both credentials, or neither, is a type error instead
 * of a constructor-time `ValidationError`.
 */
export type ResolvedCredential =
  | { apiKey: Resolvable; accessToken?: never }
  | { accessToken: Resolvable; apiKey?: never };

/**
 * One configured Backlog installation after shape A/B resolution and
 * validation (docs/specs/adapter.md §3.2). The port factory receives this,
 * not the raw config, so a test seam or a future port never has to re-derive
 * validation the constructor already did — which is only worth anything if
 * the type says what was validated, so it is not a second copy of
 * {@link BacklogInstallation}:
 *
 * - the credential is a {@link ResolvedCredential}, so "exactly one of
 *   `apiKey`/`accessToken`" holds by construction;
 * - `host` is lowercased, and stays a plain `string` deliberately. A brand
 *   would state that too, but only by making every construction site — the
 *   constructor, every fixture, every port double a test writes —
 *   cast into it, and the one producer of the value is `validateHost` in
 *   `src/ids.ts`, which lowercases through the same grammar the id codec
 *   uses. The cost outweighs what the brand buys (issue #62);
 * - `botUserId`/`botUserName` stay as configured: the port is built before
 *   `GET /users/myself` has answered, so the fetched identity is not here.
 */
export type ResolvedInstallation = {
  host: string;
  botUserId?: number;
  botUserName?: string;
  webhookSecret?: string;
} & ResolvedCredential;

/**
 * Constructor config for `BacklogAdapter` / `createBacklogAdapter`
 * (docs/specs/adapter.md §3.2). Shape A (single space, every field falling
 * back to an environment variable) and shape B (`installations`) are
 * mutually exclusive; the adapter validates that exclusivity at construction
 * time rather than the type system, for the same reason as
 * `BacklogInstallation`.
 */
export interface BacklogAdapterConfig {
  // Shape A — one space, every field falls back to an environment variable.
  host?: string;
  apiKey?: Resolvable;
  accessToken?: Resolvable;
  botUserId?: number;
  botUserName?: string;
  webhookSecret?: string;
  // Shape B — several spaces. Mutually exclusive with shape A's fields.
  installations?: BacklogInstallation[];
  // Shared
  webhookVerifier?: BacklogWebhookVerifier;
  userName?: string;
  logger?: Logger;
}
