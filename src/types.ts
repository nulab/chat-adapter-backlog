import type { Logger } from 'chat';

/**
 * A thread is a Backlog issue: `backlog:<host>:<projectId>:<issueId>`
 * (docs/specs/adapter.md §2). The numeric `issueId` is carried instead of the
 * issue key because renaming a project's key rewrites every issue key under
 * it (docs/specs/adapter.md D8, `.claude/rules/backlog-webhook-facts.md`).
 */
export interface BacklogThreadId {
  host: string;
  projectId: number;
  issueId: number;
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
 * A message: the issue body, a comment, or a fieldchange update with no
 * comment (docs/specs/adapter.md §2). Host-qualified, and without the
 * `backlog:` prefix that thread and channel ids carry, because the core's
 * dedupe key (`dedupe:<adapter.name>:<message.id>`) already carries the
 * adapter name and has no thread component of its own
 * (docs/specs/adapter.md §2, `.claude/rules/chat-sdk-core-facts.md`) — so the
 * message id alone must disambiguate across every configured space.
 */
export type BacklogMessageId =
  | { kind: 'issue'; host: string; issueId: number }
  | { kind: 'comment'; host: string; issueId: number; commentId: number }
  | { kind: 'update'; host: string; issueId: number; created: string };

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
 * Placeholder shapes for the payload and domain objects the raw-message union
 * references. Their full schemas belong to the webhook and client phases
 * (docs/plans/adapter-implementation.md P3/P1); this phase only needs them to
 * exist so `BacklogRawMessage` type-checks.
 */
export interface BacklogWebhookPayload {
  type: number;
  created: string;
  project: { id: number; projectKey?: string };
  createdUser: { id: number; name: string; userId?: string | null };
  content: Record<string, unknown>;
}

export interface BacklogComment {
  id: number;
  content: string | null;
  createdUser: { id: number; name: string; userId?: string | null };
  created: string;
  updated: string;
  changeLog: BacklogChange[];
  stars: { id: number; presenter: { id: number } }[];
}

export interface BacklogIssue {
  id: number;
  issueKey: string;
  projectId: number;
  summary: string;
  description: string;
  createdUser: { id: number; name: string; userId?: string | null };
  created: string;
  updated: string;
}

/**
 * The three shapes `parseMessage` accepts (docs/specs/adapter.md §3.5):
 * a webhook activity, a REST comment fetched for a known project, or a REST
 * issue fetched as a thread's root message. `changes` is always normalised to
 * `BacklogChange`, but the value systems underneath are not unified —
 * webhook `status` changes carry ids and `assigner` changes carry display
 * names, while REST `changeLog` carries display names for both (measured
 * 2026-08-28, docs/specs/adapter.md §3.5) — so consumers read `raw.kind`
 * before interpreting `changes`.
 */
export type BacklogRawMessage =
  | {
      kind: 'webhook';
      host: string;
      payload: BacklogWebhookPayload;
      changes: BacklogChange[];
    }
  | {
      kind: 'comment';
      host: string;
      projectId: number;
      comment: BacklogComment;
      changes: BacklogChange[];
    }
  | { kind: 'issue'; host: string; issue: BacklogIssue; changes: [] };

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
}
