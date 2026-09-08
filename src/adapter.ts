import {
  AdapterError,
  ResourceNotFoundError,
  toBuffer,
  ValidationError,
} from '@chat-adapter/shared';
import { ConsoleLogger, Message as MessageCtor } from 'chat';

import { createBacklogJsTransport } from './client/backlog-js';
import type { Backlog } from 'backlog-js';
import type {
  BacklogApi,
  BacklogCredentials,
  RateLimitSnapshots,
  RetryOptions,
  TextFormattingRule,
} from './client/port';
import {
  addReaction as addReactionToComment,
  bufferStream,
  createChannelIssue,
  editComment,
  postComment,
  removeReaction as removeReactionFromComment,
  requireCommentInThread,
} from './egress';
import { converterFor } from './format/fallback';
import type { FallbackFormatConverter } from './format/fallback';
import {
  channelIdFromThreadId as decodeChannelIdFromThreadId,
  decodeChannelId,
  decodeThreadId as decodeThreadIdString,
  decodeUserId as decodeUserIdString,
  encodeMessageId,
  encodeThreadId as encodeThreadIdStruct,
  validateHost,
} from './ids';
import {
  fetchChannelInfo as fetchChannelInfoRead,
  fetchMessage as fetchMessageRead,
  fetchMessages as fetchMessagesRead,
  fetchSubject as fetchSubjectRead,
  fetchThread as fetchThreadRead,
  getUser as getUserRead,
  listThreads as listThreadsRead,
  markAsRead as markAsReadRead,
  rehydrateAttachment as rehydrateAttachmentRead,
} from './reads';
import type { MessageBuilders } from './reads';
import { subjectClientFor } from './subject/client';
import type { SubjectClient, SubjectNames } from './subject/client';
import { downloadAttachmentAt } from './subject/url';
import type { AttachmentLocation } from './subject/url';
import type {
  BacklogAdapterConfig,
  BacklogBulkUpdatePayload,
  BacklogInstallation,
  BacklogRawMessage,
  BacklogSubjectRef,
  BacklogThreadId,
  BacklogWebhookPayload,
  Resolvable,
  ResolvedCredential,
  ResolvedInstallation,
} from './types';
import {
  buildBulkUpdateMessage,
  bulkMessageId,
  bulkUpdateTargets,
  parseBulkUpdatePayload,
} from './webhook/bulk';
import type { BulkUpdateTarget } from './webhook/bulk';
import { buildInboundMessage } from './webhook/inbound';
import type { IssueMultiUpdatedActivity } from './webhook/payload';
import {
  DISPATCHED_ACTIVITY_TYPES,
  parseActivity,
  parseEnvelope,
  repositoryNameOf,
  subjectOfActivity,
} from './webhook/payload';
import { verifyWebhookRequest } from './webhook/verify';
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChannelInfo,
  ChatInstance,
  FetchOptions,
  FetchResult,
  FileUpload,
  FormattedContent,
  ListThreadsOptions,
  ListThreadsResult,
  Logger,
  Message,
  MessageSubject,
  RawMessage,
  StreamChunk,
  StreamOptions,
  ThreadInfo,
  TypingOptions,
  UserInfo,
  WebhookOptions,
} from 'chat';

/**
 * Builds the `backlog-js`-backed port for one installation.
 *
 * The credential is passed as the resolver itself rather than an already
 * resolved string: the port awaits it on every request and never memoises the
 * result (docs/specs/adapter.md §3.2, §8.2), so a caller whose OAuth token
 * expires hourly refreshes it without reconstructing the adapter. Resolving it
 * here instead would pin the first value for the process's lifetime.
 *
 * The logger is passed as an accessor for the same reason: `initialize`
 * replaces `this.logger` with the `ChatInstance`'s, while `apiCache` keeps the
 * port built before it, so a resolved `Logger` would send the rate-limit lines
 * to the construction-time `ConsoleLogger` forever.
 */
function defaultCreateTransport(
  retry: RetryOptions,
  logger: () => Logger
): (installation: ResolvedInstallation) => AdapterTransport {
  return (installation) =>
    createBacklogJsTransport({
      host: installation.host,
      credentials: toCredentials(installation),
      retry,
      logger,
    });
}

/**
 * What one host's traffic goes through. `client` is absent exactly when the
 * `createApi` seam replaced the port with something that is not
 * `backlog-js`-backed — an in-memory double, typically — because there is then
 * no client to hand out and inventing one would talk to the network from a
 * test.
 */
interface AdapterTransport {
  api: BacklogApi;
  client?: Backlog;
}

/**
 * There is no "neither credential" branch, and none is reachable: an
 * installation is a `ResolvedCredential`, so the compiler narrows the second
 * test to `never` and a third case would be dead code the reader has to
 * reason about (this function used to end in an unreachable `throw`).
 *
 * Each resolvable is copied into a local first because the closure outlives
 * the narrowing — reading `installation.apiKey` inside the arrow would widen
 * back to `Resolvable | undefined`.
 */
function toCredentials(installation: ResolvedInstallation): BacklogCredentials {
  if (installation.apiKey !== undefined) {
    const apiKey = installation.apiKey;
    return { apiKey: () => resolve(apiKey) };
  }
  const accessToken = installation.accessToken;
  return { accessToken: () => resolve(accessToken) };
}

function resolve(resolvable: Resolvable): string | Promise<string> {
  return typeof resolvable === 'function' ? resolvable() : resolvable;
}

const ENV_HOST = 'BACKLOG_HOST';
const ENV_API_KEY = 'BACKLOG_API_KEY';
const ENV_ACCESS_TOKEN = 'BACKLOG_ACCESS_TOKEN';
const ENV_BOT_USER_ID = 'BACKLOG_BOT_USER_ID';
const ENV_BOT_USER_NAME = 'BACKLOG_BOT_USER_NAME';
const ENV_WEBHOOK_SECRET = 'BACKLOG_WEBHOOK_SECRET';

const DEFAULT_MAX_WAIT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024;

function fail(message: string): never {
  throw new ValidationError('backlog', message);
}

/**
 * `Number.isSafeInteger`, not `Number.isInteger`: the id ends up in
 * `encodeUserId`, whose grammar stops at 2^53-1 because a larger value cannot
 * be read back out of an id string (docs/specs/adapter.md §2.1). Accepting
 * one here would defer the same rejection to the first outbound mention.
 */
function validateBotUserId(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer, at most 2^53-1`);
  }
  return value;
}

function parseBotUserIdFromEnv(raw: string, envVar: string): number {
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    fail(
      `environment variable ${envVar} must be a positive integer, at most 2^53-1`
    );
  }
  return Number(raw);
}

function validateBotUserName(value: string, label: string): string {
  if (value.trim().length === 0) {
    fail(`${label} must not be empty`);
  }
  return value;
}

/**
 * The webhook secret is the whole of webhook authenticity when no
 * `webhookVerifier` is configured: Backlog signs nothing, so anyone who can
 * guess the URL can post a payload the adapter will act on
 * (docs/specs/adapter.md §11). Sixteen bytes is the floor at which guessing
 * is not the cheap attack, and it is a construction-time `ValidationError`
 * rather than a warning because config resolution has no logger to warn into
 * and a library must not decide for a deployment that a weak secret is
 * acceptable — the README's `openssl rand -hex 32` produces 64.
 */
const MIN_WEBHOOK_SECRET_BYTES = 16;

function validateWebhookSecret(value: string, label: string): string {
  if (value.length === 0) {
    fail(`${label} must not be empty`);
  }
  if (Buffer.byteLength(value, 'utf8') < MIN_WEBHOOK_SECRET_BYTES) {
    fail(
      `${label} must be at least ${MIN_WEBHOOK_SECRET_BYTES} bytes; generate one with \`openssl rand -hex 32\``
    );
  }
  return value;
}

function validateApiKey(value: string, label: string): string {
  if (value.length === 0) {
    fail(`${label} must not be empty`);
  }
  return value;
}

/**
 * Reads a required string field, in this order: explicit config value (even
 * an empty string, which is a validation error rather than a fallback
 * trigger — docs/specs/adapter.md §3.2), then the environment variable. Both
 * absent names the field and its env var in one message so a misconfigured
 * deployment sees exactly what to set.
 */
function requireWithEnvFallback(
  configValue: string | undefined,
  envVar: string,
  fieldLabel: string
): string {
  if (configValue !== undefined) {
    return configValue;
  }
  const envValue = process.env[envVar];
  if (envValue !== undefined) {
    return envValue;
  }
  fail(`${fieldLabel} is required: set config.${fieldLabel} or ${envVar}`);
}

/**
 * Validates one installation's fields, shared by shape A (after env
 * fallbacks resolve it into this shape) and shape B (each array element).
 * `requireSecret` is false only when `config.webhookVerifier` replaces the
 * secret check for every installation (D2).
 */
function validateInstallation(
  candidate: {
    host: string;
    apiKey?: Resolvable;
    accessToken?: Resolvable;
    botUserId: number;
    botUserName: string;
    webhookSecret?: string;
  },
  requireSecret: boolean
): ResolvedInstallation {
  const host = validateHost(candidate.host, 'host');

  const credential = resolveCredential(candidate);

  const botUserId = validateBotUserId(candidate.botUserId, 'botUserId');
  const botUserName = validateBotUserName(candidate.botUserName, 'botUserName');

  if (requireSecret) {
    if (candidate.webhookSecret === undefined) {
      fail(
        'webhookSecret is required: set config.webhookSecret, an installation webhookSecret, or config.webhookVerifier'
      );
    }
    validateWebhookSecret(candidate.webhookSecret, 'webhookSecret');
  } else if (candidate.webhookSecret !== undefined) {
    validateWebhookSecret(candidate.webhookSecret, 'webhookSecret');
  }

  const resolved: ResolvedInstallation = {
    host,
    botUserId,
    botUserName,
    ...credential,
  };
  if (candidate.webhookSecret !== undefined) {
    resolved.webhookSecret = candidate.webhookSecret;
  }
  return resolved;
}

/**
 * The one place "exactly one of `apiKey`/`accessToken`" is decided
 * (docs/specs/adapter.md §3.2). It returns the credential as a
 * `ResolvedCredential` rather than reporting a verdict about the candidate,
 * so the exclusivity leaves this function as a type and no later reader has
 * to trust that it was checked.
 */
function resolveCredential(candidate: {
  apiKey?: Resolvable;
  accessToken?: Resolvable;
}): ResolvedCredential {
  if (candidate.apiKey !== undefined && candidate.accessToken !== undefined) {
    fail('exactly one of apiKey or accessToken is allowed, not both');
  }
  if (candidate.apiKey !== undefined) {
    if (typeof candidate.apiKey === 'string') {
      validateApiKey(candidate.apiKey, 'apiKey');
    }
    return { apiKey: candidate.apiKey };
  }
  if (candidate.accessToken !== undefined) {
    if (typeof candidate.accessToken === 'string') {
      validateApiKey(candidate.accessToken, 'accessToken');
    }
    return { accessToken: candidate.accessToken };
  }
  fail('exactly one of apiKey or accessToken is required');
}

function resolveShapeA(
  config: BacklogAdapterConfig,
  requireSecret: boolean
): ResolvedInstallation {
  const host = requireWithEnvFallback(config.host, ENV_HOST, 'host');

  // The credential falls back to the environment as a *pair*, not field by
  // field like every other option: `apiKey` and `accessToken` are one
  // mutually exclusive choice, so an explicit one alongside the other's
  // variable is a leftover, never an instruction. Falling back per field made
  // a deployment that moved from OAuth to an API key without unsetting
  // `BACKLOG_ACCESS_TOKEN` fail `validateInstallation`'s "exactly one of
  // apiKey or accessToken" check, blaming the config the caller had just
  // written (docs/specs/adapter.md §3.2).
  const hasExplicitCredential =
    config.apiKey !== undefined || config.accessToken !== undefined;
  const apiKey = hasExplicitCredential
    ? config.apiKey
    : process.env[ENV_API_KEY];
  const accessToken = hasExplicitCredential
    ? config.accessToken
    : process.env[ENV_ACCESS_TOKEN];

  if (apiKey === undefined && accessToken === undefined) {
    fail(
      `apiKey is required: set config.apiKey, config.accessToken, ${ENV_API_KEY}, or ${ENV_ACCESS_TOKEN}`
    );
  }
  if (
    !hasExplicitCredential &&
    apiKey !== undefined &&
    accessToken !== undefined
  ) {
    fail(
      `exactly one of ${ENV_API_KEY} or ${ENV_ACCESS_TOKEN} is allowed, not both`
    );
  }

  const botUserIdSource = config.botUserId;
  let botUserId: number;
  if (botUserIdSource !== undefined) {
    botUserId = botUserIdSource;
  } else {
    const envValue = process.env[ENV_BOT_USER_ID];
    if (envValue === undefined) {
      fail(`botUserId is required: set config.botUserId or ${ENV_BOT_USER_ID}`);
    }
    botUserId = parseBotUserIdFromEnv(envValue, ENV_BOT_USER_ID);
  }

  const botUserName = requireWithEnvFallback(
    config.botUserName,
    ENV_BOT_USER_NAME,
    'botUserName'
  );

  const webhookSecret =
    config.webhookSecret !== undefined
      ? config.webhookSecret
      : process.env[ENV_WEBHOOK_SECRET];

  const candidate: {
    host: string;
    apiKey?: Resolvable;
    accessToken?: Resolvable;
    botUserId: number;
    botUserName: string;
    webhookSecret?: string;
  } = { host, botUserId, botUserName };
  if (apiKey !== undefined) {
    candidate.apiKey = apiKey;
  }
  if (accessToken !== undefined) {
    candidate.accessToken = accessToken;
  }
  if (webhookSecret !== undefined) {
    candidate.webhookSecret = webhookSecret;
  }

  return validateInstallation(candidate, requireSecret);
}

function resolveShapeB(
  installations: BacklogInstallation[],
  requireSecret: boolean
): ResolvedInstallation[] {
  if (installations.length === 0) {
    fail('installations must not be empty');
  }

  const resolved = installations.map((installation) =>
    validateInstallation(installation, requireSecret)
  );

  const seenHosts = new Set<string>();
  for (const installation of resolved) {
    if (seenHosts.has(installation.host)) {
      fail(`duplicate installation host "${installation.host}"`);
    }
    seenHosts.add(installation.host);
  }

  return resolved;
}

/**
 * `Number.isInteger`, not a bare comparison: `NaN < 0` is false, so
 * `maxWaitMs: NaN` passed validation and then made a 429 whose response
 * carried no `X-RateLimit-Reset` retry immediately into the same empty
 * bucket — `decideRetry` compares `waitMs > maxWaitMs`, which is false for
 * `NaN`, and `wait(NaN)` returns at once (`src/client/rate-limit.ts`).
 * `Infinity` fails the same check, which is the point of a ceiling on how
 * long a call may block.
 */
function validateRateLimitConfig(
  rateLimit: BacklogAdapterConfig['rateLimit']
): {
  maxWaitMs: number;
  maxRetries: number;
} {
  const maxWaitMs = rateLimit?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (!Number.isInteger(maxWaitMs) || maxWaitMs < 0) {
    fail('rateLimit.maxWaitMs must be a non-negative integer');
  }

  const maxRetries = rateLimit?.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    fail('rateLimit.maxRetries must be a non-negative integer');
  }

  return { maxWaitMs, maxRetries };
}

function validateMaxWebhookBodyBytes(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MAX_WEBHOOK_BODY_BYTES;
  }
  if (!Number.isInteger(value) || value <= 0) {
    fail('maxWebhookBodyBytes must be a positive integer');
  }
  return value;
}

/**
 * Which project and subject a `BacklogRawMessage` belongs to
 * (docs/specs/adapter.md §7.4): every variant already names both, so
 * `fetchSubject` reaches its subject client without an API call. The webhook
 * variant delegates to `subjectOfActivity` instead of reading `content`
 * itself, so the activity-type-to-subject mapping stays in
 * `src/webhook/payload.ts` alone.
 *
 * This switches on the **raw-message variant**, not on a subject's kind: the
 * four variants carry their coordinates in four different places, which is a
 * fact about `BacklogRawMessage`'s shape rather than kind-specific behaviour,
 * so moving it onto `SubjectClient` would need a subject client before there
 * is anything to build one from.
 */
/**
 * The `messageId` field of a failed-dispatch log line, or nothing when the
 * delivery cannot produce one.
 *
 * `handleWebhook` owes its caller a response from the §5.1 ladder and holds
 * no `try/catch` outside the body parse, so an encoder throwing while
 * building a **log** value would take the response with it: `created` is
 * `z.string()` on the way in, and a delivery carrying `""` would leave the
 * consumer's function rejecting — a 500 the ladder has no entry for — over
 * one field of one log line. The id of the message *itself* is built inside
 * the lazy factory, where the `.catch` on `processMessage` already turns a
 * throw into an error log after the 200 (§5.1 step 12), so nothing is
 * loosened where a failure can be reported.
 *
 * Only the `part: 'update'` form can fail today: the root and comment forms
 * are built from ids `identitySchema` already validated as positive safe
 * integers at step 9, while `created` has no such check until #63 lands.
 * This is written to be total anyway, because the value it guards is a log
 * field and the response is not.
 */
function messageIdForLog(build: () => string): { messageId?: string } {
  try {
    return { messageId: build() };
  } catch {
    return {};
  }
}

function subjectOfRaw(raw: BacklogRawMessage): {
  projectId: number;
  subject: BacklogSubjectRef;
} {
  switch (raw.kind) {
    case 'webhook':
      return {
        projectId: raw.payload.project.id,
        subject: subjectOfActivity(raw.payload),
      };
    case 'bulkUpdate':
      return {
        projectId: raw.payload.project.id,
        subject: { kind: 'issue', issueId: raw.issueId },
      };
    case 'comment':
      return { projectId: raw.projectId, subject: raw.subject };
    case 'issue':
      return {
        projectId: raw.issue.projectId,
        subject: { kind: 'issue', issueId: raw.issue.id },
      };
    case 'pullRequest':
      return {
        projectId: raw.pullRequest.projectId,
        subject: {
          kind: 'pullRequest',
          repositoryId: raw.pullRequest.repositoryId,
          number: raw.pullRequest.number,
        },
      };
  }
}

/**
 * Key of the repository-name cache (docs/specs/adapter.md §7.3). The host
 * comes first so `fetchChannelInfo` can drop a host's names by prefix, and a
 * repository id is all a pull request carries — one function so the three
 * places that build or scan the key cannot drift apart.
 */
function repositoryNameKey(host: string, repositoryId: number): string {
  return `${host}:${repositoryId}`;
}

/**
 * Backlog adapter for Chat SDK; see docs/specs/adapter.md for the full
 * behavioural contract.
 *
 * A thread is a Backlog issue **or** a pull request, and every member reaches
 * Backlog the same way: decode the id, build the `SubjectClient` its subject
 * selects (`src/subject/client.ts`), and call the one implementation of the
 * member that serves both kinds. The class itself owns only what a
 * subject cannot: the per-host installations and ports, the per-channel
 * project cache both formatting and pull-request URLs read, the repository-name
 * cache a pull request's URL needs, and the webhook response ladder.
 *
 * Every optional member the Chat SDK core degrades gracefully around
 * (`.claude/rules/chat-sdk-core-facts.md` "Degradations when optional members
 * are absent") that Backlog cannot actually support — `openDM`,
 * `postEphemeral`, `openModal`, `scheduleMessage`, `reply`,
 * `postObject`/`editObject`, `fetchChannelMessages`, `endTyping`,
 * `disconnect`, `onThreadSubscribe`, `getChannelVisibility`, `lockScope`,
 * `persistThreadHistory`, `supportsTurnCancellation`, `botUserId` — is
 * deliberately absent rather than implemented as a throwing stub, so the
 * core's own fallback behaviour runs instead of a Backlog-specific error.
 */
export class BacklogAdapter implements Adapter<
  BacklogThreadId,
  BacklogRawMessage
> {
  readonly name = 'backlog';
  readonly userName: string;

  private readonly installations: Map<string, ResolvedInstallation>;
  private readonly createTransport: (
    installation: ResolvedInstallation
  ) => AdapterTransport;
  /**
   * `rateLimit`/`maxWebhookBodyBytes`/`webhookVerifier` are validated in the
   * constructor (docs/specs/adapter.md §3.2) and read by `handleWebhook` and
   * by the port factory; grouped into one field rather than three, since they
   * travel together as "config the constructor validates for someone else".
   */
  private readonly ingressConfig: {
    rateLimit: { maxWaitMs: number; maxRetries: number };
    maxWebhookBodyBytes: number;
    webhookVerifier: BacklogAdapterConfig['webhookVerifier'];
  };
  private readonly apiCache = new Map<string, AdapterTransport>();
  /**
   * `channelId -> { projectKey, textFormattingRule }` (docs/specs/adapter.md
   * §9.1, §7.3, D14): populated by one Get Project per channel and cached
   * forever; `fetchChannelInfo` is the documented way to replace an entry.
   * Keyed on the channel id string rather than `{host, projectId}` so the same
   * map serves `ensureProject`, `renderFormatted` and `parseMessage` without
   * re-deriving the key shape in three places.
   *
   * `projectKey` rides along because Get Project returns it in the same
   * response the formatting rule comes from, and a pull request's web URL
   * needs it (`.claude/rules/backlog-pull-request-facts.md` "Addressing" — the
   * pull-request object carries neither name its URL is built from), so
   * keeping it costs nothing and saves a second lookup.
   */
  private readonly projectCache = new Map<
    string,
    { projectKey: string; textFormattingRule: TextFormattingRule }
  >();
  /**
   * `` `${host}:${repositoryId}` -> repository name `` (docs/specs/adapter.md
   * §7.3): the other half of a pull request's web URL. Filled on a miss by one
   * Get Git Repository (read bucket) and, from P3, for free from every
   * pull-request webhook's `content.repository.name`. A failed lookup is not
   * cached — the next read gets to try again rather than being pinned to a
   * URL-less answer for the process's lifetime.
   */
  private readonly repositoryNameCache = new Map<string, string>();
  /**
   * `channelId -> { issueTypeId, priorityId }` (docs/specs/adapter.md §6.7):
   * `postChannelMessage`'s defaults, cached forever like the formatting-rule
   * cache above and refreshed the same two ways — a `ValidationError` on a
   * create that used the cached values (the narrow one-shot retry), or
   * `fetchChannelInfo` replacing it outright alongside the formatting rule.
   */
  private readonly channelDefaultsCache = new Map<
    string,
    { issueTypeId: number; priorityId: number }
  >();

  private logger: Logger;
  private chat: ChatInstance | undefined;

  constructor(config: BacklogAdapterConfig = {}) {
    const shapeBFields = config.installations;
    const shapeAFieldsPresent =
      config.host !== undefined ||
      config.apiKey !== undefined ||
      config.accessToken !== undefined ||
      config.botUserId !== undefined ||
      config.botUserName !== undefined ||
      config.webhookSecret !== undefined;

    if (shapeBFields !== undefined && shapeAFieldsPresent) {
      fail(
        'installations and single-space fields (host, apiKey, accessToken, botUserId, botUserName, webhookSecret) are mutually exclusive'
      );
    }

    const requireSecret = config.webhookVerifier === undefined;

    const resolvedInstallations: ResolvedInstallation[] =
      shapeBFields !== undefined
        ? resolveShapeB(shapeBFields, requireSecret)
        : [resolveShapeA(config, requireSecret)];

    this.installations = new Map(
      resolvedInstallations.map((installation) => [
        installation.host,
        installation,
      ])
    );

    const firstInstallation = resolvedInstallations[0];
    if (firstInstallation === undefined) {
      // resolveShapeA always returns exactly one installation and
      // resolveShapeB rejects an empty array above, so this is unreachable —
      // the check exists only to satisfy noUncheckedIndexedAccess.
      fail('at least one installation is required');
    }

    this.userName =
      config.userName !== undefined
        ? validateBotUserName(config.userName, 'userName')
        : firstInstallation.botUserName;

    this.ingressConfig = {
      rateLimit: validateRateLimitConfig(config.rateLimit),
      maxWebhookBodyBytes: validateMaxWebhookBodyBytes(
        config.maxWebhookBodyBytes
      ),
      webhookVerifier: config.webhookVerifier,
    };
    this.logger = config.logger ?? new ConsoleLogger('info').child('backlog');
    const createApi = config.createApi;
    this.createTransport =
      createApi === undefined
        ? defaultCreateTransport(
            this.ingressConfig.rateLimit,
            () => this.logger
          )
        : (installation) => ({ api: createApi(installation) });
  }

  /**
   * Stores the `ChatInstance` and swaps to its logger (docs/specs/adapter.md
   * §4.1); makes no API call. Storing `chat` ahead of any member that reads
   * it is deliberate: `initialize` runs once, long before the webhook (P3)
   * dispatch that needs it, and the core tolerates construction happening
   * long before `initialize` (`.claude/rules/chat-sdk-core-facts.md`). The
   * summary line gives an operator one log entry confirming which host(s)
   * and ingress limits this instance came up with, without requiring the
   * reader to have a debugger attached to inspect construction.
   */
  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger('backlog');
    this.logger.debug(
      `initialized for host(s) ${[...this.installations.keys()].join(', ')}` +
        ` (chat=${this.chat !== undefined},` +
        ` maxWebhookBodyBytes=${this.ingressConfig.maxWebhookBodyBytes},` +
        ` webhookVerifier=${this.ingressConfig.webhookVerifier !== undefined})`
    );
  }

  encodeThreadId(platformData: BacklogThreadId): string {
    return encodeThreadIdStruct(platformData);
  }

  decodeThreadId(threadId: string): BacklogThreadId {
    return decodeThreadIdString(threadId);
  }

  channelIdFromThreadId(threadId: string): string {
    return decodeChannelIdFromThreadId(threadId);
  }

  isDM(_threadId: string): boolean {
    return false;
  }

  async startTyping(
    _threadId: string,
    _status?: string,
    _options?: TypingOptions
  ): Promise<void> {
    // Backlog has no typing indicator (docs/specs/adapter.md §4.1); the
    // member is required by the Adapter interface, so it resolves immediately.
  }

  /**
   * Resolved installation lookup, used by `api()` and (later) every egress
   * member that needs a per-host client. `Map<host, ...>` because shape A is
   * modelled as a single-entry installation map internally, so this is the
   * one place that knows the difference between shape A and B.
   */
  private resolveInstallation(host: string): ResolvedInstallation {
    const installation = this.installations.get(host);
    if (installation === undefined) {
      this.logger.warn(`no installation configured for host "${host}"`);
      throw new ResourceNotFoundError('backlog', 'installation', host);
    }
    return installation;
  }

  api(host: string): BacklogApi {
    return this.transport(host).api;
  }

  /**
   * The `backlog-js` client this adapter's own traffic goes through, for the
   * Backlog endpoints the port does not name — changing an assignee, reading
   * an issue's custom fields, anything else a bot needs and the adapter does
   * not.
   *
   * It is handed out rather than left to the caller to construct because a
   * second client would spend the same per-user rate limit without counting
   * it: this one carries the adapter's bucket accounting, its bounded 429
   * retry, its `@chat-adapter/shared` error mapping and its per-call
   * credential resolution (docs/specs/adapter.md §3.1, §8.2). It holds no
   * credential of its own, so it is safe to keep past the call that asked for
   * it.
   */
  client(host: string): Backlog {
    const { client } = this.transport(host);
    if (client === undefined) {
      throw new AdapterError(
        'no Backlog client: this adapter was constructed with a custom `createApi`, which replaces the `backlog-js`-backed port',
        'backlog',
        'NO_CLIENT'
      );
    }
    return client;
  }

  private transport(host: string): AdapterTransport {
    const installation = this.resolveInstallation(host);
    let transport = this.apiCache.get(host);
    if (transport === undefined) {
      transport = this.createTransport(installation);
      this.apiCache.set(host, transport);
    }
    return transport;
  }

  /**
   * The `X-RateLimit-*` headers **this adapter instance** observed for that
   * host, per bucket (`BacklogApi.rateLimit`). It is empty until this instance
   * has made a request and never learns about traffic from another one, so
   * where instances are short-lived — one per serverless invocation, say —
   * ask the space instead: `adapter.api(host).getRateLimit()`.
   */
  rateLimit(host: string): RateLimitSnapshots {
    return this.api(host).rateLimit();
  }

  /**
   * The bot's display name on that installation (docs/specs/adapter.md §3.3).
   * `userName` is one string for the whole adapter — the first installation's
   * name — so a consumer running several spaces under different display names
   * cannot build or match its own mention string from it. Only the name is
   * exposed, not the installation: `botUserId` stays private (§3.3) and a
   * credential must never leave through a getter.
   */
  botUserName(host: string): string {
    return this.resolveInstallation(host).botUserName;
  }

  /**
   * Synchronous and cache-only (docs/specs/adapter.md §9.1, D14): `target`,
   * when given, is a thread **or channel** id (§4.1) whose formatting rule
   * `ensureProject` (webhook ingress) or `getConverter` (egress) may already
   * have cached. An absent `target`, a channel this instance has never talked
   * to, and a `target` in neither grammar all fall back to Markdown with one
   * `warn` rather than blocking this synchronous interface method on a network
   * call the caller cannot await.
   */
  renderFormatted(content: FormattedContent, target?: string): string {
    const channelId =
      target === undefined ? undefined : this.channelIdOfTarget(target);
    const rule =
      channelId === undefined
        ? undefined
        : this.projectCache.get(channelId)?.textFormattingRule;

    if (rule === undefined) {
      this.logger.warn('textFormattingRule uncached; assuming markdown', {
        target,
      });
    }

    const context =
      channelId === undefined
        ? { host: '', projectId: 0 }
        : decodeChannelId(channelId);
    return converterFor(rule ?? 'markdown', this.logger, context).fromAst(
      content
    );
  }

  /**
   * The channel a `renderFormatted` target names, from either grammar §4.1
   * allows, or `undefined` when it is neither.
   *
   * An unrecognised `target` returns rather than throws: this member's whole
   * contract is "render with the cached rule if there is one, Markdown
   * otherwise", so an id that resolves to no cache entry and an id that
   * resolves to no channel at all are the same answer to the caller. Throwing
   * a `ValidationError` out of a synchronous render would be a harder failure
   * than the missing-cache case it is indistinguishable from.
   */
  private channelIdOfTarget(target: string): string | undefined {
    try {
      return decodeChannelIdFromThreadId(target);
    } catch {
      // Not a thread id; a channel id is equally legal here.
    }
    try {
      decodeChannelId(target);
      return target;
    } catch {
      return undefined;
    }
  }

  /**
   * Populates the §9.1/§7.3 project cache for `channelId` with one Get
   * Project call, unless an entry already exists — the cache is forever
   * until `fetchChannelInfo` replaces it, so a second webhook for the
   * same project must not spend a `read`-bucket call repeating a lookup this
   * method already made. A lookup failure is not cached (`PermissionError`,
   * `NetworkError`, …): the next call gets to try again rather than being
   * pinned to a guess for the process's lifetime.
   */
  private async ensureProject(host: string, projectId: number): Promise<void> {
    const channelId = `backlog:${host}:${projectId}`;
    if (this.projectCache.has(channelId)) {
      return;
    }
    try {
      const project = await this.api(host).getProject(projectId);
      this.projectCache.set(channelId, {
        projectKey: project.projectKey,
        textFormattingRule: project.textFormattingRule,
      });
    } catch (cause) {
      this.logger.warn('textFormattingRule lookup failed; assuming markdown', {
        host,
        projectId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  /**
   * Resolves the converter an egress call renders through: awaits
   * `ensureProject` (a single cached Get Project per channel, §9.1)
   * and wraps the result in the §9.2 fallback. Every egress member reaches
   * Backlog through this so a notation project renders `''bold''` instead of
   * `**bold**` on the very first post to a channel, not just once the cache
   * happens to be warm.
   */
  private async getConverter(
    host: string,
    projectId: number
  ): Promise<FallbackFormatConverter> {
    await this.ensureProject(host, projectId);
    const channelId = `backlog:${host}:${projectId}`;
    const rule =
      this.projectCache.get(channelId)?.textFormattingRule ?? 'markdown';
    return converterFor(rule, this.logger, { host, projectId });
  }

  /**
   * Synchronous converter selection, for the one caller that cannot await:
   * `parseMessage` is a synchronous member of the `Adapter` interface, so a
   * cold cache is a warning and the §9.2 markdown default rather than the Get
   * Project a read would spend. Every read resolves through `getConverter`.
   */
  private cachedConverter(
    host: string,
    projectId: number
  ): FallbackFormatConverter {
    const channelId = `backlog:${host}:${projectId}`;
    const rule = this.projectCache.get(channelId)?.textFormattingRule;
    if (rule === undefined) {
      this.logger.warn('textFormattingRule uncached; assuming markdown', {
        host,
        projectId,
      });
    }
    return converterFor(rule ?? 'markdown', this.logger, { host, projectId });
  }

  /**
   * The seam every member goes through: one `SubjectClient` for the issue or
   * pull request an id names (docs/plans/pull-request-support.md §3.4). The
   * kind is dispatched inside `subjectClientFor` and nowhere else, so nothing
   * in this class asks what it is holding.
   */
  private subjectClient(
    host: string,
    projectId: number,
    subject: BacklogSubjectRef
  ): SubjectClient {
    return subjectClientFor(this.api(host), subject, { host, projectId });
  }

  /**
   * The half of `MessageBuilders` (`src/reads.ts`) that is per host rather
   * than per subject; each read completes it with the coordinates it decoded.
   */
  private messageBuilders(
    host: string,
    converter: FallbackFormatConverter
  ): Omit<MessageBuilders, 'projectId' | 'subject'> {
    return {
      host,
      botUserId: this.resolveInstallation(host).botUserId,
      format: (text) => converter.toAst(text),
      MessageCtor,
    };
  }

  /** `subjectClient` for a thread id, with the coordinates it decoded to. */
  private subjectFor(threadId: string): {
    host: string;
    projectId: number;
    subject: SubjectClient;
  } {
    const { host, projectId, subject } = decodeThreadIdString(threadId);
    return {
      host,
      projectId,
      subject: this.subjectClient(host, projectId, subject),
    };
  }

  /**
   * The display names a subject's web URL needs and its REST object does not
   * carry (docs/specs/adapter.md §7.3). Neither lookup is allowed to fail the
   * read that asked for it: an unresolved name yields a `ThreadInfo` or
   * `MessageSubject` without a `url`, which both types allow.
   *
   * The kind never appears here — `repositoryIdForName` is `undefined` for a
   * subject whose URL needs no repository, so "which names does this subject
   * need" is answered by the subject itself rather than by a branch that would
   * have to be kept in step with a third kind.
   *
   * That one member gates the **project key** too, so a subject that needs no
   * repository name spends no Get Project either: §7.3 budgets an issue thread
   * exactly one Get Issue and §7.4 no call at all for a `kind: "issue"` raw,
   * and the issue client reads nothing off `SubjectNames` — it derives its own
   * project key from `issueKey`. Looking the key up regardless bought a
   * `read`-bucket call per issue thread and reported its failure as
   * "textFormattingRule lookup failed", from a read that has nothing to do
   * with formatting. If a kind ever needs the project key without a
   * repository, give `SubjectClient` a second member for it rather than
   * restoring the unconditional lookup.
   */
  private async namesFor(
    host: string,
    projectId: number,
    subject: SubjectClient
  ): Promise<SubjectNames> {
    const repositoryId = subject.repositoryIdForName;
    if (repositoryId === undefined) {
      return {};
    }
    await this.ensureProject(host, projectId);
    return {
      projectKey: this.projectCache.get(`backlog:${host}:${projectId}`)
        ?.projectKey,
      repositoryName: await this.repositoryName(host, projectId, repositoryId),
    };
  }

  /**
   * A git repository's display name, cached per host (docs/specs/adapter.md
   * §7.3). A failed lookup is **not** cached and is reported once as a `warn`:
   * the caller then omits the URL rather than failing, and the next call may
   * find the repository readable again (a permission change, a transient
   * network failure).
   */
  private async repositoryName(
    host: string,
    projectId: number,
    repositoryId: number
  ): Promise<string | undefined> {
    const key = repositoryNameKey(host, repositoryId);
    const cached = this.repositoryNameCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const repository = await this.api(host).getGitRepository(
        projectId,
        repositoryId
      );
      this.repositoryNameCache.set(key, repository.name);
      return repository.name;
    } catch (cause) {
      this.logger.warn('repository name lookup failed; url omitted', {
        host,
        projectId,
        repositoryId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return undefined;
    }
  }

  /**
   * `toBuffer`'s `platform: PlatformName` has no `"backlog"` member
   * (`@chat-adapter/shared@4.39.0`) and its default `throwOnUnsupported: true`
   * throws a `ValidationError` named after whichever platform was passed, so
   * the default would blame `"slack"` for a caller's unsupported `file.data`
   * and never reach the error below. `throwOnUnsupported: false` turns the
   * unsupported case into `null`, which leaves `platform` selecting wording
   * that is never rendered and keeps every error this adapter throws named
   * `"backlog"` (#48; the same trade-off on `cardToFallbackText` is in
   * `resolveSummaryAndDescription`, `egress.ts`).
   */
  private toFileBuffer = async (file: FileUpload): Promise<Buffer> => {
    const buffer = await toBuffer(file.data, {
      platform: 'slack',
      throwOnUnsupported: false,
    });
    if (buffer === null) {
      throw new ValidationError(
        'backlog',
        `file "${file.filename}" has unsupported data; expected a Buffer, an ArrayBuffer or a Blob`
      );
    }
    return buffer;
  };

  async handleWebhook(
    request: Request,
    options?: WebhookOptions
  ): Promise<Response> {
    const verification = await verifyWebhookRequest({
      request,
      maxWebhookBodyBytes: this.ingressConfig.maxWebhookBodyBytes,
      webhookVerifier: this.ingressConfig.webhookVerifier,
      installations: this.installations,
      logger: this.logger,
    });

    if (!verification.ok) {
      return new Response(verification.body, { status: verification.status });
    }

    const { host, installation, rawBody } = verification;

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      this.logger.warn('webhook rejected', { reason: 'invalid_json' });
      return new Response('Invalid JSON', { status: 400 });
    }
    if (typeof parsedBody !== 'object' || parsedBody === null) {
      this.logger.warn('webhook rejected', { reason: 'invalid_json' });
      return new Response('Invalid JSON', { status: 400 });
    }

    const envelope = parseEnvelope(parsedBody);
    if (envelope === null) {
      this.logger.warn('webhook rejected', { reason: 'invalid_envelope' });
      return new Response('Invalid payload', { status: 400 });
    }

    if (
      !(DISPATCHED_ACTIVITY_TYPES as readonly number[]).includes(envelope.type)
    ) {
      this.logger.info('webhook ignored', { host, type: envelope.type });
      return new Response('Ignored', { status: 200 });
    }

    const parsed = parseActivity(envelope.type, parsedBody);
    if ('issuePaths' in parsed) {
      this.logger.warn('webhook rejected', {
        reason: 'invalid_payload',
        issuePaths: parsed.issuePaths,
      });
      return new Response('Invalid payload', { status: 400 });
    }
    const { activity } = parsed;
    // `raw.payload` must be the body as Backlog sent it, unknown keys
    // included (docs/specs/adapter.md §5.2 "not a stripped copy") — `zod`
    // strips fields a schema does not name, so `activity` above (its output)
    // is never what reaches a message; `parsedBody` is.
    const rawPayload = parsedBody as BacklogWebhookPayload;

    if (this.chat === undefined) {
      this.logger.error('webhook rejected: adapter not initialized');
      return new Response('Adapter not initialized', { status: 503 });
    }
    const chat = this.chat;

    if (activity.type === 14) {
      // Answered before `subjectOfActivity` rather than inside it: a bulk
      // update names one issue per `content.link[]` entry, so there is no
      // single subject to build a thread id from, and the narrowing this
      // branch performs is what lets everything below keep assuming there is.
      return this.dispatchBulkUpdate({
        activity,
        payload: parsedBody as BacklogBulkUpdatePayload,
        host,
        botUserId: installation.botUserId,
        chat,
        options,
      });
    }

    const subject = subjectOfActivity(activity);
    const threadId = encodeThreadIdStruct({
      host,
      projectId: activity.project.id,
      subject,
    });

    if (activity.createdUser.id === installation.botUserId) {
      this.logger.debug('self message skipped', { host, threadId });
      return new Response('OK', { status: 200 });
    }

    // Every pull-request delivery carries `content.repository.name`, which the
    // REST pull-request object carries nowhere and the §7.3 web URL needs
    // (measured 2026-09-06, `.claude/rules/backlog-pull-request-facts.md`
    // "Addressing"). Caching it here rather than on the read side is what
    // spares the next `fetchThread` a Get Git Repository, so it happens before
    // the response returns, not inside the dispatched factory.
    const repository = repositoryNameOf(activity);
    if (repository !== undefined) {
      this.repositoryNameCache.set(
        repositoryNameKey(host, repository.repositoryId),
        repository.name
      );
    }

    if (activity.type === 4) {
      const channelId = decodeChannelIdFromThreadId(threadId);
      const messageId = encodeMessageId({ host, subject, part: 'root' });
      // The core registers this promise with `options.waitUntil` itself
      // (docs/specs/adapter.md §5.1); the response below returns
      // immediately regardless of how long that processing takes.
      // Wrapped in `Promise.resolve` because `ChatInstance` is an interface,
      // not a guarantee: `createMockChatInstance`'s default `processMessageDeleted`
      // is `vi.fn()` with no implementation, which returns `undefined` rather
      // than a promise, and `undefined.catch` throws synchronously.
      void Promise.resolve(
        chat.processMessageDeleted(
          {
            adapter: this,
            platform: 'backlog',
            channelId,
            threadId,
            messageId,
            raw: { kind: 'webhook', host, payload: rawPayload, changes: [] },
            deletedAt: new Date(activity.created),
          },
          options
        )
      ).catch((cause: unknown) => {
        this.logger.error('inbound processing failed', {
          host,
          threadId,
          messageId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
      return new Response('OK', { status: 200 });
    }

    const factory = async (): Promise<Message<BacklogRawMessage>> => {
      await this.ensureProject(host, activity.project.id);
      return this.parseMessage({
        kind: 'webhook',
        host,
        payload: rawPayload,
        changes: [],
      });
    };

    const idForLog = messageIdForLog(() =>
      activity.type === 1 || activity.type === 18
        ? encodeMessageId({ host, subject, part: 'root' })
        : activity.content.comment !== null &&
            activity.content.comment !== undefined
          ? encodeMessageId({
              host,
              subject,
              part: 'comment',
              commentId: activity.content.comment.id,
            })
          : encodeMessageId({
              host,
              subject,
              part: 'update',
              created: activity.created,
            })
    );

    // Dispatched, not awaited: the response below must return before
    // processing completes (docs/specs/adapter.md §5.1 step 12). A factory
    // that throws is logged here rather than left to reject unhandled,
    // because the core swallows the rejection for `waitUntil` but this is
    // the only place that knows which host/issue/message it was for.
    // `Promise.resolve(...)` guards the same mock-return-value gap noted on
    // the type-4 branch above.
    void Promise.resolve(
      chat.processMessage(this, threadId, factory, options)
    ).catch((cause: unknown) => {
      this.logger.error('inbound processing failed', {
        host,
        threadId,
        ...idForLog,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });

    return new Response('OK', { status: 200 });
  }

  /**
   * Type 14 — one delivery, one message per issue it touched
   * (docs/specs/adapter.md §5.3, D22).
   *
   * The loop dispatches N times into N threads, which is the whole point: a
   * bulk update of twelve issues is twelve issues whose status changed, and a
   * handler that reacts per thread has to be told twelve times. It is also the
   * cost — a handler that calls the API per message spends N calls out of a
   * per-minute bucket from a single webhook — which is why the README says so
   * where activity type 14 is registered, and why leaving 14 unregistered is
   * the documented way out (D-PR4).
   *
   * The self-message check is repeated here rather than being hoisted above
   * this branch: §5.1 step 11 logs the thread id it skipped, and this branch
   * has no single thread id to log.
   */
  private dispatchBulkUpdate(input: {
    activity: IssueMultiUpdatedActivity;
    payload: BacklogBulkUpdatePayload;
    host: string;
    botUserId: number;
    chat: ChatInstance;
    options: WebhookOptions | undefined;
  }): Response {
    const { activity, payload, host, botUserId, chat, options } = input;

    if (activity.createdUser.id === botUserId) {
      this.logger.debug('self message skipped', {
        host,
        projectId: activity.project.id,
        type: 14,
      });
      return new Response('OK', { status: 200 });
    }

    const targets = bulkUpdateTargets(activity);
    if (targets.length === 0) {
      return new Response('OK', { status: 200 });
    }

    // One lookup shared by every factory, rather than `ensureProject` per
    // factory as the single-subject path does. The factories run concurrently
    // in separate threads, so on a cold cache each of them would miss and a
    // batch of fifty issues would spend fifty Get Project calls on one
    // project. `ensureProject` never rejects (it logs and falls back), so this
    // promise needs no `.catch` of its own; it is started rather than awaited,
    // so the response below still does not wait for it.
    const projectReady = this.ensureProject(host, activity.project.id);

    for (const target of targets) {
      const subject: BacklogSubjectRef = {
        kind: 'issue',
        issueId: target.issueId,
      };
      const threadId = encodeThreadIdStruct({
        host,
        projectId: activity.project.id,
        subject,
      });
      const factory = async (): Promise<Message<BacklogRawMessage>> => {
        await projectReady;
        return this.buildValidatedBulkUpdateMessage(
          activity,
          target,
          host,
          payload
        );
      };
      // The same function the message itself is built with, so the id logged
      // for a failed dispatch is the id the handler would have seen — and
      // guarded, because this one runs before the response rather than inside
      // the factory (see `messageIdForLog`).
      const idForLog = messageIdForLog(() =>
        bulkMessageId(host, subject, target, activity.created)
      );

      // Dispatched per issue and never awaited, exactly as the single-subject
      // path below; the response returns before any of them completes.
      void Promise.resolve(
        chat.processMessage(this, threadId, factory, options)
      ).catch((cause: unknown) => {
        this.logger.error('inbound processing failed', {
          host,
          threadId,
          ...idForLog,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    }

    return new Response('OK', { status: 200 });
  }

  parseMessage(raw: BacklogRawMessage): Message<BacklogRawMessage> {
    if (raw.kind === 'bulkUpdate') {
      return this.parseBulkUpdateMessage(raw);
    }
    if (raw.kind !== 'webhook') {
      // P5 (REST comment/issue -> Message) and P3 (webhook) share the
      // `BacklogRawMessage` union, but this phase only ever constructs the
      // `webhook` variant; a non-webhook raw reaching here would be a defect
      // in the caller, not a recoverable input.
      throw new ValidationError(
        'backlog',
        `parseMessage: unsupported raw message kind "${raw.kind}"`
      );
    }

    const { host, payload } = raw;
    const installation = this.resolveInstallation(host);

    // Re-validated rather than read through its declared type, for the reason
    // `parseBulkUpdatePayload` re-parses a bulk delivery: `raw.payload` is the
    // body as received (§5.2 "not a stripped copy") and that type is reached
    // by a cast, so nothing the schema decided has reached this value. Reading
    // it directly made `notifications`' `[]` fallback unreachable at run time
    // — a delivery without the key threw inside the dispatched factory, after
    // the 200 had been sent, and the message was lost rather than falling back
    // to the textual and assignment rules (§5.4 rule 6).
    const parsed = parseActivity(payload.type, payload);
    if ('issuePaths' in parsed) {
      throw new ValidationError(
        'backlog',
        `parseMessage: raw.payload is not a valid type ${payload.type} activity`
      );
    }
    const { activity } = parsed;
    // Stated as "not a deletion, not a bulk update" rather than as the list of
    // types §5.3 does map, although either form narrows: a positive list
    // silently drops a type added to `ParsedActivity` later, while excluding
    // these two lets it through to `buildInboundMessage` below, where it is a
    // compile error until §5.3 has a mapping row for it.
    if (activity.type === 4 || activity.type === 14) {
      throw new ValidationError(
        'backlog',
        `parseMessage: activity type ${activity.type} produces no message`
      );
    }

    const converter = this.cachedConverter(host, activity.project.id);

    return buildInboundMessage(
      activity,
      {
        host,
        botUserId: installation.botUserId,
        botUserName: installation.botUserName,
        subject: this.subjectClient(
          host,
          activity.project.id,
          subjectOfActivity(activity)
        ),
        payload,
        format: (text) => converter.toAst(text),
      },
      MessageCtor
    );
  }

  /**
   * One issue of a bulk update as a `Message` (docs/specs/adapter.md §5.3).
   *
   * `raw.issueId` selects the `content.link[]` entry instead of an index into
   * it, so a `raw` that outlived its delivery — through the core's
   * queue/debounce JSON round trip, or a redelivery arriving in another order
   * — still resolves to the same issue. An id that is no longer in the batch
   * is a `raw` that was assembled by hand, not a payload defect.
   */
  private parseBulkUpdateMessage(
    raw: Extract<BacklogRawMessage, { kind: 'bulkUpdate' }>
  ): Message<BacklogRawMessage> {
    const { host, payload, issueId } = raw;

    const activity = parseBulkUpdatePayload(payload);
    if (activity === null) {
      throw new ValidationError(
        'backlog',
        'parseMessage: raw.payload is not a type 14 activity'
      );
    }

    const target = bulkUpdateTargets(activity).find(
      (candidate) => candidate.issueId === issueId
    );
    if (target === undefined) {
      throw new ValidationError(
        'backlog',
        `parseMessage: issue ${issueId} is not in this bulk update`
      );
    }

    return this.buildValidatedBulkUpdateMessage(
      activity,
      target,
      host,
      payload
    );
  }

  /**
   * Builds one type-14 message from the activity and target already validated
   * by ingress. The webhook factories close over these values, so an N-item
   * delivery pays one schema pass and one O(N) target projection in total;
   * `parseMessage(raw)` still revalidates serialised or hand-built raw input.
   */
  private buildValidatedBulkUpdateMessage(
    activity: IssueMultiUpdatedActivity,
    target: BulkUpdateTarget,
    host: string,
    payload: BacklogBulkUpdatePayload
  ): Message<BacklogRawMessage> {
    const installation = this.resolveInstallation(host);
    const converter = this.cachedConverter(host, activity.project.id);

    return buildBulkUpdateMessage(
      activity,
      target,
      {
        host,
        botUserId: installation.botUserId,
        botUserName: installation.botUserName,
        payload,
        format: (text) => converter.toAst(text),
      },
      MessageCtor
    );
  }

  /**
   * Downloads one attachment a serialised `Attachment` URL still points at
   * (docs/specs/adapter.md §6.6). Only `rehydrateAttachment` needs this:
   * every attachment built from a webhook or a REST comment already carries
   * the `fetchData` its subject client closed over. The port maps every
   * failure to a `@chat-adapter/shared` error, so `fetchData()` never throws a
   * `backlog-js` type to a consumer.
   */
  private readonly downloadAttachment = (
    host: string,
    location: AttachmentLocation
  ): Promise<Buffer> => downloadAttachmentAt(this.api(host), location);

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<BacklogRawMessage>> {
    const { host, projectId, subject } = this.subjectFor(threadId);
    const converter = await this.getConverter(host, projectId);
    return postComment({
      host,
      projectId,
      subject,
      api: this.api(host),
      converter,
      message,
      toBuffer: this.toFileBuffer,
    });
  }

  /**
   * The comment `messageId` names is edited on the **thread's** subject, and
   * a `messageId` naming another host or another subject is rejected rather
   * than followed: a message id is self-contained (docs/specs/adapter.md §2),
   * so an id from another subject must not be silently re-pointed at the
   * thread's own — nor must the thread be silently re-pointed at the id's
   * (§6 preamble; `requireCommentInThread` in `src/egress.ts`).
   */
  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<BacklogRawMessage>> {
    const { host, projectId, subject, commentId } = requireCommentInThread(
      threadId,
      messageId,
      'edited'
    );
    const converter = await this.getConverter(host, projectId);
    return editComment({
      host,
      projectId,
      subject: this.subjectClient(host, projectId, subject),
      commentId,
      converter,
      message,
    });
  }

  /**
   * Delegates to the subject client without asking what kind it is: deleting a
   * pull-request comment is refused there, before any request, because Backlog
   * has no endpoint for it (docs/specs/adapter.md §6.3, D-PR3).
   */
  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const { host, projectId, subject, commentId } = requireCommentInThread(
      threadId,
      messageId,
      'deleted'
    );
    await this.subjectClient(host, projectId, subject).deleteComment(commentId);
  }

  /**
   * Buffers the whole stream into one `postMessage` call
   * (docs/specs/adapter.md §6.4, D4; CLAUDE.md "`stream()` must be
   * overridden"): the core's fallback would otherwise edit a message every
   * `streamingUpdateIntervalMs` (default 500 ms), which is roughly 120
   * `updateComment` calls a minute against a documented example 150/min
   * update-bucket limit. An empty stream — an `options.signal` abort that
   * buffered nothing included — still posts `" "` (D4 default, matching the
   * core's own fallback) so a `SentMessage` always exists for the caller to
   * reference (§15 question 7).
   */
  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    options?: StreamOptions
  ): Promise<RawMessage<BacklogRawMessage>> {
    const buffered = await bufferStream(textStream, options?.signal);
    return this.postMessage(threadId, {
      markdown: buffered.length > 0 ? buffered : ' ',
    });
  }

  async addReaction(
    threadId: string,
    messageId: string,
    _emoji: string
  ): Promise<void> {
    const { host, projectId, subject, commentId } = requireCommentInThread(
      threadId,
      messageId,
      'starred'
    );
    await addReactionToComment({
      api: this.api(host),
      subject: this.subjectClient(host, projectId, subject),
      commentId,
      botUserId: this.resolveInstallation(host).botUserId,
    });
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    _emoji: string
  ): Promise<void> {
    const { host, projectId, subject, commentId } = requireCommentInThread(
      threadId,
      messageId,
      'starred'
    );
    await removeReactionFromComment({
      api: this.api(host),
      subject: this.subjectClient(host, projectId, subject),
      commentId,
      botUserId: this.resolveInstallation(host).botUserId,
    });
  }

  async fetchMessages(
    threadId: string,
    options?: FetchOptions
  ): Promise<FetchResult<BacklogRawMessage>> {
    const { host, projectId, subject } = this.subjectFor(threadId);
    const converter = await this.getConverter(host, projectId);
    return fetchMessagesRead({
      threadId,
      options,
      subject,
      builders: this.messageBuilders(host, converter),
    });
  }

  async fetchMessage(
    threadId: string,
    messageId: string
  ): Promise<Message<BacklogRawMessage> | null> {
    const { host, projectId, subject } = this.subjectFor(threadId);
    return fetchMessageRead({
      threadId,
      messageId,
      subject,
      // Deferred so an id §7.2 answers `null` for still costs nothing: this
      // resolves the project's formatting rule, and `fetchMessageRead` only
      // calls it once it is going to build a message.
      builders: async () =>
        this.messageBuilders(host, await this.getConverter(host, projectId)),
    });
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { host, projectId, subject } = this.subjectFor(threadId);
    return fetchThreadRead({
      threadId,
      subject,
      names: await this.namesFor(host, projectId, subject),
    });
  }

  /**
   * `postChannelMessage` (docs/specs/adapter.md §6.7): creates an issue from
   * a channel-level post. `issueTypeId`/`priorityId` default resolution and
   * the narrow retry-once-on-stale-cache rule live in `createChannelIssue`
   * (`src/egress.ts`); this method's job is only to own the per-channel
   * defaults cache the way `getConverter`/`ensureProject` own the
   * project cache above.
   */
  async postChannelMessage(
    channelId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<BacklogRawMessage>> {
    const { host, projectId } = decodeChannelId(channelId);
    const converter = await this.getConverter(host, projectId);
    return createChannelIssue({
      host,
      projectId,
      api: this.api(host),
      converter,
      message,
      toBuffer: this.toFileBuffer,
      getCachedDefaults: () => this.channelDefaultsCache.get(channelId),
      setCachedDefaults: (defaults) =>
        this.channelDefaultsCache.set(channelId, defaults),
      clearCachedDefaults: () => this.channelDefaultsCache.delete(channelId),
    });
  }

  /**
   * `listThreads` (docs/specs/adapter.md §7.6): the port call and result
   * shaping live in `src/reads.ts`; this method only decodes the channel id
   * and supplies the host-scoped port and builders, matching every other
   * read member above.
   *
   * Issues only, and no companion member lists pull requests (D-PR7): a
   * pull-request list is keyed by repository, a coordinate no channel id
   * carries. A caller that has the repository reaches its pull requests
   * through the public port, `api(host).listPullRequests(projectId,
   * repositoryId, …)`, which spends the **read** bucket rather than the
   * `search` bucket Get Issue List below draws on (measured 2026-09-06,
   * `.claude/rules/backlog-pull-request-facts.md` "Rate limit").
   */
  async listThreads(
    channelId: string,
    options?: ListThreadsOptions
  ): Promise<ListThreadsResult<BacklogRawMessage>> {
    const { host, projectId } = decodeChannelId(channelId);
    const converter = await this.getConverter(host, projectId);
    return listThreadsRead({
      channelId,
      options,
      api: this.api(host),
      builders: this.messageBuilders(host, converter),
      // Every thread this lists is an issue: a pull-request list is per
      // repository, a coordinate a channel id does not carry (D-PR7), so the
      // subject of each row is known before the row is read.
      subjectFor: (issueId) =>
        this.subjectClient(host, projectId, { kind: 'issue', issueId }),
    });
  }

  /**
   * `getUser` (docs/specs/adapter.md §7.7). `chat.getUser()` cannot route to
   * this adapter — the core infers an adapter from id shape and does not
   * recognise `<host>:<id>` (`.claude/rules/chat-sdk-core-facts.md`) — so a
   * caller reaches this only through `adapter.getUser()` directly.
   */
  async getUser(userId: string): Promise<UserInfo | null> {
    const { host } = decodeUserIdString(userId);
    return getUserRead({
      userId,
      api: this.api(host),
      botUserId: this.resolveInstallation(host).botUserId,
    });
  }

  /**
   * `fetchSubject` (docs/specs/adapter.md §7.4). Called lazily by
   * `message.subject`; the core turns a thrown error into `null`
   * (`.claude/rules/chat-sdk-core-facts.md`), so this deliberately lets a
   * lookup failure propagate rather than pre-emptively returning `null`
   * itself — the core's own handling is the single place that decision is
   * made.
   */
  async fetchSubject(raw: BacklogRawMessage): Promise<MessageSubject | null> {
    const { host } = raw;
    const { projectId, subject } = subjectOfRaw(raw);
    const subjectClient = this.subjectClient(host, projectId, subject);
    return fetchSubjectRead({
      raw,
      subject: subjectClient,
      names: await this.namesFor(host, projectId, subjectClient),
      threadId: encodeThreadIdStruct({ host, projectId, subject }),
    });
  }

  /**
   * `fetchChannelInfo` (docs/specs/adapter.md §7.5). Replaces this channel's
   * project cache entry and drops both the `postChannelMessage` defaults and
   * the repository names — the documented way to pick up a changed project
   * setting (formatting rule, project key, issue types, priorities, a renamed
   * repository) without restarting, since every one of those caches is
   * otherwise permanent (D14).
   *
   * The repository names are dropped by **host prefix**, not by this channel's
   * project: the key is `` `${host}:${repositoryId}` `` and carries no
   * project, so a sibling project's cached name goes with them. Keep it that
   * way rather than narrowing the loop. A repository id already identifies a
   * repository within a space, so putting the project in the key would buy
   * exact invalidation at the price of a key the same repository can occupy
   * twice — once per `projectId` a caller's thread id happened to name — which
   * leaves a stale name alive under whichever key this call did not clear.
   * Over-clearing costs one `read`-bucket Get Git Repository per dropped name,
   * once, and only after a `fetchChannelInfo` somebody asked for.
   */
  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const { host } = decodeChannelId(channelId);
    const { info, projectKey, textFormattingRule } = await fetchChannelInfoRead(
      { channelId, api: this.api(host) }
    );
    this.projectCache.set(channelId, { projectKey, textFormattingRule });
    this.channelDefaultsCache.delete(channelId);
    for (const key of this.repositoryNameCache.keys()) {
      if (key.startsWith(`${host}:`)) {
        this.repositoryNameCache.delete(key);
      }
    }
    return info;
  }

  /**
   * `markAsRead` (docs/specs/adapter.md §7.8): notifications are the bot
   * user's own feed, so the host comes from `threadId`, not from a
   * per-message installation lookup — `message`, when given, is only used to
   * cross-check the comment `messageId` already names, subject included.
   */
  async markAsRead(
    threadId: string,
    messageId: string,
    message?: Message<BacklogRawMessage>
  ): Promise<void> {
    const { host, subject } = this.subjectFor(threadId);
    await markAsReadRead({
      threadId,
      messageId,
      message,
      api: this.api(host),
      subject,
      logger: this.logger,
    });
  }

  /**
   * `rehydrateAttachment` (docs/specs/adapter.md §6.6): **synchronous**
   * (`.claude/rules/chat-sdk-core-facts.md`, VERIFIED-FACTS — the shipped
   * `Adapter` signature is `(attachment) => Attachment`, not a `Promise`).
   * `configuredHosts` is this instance's installation map, so an attachment
   * URL naming a host nobody configured here is returned unchanged rather
   * than trusted — the security boundary docs/specs/adapter.md §6.6 and §11
   * describe.
   */
  rehydrateAttachment(attachment: Attachment): Attachment {
    return rehydrateAttachmentRead({
      attachment,
      configuredHosts: new Set(this.installations.keys()),
      download: this.downloadAttachment,
    });
  }
}

/**
 * Zero-config-friendly factory (docs/specs/adapter.md §3.2): every shape-A
 * field falls back to an environment variable inside the constructor, so
 * `createBacklogAdapter()` with no arguments works when the environment is
 * fully populated.
 */
export function createBacklogAdapter(
  config?: BacklogAdapterConfig
): BacklogAdapter {
  return new BacklogAdapter(config ?? {});
}
