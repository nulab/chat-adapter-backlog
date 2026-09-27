import type { BacklogApi } from './client/port';
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
 * A user as an activity carries them: `createdUser` on every dispatched type
 * (docs/specs/adapter.md §5.2 "Required"). `userId` is nullable as well as
 * optional — a Nulab-account user has none.
 */
export interface BacklogActivityUser {
  id: number;
  name: string;
  userId?: string | null | undefined;
}

/**
 * One `content.changes[]` entry (docs/specs/adapter.md §5.2). The keys stay
 * `snake_case` because this is the delivery verbatim, not the normalised
 * {@link BacklogChange} the adapter derives from it. `old_value` is optional
 * because a bulk update sends none at all.
 */
export interface BacklogActivityChange {
  field: string;
  new_value?: string | number | null | undefined;
  old_value?: string | number | null | undefined;
}

/**
 * One `content.attachments[]` entry (docs/specs/adapter.md §5.2, §6.6).
 * `size` is optional: it is informational, so a delivery that omits it — or
 * sends it as anything but a number — is read rather than rejected, with the
 * key absent. Only `id` addresses the file; `src/webhook/payload.ts` says why
 * `name` is not optional alongside it.
 */
export interface BacklogActivityAttachment {
  id: number;
  name: string;
  size?: number | undefined;
}

/**
 * `content.comment` on types 2, 3, 19 and 20, and `content.link[].comment` on
 * type 14: the comment this activity wrote, or `null` when it wrote none.
 */
export type BacklogActivityComment = {
  id: number;
  content: string | null;
} | null;

/**
 * The subject's assignee as an activity carries it. Only the two fields the
 * adapter reads are named although a delivery carries `userId`, `roleType`
 * and `lang` too (measured 2026-09-06), which costs a consumer nothing:
 * `raw.payload` is the parsed body, not a stripped copy
 * (docs/specs/adapter.md §5.2).
 */
export interface BacklogActivityAssignee {
  id: number;
  name: string;
}

/**
 * One top-level `notifications[]` entry: a user this activity notified and
 * the reason code Get Notification documents (1 assigned to the issue, 2 a
 * comment addressed to you, 10 and 11 for the pull-request equivalents).
 * Mention detection does not branch on `reason` (docs/specs/adapter.md §5.4
 * rule 6); it is named because it is the field a consumer needs to tell an
 * assignment apart from a comment.
 */
export interface BacklogActivityNotification {
  reason?: number | undefined;
  user: { id: number };
}

/** `content.repository` on types 18–20 (docs/specs/adapter.md §5.2). */
export interface BacklogActivityRepository {
  id: number;
  name?: string | undefined;
  description?: string | null | undefined;
}

/**
 * `content.issue` on types 18–20: the issue the pull request is linked to.
 * Display data, never identity — a linked pull request is still its own
 * thread and the link can be repointed (docs/specs/adapter.md §5.3, D-PR6).
 */
export interface BacklogActivityLinkedIssue {
  id: number;
  key_id?: number | undefined;
  issue_key?: string | undefined;
  summary?: string | undefined;
  description?: string | null | undefined;
}

/**
 * The envelope every dispatched activity carries, type 14 included
 * (docs/specs/adapter.md §5.2 "Required"). `project.projectKey` stays
 * optional although every measured delivery carries it, because it is
 * display data and never identity.
 */
export interface BacklogActivityEnvelope {
  created: string;
  project: { id: number; projectKey?: string | undefined };
  createdUser: BacklogActivityUser;
  notifications: BacklogActivityNotification[];
}

/** Type 1 — Issue Created. `content.assignee` is webhook-only (§5.3). */
export interface BacklogIssueCreatedActivity extends BacklogActivityEnvelope {
  type: 1;
  content: {
    id: number;
    key_id?: number | undefined;
    summary: string;
    description: string | null;
    assignee?: BacklogActivityAssignee | null | undefined;
    attachments?: BacklogActivityAttachment[] | undefined;
  };
}

/** Types 2 and 3 — Issue Updated / Issue Commented share one content shape. */
export interface BacklogIssueUpdatedOrCommentedActivity extends BacklogActivityEnvelope {
  type: 2 | 3;
  content: {
    id: number;
    key_id?: number | undefined;
    comment?: BacklogActivityComment | undefined;
    changes?: BacklogActivityChange[] | undefined;
    attachments?: BacklogActivityAttachment[] | undefined;
  };
}

/** Type 4 — Issue Deleted. */
export interface BacklogIssueDeletedActivity extends BacklogActivityEnvelope {
  type: 4;
  content: {
    id: number;
    key_id?: number | undefined;
  };
}

/**
 * `content` of a pull-request activity, shared by types 18, 19 and 20 — the
 * activity form plus `assignee`, `base`, `branch` and `diff` on all three
 * alike (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md`). Only the three fields that
 * address a pull request — `id`, `number` and `repository.id` — are
 * required, so an activity-form body still parses while one that cannot be
 * addressed is the 400 it should be. `attachments` is named although neither
 * form was measured to carry it.
 */
export interface BacklogPullRequestActivityContent {
  id: number;
  number: number;
  repository: BacklogActivityRepository;
  summary?: string | undefined;
  description?: string | null | undefined;
  comment?: BacklogActivityComment | undefined;
  changes?: BacklogActivityChange[] | undefined;
  issue?: BacklogActivityLinkedIssue | null | undefined;
  assignee?: BacklogActivityAssignee | null | undefined;
  base?: string | null | undefined;
  branch?: string | null | undefined;
  diff?: string | null | undefined;
  attachments?: BacklogActivityAttachment[] | undefined;
}

/** Type 18 — Pull Request Added. */
export interface BacklogPullRequestAddedActivity extends BacklogActivityEnvelope {
  type: 18;
  content: BacklogPullRequestActivityContent;
}

/**
 * Types 19 and 20 — Pull Request Updated / Comment Added on Pull Request.
 * They share type 18's content shape; the literals stay distinct so a caller
 * can still tell a creation from an update.
 */
export interface BacklogPullRequestUpdatedOrCommentedActivity extends BacklogActivityEnvelope {
  type: 19 | 20;
  content: BacklogPullRequestActivityContent;
}

/**
 * A webhook body that has passed `src/webhook/payload.ts` validation: one of
 * the dispatched activity types that names a single subject
 * (docs/specs/adapter.md §5.1 step 8, §5.2).
 *
 * The schemas' **output** type, while the value on `raw.payload` is the
 * delivery as received and reaches this type by a cast — §5.2 requires the
 * body verbatim, not a stripped copy. The two are not interchangeable in the
 * one field the schema repairs rather than requires: `notifications[]` is `[]`
 * here whatever arrived, and on `raw.payload` it is whatever arrived,
 * including absent. So a field read off `raw.payload` is unvalidated whatever
 * this type says, and `parseMessage` parses again before reading one, as the
 * bulk path does.
 *
 * Declared by hand rather than aliased to the schemas' `z.infer`, which is
 * what it was until #37. Such an alias is not an alias in a `.d.ts`: the
 * emitter cannot describe it without the type of every schema const behind
 * it, so `dist/index.d.ts` imported `zod` and published three hundred lines
 * of `z.ZodObject<…, z.core.$strip>` as part of this package's contract. A
 * consumer's `tsc` then had to resolve zod's internals to check
 * `message.raw.payload`, a hoisted zod minor could break that, and a zod
 * major would have been a semver-major here.
 *
 * The duplication that buys is not free to keep, so it is not kept by hand:
 * `src/webhook/payload.test.ts` asserts this declaration and the schemas'
 * inferred types are identical in both directions, and
 * `scripts/check-published-types.mjs` fails the build if an implementation
 * type reaches the declarations again.
 */
export type BacklogWebhookPayload =
  | BacklogIssueCreatedActivity
  | BacklogIssueUpdatedOrCommentedActivity
  | BacklogIssueDeletedActivity
  | BacklogPullRequestAddedActivity
  | BacklogPullRequestUpdatedOrCommentedActivity;

/**
 * One `content.link[]` entry of a bulk update: the issue that was updated and
 * the comment the update wrote on it.
 *
 * `id` and `key_id` are `string | number` because a webhook serialises them
 * as decimal strings where `GET /space/activities` sends numbers (measured on
 * a development space, 2026-09-06) and this is the delivery verbatim.
 * `comment` is optional although every measured entry carried one, empty
 * comment box included: an entry that carries none still addresses an issue,
 * and requiring it would answer 400 and drop a batch Backlog will not send
 * again.
 */
export interface BacklogActivityBulkLink {
  id: string | number;
  key_id?: string | number | undefined;
  title?: string | undefined;
  comment?: BacklogActivityComment | undefined;
}

/**
 * A type-14 body that has passed validation. Kept out of
 * {@link BacklogWebhookPayload} because a bulk update names no single subject
 * (docs/specs/adapter.md §5.2): the types in that union are the ones an id can
 * be built from without asking which issue of several is meant.
 *
 * The shape as **delivered**, not as the schema leaves it. `raw.payload` is
 * the delivery verbatim, and a delivery writes `content.link[].id` and
 * `key_id` as decimal strings; the schema coerces them to numbers, which is
 * true of `parseBulkUpdatePayload`'s result and false of the body it was
 * given. A consumer reading them off `raw.payload` gets `string | number`
 * here and has to say which it means.
 *
 * `content.comment` is the text as typed into the bulk comment box and is
 * **not** a comment object: it has no `id`, and every `link[]` entry repeats
 * the same text with the id of the comment actually written on that issue.
 * `content.changes[]` describes the whole batch, not any one issue.
 *
 * Declared by hand for the reason {@link BacklogWebhookPayload} gives, and
 * pinned to `z.input<typeof issueMultiUpdatedSchema>` — the schema's input,
 * since the coercion above is exactly what the output type hides — by the
 * same test.
 */
export interface BacklogBulkUpdatePayload extends BacklogActivityEnvelope {
  type: 14;
  content: {
    tx_id?: string | number | undefined;
    comment?: { content: string | null } | null | undefined;
    link: BacklogActivityBulkLink[];
    individual_update?: boolean | undefined;
    changes?: BacklogActivityChange[] | undefined;
  };
}

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
 * The five shapes `parseMessage` accepts (docs/specs/adapter.md §3.5): a
 * webhook activity, one issue out of a bulk update, a REST comment fetched
 * for a known project and subject, or a REST issue or pull request fetched as
 * a thread's root message. All five are accepted, not only the two the
 * webhook path builds: the last three are what `fetchMessages`,
 * `fetchMessage`, `listThreads`, `postMessage`, `editMessage` and
 * `postChannelMessage` put on the messages they return, and
 * `parseMessage(message.raw)` rebuilds such a message without a Backlog call
 * — the round trip §12.2 asserts. The two root variants stay flat rather than one
 * `root` variant with a nested discriminator, so `raw.issue` is reachable
 * after one `kind` check — the common case — instead of descending into
 * `raw.subject.kind` first.
 * `changes` is always normalised to
 * `BacklogChange`, but the value systems underneath are not unified —
 * webhook `status` changes carry ids and `assigner` changes carry display
 * names, while REST `changeLog` carries display names for both (measured
 * 2026-08-28, docs/specs/adapter.md §3.5) — so consumers read `raw.kind`
 * before interpreting `changes`. `bulkUpdate` is on the webhook side of that
 * split: its `changes` come from the same `content.changes[]`, so a `status`
 * entry there is a status **id** as a string too.
 */
export type BacklogRawMessage =
  | {
      kind: 'webhook';
      host: string;
      payload: BacklogWebhookPayload;
      changes: BacklogChange[];
    }
  | {
      /**
       * One issue of a type-14 bulk update (docs/specs/adapter.md §5.3, D22).
       * `payload` is the whole delivery as Backlog sent it — the same
       * `content.link[]`, `content.changes[]` and `tx_id` reach every message
       * the batch produced — and `issueId` says which `content.link[]` entry
       * this message is. The entry is named by its issue id rather than by
       * its index, so the field survives a redelivery arriving in another
       * order and means something on its own.
       *
       * It is its own kind rather than a field added to `webhook` because
       * `webhook` guarantees that `payload` names one subject, and code that
       * relies on that (`subjectOfActivity`) must not silently be handed a
       * body that names several.
       */
      kind: 'bulkUpdate';
      host: string;
      payload: BacklogBulkUpdatePayload;
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
 * Extras a caller intersects with a Chat SDK postable to reach Backlog-only
 * behaviour on `postChannelMessage`, which creates an issue
 * (docs/specs/adapter.md §3.4, §6.7).
 */
export interface BacklogChannelPostableExtras {
  notifiedUserId?: number[];
  issueTypeId?: number;
  priorityId?: number;
  assigneeId?: number;
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
 * Deliberately **not** the union {@link ResolvedCredential} uses, although
 * this is the same rule: config is the shape a consumer assembles, often from
 * `process.env` or JSON the compiler knows nothing about, and every field
 * here is checked at construction anyway. Stating the exclusivity in the
 * input type would turn one uniform `ValidationError` naming the field into a
 * type error a plain-JavaScript consumer never sees and a TypeScript one
 * meets while building the object rather than where the value came from. The
 * strictness belongs on the way out, which is what {@link
 * ResolvedInstallation} is for.
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
 * validation (docs/specs/adapter.md §3.2). `createApi` receives this, not the
 * raw config, so a test seam or a future port never has to re-derive
 * validation the constructor already did — which is only worth anything if
 * the type says what was validated, so it is not a second copy of
 * {@link BacklogInstallation}:
 *
 * - the credential is a {@link ResolvedCredential}, so "exactly one of
 *   `apiKey`/`accessToken`" holds by construction;
 * - `host` is lowercased, and stays a plain `string` deliberately. A brand
 *   would state that too, but only by making every construction site — the
 *   constructor, every fixture, every `createApi` double a consumer writes —
 *   cast into it, and the one producer of the value is `validateHost` in
 *   `src/ids.ts`, which lowercases through the same grammar the id codec
 *   uses. The cost outweighs what the brand buys (issue #62);
 * - `botUserId`/`botUserName` stay as configured: `createApi` runs before
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
  rateLimit?: { maxWaitMs?: number; maxRetries?: number };
  maxWebhookBodyBytes?: number;
  /**
   * Test seam and escape hatch: receives the resolved installation and returns
   * the Backlog API port. Defaults to the `backlog-js`-backed implementation.
   */
  createApi?: (installation: ResolvedInstallation) => BacklogApi;
}
