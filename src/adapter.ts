import {
  AuthenticationError,
  ResourceNotFoundError,
  toBuffer,
  ValidationError,
} from '@chat-adapter/shared';
import { ConsoleLogger, Message as MessageCtor } from 'chat';

import { createBacklogJsApi } from './client/backlog-js';
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
  requireCommentId,
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
import type {
  BacklogAdapterConfig,
  BacklogInstallation,
  BacklogRawMessage,
  BacklogThreadId,
  BacklogWebhookPayload,
  Resolvable,
  ResolvedInstallation,
} from './types';
import { buildInboundMessage } from './webhook/inbound';
import {
  DISPATCHED_ACTIVITY_TYPES,
  parseActivity,
  parseEnvelope,
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
 */
function defaultCreateApi(
  retry: RetryOptions
): (installation: ResolvedInstallation) => BacklogApi {
  return (installation) =>
    createBacklogJsApi({
      host: installation.host,
      credentials: toCredentials(installation),
      retry,
    });
}

function toCredentials(installation: ResolvedInstallation): BacklogCredentials {
  // The constructor already rejected an installation carrying neither
  // credential, so the fallback below is unreachable; it exists because the
  // port's union type cannot express "exactly one of these two" in a way the
  // compiler can narrow from `ResolvedInstallation`.
  if (installation.apiKey !== undefined) {
    const apiKey = installation.apiKey;
    return { apiKey: () => resolve(apiKey) };
  }
  if (installation.accessToken !== undefined) {
    const accessToken = installation.accessToken;
    return { accessToken: () => resolve(accessToken) };
  }
  throw new ValidationError(
    'backlog',
    `installation ${installation.host} has no apiKey or accessToken`
  );
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

const HOST_GRAMMAR = /^[a-z0-9.-]+$/;
const DEFAULT_MAX_WAIT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024;

function fail(message: string): never {
  throw new ValidationError('backlog', message);
}

/**
 * `host` is validated in its raw (non-lowercased) form for scheme/whitespace
 * before lowercasing, so a rejection message shows the value the caller
 * actually passed rather than a silently-transformed one.
 */
function validateHost(host: string, label: string): string {
  if (host.trim() !== host || /\s/.test(host)) {
    fail(`${label} must not contain whitespace`);
  }
  if (host.includes('://')) {
    fail(`${label} must not include a scheme`);
  }
  if (host.includes('/')) {
    fail(`${label} must not include a path`);
  }
  const lowered = host.toLowerCase();
  if (lowered.includes(':')) {
    fail(`${label} must not include a port`);
  }
  if (lowered.length === 0 || !HOST_GRAMMAR.test(lowered)) {
    fail(`${label} is not a valid Backlog host`);
  }
  return lowered;
}

function validateBotUserId(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

function parseBotUserIdFromEnv(raw: string, envVar: string): number {
  if (!/^[1-9]\d*$/.test(raw)) {
    fail(`environment variable ${envVar} must be a positive integer`);
  }
  return Number(raw);
}

function validateBotUserName(value: string, label: string): string {
  if (value.trim().length === 0) {
    fail(`${label} must not be empty`);
  }
  return value;
}

function validateWebhookSecret(value: string, label: string): string {
  if (value.length === 0) {
    fail(`${label} must not be empty`);
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

  const hasApiKey = candidate.apiKey !== undefined;
  const hasAccessToken = candidate.accessToken !== undefined;
  if (hasApiKey === hasAccessToken) {
    fail(
      hasApiKey
        ? 'exactly one of apiKey or accessToken is allowed, not both'
        : 'exactly one of apiKey or accessToken is required'
    );
  }
  if (typeof candidate.apiKey === 'string') {
    validateApiKey(candidate.apiKey, 'apiKey');
  }
  if (typeof candidate.accessToken === 'string') {
    validateApiKey(candidate.accessToken, 'accessToken');
  }

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
  };
  if (candidate.apiKey !== undefined) {
    resolved.apiKey = candidate.apiKey;
  }
  if (candidate.accessToken !== undefined) {
    resolved.accessToken = candidate.accessToken;
  }
  if (candidate.webhookSecret !== undefined) {
    resolved.webhookSecret = candidate.webhookSecret;
  }
  return resolved;
}

function resolveShapeA(
  config: BacklogAdapterConfig,
  requireSecret: boolean
): ResolvedInstallation {
  const host = requireWithEnvFallback(config.host, ENV_HOST, 'host');

  const apiKey =
    config.apiKey ??
    (config.accessToken === undefined ? process.env[ENV_API_KEY] : undefined);
  const accessToken = config.accessToken ?? process.env[ENV_ACCESS_TOKEN];

  const hasApiKey = apiKey !== undefined;
  const hasAccessToken = accessToken !== undefined;
  if (!hasApiKey && !hasAccessToken) {
    fail(
      `apiKey is required: set config.apiKey, config.accessToken, ${ENV_API_KEY}, or ${ENV_ACCESS_TOKEN}`
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

function validateRateLimitConfig(
  rateLimit: BacklogAdapterConfig['rateLimit']
): {
  maxWaitMs: number;
  maxRetries: number;
} {
  const maxWaitMs = rateLimit?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  if (maxWaitMs < 0) {
    fail('rateLimit.maxWaitMs must be >= 0');
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
  if (value <= 0) {
    fail('maxWebhookBodyBytes must be > 0');
  }
  return value;
}

/**
 * Backlog adapter for Chat SDK. See docs/specs/adapter.md for the full
 * behavioural contract. Construction, config resolution, thread-id codec
 * delegation and identity/lifecycle members landed in P2; webhook ingress in
 * P3; format converters in P4; egress, reads, `stream` and reactions in P5;
 * `postChannelMessage`, `listThreads`, `getUser`, `fetchSubject`,
 * `fetchChannelInfo`, `markAsRead`, `rehydrateAttachment` and type-4 deletion
 * in P6 (docs/plans/adapter-implementation.md). Every optional member the
 * Chat SDK core degrades gracefully around
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
  private readonly createApi: (
    installation: ResolvedInstallation
  ) => BacklogApi;
  /**
   * `rateLimit`/`maxWebhookBodyBytes`/`webhookVerifier` are validated in the
   * constructor (docs/specs/adapter.md §3.2) and held here for the webhook
   * (P3) and port (P1) phases, which are the ones that actually read them;
   * grouped into one field rather than three, since they travel together as
   * "config this phase validates but does not yet act on".
   */
  private readonly ingressConfig: {
    rateLimit: { maxWaitMs: number; maxRetries: number };
    maxWebhookBodyBytes: number;
    webhookVerifier: BacklogAdapterConfig['webhookVerifier'];
  };
  private readonly apiCache = new Map<string, BacklogApi>();
  /**
   * `channelId -> TextFormattingRule` (docs/specs/adapter.md §9.1, D14):
   * populated by one Get Project per channel and cached forever;
   * `fetchChannelInfo` (P6) is the documented way to replace an entry. Keyed
   * on the channel id string rather than `{host, projectId}` so the same map
   * serves `ensureFormattingRule`, `renderFormatted` and `parseMessage`
   * without re-deriving the key shape in three places.
   */
  private readonly formattingRuleCache = new Map<string, TextFormattingRule>();
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
    this.createApi =
      config.createApi ?? defaultCreateApi(this.ingressConfig.rateLimit);
    this.logger = config.logger ?? new ConsoleLogger('info').child('backlog');
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

  /**
   * Resolves an installation's credential fresh on every call rather than
   * caching it on the instance, so a resolver function can rotate an OAuth
   * access token without the adapter being reconstructed (docs/specs/adapter.md
   * §3.2, vendor-official requirement in CLAUDE.md "Conventions to follow").
   * A rejecting or throwing resolver becomes `AuthenticationError` rather than
   * an unhandled rejection reaching the caller.
   */
  async resolveCredential(installation: ResolvedInstallation): Promise<string> {
    const resolvable = installation.apiKey ?? installation.accessToken;
    if (resolvable === undefined) {
      throw new AuthenticationError(
        'backlog',
        'no credential configured for this installation'
      );
    }
    if (typeof resolvable === 'string') {
      return resolvable;
    }
    try {
      return await resolvable();
    } catch (cause) {
      throw new AuthenticationError(
        'backlog',
        cause instanceof Error ? cause.message : 'credential resolver failed'
      );
    }
  }

  api(host: string): BacklogApi {
    const installation = this.resolveInstallation(host);
    let api = this.apiCache.get(host);
    if (api === undefined) {
      api = this.createApi(installation);
      this.apiCache.set(host, api);
    }
    return api;
  }

  rateLimit(host: string): RateLimitSnapshots {
    return this.api(host).rateLimit();
  }

  /**
   * Synchronous and cache-only (docs/specs/adapter.md §9.1, D14): `target`,
   * when given, is a thread id whose formatting rule `ensureFormattingRule`
   * (webhook ingress) or `getConverter` (egress) may already have cached. An
   * absent `target` or a channel this instance has never talked to falls
   * back to Markdown with one `warn` rather than blocking this synchronous
   * interface method on a network call the caller cannot await.
   */
  renderFormatted(content: FormattedContent, target?: string): string {
    const channelId =
      target === undefined ? undefined : decodeChannelIdFromThreadId(target);
    const rule =
      channelId === undefined
        ? undefined
        : this.formattingRuleCache.get(channelId);

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
   * Populates the §9.1 formatting-rule cache for `channelId` with one Get
   * Project call, unless an entry already exists — the cache is forever
   * until `fetchChannelInfo` (P6) replaces it, so a second webhook for the
   * same project must not spend a `read`-bucket call repeating a lookup this
   * method already made. A lookup failure is not cached (`PermissionError`,
   * `NetworkError`, …): the next call gets to try again rather than being
   * pinned to a guess for the process's lifetime.
   */
  private async ensureFormattingRule(
    host: string,
    projectId: number
  ): Promise<void> {
    const channelId = `backlog:${host}:${projectId}`;
    if (this.formattingRuleCache.has(channelId)) {
      return;
    }
    try {
      const project = await this.api(host).getProject(projectId);
      this.formattingRuleCache.set(channelId, project.textFormattingRule);
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
   * `ensureFormattingRule` (a single cached Get Project per channel, §9.1)
   * and wraps the result in the §9.2 fallback. Every egress member reaches
   * Backlog through this so a notation project renders `''bold''` instead of
   * `**bold**` on the very first post to a channel, not just once the cache
   * happens to be warm.
   */
  private async getConverter(
    host: string,
    projectId: number
  ): Promise<FallbackFormatConverter> {
    await this.ensureFormattingRule(host, projectId);
    const channelId = `backlog:${host}:${projectId}`;
    const rule = this.formattingRuleCache.get(channelId) ?? 'markdown';
    return converterFor(rule, this.logger, { host, projectId });
  }

  private toFileBuffer = async (file: FileUpload): Promise<Buffer> => {
    const buffer = await toBuffer(file.data, { platform: 'slack' });
    if (buffer === null) {
      throw new ValidationError(
        'backlog',
        `file "${file.filename}" has no readable data`
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

    if (activity.createdUser.id === installation.botUserId) {
      this.logger.debug('self message skipped', {
        host,
        issueId: activity.content.id,
      });
      return new Response('OK', { status: 200 });
    }

    const threadId = encodeThreadIdStruct({
      host,
      projectId: activity.project.id,
      issueId: activity.content.id,
    });

    if (activity.type === 4) {
      const channelId = decodeChannelIdFromThreadId(threadId);
      const messageId = encodeMessageId({
        kind: 'issue',
        host,
        issueId: activity.content.id,
      });
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
          issueId: activity.content.id,
          messageId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
      return new Response('OK', { status: 200 });
    }

    const factory = async (): Promise<Message<BacklogRawMessage>> => {
      await this.ensureFormattingRule(host, activity.project.id);
      return this.parseMessage({
        kind: 'webhook',
        host,
        payload: rawPayload,
        changes: [],
      });
    };

    const messageIdForLog =
      activity.type === 1
        ? encodeMessageId({ kind: 'issue', host, issueId: activity.content.id })
        : activity.content.comment !== null &&
            activity.content.comment !== undefined
          ? encodeMessageId({
              kind: 'comment',
              host,
              issueId: activity.content.id,
              commentId: activity.content.comment.id,
            })
          : encodeMessageId({
              kind: 'update',
              host,
              issueId: activity.content.id,
              created: activity.created,
            });

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
        issueId: activity.content.id,
        messageId: messageIdForLog,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });

    return new Response('OK', { status: 200 });
  }

  parseMessage(raw: BacklogRawMessage): Message<BacklogRawMessage> {
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
    const channelId = `backlog:${host}:${payload.project.id}`;
    if (!this.formattingRuleCache.has(channelId)) {
      this.logger.warn('textFormattingRule uncached; assuming markdown', {
        host,
        projectId: payload.project.id,
      });
    }

    if (payload.type !== 1 && payload.type !== 2 && payload.type !== 3) {
      throw new ValidationError(
        'backlog',
        `parseMessage: activity type ${payload.type} produces no message`
      );
    }
    const activity = payload;

    return buildInboundMessage(
      activity,
      {
        host,
        botUserId: installation.botUserId,
        botUserName: installation.botUserName,
        fetchAttachment: (issueId, attachmentId) =>
          this.fetchAttachmentData(host, issueId, attachmentId),
        payload,
      },
      MessageCtor
    );
  }

  /**
   * Downloads one attachment through the port
   * (docs/specs/adapter.md §6.6, `GET /issues/:issueId/attachments/:id`);
   * the port already maps every failure to a `@chat-adapter/shared` error,
   * so `fetchData()` never throws a `backlog-js` type to a consumer.
   */
  private async fetchAttachmentData(
    host: string,
    issueId: number,
    attachmentId: number
  ): Promise<Buffer> {
    const file = await this.api(host).downloadAttachment(issueId, attachmentId);
    return file.data;
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<BacklogRawMessage>> {
    const { host, projectId, issueId } = decodeThreadIdString(threadId);
    const converter = await this.getConverter(host, projectId);
    return postComment({
      host,
      projectId,
      issueId,
      api: this.api(host),
      converter,
      message,
      toBuffer: this.toFileBuffer,
    });
  }

  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<BacklogRawMessage>> {
    const { host, projectId } = decodeThreadIdString(threadId);
    const { issueId, commentId } = requireCommentId(messageId, 'edited');
    const converter = await this.getConverter(host, projectId);
    return editComment({
      host,
      projectId,
      issueId,
      commentId,
      api: this.api(host),
      converter,
      message,
    });
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const { host } = decodeThreadIdString(threadId);
    const { issueId, commentId } = requireCommentId(messageId, 'deleted');
    await this.api(host).deleteComment(issueId, commentId);
  }

  /**
   * Buffers the whole stream into one `postMessage` call
   * (docs/specs/adapter.md §6.4, D4; CLAUDE.md "`stream()` must be
   * overridden"): the core's fallback would otherwise edit a message every
   * `streamingUpdateIntervalMs` (default 500 ms), which is roughly 120
   * `updateComment` calls a minute against a documented example 150/min
   * update-bucket limit. An empty stream still posts `" "` (D4 default,
   * matching the core's own fallback) so a `SentMessage` always exists for
   * the caller to reference.
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
    const { host } = decodeThreadIdString(threadId);
    const { issueId, commentId } = requireCommentId(messageId, 'starred');
    await addReactionToComment({
      issueId,
      commentId,
      api: this.api(host),
      botUserId: this.resolveInstallation(host).botUserId,
    });
  }

  async removeReaction(
    threadId: string,
    messageId: string,
    _emoji: string
  ): Promise<void> {
    const { host } = decodeThreadIdString(threadId);
    const { issueId, commentId } = requireCommentId(messageId, 'starred');
    await removeReactionFromComment({
      issueId,
      commentId,
      api: this.api(host),
      botUserId: this.resolveInstallation(host).botUserId,
    });
  }

  async fetchMessages(
    threadId: string,
    options?: FetchOptions
  ): Promise<FetchResult<BacklogRawMessage>> {
    const { host } = decodeThreadIdString(threadId);
    return fetchMessagesRead({
      threadId,
      options,
      api: this.api(host),
      builders: {
        host,
        botUserId: this.resolveInstallation(host).botUserId,
        fetchAttachment: (issueId, attachmentId) =>
          this.fetchAttachmentData(host, issueId, attachmentId),
        MessageCtor,
      },
    });
  }

  async fetchMessage(
    threadId: string,
    messageId: string
  ): Promise<Message<BacklogRawMessage> | null> {
    const { host } = decodeThreadIdString(threadId);
    return fetchMessageRead({
      threadId,
      messageId,
      api: this.api(host),
      builders: {
        host,
        botUserId: this.resolveInstallation(host).botUserId,
        fetchAttachment: (issueId, attachmentId) =>
          this.fetchAttachmentData(host, issueId, attachmentId),
        MessageCtor,
      },
    });
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { host } = decodeThreadIdString(threadId);
    return fetchThreadRead({ threadId, api: this.api(host) });
  }

  /**
   * `postChannelMessage` (docs/specs/adapter.md §6.7): creates an issue from
   * a channel-level post. `issueTypeId`/`priorityId` default resolution and
   * the narrow retry-once-on-stale-cache rule live in `createChannelIssue`
   * (`src/egress.ts`); this method's job is only to own the per-channel
   * defaults cache the way `getConverter`/`ensureFormattingRule` own the
   * formatting-rule cache above.
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
   */
  async listThreads(
    channelId: string,
    options?: ListThreadsOptions
  ): Promise<ListThreadsResult<BacklogRawMessage>> {
    const { host } = decodeChannelId(channelId);
    return listThreadsRead({
      channelId,
      options,
      api: this.api(host),
      builders: {
        host,
        botUserId: this.resolveInstallation(host).botUserId,
        fetchAttachment: (issueId, attachmentId) =>
          this.fetchAttachmentData(host, issueId, attachmentId),
        MessageCtor,
      },
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
    return fetchSubjectRead({ raw, api: this.api(raw.host) });
  }

  /**
   * `fetchChannelInfo` (docs/specs/adapter.md §7.5). Replaces both the
   * formatting-rule cache entry and the `postChannelMessage` defaults cache
   * entry for this channel — the documented way to pick up a changed project
   * setting (formatting rule, issue types, priorities) without restarting,
   * since both caches are otherwise permanent (D14).
   */
  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const { host } = decodeChannelId(channelId);
    const { info, textFormattingRule } = await fetchChannelInfoRead({
      channelId,
      api: this.api(host),
    });
    this.formattingRuleCache.set(channelId, textFormattingRule);
    this.channelDefaultsCache.delete(channelId);
    return info;
  }

  /**
   * `markAsRead` (docs/specs/adapter.md §7.8): notifications are the bot
   * user's own feed, so the host comes from `threadId`, not from a
   * per-message installation lookup — `message`, when given, is only used to
   * cross-check the comment id `messageId` already names.
   */
  async markAsRead(
    threadId: string,
    messageId: string,
    message?: Message<BacklogRawMessage>
  ): Promise<void> {
    const { host } = decodeThreadIdString(threadId);
    await markAsReadRead({
      messageId,
      message,
      api: this.api(host),
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
      fetchAttachment: (host, issueId, attachmentId) =>
        this.fetchAttachmentData(host, issueId, attachmentId),
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
