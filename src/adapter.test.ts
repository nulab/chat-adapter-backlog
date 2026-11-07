import { ResourceNotFoundError, ValidationError } from '@chat-adapter/shared';
import { MemoryStateAdapter } from '@chat-adapter/state-memory';
import {
  connectWebhookContract,
  createMockChatInstance,
  createMockLogger,
  selfMessageContract,
  threadIdContract,
} from '@chat-adapter/tests';
import type { ChatHandler } from '@chat-adapter/tests/matchers';
import { Chat } from 'chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { BacklogAdapter, createBacklogAdapter } from './adapter';
import { encodeMessageId } from './ids';
import {
  ALICE,
  BOT,
  comment,
  gitRepository,
  issue,
  issueComment,
  project,
  pullRequest,
  star,
} from './test/fixtures/rest';
import {
  bulkFieldsChanged,
  FIXTURE,
  issueCommented,
  issueDeleted,
  issueMultiUpdated,
  pullRequestCommented,
  unrelatedActivity,
  webhookRequest,
} from './test/fixtures/webhooks';
import type {
  BacklogAdapterConfig,
  BacklogRawMessage,
  BacklogSubjectRef,
  BacklogThreadId,
  BacklogUser,
} from './types';
import type { Adapter, ChatInstance, FormattedContent, Message } from 'chat';

// `@chat-adapter/tests` declares its matchers on vitest 5's `Matchers<R, T>`, which
// cannot merge with the `Matchers<T>` of the vitest 4 installed here, so
// `toHaveDispatched` is declared again on `Assertion`. Drop this when vitest moves to 5.
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must match `Assertion<T = any>` exactly for declaration merging.
  interface Assertion<T = any> {
    toHaveDispatched(handler: ChatHandler): T;
  }
}

const ENV_KEYS = [
  'BACKLOG_HOST',
  'BACKLOG_API_KEY',
  'BACKLOG_BOT_USER_ID',
  'BACKLOG_WEBHOOK_SECRET',
] as const;

let savedEnv: Record<string, string | undefined>;

let network: Mock<typeof fetch>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  network = vi.fn<typeof fetch>(async (input) => {
    throw new Error(`unexpected network call: ${String(input)}`);
  });
  vi.stubGlobal('fetch', network);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function validConfig() {
  return {
    host: 'example.backlog.com',
    apiKey: 'test-api-key',
    botUserId: 999,
    webhookSecret: 'test-webhook-secret',
  };
}

describe('BacklogAdapter lifecycle and identity', () => {
  it('reports no thread as a DM', () => {
    const adapter = new BacklogAdapter(validConfig());
    expect(adapter.isDM('backlog:example.backlog.com:500:issue:8001')).toBe(
      false
    );
  });

  it('resolves startTyping as a no-op accepting all three parameters', async () => {
    const adapter = new BacklogAdapter(validConfig());
    await expect(
      adapter.startTyping(
        'backlog:example.backlog.com:500:issue:8001',
        'typing',
        { initiatorUserId: '100' }
      )
    ).resolves.toBeUndefined();
  });
});

describe('BacklogAdapter optional members Backlog cannot support are absent', () => {
  it('leaves out every optional member Backlog cannot support, so the core falls back', () => {
    const adapter = new BacklogAdapter(validConfig());
    const optionalMembers = [
      'openDM',
      'postEphemeral',
      'openModal',
      'scheduleMessage',
      'reply',
      'postObject',
      'editObject',
      'postChannelMessage',
      'markAsRead',
      'fetchChannelMessages',
      'endTyping',
      'disconnect',
      'onThreadSubscribe',
      'getChannelVisibility',
      'lockScope',
      'persistThreadHistory',
      'supportsTurnCancellation',
      'botUserId',
    ] as const;

    for (const member of optionalMembers) {
      expect(
        (adapter as unknown as Record<string, unknown>)[member]
      ).toBeUndefined();
    }
  });

  it('implements the optional members Backlog can support', () => {
    const adapter = new BacklogAdapter(validConfig());
    const implementedMembers = [
      'stream',
      'fetchMessage',
      'getUser',
      'fetchSubject',
      'fetchChannelInfo',
      'rehydrateAttachment',
    ] as const;

    for (const member of implementedMembers) {
      expect(adapter[member]).toBeInstanceOf(Function);
    }
  });
});

threadIdContract<BacklogThreadId>({
  name: 'backlog',
  encode: (decoded) =>
    new BacklogAdapter(validConfig()).encodeThreadId(decoded),
  decode: (id) => new BacklogAdapter(validConfig()).decodeThreadId(id),
  cases: [
    {
      decoded: {
        host: 'example.backlog.com',
        projectId: 500,
        subject: { kind: 'issue', issueId: 8001 },
      },
      encoded: 'backlog:example.backlog.com:500:issue:8001',
    },
    {
      decoded: {
        host: 'example.backlog.jp',
        projectId: 500,
        subject: { kind: 'issue', issueId: 8001 },
      },
      encoded: 'backlog:example.backlog.jp:500:issue:8001',
    },
    {
      decoded: {
        host: 'example.backlogtool.com',
        projectId: 500,
        subject: { kind: 'issue', issueId: 8001 },
      },
      encoded: 'backlog:example.backlogtool.com:500:issue:8001',
    },
    {
      decoded: {
        host: 'example.backlog.com',
        projectId: 500,
        subject: { kind: 'pullRequest', repositoryId: 700, number: 12 },
      },
      encoded: 'backlog:example.backlog.com:500:pr:700:12',
    },
    {
      decoded: {
        host: 'example.backlog.jp',
        projectId: 500,
        subject: { kind: 'pullRequest', repositoryId: 700, number: 12 },
      },
      encoded: 'backlog:example.backlog.jp:500:pr:700:12',
    },
    {
      decoded: {
        host: 'example.backlogtool.com',
        projectId: 500,
        subject: { kind: 'pullRequest', repositoryId: 700, number: 12 },
      },
      encoded: 'backlog:example.backlogtool.com:500:pr:700:12',
    },
  ],
});

describe('BacklogAdapter.client', () => {
  const base = {
    host: 'example.backlog.com',
    botUserId: 999,
    webhookSecret: 'test-webhook-secret',
  } as const;

  it('hands out one client across calls', () => {
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });

    expect(adapter.client()).toBe(adapter.client());
  });

  it('refuses a thread on a host other than the configured space', async () => {
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });

    await expect(
      adapter.fetchThread('backlog:other.backlog.com:500:issue:8001')
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    expect(network).not.toHaveBeenCalled();
  });
});

function webhookAdapterConfig(overrides: Partial<BacklogAdapterConfig> = {}) {
  return {
    host: FIXTURE.host,
    apiKey: 'test-api-key',
    botUserId: FIXTURE.bot.id,
    webhookSecret: FIXTURE.webhookSecret,
    ...overrides,
  };
}

function exampleProject() {
  return project({
    projectKey: FIXTURE.projectKey,
    name: 'Example project',
  });
}

const EXAMPLE_ISSUE = issue({
  issueKey: `${FIXTURE.projectKey}-1`,
  summary: 'Deploy fails on the staging space',
  createdUser: ALICE,
});

type Factory = () => Promise<Message<BacklogRawMessage>>;

/**
 * `createMockChatInstance`'s `processMessage` returns `undefined`, where the
 * real one returns a promise the adapter attaches its failure log to.
 */
function mockChat(
  processMessage: (
    adapter: Adapter,
    threadId: string,
    factory: Factory
  ) => Promise<void> = async () => {},
  logger = createMockLogger()
): ChatInstance {
  return createMockChatInstance({
    logger,
    overrides: {
      processMessage: vi.fn(processMessage) as ChatInstance['processMessage'],
      processMessageDeleted: vi.fn(async () => {}),
    },
  });
}

async function webhookAdapter(
  config: Record<string, unknown> = {}
): Promise<{ adapter: BacklogAdapter; chat: ChatInstance }> {
  const adapter = createBacklogAdapter({
    ...webhookAdapterConfig(),
    ...config,
  });
  const chat = mockChat();
  await adapter.initialize(chat);
  return { adapter, chat };
}

/** Resolves every dispatched factory, as the core does. */
async function initializeCapturingDispatches(
  adapter: BacklogAdapter
): Promise<{ threadId: string; message: Message<BacklogRawMessage> }[]> {
  const dispatched: {
    threadId: string;
    message: Message<BacklogRawMessage>;
  }[] = [];
  await adapter.initialize(
    mockChat(async (_adapter, threadId, factory) => {
      dispatched.push({ threadId, message: await factory() });
    })
  );
  return dispatched;
}

function threadIdsProcessedBy(chat: ChatInstance): string[] {
  return vi
    .mocked(chat.processMessage)
    .mock.calls.map(([, threadId]) => threadId);
}

const ISSUE_THREAD_ID = `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.issueId}`;
const PULL_REQUEST_THREAD_ID = `backlog:${FIXTURE.host}:${FIXTURE.projectId}:pr:${FIXTURE.repositoryId}:${FIXTURE.pullRequestNumber}`;

describe('BacklogAdapter.handleWebhook', () => {
  it('answers an unauthenticated request 401 and dispatches nothing', async () => {
    const { adapter, chat } = await webhookAdapter();

    const response = await adapter.handleWebhook(
      webhookRequest(issueCommented(), { token: 'wrong' })
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
    expect(chat).not.toHaveDispatched('processMessage');
  });

  it('answers a body that is not JSON 400', async () => {
    const { adapter } = await webhookAdapter();

    const response = await adapter.handleWebhook(
      webhookRequest(undefined, { body: 'not json' })
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid JSON');
  });

  it('answers a delivery its schema rejects 400', async () => {
    const { adapter, chat } = await webhookAdapter();
    const payload = issueCommented();
    delete payload['createdUser'];

    const response = await adapter.handleWebhook(webhookRequest(payload));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid payload');
    expect(chat).not.toHaveDispatched('processMessage');
  });

  it.each([[12], [13], [17], [21]])(
    'acknowledges an activity of type %i without dispatching it',
    async (type) => {
      const { adapter, chat } = await webhookAdapter();

      const response = await adapter.handleWebhook(
        webhookRequest({ ...unrelatedActivity(), type })
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Ignored');
      expect(chat).not.toHaveDispatched('processMessage');
    }
  );

  it('answers 503 before initialize() has run', async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());

    const response = await adapter.handleWebhook(
      webhookRequest(issueCommented())
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Adapter not initialized');
  });

  it("acknowledges the bot's own activity without dispatching it", async () => {
    const { adapter, chat } = await webhookAdapter();

    const response = await adapter.handleWebhook(
      webhookRequest(issueMultiUpdated({ createdUser: FIXTURE.bot }))
    );

    expect(response.status).toBe(200);
    expect(chat).not.toHaveDispatched('processMessage');
  });

  it('answers before the dispatched message has been built', async () => {
    let release: (() => void) | undefined;
    const built = vi.fn();
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    await adapter.initialize(
      mockChat(async (_adapter, _threadId, factory) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        built(await factory());
      })
    );

    const response = await adapter.handleWebhook(
      webhookRequest(issueCommented())
    );

    expect(response.status).toBe(200);
    expect(built).not.toHaveBeenCalled();
    release?.();
    await vi.waitFor(() =>
      expect(built).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: ISSUE_THREAD_ID })
      )
    );
  });

  it('logs a failed dispatch with its thread instead of rejecting', async () => {
    const logger = createMockLogger();
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    await adapter.initialize(
      mockChat(async () => {
        throw new Error('handler exploded');
      }, logger)
    );

    const response = await adapter.handleWebhook(
      webhookRequest(issueCommented())
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() =>
      expect(logger.error).toHaveBeenCalledWith('inbound processing failed', {
        host: FIXTURE.host,
        threadId: ISSUE_THREAD_ID,
        error: 'handler exploded',
      })
    );
  });

  it('reports a deleted issue as the deletion of its root message', async () => {
    const { adapter, chat } = await webhookAdapter();

    const response = await adapter.handleWebhook(
      webhookRequest(issueDeleted())
    );

    expect(response.status).toBe(200);
    expect(chat.processMessageDeleted).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'backlog',
        threadId: ISSUE_THREAD_ID,
        messageId: `${FIXTURE.host}:issue:${FIXTURE.issueId}:r`,
      }),
      undefined
    );
  });

  it('dispatches a bulk update once per issue, each into its own thread', async () => {
    const { adapter, chat } = await webhookAdapter();

    await adapter.handleWebhook(webhookRequest(bulkFieldsChanged()));

    expect(threadIdsProcessedBy(chat)).toEqual([
      ISSUE_THREAD_ID,
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.otherIssueId}`,
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.thirdIssueId}`,
    ]);
  });

  it('builds the messages of a delivery without a project lookup', async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const getProject = vi
      .spyOn(adapter.client(), 'getProject')
      .mockResolvedValue(exampleProject());
    const dispatched = await initializeCapturingDispatches(adapter);

    await adapter.handleWebhook(webhookRequest(bulkFieldsChanged()));
    await vi.waitFor(() => expect(dispatched).toHaveLength(3));

    expect(getProject).not.toHaveBeenCalled();
  });

  it("dispatches a pull-request comment into the pull request's thread", async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const dispatched = await initializeCapturingDispatches(adapter);

    await adapter.handleWebhook(webhookRequest(pullRequestCommented()));

    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]?.threadId).toBe(PULL_REQUEST_THREAD_ID);
  });
});

describe('BacklogAdapter.parseMessage', () => {
  async function delivered(
    payload: Record<string, unknown>
  ): Promise<Message<BacklogRawMessage>[]> {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const dispatched = await initializeCapturingDispatches(adapter);
    await adapter.handleWebhook(webhookRequest(payload));
    await vi.waitFor(() => expect(dispatched.length).toBeGreaterThan(0));
    return dispatched.map(({ message }) => message);
  }

  async function parsedAgain(
    message: Message<BacklogRawMessage>
  ): Promise<Message<BacklogRawMessage>> {
    const { adapter } = await webhookAdapter();
    return adapter.parseMessage(JSON.parse(JSON.stringify(message.raw)));
  }

  it.each([
    ['an issue comment', issueCommented()],
    ['a pull-request comment', pullRequestCommented()],
  ])(
    'rebuilds %s from its raw message after a JSON round trip',
    async (_case, payload) => {
      const [message] = await delivered(payload);

      const rebuilt = await parsedAgain(message!);

      expect(rebuilt.toJSON()).toEqual(message!.toJSON());
    }
  );

  it('rebuilds one issue of a bulk update from the delivery and its issue id', async () => {
    const [, second] = await delivered(issueMultiUpdated());

    const rebuilt = await parsedAgain(second!);

    expect(rebuilt.toJSON()).toEqual(second!.toJSON());
  });

  it('refuses a raw message the adapter read over REST', async () => {
    const { adapter } = await webhookAdapter();
    const raw: BacklogRawMessage = {
      kind: 'comment',
      host: FIXTURE.host,
      projectId: FIXTURE.projectId,
      subject: { kind: 'issue', issueId: FIXTURE.issueId },
      comment: comment({ content: 'hello' }),
      changes: [],
    };

    expect(() => adapter.parseMessage(raw)).toThrow(ValidationError);
  });

  it('refuses a bulk update raw message naming an issue the batch does not cover', async () => {
    const [message] = await delivered(issueMultiUpdated());
    const { adapter } = await webhookAdapter();

    expect(() =>
      adapter.parseMessage({
        ...(message!.raw as Extract<BacklogRawMessage, { kind: 'bulkUpdate' }>),
        issueId: 1,
      })
    ).toThrow(ValidationError);
  });
});

const ISSUE_SUBJECT: BacklogSubjectRef = {
  kind: 'issue',
  issueId: FIXTURE.issueId,
};

/**
 * An adapter on the fixture space whose client answers Get Project,
 * Get Issue and Add Comment; a test stubs any other method it reaches, and
 * one it forgot fails on the stubbed global `fetch`.
 */
function egressAdapter(
  options: {
    logger?: ReturnType<typeof createMockLogger>;
  } = {}
) {
  const adapter = createBacklogAdapter({
    ...webhookAdapterConfig(),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  const client = adapter.client();
  const backlog = {
    client,
    getProject: vi
      .spyOn(client, 'getProject')
      .mockResolvedValue(exampleProject()),
    getIssue: vi
      .spyOn(client, 'getIssue')
      .mockResolvedValue(EXAMPLE_ISSUE as never),
    postIssueComments: vi
      .spyOn(client, 'postIssueComments')
      .mockImplementation(
        async (_issueIdOrKey, params) =>
          issueComment({ content: params.content, createdUser: BOT }) as never
      ),
  };
  return { adapter, backlog };
}

const EGRESS_THREAD_ID = ISSUE_THREAD_ID;

function commentMessageId(
  subject: BacklogSubjectRef = ISSUE_SUBJECT,
  commentId = 1
): string {
  return encodeMessageId({
    host: FIXTURE.host,
    subject,
    part: 'comment',
    commentId,
  });
}

describe('BacklogAdapter.postMessage', () => {
  it('a reply is posted as a comment on the issue', async () => {
    const { adapter, backlog } = egressAdapter();

    const result = await adapter.postMessage(EGRESS_THREAD_ID, {
      markdown: 'Any progress on this?',
    });

    expect(result.threadId).toBe(EGRESS_THREAD_ID);
    expect(backlog.postIssueComments).toHaveBeenCalledWith(FIXTURE.issueId, {
      content: 'Any progress on this?',
    });
  });

  it('a channel id, which channel.post() passes, is a validation error and creates nothing', async () => {
    const { adapter, backlog } = egressAdapter();

    await expect(
      adapter.postMessage(`backlog:${FIXTURE.host}:${FIXTURE.projectId}`, {
        markdown: 'Deploy fails on staging',
      })
    ).rejects.toThrow(ValidationError);
    expect(backlog.postIssueComments).not.toHaveBeenCalled();
  });

  it('an ArrayBuffer and a Blob are uploaded like a Buffer, each with its own bytes', async () => {
    const { adapter, backlog } = egressAdapter();
    const postSpaceAttachment = vi
      .spyOn(backlog.client, 'postSpaceAttachment')
      .mockImplementation(async () => ({ id: 77 }) as never);

    await adapter.postMessage(EGRESS_THREAD_ID, {
      markdown: 'See attached',
      files: [
        { filename: 'buffer.bin', data: Buffer.from('buf') },
        { filename: 'array.bin', data: new ArrayBuffer(4) },
        { filename: 'blob.txt', data: new Blob(['blob!']) },
      ],
    });

    expect(
      postSpaceAttachment.mock.calls.map(([form]) => {
        const file = form.get('file') as File;
        return [file.name, file.size];
      })
    ).toEqual([
      ['buffer.bin', 3],
      ['array.bin', 4],
      ['blob.txt', 5],
    ]);
  });

  it('a file whose data is neither a Buffer, an ArrayBuffer nor a Blob is rejected as a backlog error, and neither that file nor the comment reaches Backlog', async () => {
    const { adapter, backlog } = egressAdapter();
    const postSpaceAttachment = vi.spyOn(backlog.client, 'postSpaceAttachment');

    const rejection = adapter.postMessage(EGRESS_THREAD_ID, {
      markdown: 'See attached',
      files: [{ filename: 'notes.txt', data: new ReadableStream() }],
    } as unknown as Parameters<BacklogAdapter['postMessage']>[1]);

    await expect(rejection).rejects.toThrow(ValidationError);
    await expect(rejection).rejects.toThrow(/notes\.txt/);
    await expect(rejection).rejects.toMatchObject({ adapter: 'backlog' });
    expect(postSpaceAttachment).not.toHaveBeenCalled();
    expect(backlog.postIssueComments).not.toHaveBeenCalled();
  });

  it('a Blob that cannot be read is rejected as a backlog error carrying the read failure, and the comment does not reach Backlog', async () => {
    const { adapter, backlog } = egressAdapter();
    const readFailure = new TypeError('The blob could not be read');
    const unreadable = new Blob(['gone']);
    unreadable.arrayBuffer = () => Promise.reject(readFailure);

    const rejection = adapter.postMessage(EGRESS_THREAD_ID, {
      markdown: 'See attached',
      files: [{ filename: 'detached.png', data: unreadable }],
    });

    await expect(rejection).rejects.toThrow(ValidationError);
    await expect(rejection).rejects.toThrow(/detached\.png/);
    await expect(rejection).rejects.toMatchObject({
      adapter: 'backlog',
      cause: readFailure,
    });
    expect(backlog.postIssueComments).not.toHaveBeenCalled();
  });
});

describe('BacklogAdapter.editMessage / deleteMessage', () => {
  it('an edit rewrites the comment with the rendered content', async () => {
    const { adapter, backlog } = egressAdapter();
    const patchIssueComment = vi
      .spyOn(backlog.client, 'patchIssueComment')
      .mockImplementation(
        async (_issueIdOrKey, commentId, params) =>
          issueComment({
            id: commentId,
            content: params.content,
            createdUser: BOT,
          }) as never
      );

    const result = await adapter.editMessage(
      EGRESS_THREAD_ID,
      commentMessageId(),
      { markdown: '**bold**' }
    );

    expect(patchIssueComment).toHaveBeenCalledWith(FIXTURE.issueId, 1, {
      content: '**bold**',
    });
    expect(result.id).toBe(commentMessageId());
  });
});

describe('BacklogAdapter.stream', () => {
  it('a streamed reply is posted once and never edited', async () => {
    const { adapter, backlog } = egressAdapter();
    const patchIssueComment = vi.spyOn(backlog.client, 'patchIssueComment');
    async function* chunks() {
      yield 'Hello, ';
      yield { type: 'markdown_text' as const, text: 'world' };
    }

    const result = await adapter.stream(EGRESS_THREAD_ID, chunks());

    expect(result.threadId).toBe(EGRESS_THREAD_ID);
    expect(backlog.postIssueComments).toHaveBeenCalledTimes(1);
    expect(backlog.postIssueComments).toHaveBeenCalledWith(FIXTURE.issueId, {
      content: 'Hello, world',
    });
    expect(patchIssueComment).not.toHaveBeenCalled();
  });

  it('an empty stream posts a single space', async () => {
    const { adapter, backlog } = egressAdapter();
    async function* chunks(): AsyncIterable<string> {}

    await adapter.stream(EGRESS_THREAD_ID, chunks());

    expect(backlog.postIssueComments).toHaveBeenCalledWith(FIXTURE.issueId, {
      content: ' ',
    });
  });
});

describe('BacklogAdapter reactions', () => {
  it('a reaction stars the comment through the thread subject', async () => {
    const { adapter, backlog } = egressAdapter();
    vi.spyOn(backlog.client, 'getIssueComment').mockResolvedValue(
      issueComment({ id: 1, stars: [star(ALICE, 1)] }) as never
    );
    const postStar = vi
      .spyOn(backlog.client, 'postStar')
      .mockResolvedValue(undefined);

    await adapter.addReaction(EGRESS_THREAD_ID, commentMessageId(), 'star');

    expect(postStar).toHaveBeenCalledWith({ commentId: 1 });
  });
});

describe('BacklogAdapter.fetchSubject', () => {
  it('the subject of a serialised pull request root spends two reads, the names but not the pull request', async () => {
    const { adapter, backlog } = egressAdapter();
    const getPullRequest = vi
      .spyOn(backlog.client, 'getPullRequest')
      .mockResolvedValue(pullRequest() as never);
    const getGitRepository = vi
      .spyOn(backlog.client, 'getGitRepository')
      .mockResolvedValue(gitRepository({ name: FIXTURE.repositoryName }));

    const subject = await adapter.fetchSubject({
      kind: 'pullRequest',
      host: FIXTURE.host,
      pullRequest: pullRequest(),
      changes: [],
    });

    expect(subject).toMatchObject({
      type: 'pull_request',
      url: `https://${FIXTURE.host}/git/${FIXTURE.projectKey}/${FIXTURE.repositoryName}/pullRequests/${FIXTURE.pullRequestNumber}`,
    });
    expect(getPullRequest).not.toHaveBeenCalled();
    expect(backlog.getProject).toHaveBeenCalledTimes(1);
    expect(getGitRepository).toHaveBeenCalledTimes(1);
  });
});

describe('BacklogAdapter.getUser', () => {
  function answeringUsers(users: BacklogUser[]) {
    const { adapter, backlog } = egressAdapter();
    vi.spyOn(backlog.client, 'getUser').mockImplementation(async (id) => {
      const found = users.find((candidate) => candidate.id === id);
      if (found === undefined) {
        throw new ResourceNotFoundError('backlog', 'user', String(id));
      }
      return found as never;
    });
    return adapter;
  }

  it('a user id round-trips through getUser', async () => {
    const adapter = answeringUsers([BOT, ALICE]);
    const userId = `${FIXTURE.host}:${FIXTURE.alice.id}`;

    const user = await adapter.getUser(userId);

    expect(user).toMatchObject({
      userId,
      userName: FIXTURE.alice.userId,
      fullName: FIXTURE.alice.name,
      isBot: false,
    });
  });

  it('the bot user reports isBot true', async () => {
    const adapter = answeringUsers([BOT]);

    const user = await adapter.getUser(`${FIXTURE.host}:${FIXTURE.bot.id}`);

    expect(user?.isBot).toBe(true);
  });

  it('an unknown user id resolves to null', async () => {
    const adapter = answeringUsers([BOT]);

    const user = await adapter.getUser(`${FIXTURE.host}:999999`);

    expect(user).toBeNull();
  });
});

describe('BacklogAdapter.fetchChannelInfo', () => {
  it('names the project and reports its key', async () => {
    const { adapter } = egressAdapter();
    const channelId = `backlog:${FIXTURE.host}:${FIXTURE.projectId}`;

    await expect(adapter.fetchChannelInfo(channelId)).resolves.toEqual({
      id: channelId,
      name: 'Example project',
      isDM: false,
      metadata: {
        host: FIXTURE.host,
        projectId: FIXTURE.projectId,
        projectKey: FIXTURE.projectKey,
      },
    });
  });
});

const BOLD_CONTENT: FormattedContent = {
  type: 'root',
  children: [
    {
      type: 'paragraph',
      children: [
        { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
      ],
    },
  ],
};

describe('BacklogAdapter.renderFormatted', () => {
  it('renders Markdown', () => {
    const adapter = new BacklogAdapter(validConfig());

    expect(adapter.renderFormatted(BOLD_CONTENT)).toBe('**bold**');
  });
});

describe('BacklogAdapter wiring with a real Chat instance', () => {
  it('a mention delivered through handleWebhook is answered with exactly one comment', async () => {
    const { adapter, backlog } = egressAdapter();
    let resolveMentionHandled: (() => void) | undefined;
    const mentionHandled = new Promise<void>((resolve) => {
      resolveMentionHandled = resolve;
    });
    const chat = new Chat({
      adapters: { backlog: adapter },
      state: new MemoryStateAdapter(),
      userName: 'backlog-bot',
    });
    chat.onNewMention(async (thread, message) => {
      await thread.post(`Thanks for the mention, ${message.author.fullName}!`);
      resolveMentionHandled?.();
    });
    await chat.initialize();

    const response = await adapter.handleWebhook(
      webhookRequest(
        issueCommented({
          text: 'please help',
          notifications: [{ user: FIXTURE.bot, reason: 2 }],
          createdUser: FIXTURE.alice,
        })
      )
    );
    expect(response.status).toBe(200);
    await mentionHandled;

    expect(backlog.postIssueComments).toHaveBeenCalledTimes(1);
    expect(backlog.postIssueComments).toHaveBeenCalledWith(FIXTURE.issueId, {
      content: 'Thanks for the mention, Alice!',
    });
  });
});

connectWebhookContract({
  name: 'backlog',
  createChat: () => mockChat(),
  createAdapter: ({ webhookVerifier }) =>
    createBacklogAdapter({
      host: FIXTURE.host,
      apiKey: 'connect-key',
      botUserId: FIXTURE.bot.id,
      webhookVerifier,
    }),
  makeWebhookRequest: () => webhookRequest(issueCommented(), { token: null }),
});

selfMessageContract({
  name: 'backlog',
  setup: async () => webhookAdapter(),
  makeOtherMessageRequest: () => webhookRequest(issueCommented()),
  makeSelfMessageRequest: () =>
    webhookRequest(
      issueCommented({
        createdUser: {
          id: FIXTURE.bot.id,
          name: FIXTURE.bot.name,
          userId: FIXTURE.bot.userId,
        },
      })
    ),
});

/**
 * The same contract over a pull-request activity. The self-skip reads
 * `createdUser.id` off the envelope, which every activity type carries, so
 * this run cannot fail while the type-3 run above passes — unless the
 * pull-request path ever grows a skip of its own, which is exactly the
 * regression worth catching.
 */
selfMessageContract({
  name: 'backlog (pull request)',
  setup: async () => webhookAdapter(),
  makeOtherMessageRequest: () => webhookRequest(pullRequestCommented()),
  makeSelfMessageRequest: () =>
    webhookRequest(
      pullRequestCommented({
        createdUser: {
          id: FIXTURE.bot.id,
          name: FIXTURE.bot.name,
          userId: FIXTURE.bot.userId,
        },
      })
    ),
});
