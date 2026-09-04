import {
  AdapterError,
  AuthenticationError,
  ResourceNotFoundError,
  ValidationError,
} from '@chat-adapter/shared';
import { ConsoleLogger } from 'chat';

import {
  channelIdFromThreadId as decodeChannelIdFromThreadId,
  decodeThreadId as decodeThreadIdString,
  encodeThreadId as encodeThreadIdStruct,
} from './ids';
import type {
  BacklogAdapterConfig,
  BacklogInstallation,
  BacklogRawMessage,
  BacklogThreadId,
  Resolvable,
  ResolvedInstallation,
} from './types';
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  Message,
  RawMessage,
  ThreadInfo,
  TypingOptions,
  WebhookOptions,
} from 'chat';

/**
 * The Backlog API port, once `src/client/**` lands (docs/plans/adapter-implementation.md
 * P1, landing in parallel with this PR). This phase implements no member that
 * makes an API call, so a structural placeholder is enough to keep `api(host)`
 * type-checking without importing a port that does not exist in this
 * worktree; a later PR narrows this to the real `BacklogApi` and deletes it.
 */
export type BacklogApiLike = unknown;

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

function notImplemented(): never {
  throw new AdapterError('not implemented', 'backlog', 'NOT_IMPLEMENTED');
}

/**
 * Backlog adapter for Chat SDK. See docs/specs/adapter.md for the full
 * behavioural contract; this phase (P2, docs/plans/adapter-implementation.md)
 * implements construction, config resolution, the thread-id codec delegation
 * and identity/lifecycle members. Every other required member throws a typed
 * "not implemented" error until its owning phase lands (P3 webhook, P4
 * format, P5 egress/reads, P6 optional members).
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
  ) => BacklogApiLike;
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
  private readonly apiCache = new Map<string, BacklogApiLike>();

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
    this.createApi = config.createApi ?? ((): BacklogApiLike => undefined);
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

  api(host: string): BacklogApiLike {
    const installation = this.resolveInstallation(host);
    let api = this.apiCache.get(host);
    if (api === undefined) {
      api = this.createApi(installation);
      this.apiCache.set(host, api);
    }
    return api;
  }

  rateLimit(_host: string): Record<string, never> {
    // No port makes a request yet in this phase (P1 lands in parallel), so
    // there is nothing to report. A later PR replaces this with the real
    // per-bucket X-RateLimit-* snapshot (docs/specs/adapter.md §3.3).
    return {};
  }

  renderFormatted(_content: FormattedContent, _target?: string): string {
    notImplemented();
  }

  handleWebhook(
    _request: Request,
    _options?: WebhookOptions
  ): Promise<Response> {
    notImplemented();
  }

  parseMessage(_raw: BacklogRawMessage): Message<BacklogRawMessage> {
    notImplemented();
  }

  postMessage(
    _threadId: string,
    _message: AdapterPostableMessage
  ): Promise<RawMessage<BacklogRawMessage>> {
    notImplemented();
  }

  editMessage(
    _threadId: string,
    _messageId: string,
    _message: AdapterPostableMessage
  ): Promise<RawMessage<BacklogRawMessage>> {
    notImplemented();
  }

  deleteMessage(_threadId: string, _messageId: string): Promise<void> {
    notImplemented();
  }

  addReaction(
    _threadId: string,
    _messageId: string,
    _emoji: string
  ): Promise<void> {
    notImplemented();
  }

  removeReaction(
    _threadId: string,
    _messageId: string,
    _emoji: string
  ): Promise<void> {
    notImplemented();
  }

  fetchMessages(
    _threadId: string,
    _options?: FetchOptions
  ): Promise<FetchResult<BacklogRawMessage>> {
    notImplemented();
  }

  fetchThread(_threadId: string): Promise<ThreadInfo> {
    notImplemented();
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
