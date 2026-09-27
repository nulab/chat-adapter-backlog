import {
  AdapterError,
  ResourceNotFoundError,
  toBuffer,
  ValidationError,
} from '@chat-adapter/shared';
import { ConsoleLogger, Message as MessageCtor } from 'chat';

import { createBacklogJsTransport } from './client/backlog-js';
import { parseConfig } from './config';
import type { SpaceConfig } from './config';
import type { Backlog } from 'backlog-js';
import type { BacklogApi, TextFormattingRule } from './client/port';
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
  BacklogRawMessage,
  BacklogSubjectRef,
  BacklogThreadId,
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
 * What the space's traffic goes through. `client` is absent exactly when a
 * test replaced the port with one that is not `backlog-js`-backed, because
 * there is then no client to hand out and inventing one would talk to the
 * network.
 */
interface AdapterTransport {
  api: BacklogApi;
  client?: Backlog;
}

/** The name is absent when only the id was configured (see `initialize`). */
interface BotIdentity {
  id: number;
  name: string | undefined;
}

const CONVERTERS: Record<TextFormattingRule, BaseFormatConverter> = {
  markdown: new BacklogMarkdownConverter(),
  backlog: new BacklogNotationConverter(),
};

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
 * subject cannot: the space's configuration and port, the per-channel
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

  private readonly space: SpaceConfig;
  /**
   * Configured, or learned from `GET /users/myself` when the id was left out.
   * A failed lookup leaves it `undefined`, so the next caller that needs it
   * asks again (D23).
   */
  private identity: BotIdentity | undefined;
  /**
   * Not `readonly`: `src/adapter.test.ts` replaces it after construction to
   * run the adapter on another port. There is no config field for that,
   * because a config field would be a published promise.
   */
  private createTransport: () => AdapterTransport;
  private cachedTransport: AdapterTransport | undefined;
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
    this.space = parseConfig(config);
    const { botUserId, botUserName } = this.space;
    if (botUserId !== undefined) {
      this.identity = { id: botUserId, name: botUserName };
    }
    this.logger =
      this.space.logger ?? new ConsoleLogger('info').child('backlog');
    // The logger is read per request rather than captured: `initialize`
    // swaps in the `ChatInstance`'s after the transport may have been built.
    this.createTransport = () =>
      createBacklogJsTransport({
        host: this.space.host,
        credentials: this.space.credentials,
        logger: () => this.logger,
      });
  }

  /** `""` when the name is unknown: the core then falls back to `chat.userName`. */
  get userName(): string {
    return this.identity?.name ?? this.space.botUserName ?? '';
  }

  /**
   * A configured `botUserId` means no `GET /users/myself` at all, even with
   * the name missing: on serverless every cold start runs `initialize`, and a
   * bot that never relies on a typed `@name` would spend a request per start
   * learning it. A failed lookup is logged, never thrown: the core memoises a
   * rejected `initialize` and never retries it, which would refuse every later
   * webhook until the process restarts (D23).
   */
  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger('backlog');
    if (this.identity === undefined) {
      await this.botIdentity().catch((cause: unknown) => {
        this.logger.warn('bot identity lookup failed; retried on demand', {
          host: this.space.host,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    } else if (this.identity.name === undefined) {
      this.logger.warn(
        'botUserName is not set: the adapter does not detect a typed @name in comment text, nor an assignment in a body replayed from the activity API (its changes name the assignee by display name); notifications and the assignee id still count. The Chat SDK core still matches @<chat.userName>. Set BACKLOG_BOT_USER_NAME to enable both rules.'
      );
    }
  }

  private async botIdentity(): Promise<BotIdentity> {
    if (this.identity !== undefined) {
      return this.identity;
    }
    const myself = await this.api(this.space.host).getMyself();
    this.identity = {
      id: myself.id,
      name: this.space.botUserName ?? myself.name,
    };
    return this.identity;
  }

  /** For the synchronous members, which cannot await `botIdentity`. */
  private knownBotIdentity(): BotIdentity {
    if (this.identity === undefined) {
      throw new AdapterError(
        'the bot identity is not known yet: configure botUserId, or let initialize() read it from GET /users/myself',
        'backlog',
        'BOT_IDENTITY_UNRESOLVED'
      );
    }
    return this.identity;
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
    // Backlog has no typing indicator; the
    // member is required by the Adapter interface, so it resolves immediately.
  }

  /**
   * An id is well-formed whatever space it names, so a host other than the
   * configured one is refused here, at the point of use, rather than by the
   * decoder.
   */
  private api(host: string): BacklogApi {
    if (host !== this.space.host) {
      throw new ResourceNotFoundError('backlog', 'space', host);
    }
    return this.transport().api;
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
   * credential resolution. It holds no credential of its own, so it is safe
   * to keep past the call that asked for it.
   */
  client(): Backlog {
    const { client } = this.transport();
    if (client === undefined) {
      throw new AdapterError(
        'no Backlog client: this adapter runs on a port that is not `backlog-js`-backed',
        'backlog',
        'NO_CLIENT'
      );
    }
    return client;
  }

  private transport(): AdapterTransport {
    this.cachedTransport ??= this.createTransport();
    return this.cachedTransport;
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
    const rawBody = await verifyWebhookRequest({
      request,
      webhookVerifier: this.space.webhookVerifier,
      webhookSecret: this.space.webhookSecret,
      logger: this.logger,
    });
    if (rawBody === undefined) {
      this.logger.warn('webhook rejected: unauthorized');
      return new Response('Unauthorized', { status: 401 });
    }
    const { host } = this.space;

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
      identity = await this.botIdentity();
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
      this.knownBotIdentity()
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
      botUserId: (await this.botIdentity()).id,
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
      botUserId: (await this.botIdentity()).id,
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
      builders: this.messageBuilders(host, converter, await this.botIdentity()),
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
          await this.botIdentity()
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
   * through `client().getPullRequests(projectIdOrKey, repoIdOrName,
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
      builders: this.messageBuilders(host, converter, await this.botIdentity()),
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
      botUserId: (await this.botIdentity()).id,
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
      host: this.space.host,
      api: () => this.api(this.space.host),
    });
  }
}

export function createBacklogAdapter(
  config?: BacklogAdapterConfig
): BacklogAdapter {
  return new BacklogAdapter(config ?? {});
}
