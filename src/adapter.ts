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
  TextFormattingRule,
} from './client/port';
import {
  addReaction as addReactionToComment,
  bufferStream,
  editComment,
  postComment,
  removeReaction as removeReactionFromComment,
  requireCommentInThread,
} from './egress';
import { BacklogMarkdownConverter } from './format/markdown';
import { BacklogNotationConverter } from './format/notation';
import {
  channelIdFromThreadId as decodeChannelIdFromThreadId,
  decodeChannelId,
  decodeThreadId as decodeThreadIdString,
  decodeUserId as decodeUserIdString,
  encodeChannelId,
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
  rehydrateAttachment as rehydrateAttachmentRead,
} from './reads';
import type { MessageBuilders } from './reads';
import { subjectClientFor } from './subject/client';
import type { SubjectClient, SubjectNames } from './subject/client';
import type {
  BacklogAdapterConfig,
  BacklogChannelId,
  BacklogInstallation,
  BacklogRawMessage,
  BacklogSubjectRef,
  BacklogThreadId,
  BacklogWebhookVerifier,
  Resolvable,
  ResolvedCredential,
  ResolvedInstallation,
} from './types';
import { buildBulkUpdateMessage, buildInboundMessage } from './webhook/inbound';
import type { InboundContext } from './webhook/inbound';
import {
  activityOf,
  parseDelivery,
  payloadOf,
  repositoryNameOf,
  subjectOfActivity,
} from './webhook/payload';
import type { SubjectActivity } from './webhook/payload';
import { verifyWebhookRequest } from './webhook/verify';
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  BaseFormatConverter,
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
  logger: () => Logger
): (installation: ResolvedInstallation) => AdapterTransport {
  return (installation) =>
    createBacklogJsTransport({
      host: installation.host,
      credentials: toCredentials(installation),
      logger,
    });
}

/**
 * What one host's traffic goes through. `client` is absent exactly when a test
 * replaced the port with one that is not `backlog-js`-backed, because there is
 * then no client to hand out and inventing one would talk to the network.
 */
interface AdapterTransport {
  api: BacklogApi;
  client?: Backlog;
}

/** Who the bot is on one installation, once configuration and `GET /users/myself` have both had their say. */
interface BotIdentity {
  id: number;
  name: string;
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

const CONVERTERS: Record<TextFormattingRule, BaseFormatConverter> = {
  markdown: new BacklogMarkdownConverter(),
  backlog: new BacklogNotationConverter(),
};

const ENV_HOST = 'BACKLOG_HOST';
const ENV_API_KEY = 'BACKLOG_API_KEY';
const ENV_ACCESS_TOKEN = 'BACKLOG_ACCESS_TOKEN';
const ENV_BOT_USER_ID = 'BACKLOG_BOT_USER_ID';
const ENV_BOT_USER_NAME = 'BACKLOG_BOT_USER_NAME';
const ENV_WEBHOOK_SECRET = 'BACKLOG_WEBHOOK_SECRET';

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
    botUserId?: number;
    botUserName?: string;
    webhookSecret?: string;
  },
  requireSecret: boolean
): ResolvedInstallation {
  const host = validateHost(candidate.host, 'host');

  const credential = resolveCredential(candidate);

  if (candidate.botUserId !== undefined) {
    validateBotUserId(candidate.botUserId, 'botUserId');
  }
  if (candidate.botUserName !== undefined) {
    validateBotUserName(candidate.botUserName, 'botUserName');
  }

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

  const resolved: ResolvedInstallation = { host, ...credential };
  if (candidate.botUserId !== undefined) {
    resolved.botUserId = candidate.botUserId;
  }
  if (candidate.botUserName !== undefined) {
    resolved.botUserName = candidate.botUserName;
  }
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

/**
 * Only for the two optional `BACKLOG_BOT_*` variables: a blank line copied
 * from `.env.example` means "look it up", whereas a blank required variable
 * stays the validation error `requireWithEnvFallback` reports.
 */
function blankAsUnset(value: string | undefined): string | undefined {
  return value === '' ? undefined : value;
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

  const botUserIdFromEnv = blankAsUnset(process.env[ENV_BOT_USER_ID]);
  const botUserId =
    config.botUserId ??
    (botUserIdFromEnv === undefined
      ? undefined
      : parseBotUserIdFromEnv(botUserIdFromEnv, ENV_BOT_USER_ID));
  const botUserName =
    config.botUserName ?? blankAsUnset(process.env[ENV_BOT_USER_NAME]);

  const webhookSecret =
    config.webhookSecret !== undefined
      ? config.webhookSecret
      : process.env[ENV_WEBHOOK_SECRET];

  const candidate: {
    host: string;
    apiKey?: Resolvable;
    accessToken?: Resolvable;
    botUserId?: number;
    botUserName?: string;
    webhookSecret?: string;
  } = { host };
  if (botUserId !== undefined) {
    candidate.botUserId = botUserId;
  }
  if (botUserName !== undefined) {
    candidate.botUserName = botUserName;
  }
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

function subjectOfRaw(raw: BacklogRawMessage): {
  projectId: number;
  subject: BacklogSubjectRef;
} {
  switch (raw.kind) {
    case 'webhook':
      return {
        projectId: raw.payload.project.id,
        // A type-14 delivery travels as a `bulkUpdate` raw.
        subject: subjectOfActivity(activityOf(raw.payload) as SubjectActivity),
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

/** `renderFormatted` accepts a thread id or a channel id; anything else has no cached rule. */
function channelOfTarget(target: string): BacklogChannelId | undefined {
  try {
    return decodeThreadIdString(target);
  } catch {
    // Not a thread id; a channel id is equally valid.
  }
  try {
    return decodeChannelId(target);
  } catch {
    return undefined;
  }
}

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

  private readonly installations: Map<string, ResolvedInstallation>;
  private readonly configuredUserName: string | undefined;
  private readonly firstHost: string;
  /**
   * `host -> BotIdentity`, filled at construction for an installation that
   * configured both halves and by `GET /users/myself` for the rest
   * (docs/specs/adapter.md §3.2, D23). A failed lookup leaves no entry, so
   * the next caller that needs the identity asks again.
   */
  private readonly botIdentities = new Map<string, BotIdentity>();
  /**
   * Not `readonly`: `src/adapter.test.ts` replaces it after construction to
   * run the adapter on an in-memory port. There is no config field for that,
   * because a config field would be a published promise.
   */
  private createTransport: (
    installation: ResolvedInstallation
  ) => AdapterTransport;
  private readonly webhookVerifier: BacklogWebhookVerifier | undefined;
  private readonly apiCache = new Map<string, AdapterTransport>();
  /**
   * Keyed by channel id and cached for the process's lifetime (D14). The
   * project key rides along because a pull request's web URL needs it and
   * the pull-request object does not carry it.
   */
  private readonly projectCache = new Map<
    string,
    { projectKey: string; textFormattingRule: TextFormattingRule }
  >();
  /** The other half of a pull request's web URL; also filled for free by every pull-request webhook. */
  private readonly repositoryNameCache = new Map<string, string>();

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

    this.firstHost = firstInstallation.host;
    this.configuredUserName =
      config.userName !== undefined
        ? validateBotUserName(config.userName, 'userName')
        : undefined;
    for (const installation of resolvedInstallations) {
      if (
        installation.botUserId !== undefined &&
        installation.botUserName !== undefined
      ) {
        this.botIdentities.set(installation.host, {
          id: installation.botUserId,
          name: installation.botUserName,
        });
      }
    }

    this.webhookVerifier = config.webhookVerifier;
    this.logger = config.logger ?? new ConsoleLogger('info').child('backlog');
    this.createTransport = defaultCreateTransport(() => this.logger);
  }

  /** `""` rather than a guess until fetched: the core then falls back to `chat.userName`. */
  get userName(): string {
    return (
      this.configuredUserName ??
      this.botIdentities.get(this.firstHost)?.name ??
      ''
    );
  }

  /**
   * A failed bot identity lookup is logged, never thrown: the core memoises a
   * rejected `initialize` and never retries it, which would refuse every later
   * webhook until the process restarts (docs/specs/adapter.md D23).
   */
  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger('backlog');
    await Promise.all(
      [...this.installations.keys()]
        .filter((host) => !this.botIdentities.has(host))
        .map((host) =>
          this.botIdentity(host).catch((cause: unknown) => {
            this.logger.warn('bot identity lookup failed; retried on demand', {
              host,
              error: cause instanceof Error ? cause.message : String(cause),
            });
          })
        )
    );
    this.logger.debug(
      `initialized for host(s) ${[...this.installations.keys()].join(', ')}` +
        ` (chat=${this.chat !== undefined},` +
        ` webhookVerifier=${this.webhookVerifier !== undefined})`
    );
  }

  private async botIdentity(host: string): Promise<BotIdentity> {
    const installation = this.resolveInstallation(host);
    const known = this.botIdentities.get(host);
    if (known !== undefined) {
      return known;
    }
    const myself = await this.api(host).getMyself();
    const identity: BotIdentity = {
      id: installation.botUserId ?? myself.id,
      name: installation.botUserName ?? myself.name,
    };
    this.botIdentities.set(host, identity);
    return identity;
  }

  /** For the synchronous members, which cannot await `botIdentity`. */
  private knownBotIdentity(host: string): BotIdentity {
    this.resolveInstallation(host);
    const identity = this.botIdentities.get(host);
    if (identity === undefined) {
      throw new AdapterError(
        `the bot identity for "${host}" is not known yet: configure botUserId and botUserName, or let initialize() read them from GET /users/myself`,
        'backlog',
        'BOT_IDENTITY_UNRESOLVED'
      );
    }
    return identity;
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

  private api(host: string): BacklogApi {
    return this.transport(host).api;
  }

  /**
   * The `backlog-js` client this adapter's own traffic goes through, for the
   * Backlog endpoints the port does not name — changing an assignee, reading
   * an issue's custom fields, anything else a bot needs and the adapter does
   * not.
   *
   * It is handed out rather than left to the caller to construct because a
   * second client would have none of what this one carries: its bounded 429
   * retry, its `@chat-adapter/shared` error mapping and its per-call
   * credential resolution (docs/specs/adapter.md §3.1, §8.2). It holds no
   * credential of its own, so it is safe to keep past the call that asked for
   * it.
   */
  client(host: string): Backlog {
    const { client } = this.transport(host);
    if (client === undefined) {
      throw new AdapterError(
        'no Backlog client: this adapter runs on a port that is not `backlog-js`-backed',
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
   * The bot's display name on that installation (docs/specs/adapter.md §3.3).
   * `userName` is one string for the whole adapter — the first installation's
   * name — so a consumer running several spaces under different display names
   * cannot build or match its own mention string from it. Only the name is
   * exposed, not the installation: `botUserId` stays private (§3.3) and a
   * credential must never leave through a getter.
   */
  botUserName(host: string): string {
    return this.knownBotIdentity(host).name;
  }

  /**
   * Cache-only because the member is synchronous: a target with no cached
   * rule renders Markdown rather than blocking on a Get Project (D14).
   */
  renderFormatted(content: FormattedContent, target?: string): string {
    const channel = target === undefined ? undefined : channelOfTarget(target);
    const rule =
      channel === undefined
        ? 'markdown'
        : this.ruleFor(channel.host, channel.projectId);
    return CONVERTERS[rule].fromAst(content);
  }

  /** A cold cache is a `warn` and Markdown, never a failure. */
  private ruleFor(host: string, projectId: number): TextFormattingRule {
    const rule = this.projectCache.get(
      encodeChannelId({ host, projectId })
    )?.textFormattingRule;
    if (rule === undefined) {
      this.logger.warn('textFormattingRule uncached; assuming markdown', {
        host,
        projectId,
      });
      return 'markdown';
    }
    return rule;
  }

  /**
   * A failed lookup is not cached, so the next caller tries again rather than
   * being pinned to Markdown for the process's lifetime.
   */
  private async ensureProject(host: string, projectId: number): Promise<void> {
    const channelId = encodeChannelId({ host, projectId });
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
      this.logger.warn('project lookup failed', {
        host,
        projectId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  /** For the members that can await: the first post to a notation project must not render Markdown. */
  private async converterFor(
    host: string,
    projectId: number
  ): Promise<BaseFormatConverter> {
    await this.ensureProject(host, projectId);
    return CONVERTERS[this.ruleFor(host, projectId)];
  }

  /**
   * The seam every member goes through: one `SubjectClient` for the issue or
   * pull request an id names (D-PR2). The
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
    converter: BaseFormatConverter,
    identity: BotIdentity
  ): Omit<MessageBuilders, 'projectId' | 'subject'> {
    return {
      host,
      botUserId: identity.id,
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
   * `read`-bucket call per issue thread. If a kind ever needs the project key without a
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
   * `"backlog"` (#48).
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
    const verified = await verifyWebhookRequest({
      request,
      webhookVerifier: this.webhookVerifier,
      installations: this.installations,
      logger: this.logger,
    });
    if (verified === undefined) {
      this.logger.warn('webhook rejected: unauthorized');
      return new Response('Unauthorized', { status: 401 });
    }
    const { host, rawBody } = verified;

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      this.logger.warn('webhook rejected: invalid JSON');
      return new Response('Invalid JSON', { status: 400 });
    }

    const delivery = parseDelivery(body);
    if (!delivery.ok) {
      this.logger.warn('webhook rejected: invalid payload', {
        issuePaths: delivery.issuePaths,
      });
      return new Response('Invalid payload', { status: 400 });
    }
    if ('ignoredType' in delivery) {
      this.logger.info('webhook ignored', { host, type: delivery.ignoredType });
      return new Response('Ignored', { status: 200 });
    }
    const { activity } = delivery;

    const chat = this.chat;
    if (chat === undefined) {
      this.logger.error('webhook rejected: adapter not initialized');
      return new Response('Adapter not initialized', { status: 503 });
    }

    let identity: BotIdentity;
    try {
      identity = await this.botIdentity(host);
    } catch (cause) {
      this.logger.error('webhook rejected: bot identity unavailable', {
        host,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      return new Response('Bot identity unavailable', { status: 503 });
    }

    if (activity.createdUser.id === identity.id) {
      this.logger.debug('self message skipped', { host, type: activity.type });
      return new Response('OK', { status: 200 });
    }

    const projectId = activity.project.id;

    if (activity.type === 4) {
      const subject = subjectOfActivity(activity);
      const threadId = encodeThreadIdStruct({ host, projectId, subject });
      chat
        .processMessageDeleted(
          {
            adapter: this,
            platform: 'backlog',
            channelId: decodeChannelIdFromThreadId(threadId),
            threadId,
            messageId: encodeMessageId({ host, subject, part: 'root' }),
            raw: {
              kind: 'webhook',
              host,
              payload: payloadOf(activity),
              changes: [],
            },
            deletedAt: new Date(activity.created),
          },
          options
        )
        .catch((cause: unknown) =>
          this.logInboundFailure(host, threadId, cause)
        );
      return new Response('OK', { status: 200 });
    }

    // One lookup for every factory: a bulk update's run concurrently, and
    // each would otherwise miss the same cold cache.
    const projectReady = this.ensureProject(host, projectId);
    const dispatch = (
      threadId: string,
      build: (context: InboundContext) => Message<BacklogRawMessage>
    ): void => {
      const factory = async () => {
        await projectReady;
        return build(this.inboundContext(host, projectId, identity));
      };
      chat
        .processMessage(this, threadId, factory, options)
        .catch((cause: unknown) =>
          this.logInboundFailure(host, threadId, cause)
        );
    };

    if (activity.type === 14) {
      for (const link of activity.content.link) {
        const threadId = encodeThreadIdStruct({
          host,
          projectId,
          subject: { kind: 'issue', issueId: link.id },
        });
        dispatch(threadId, (context) =>
          buildBulkUpdateMessage(activity, link, context)
        );
      }
      return new Response('OK', { status: 200 });
    }

    // Cached before the response, not in the factory: it is what spares the
    // next `fetchThread` a Get Git Repository.
    const repository = repositoryNameOf(activity);
    if (repository !== undefined) {
      this.repositoryNameCache.set(
        repositoryNameKey(host, repository.repositoryId),
        repository.name
      );
    }

    const subject = subjectOfActivity(activity);
    const subjectClient = this.subjectClient(host, projectId, subject);
    dispatch(encodeThreadIdStruct({ host, projectId, subject }), (context) =>
      buildInboundMessage(activity, context, subjectClient)
    );
    return new Response('OK', { status: 200 });
  }

  private logInboundFailure(
    host: string,
    threadId: string,
    cause: unknown
  ): void {
    this.logger.error('inbound processing failed', {
      host,
      threadId,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }

  private inboundContext(
    host: string,
    projectId: number,
    identity: BotIdentity
  ): InboundContext {
    const converter = CONVERTERS[this.ruleFor(host, projectId)];
    return {
      host,
      botUserId: identity.id,
      botUserName: identity.name,
      format: (text) => converter.toAst(text),
    };
  }

  /**
   * Only the two kinds a webhook builds: the core never calls `parseMessage`,
   * and a message read over REST already is a `Message`.
   */
  parseMessage(raw: BacklogRawMessage): Message<BacklogRawMessage> {
    if (raw.kind !== 'webhook' && raw.kind !== 'bulkUpdate') {
      throw new ValidationError(
        'backlog',
        `parseMessage: a ${raw.kind} raw message is not a webhook delivery`
      );
    }
    const activity = activityOf(raw.payload);
    const context = this.inboundContext(
      raw.host,
      activity.project.id,
      this.knownBotIdentity(raw.host)
    );
    if (activity.type === 14) {
      const issueId = raw.kind === 'bulkUpdate' ? raw.issueId : undefined;
      const link = activity.content.link.find((entry) => entry.id === issueId);
      if (link === undefined) {
        throw new ValidationError(
          'backlog',
          'parseMessage: the raw message names no issue of this bulk update'
        );
      }
      return buildBulkUpdateMessage(activity, link, context);
    }
    if (activity.type === 4) {
      throw new ValidationError(
        'backlog',
        'parseMessage: a deletion produces no message'
      );
    }
    return buildInboundMessage(
      activity,
      context,
      this.subjectClient(
        raw.host,
        activity.project.id,
        subjectOfActivity(activity)
      )
    );
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<BacklogRawMessage>> {
    const { host, projectId, subject } = this.subjectFor(threadId);
    const converter = await this.converterFor(host, projectId);
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
    const converter = await this.converterFor(host, projectId);
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
   * Overridden so a stream is one comment: the core's fallback would edit the
   * message every 500 ms and exhaust the update bucket (D4). An empty stream
   * still posts `" "` rather than nothing, so the caller always gets a
   * `SentMessage` to edit or delete.
   */
  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    _options?: StreamOptions
  ): Promise<RawMessage<BacklogRawMessage>> {
    const buffered = await bufferStream(textStream);
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
      botUserId: (await this.botIdentity(host)).id,
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
      botUserId: (await this.botIdentity(host)).id,
    });
  }

  async fetchMessages(
    threadId: string,
    options?: FetchOptions
  ): Promise<FetchResult<BacklogRawMessage>> {
    const { host, projectId, subject } = this.subjectFor(threadId);
    const converter = await this.converterFor(host, projectId);
    return fetchMessagesRead({
      threadId,
      options,
      subject,
      builders: this.messageBuilders(
        host,
        converter,
        await this.botIdentity(host)
      ),
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
        this.messageBuilders(
          host,
          await this.converterFor(host, projectId),
          await this.botIdentity(host)
        ),
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
   * `listThreads` (docs/specs/adapter.md §7.6): the port call and result
   * shaping live in `src/reads.ts`; this method only decodes the channel id
   * and supplies the host-scoped port and builders, matching every other
   * read member above.
   *
   * Issues only, and no companion member lists pull requests (D-PR7): a
   * pull-request list is keyed by repository, a coordinate no channel id
   * carries. A caller that has the repository reaches its pull requests
   * through `client(host).getPullRequests(projectIdOrKey, repoIdOrName,
   * …)`, which spends the **read** bucket rather than the
   * `search` bucket Get Issue List below draws on (measured 2026-09-06,
   * `.claude/rules/backlog-pull-request-facts.md` "Rate limit").
   */
  async listThreads(
    channelId: string,
    options?: ListThreadsOptions
  ): Promise<ListThreadsResult<BacklogRawMessage>> {
    const { host, projectId } = decodeChannelId(channelId);
    const converter = await this.converterFor(host, projectId);
    return listThreadsRead({
      channelId,
      options,
      api: this.api(host),
      builders: this.messageBuilders(
        host,
        converter,
        await this.botIdentity(host)
      ),
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
      botUserId: (await this.botIdentity(host)).id,
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

  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const { host } = decodeChannelId(channelId);
    return fetchChannelInfoRead({ channelId, api: this.api(host) });
  }

  /**
   * Synchronous in the `Adapter` interface. A URL naming a host this adapter
   * was not configured for is returned unchanged, never fetched.
   */
  rehydrateAttachment(attachment: Attachment): Attachment {
    return rehydrateAttachmentRead({
      attachment,
      configuredHosts: new Set(this.installations.keys()),
      apiFor: (host) => this.api(host),
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
