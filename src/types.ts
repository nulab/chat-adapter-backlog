import { z } from 'zod';

import type { BacklogApi } from './client/port';
import type {
  IssueMultiUpdatedActivity,
  RecognisedActivity,
} from './webhook/payload';
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
 * A webhook body that has passed `src/webhook/payload.ts` validation: one of
 * the four dispatched activity types (docs/specs/adapter.md §5.1 step 8,
 * §5.2). Broadened from a P2-era placeholder `{ type: number; content:
 * Record<string, unknown> }` to the real discriminated union once P3 owned
 * the schema, per this phase's file list ("You may broaden
 * `BacklogWebhookPayload` to the full §5.2 shape; that was left to you
 * deliberately").
 */
export type BacklogWebhookPayload = RecognisedActivity;

/**
 * A type-14 body that has passed validation. Kept out of
 * {@link BacklogWebhookPayload} because a bulk update names no single subject
 * (docs/specs/adapter.md §5.2): the types in that union are the ones an id can
 * be built from without asking which issue of several is meant.
 */
export type BacklogBulkUpdatePayload = IssueMultiUpdatedActivity;

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
 * a thread's root message. The two root variants stay flat rather than one
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
 * Validates `notifiedUserId` strictly: a present-but-mistyped extra is a
 * `ValidationError` rather than a value silently dropped
 * (docs/specs/adapter.md §3.4). Membership is deliberately not checked here —
 * Backlog itself drops a non-member or nonexistent id without failing the
 * request (measured 2026-08-18, `.claude/rules/backlog-api-facts.md`
 * "`notifiedUserId[]` fails open"), so pre-validating membership would reject
 * requests Backlog would have accepted.
 */
export const notifiedUserIdSchema = z.array(z.number().int().positive());

/**
 * The strict schema `postMessage`/`postChannelMessage` read
 * `BacklogPostableExtras` through (docs/specs/adapter.md §3.4). Only
 * `notifiedUserId` is defined for `postMessage`; `.strip()` would silently
 * drop an unknown key, so `.strict()` is used instead to surface a typo as a
 * `ValidationError` rather than a no-op.
 */
export const backlogPostableExtrasSchema = z
  .object({
    notifiedUserId: notifiedUserIdSchema.optional(),
  })
  .strict();

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
 * The strict schema `postChannelMessage` reads `BacklogChannelPostableExtras`
 * through (docs/specs/adapter.md §3.4, §6.7). `.strict()` for the same reason
 * as `backlogPostableExtrasSchema`: a typo'd extra must surface as a
 * `ValidationError`, not a silently ignored field.
 */
export const backlogChannelPostableExtrasSchema = z
  .object({
    notifiedUserId: notifiedUserIdSchema.optional(),
    issueTypeId: z.number().int().positive().optional(),
    priorityId: z.number().int().positive().optional(),
    assigneeId: z.number().int().positive().optional(),
  })
  .strict();

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
 * required; `webhookSecret` is required unless `BacklogAdapterConfig.webhookVerifier`
 * is set (D2) — both are validated by the adapter constructor, not by this
 * type, because the exclusivity is a cross-field rule `exactOptionalPropertyTypes`
 * cannot express.
 */
export interface BacklogInstallation {
  host: string;
  apiKey?: Resolvable;
  accessToken?: Resolvable;
  botUserId: number;
  botUserName: string;
  webhookSecret?: string;
}

/**
 * One configured Backlog installation after shape A/B resolution and
 * validation (docs/specs/adapter.md §3.2): a fully-formed `BacklogInstallation`
 * with its host lowercased and exactly one of `apiKey`/`accessToken` present.
 * `createApi` receives this, not the raw config, so a test seam or a future
 * `backlog-js`-backed port never has to re-derive validation the constructor
 * already did.
 */
export interface ResolvedInstallation {
  host: string;
  apiKey?: Resolvable;
  accessToken?: Resolvable;
  botUserId: number;
  botUserName: string;
  webhookSecret?: string;
}

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
