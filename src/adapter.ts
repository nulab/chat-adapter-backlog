import {
  ResourceNotFoundError,
  toBuffer,
  ValidationError,
} from '@chat-adapter/shared';
import { ConsoleLogger, Message as MessageCtor } from 'chat';

import { createBacklogClient } from './client/backlog';
import { errorMessage } from './client/errors';
import { parseConfig } from './config';
import type { SpaceConfig } from './config';
import { readGitRepository, readProject } from './client/responses';
import type { Backlog } from 'backlog-js';
import {
  addReaction as addReactionToComment,
  bufferStream,
  editComment,
  postComment,
  removeReaction as removeReactionFromComment,
  requireCommentInThread,
} from './egress';
import { converter } from './format';
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
  rehydrateAttachment as rehydrateAttachmentRead,
} from './reads';
import type { MessageBuilders } from './reads';
import { subjectClientFor } from './subject/client';
import type { SubjectClient, SubjectNames } from './subject/client';
import type {
  BacklogAdapterConfig,
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
  ChannelInfo,
  ChatInstance,
  FetchOptions,
  FetchResult,
  FileUpload,
  FormattedContent,
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

function repositoryNameKey(host: string, repositoryId: number): string {
  return `${host}:${repositoryId}`;
}

/**
 * A Chat SDK adapter for one Backlog space, where a thread is an issue or a
 * pull request and a channel is a project.
 */
export class BacklogAdapter implements Adapter<
  BacklogThreadId,
  BacklogRawMessage
> {
  readonly name = 'backlog';

  private readonly space: SpaceConfig;
  private readonly backlog: Backlog;
  /** The two halves of a pull request's web URL, which its object lacks. */
  private readonly projectKeyCache = new Map<string, string>();
  private readonly repositoryNameCache = new Map<string, string>();

  private logger: Logger;
  private chat: ChatInstance | undefined;

  constructor(config: BacklogAdapterConfig = {}) {
    this.space = parseConfig(config);
    this.logger =
      this.space.logger ?? new ConsoleLogger('info').child('backlog');
    this.backlog = createBacklogClient({
      host: this.space.host,
      resolveApiKey: this.space.resolveApiKey,
      logger: () => this.logger,
    });
  }

  // Empty: the core reads it only for a text match the adapter overrides by
  // always setting isMention (chat-sdk-core-facts.md, D23).
  get userName(): string {
    return '';
  }

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger('backlog');
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
    // Required by `Adapter`; Backlog has no typing indicator.
  }

  /**
   * An id is well-formed whatever space it names, so a host other than the
   * configured one is refused here, at the point of use, rather than by the
   * decoder.
   */
  private clientFor(host: string): Backlog {
    if (host !== this.space.host) {
      throw new ResourceNotFoundError('backlog', 'space', host);
    }
    return this.backlog;
  }

  /**
   * The `backlog-js` client the adapter's own requests go through, for the
   * endpoints the adapter does not cover: it carries the bounded 429 retry,
   * the `@chat-adapter/shared` errors and the per-request credential, which
   * a client built beside it would not. It holds no credential itself.
   */
  client(): Backlog {
    return this.backlog;
  }

  renderFormatted(content: FormattedContent): string {
    return converter.fromAst(content);
  }

  private subjectClient(
    host: string,
    projectId: number,
    subject: BacklogSubjectRef
  ): SubjectClient {
    return subjectClientFor(this.clientFor(host), subject, { host, projectId });
  }

  private messageBuilders(
    host: string
  ): Omit<MessageBuilders, 'projectId' | 'subject'> {
    return {
      host,
      botUserId: this.space.botUserId,
      format: (text) => converter.toAst(text),
      MessageCtor,
    };
  }

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
   * `repositoryIdForName` gates the project key too, so an issue thread
   * spends no Get Project: its read budget is one Get Issue, and the issue
   * client derives its project key from `issueKey`. A kind that needs the
   * key without a repository gets a `SubjectClient` member of its own rather
   * than an unconditional lookup here.
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
    return {
      projectKey: await this.cachedName(
        this.projectKeyCache,
        encodeChannelId({ host, projectId }),
        async () =>
          (await readProject(this.clientFor(host).getProject(projectId)))
            .projectKey,
        'project key',
        { host, projectId }
      ),
      repositoryName: await this.cachedName(
        this.repositoryNameCache,
        repositoryNameKey(host, repositoryId),
        async () =>
          (
            await readGitRepository(
              this.clientFor(host).getGitRepository(
                projectId,
                String(repositoryId)
              )
            )
          ).name,
        'repository name',
        { host, projectId, repositoryId }
      ),
    };
  }

  /**
   * A failed lookup is not cached: the caller omits the URL rather than
   * failing, and the next call may find the name readable again.
   */
  private async cachedName(
    cache: Map<string, string>,
    key: string,
    lookUp: () => Promise<string>,
    what: string,
    fields: Record<string, unknown>
  ): Promise<string | undefined> {
    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    try {
      const name = await lookUp();
      cache.set(key, name);
      return name;
    } catch (cause) {
      this.logger.warn(`${what} lookup failed; url omitted`, {
        ...fields,
        error: errorMessage(cause),
      });
      return undefined;
    }
  }

  /**
   * `toBuffer`'s `platform: PlatformName` has no `"backlog"` member
   * (`@chat-adapter/shared@4.41.0`) and its default `throwOnUnsupported: true`
   * throws a `ValidationError` named after whichever platform was passed, so
   * the default would blame `"slack"` for a caller's unsupported `file.data`
   * and never reach the error below. `throwOnUnsupported: false` turns the
   * unsupported case into `null`, which leaves `platform` selecting wording
   * that is never rendered and keeps every error this adapter throws named
   * `"backlog"`.
   */
  private toFileBuffer = async (file: FileUpload): Promise<Buffer> => {
    let buffer: Buffer | null;
    try {
      buffer = await toBuffer(file.data, {
        platform: 'slack',
        throwOnUnsupported: false,
      });
    } catch (cause) {
      const error = new ValidationError(
        'backlog',
        `file "${file.filename}" could not be read: ${errorMessage(cause)}`
      );
      error.cause = cause;
      throw error;
    }
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

    if (activity.createdUser.id === this.space.botUserId) {
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

    const dispatch = (
      threadId: string,
      build: (context: InboundContext) => Message<BacklogRawMessage>
    ): void => {
      const factory = async () => build(this.inboundContext(host));
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
      error: errorMessage(cause),
    });
  }

  private inboundContext(host: string): InboundContext {
    return {
      host,
      botUserId: this.space.botUserId,
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
    const context = this.inboundContext(raw.host);
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
    return postComment({
      host,
      projectId,
      subject,
      client: this.clientFor(host),
      message,
      toBuffer: this.toFileBuffer,
    });
  }

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
    return editComment({
      host,
      projectId,
      subject: this.subjectClient(host, projectId, subject),
      commentId,
      message,
    });
  }

  /**
   * Rejects on a pull-request thread: Backlog cannot delete its comments
   * (D-PR3).
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
      client: this.clientFor(host),
      subject: this.subjectClient(host, projectId, subject),
      commentId,
      botUserId: this.space.botUserId,
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
      client: this.clientFor(host),
      subject: this.subjectClient(host, projectId, subject),
      commentId,
      botUserId: this.space.botUserId,
    });
  }

  async fetchMessages(
    threadId: string,
    options?: FetchOptions
  ): Promise<FetchResult<BacklogRawMessage>> {
    const { host, subject } = this.subjectFor(threadId);
    return fetchMessagesRead({
      threadId,
      options,
      subject,
      builders: this.messageBuilders(host),
    });
  }

  async fetchMessage(
    threadId: string,
    messageId: string
  ): Promise<Message<BacklogRawMessage> | null> {
    const { host, subject } = this.subjectFor(threadId);
    return fetchMessageRead({
      threadId,
      messageId,
      subject,
      builders: this.messageBuilders(host),
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
   * Call it on the adapter: `chat.getUser()` picks an adapter by the shape of
   * the id and does not recognise `<host>:<userId>`.
   */
  async getUser(userId: string): Promise<UserInfo | null> {
    const { host } = decodeUserIdString(userId);
    return getUserRead({
      userId,
      client: this.clientFor(host),
      botUserId: this.space.botUserId,
    });
  }

  /**
   * A failed lookup propagates rather than answering `null`: the core's
   * `message.subject` already turns a thrown error into `null`.
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
    return fetchChannelInfoRead({ channelId, client: this.clientFor(host) });
  }

  /**
   * Synchronous in the `Adapter` interface. A URL naming a host this adapter
   * was not configured for is returned unchanged, never fetched.
   */
  rehydrateAttachment(attachment: Attachment): Attachment {
    return rehydrateAttachmentRead({
      attachment,
      host: this.space.host,
      client: this.backlog,
    });
  }
}

export function createBacklogAdapter(
  config?: BacklogAdapterConfig
): BacklogAdapter {
  return new BacklogAdapter(config ?? {});
}
