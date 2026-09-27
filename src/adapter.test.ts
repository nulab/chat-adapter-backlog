import {
  AdapterError,
  ResourceNotFoundError,
  ValidationError,
} from '@chat-adapter/shared';
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
  BOB,
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
  BacklogWebhookPayload,
} from './types';
import type { Adapter, ChatInstance, FormattedContent, Message } from 'chat';

/**
 * `@chat-adapter/tests@4.39.0`'s own `matchers.d.ts` augments
 * `declare module "vitest" { interface Assertion<T = any> { ... } }`, which
 * does not merge under this repo's installed `vitest@4.1.11`: `Assertion`
 * there only re-exports `@vitest/expect`'s `Assertion`, and vitest 4 moved
 * the actual custom-matcher extension point to the (initially empty)
 * `Matchers<T>` interface `Assertion` extends — verified by reproducing both
 * augmentation targets against this toolchain, where only `Matchers` merged.
 * Re-declaring `toHaveDispatched` here against the interface vitest 4
 * actually extends is a type-only shim; the runtime matcher itself still
 * comes from `@chat-adapter/tests/setup` via `vitest.config.ts`.
 */
declare module 'vitest' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- must match `Matchers<T = any>` exactly for declaration merging (see comment above).
  interface Matchers<T = any> {
    toHaveDispatched(handler: ChatHandler): T;
  }
}

const ENV_KEYS = [
  'BACKLOG_HOST',
  'BACKLOG_API_KEY',
  'BACKLOG_ACCESS_TOKEN',
  'BACKLOG_BOT_USER_ID',
  'BACKLOG_BOT_USER_NAME',
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

async function requestHeaders(adapter: BacklogAdapter): Promise<Headers> {
  network.mockImplementation(async () => new Response(JSON.stringify(BOT)));
  await adapter.client().getMyself();
  return new Headers(network.mock.calls[0]?.[1]?.headers);
}

function validConfig() {
  return {
    host: 'example.backlog.com',
    apiKey: 'test-api-key',
    botUserId: 999,
    botUserName: 'Chatbot',
    webhookSecret: 'test-webhook-secret',
  };
}

describe('BacklogAdapter construction', () => {
  it('refuses a config its schema rejects', () => {
    expect(() => new BacklogAdapter({})).toThrow(ValidationError);
  });

  it('reports the configured bot name as its userName', () => {
    expect(new BacklogAdapter(validConfig()).userName).toBe('Chatbot');
  });
});

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

  it('derives the channel id from a thread id', () => {
    const adapter = new BacklogAdapter(validConfig());
    expect(
      adapter.channelIdFromThreadId(
        'backlog:example.backlog.com:500:issue:8001'
      )
    ).toBe('backlog:example.backlog.com:500');
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
      'listThreads',
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

describe('BacklogAdapter type-level contract', () => {
  it('satisfies the Adapter<BacklogThreadId, BacklogRawMessage> shape', () => {
    const adapter = new BacklogAdapter(validConfig());
    const typed: Adapter<BacklogThreadId, unknown> = adapter;
    expect(typed).toBe(adapter);
  });

  it('is accepted by new Chat({ adapters: { backlog } })', () => {
    const adapter = new BacklogAdapter(validConfig());
    const chat = new Chat({
      adapters: { backlog: adapter },
      state: new MemoryStateAdapter(),
      userName: 'Chatbot',
    });
    expect(chat).toBeDefined();
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
    botUserName: 'Chatbot',
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

  it('sends an api key as the Backlog-API-Key header', async () => {
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });

    const headers = await requestHeaders(adapter);

    expect(headers.get('Backlog-API-Key')).toBe('key');
    expect(headers.get('Authorization')).toBeNull();
  });

  it('sends an access token as a Bearer Authorization header', async () => {
    const adapter = createBacklogAdapter({ ...base, accessToken: 'token' });

    const headers = await requestHeaders(adapter);

    expect(headers.get('Authorization')).toBe('Bearer token');
    expect(headers.get('Backlog-API-Key')).toBeNull();
  });
});

function webhookAdapterConfig(overrides: Partial<BacklogAdapterConfig> = {}) {
  return {
    host: FIXTURE.host,
    apiKey: 'test-api-key',
    botUserId: FIXTURE.bot.id,
    botUserName: FIXTURE.bot.name,
    webhookSecret: FIXTURE.webhookSecret,
    ...overrides,
  };
}

function exampleProject(
  textFormattingRule: 'markdown' | 'backlog' = 'markdown'
) {
  return project({
    projectKey: FIXTURE.projectKey,
    name: 'Example project',
    textFormattingRule,
  });
}

const EXAMPLE_ISSUE = issue({
  issueKey: `${FIXTURE.projectKey}-1`,
  summary: 'Deploy fails on the staging space',
  createdUser: ALICE,
});

/** Answers Get Project for the fixture project, which every webhook and formatted write looks up. */
function withProject(
  adapter: BacklogAdapter,
  textFormattingRule: 'markdown' | 'backlog' = 'markdown'
): BacklogAdapter {
  vi.spyOn(adapter.client(), 'getProject').mockResolvedValue(
    exampleProject(textFormattingRule)
  );
  return adapter;
}

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
  const adapter = withProject(
    createBacklogAdapter({ ...webhookAdapterConfig(), ...config })
  );
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
    const adapter = withProject(createBacklogAdapter(webhookAdapterConfig()));
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
    const adapter = withProject(createBacklogAdapter(webhookAdapterConfig()));
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

  it('looks the project up once for a bulk update, however many issues it touched', async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const getProject = vi
      .spyOn(adapter.client(), 'getProject')
      .mockResolvedValue(exampleProject());
    const dispatched = await initializeCapturingDispatches(adapter);

    await adapter.handleWebhook(webhookRequest(bulkFieldsChanged()));
    await vi.waitFor(() => expect(dispatched).toHaveLength(3));

    expect(getProject).toHaveBeenCalledTimes(1);
  });

  it("dispatches a pull-request comment into the pull request's thread", async () => {
    const adapter = withProject(createBacklogAdapter(webhookAdapterConfig()));
    const dispatched = await initializeCapturingDispatches(adapter);

    await adapter.handleWebhook(webhookRequest(pullRequestCommented()));

    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]?.threadId).toBe(PULL_REQUEST_THREAD_ID);
  });

  it('keeps the repository name a delivery carries, sparing the next thread read a lookup', async () => {
    const { adapter, backlog } = egressAdapter();
    vi.spyOn(backlog.client, 'getPullRequest').mockResolvedValue(
      pullRequest() as never
    );
    const getGitRepository = vi.spyOn(backlog.client, 'getGitRepository');
    await initializeCapturingDispatches(adapter);

    await adapter.handleWebhook(webhookRequest(pullRequestCommented()));
    const thread = await adapter.fetchThread(PULL_REQUEST_THREAD_ID);

    expect(thread.metadata).toMatchObject({
      url: `https://${FIXTURE.host}/git/${FIXTURE.projectKey}/${FIXTURE.repositoryName}/pullRequests/${FIXTURE.pullRequestNumber}`,
    });
    expect(getGitRepository).not.toHaveBeenCalled();
  });

  it('formats the text with the rule of the project the delivery came from', async () => {
    const adapter = withProject(
      createBacklogAdapter(webhookAdapterConfig()),
      'backlog'
    );
    const dispatched = await initializeCapturingDispatches(adapter);

    await adapter.handleWebhook(
      webhookRequest(issueCommented({ text: "''urgent''" }))
    );

    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]?.message.formatted).toEqual(URGENT_CONTENT);
  });
});

describe('BacklogAdapter.parseMessage', () => {
  async function delivered(
    payload: Record<string, unknown>
  ): Promise<Message<BacklogRawMessage>[]> {
    const adapter = withProject(createBacklogAdapter(webhookAdapterConfig()));
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

const URGENT_CONTENT: FormattedContent = {
  type: 'root',
  children: [
    {
      type: 'paragraph',
      children: [
        { type: 'strong', children: [{ type: 'text', value: 'urgent' }] },
      ],
    },
  ],
};

/**
 * An adapter on the fixture space whose client answers Get Project,
 * Get Issue and Add Comment; a test stubs any other method it reaches, and
 * one it forgot fails on the stubbed global `fetch`.
 */
function egressAdapter(
  options: {
    textFormattingRule?: 'markdown' | 'backlog';
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
      .mockResolvedValue(exampleProject(options.textFormattingRule)),
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

  it('a bold reply on a notation project uses two quotes', async () => {
    const { adapter, backlog } = egressAdapter({
      textFormattingRule: 'backlog',
    });

    await adapter.postMessage(EGRESS_THREAD_ID, { markdown: '**bold**' });

    expect(backlog.postIssueComments).toHaveBeenCalledWith(FIXTURE.issueId, {
      content: "''bold''",
    });
  });

  it('an unreadable project setting degrades to markdown for one call', async () => {
    const { adapter, backlog } = egressAdapter();
    backlog.getProject.mockRejectedValue(new Error('project lookup failed'));

    await adapter.postMessage(EGRESS_THREAD_ID, { markdown: '**bold**' });

    expect(backlog.postIssueComments).toHaveBeenCalledWith(FIXTURE.issueId, {
      content: '**bold**',
    });
  });
});

describe('BacklogAdapter.editMessage / deleteMessage', () => {
  it("an edit rewrites the comment with the project's formatting rule", async () => {
    const { adapter, backlog } = egressAdapter({
      textFormattingRule: 'backlog',
    });
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
      content: "''bold''",
    });
    expect(result.id).toBe(commentMessageId());
  });

  it('deleting an issue comment through a pull request thread is rejected before any request', async () => {
    const { adapter, backlog } = egressAdapter();
    const deleteIssueComment = vi.spyOn(backlog.client, 'deleteIssueComment');

    await expect(
      adapter.deleteMessage(PULL_REQUEST_THREAD_ID, commentMessageId())
    ).rejects.toThrow(ValidationError);
    expect(deleteIssueComment).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
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
  function withCommentStarredBy(presenters: BacklogUser[] = []) {
    const { adapter, backlog } = egressAdapter();
    vi.spyOn(backlog.client, 'getIssueComment').mockResolvedValue(
      issueComment({
        id: 1,
        stars: presenters.map((presenter, index) => star(presenter, index + 1)),
      }) as never
    );
    const postStar = vi
      .spyOn(backlog.client, 'postStar')
      .mockResolvedValue(undefined);
    const removeStar = vi
      .spyOn(backlog.client, 'removeStar')
      .mockResolvedValue(undefined);
    return { adapter, postStar, removeStar };
  }

  it('a reaction stars the comment unless the bot has already starred it', async () => {
    const unstarred = withCommentStarredBy([ALICE]);
    const starred = withCommentStarredBy([BOT]);

    await unstarred.adapter.addReaction(
      EGRESS_THREAD_ID,
      commentMessageId(),
      'star'
    );
    await starred.adapter.addReaction(
      EGRESS_THREAD_ID,
      commentMessageId(),
      'star'
    );

    expect(unstarred.postStar).toHaveBeenCalledWith({ commentId: 1 });
    expect(starred.postStar).not.toHaveBeenCalled();
  });

  it("removing a reaction leaves other users' stars", async () => {
    const { adapter, removeStar } = withCommentStarredBy([BOT, BOB]);

    await adapter.removeReaction(EGRESS_THREAD_ID, commentMessageId(), 'star');

    expect(removeStar.mock.calls).toEqual([[1]]);
  });
});

describe('BacklogAdapter.fetchMessages / fetchMessage / fetchThread', () => {
  it('fetchMessage parses a comment with the project formatting rule', async () => {
    const { adapter, backlog } = egressAdapter({
      textFormattingRule: 'backlog',
    });
    vi.spyOn(backlog.client, 'getIssueComment').mockResolvedValue(
      issueComment({ id: 1, content: "''urgent''" }) as never
    );

    const message = await adapter.fetchMessage(
      EGRESS_THREAD_ID,
      commentMessageId()
    );

    expect(message?.formatted).toEqual(URGENT_CONTENT);
  });

  it('an id fetchMessage answers null for spends no project lookup', async () => {
    const { adapter, backlog } = egressAdapter();

    const message = await adapter.fetchMessage(
      EGRESS_THREAD_ID,
      encodeMessageId({
        host: FIXTURE.host,
        subject: ISSUE_SUBJECT,
        part: 'update',
        created: '2026-01-01T00:00:00Z',
      })
    );

    expect(message).toBeNull();
    expect(backlog.getProject).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it('fetchMessages parses comments with the project formatting rule', async () => {
    const { adapter, backlog } = egressAdapter({
      textFormattingRule: 'backlog',
    });
    vi.spyOn(backlog.client, 'getIssueComments').mockResolvedValue([
      issueComment({ id: 1, content: "''urgent''" }),
    ] as never);

    const result = await adapter.fetchMessages(EGRESS_THREAD_ID, {
      limit: 2,
      direction: 'backward',
    });
    const urgent = result.messages.find(
      (message) => message.text === "''urgent''"
    );

    expect(urgent?.formatted).toEqual(URGENT_CONTENT);
  });

  it('thread info names its kind for both issues and pull requests', async () => {
    const { adapter, backlog } = egressAdapter();
    vi.spyOn(backlog.client, 'getPullRequest').mockResolvedValue(
      pullRequest() as never
    );
    vi.spyOn(backlog.client, 'getGitRepository').mockResolvedValue(
      gitRepository({ name: FIXTURE.repositoryName })
    );

    const issueThread = await adapter.fetchThread(EGRESS_THREAD_ID);
    const pullRequestThread = await adapter.fetchThread(PULL_REQUEST_THREAD_ID);

    expect(issueThread.metadata).toMatchObject({
      kind: 'issue',
      issueId: FIXTURE.issueId,
      url: `https://${FIXTURE.host}/view/${FIXTURE.projectKey}-1`,
    });
    expect(pullRequestThread).toMatchObject({
      channelId: `backlog:${FIXTURE.host}:${FIXTURE.projectId}`,
      channelName: FIXTURE.projectKey,
      isDM: false,
    });
    expect(pullRequestThread.metadata).toMatchObject({
      kind: 'pullRequest',
      repositoryId: FIXTURE.repositoryId,
      number: FIXTURE.pullRequestNumber,
      url: `https://${FIXTURE.host}/git/${FIXTURE.projectKey}/${FIXTURE.repositoryName}/pullRequests/${FIXTURE.pullRequestNumber}`,
    });
  });

  it('a pull request thread whose repository cannot be read is described without a url', async () => {
    const logger = createMockLogger();
    const { adapter, backlog } = egressAdapter({ logger });
    vi.spyOn(backlog.client, 'getPullRequest').mockResolvedValue(
      pullRequest() as never
    );
    vi.spyOn(backlog.client, 'getGitRepository').mockRejectedValue(
      new ResourceNotFoundError('backlog', 'gitRepository')
    );

    const thread = await adapter.fetchThread(PULL_REQUEST_THREAD_ID);

    expect(thread.metadata).toMatchObject({ kind: 'pullRequest' });
    expect(thread.metadata).not.toHaveProperty('url');
    expect(logger.warn).toHaveBeenCalledWith(
      'repository name lookup failed; url omitted',
      expect.objectContaining({ repositoryId: FIXTURE.repositoryId })
    );
  });
});

describe('BacklogAdapter read budget', () => {
  it('resolving an issue thread spends one read', async () => {
    const { adapter, backlog } = egressAdapter();

    const thread = await adapter.fetchThread(EGRESS_THREAD_ID);

    expect(thread.metadata).toMatchObject({ kind: 'issue' });
    expect(backlog.getIssue).toHaveBeenCalledTimes(1);
    expect(backlog.getProject).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it('the subject of a serialised issue root spends none', async () => {
    const { adapter, backlog } = egressAdapter();
    const message = await adapter.fetchMessage(
      EGRESS_THREAD_ID,
      encodeMessageId({
        host: FIXTURE.host,
        subject: ISSUE_SUBJECT,
        part: 'root',
      })
    );
    if (message === null) {
      throw new Error('the issue root was not returned');
    }
    backlog.getIssue.mockClear();
    backlog.getProject.mockClear();

    const subject = await adapter.fetchSubject(message.raw);

    expect(subject).toMatchObject({ type: 'issue' });
    expect(backlog.getIssue).not.toHaveBeenCalled();
    expect(backlog.getProject).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});

describe('BacklogAdapter.listThreads', () => {
  it('threads are listed with an offset cursor and a trailing empty page', async () => {
    const { adapter, backlog } = egressAdapter();
    const issues = Array.from({ length: 3 }, (_, index) =>
      issue({
        id: FIXTURE.issueId + index,
        issueKey: `${FIXTURE.projectKey}-${index + 1}`,
        summary: `Issue ${index + 1}`,
      })
    );
    vi.spyOn(backlog.client, 'getIssues').mockImplementation(
      async ({ offset = 0, count = 20 } = {}) =>
        issues.slice(offset, offset + count) as never
    );
    const channelId = `backlog:${FIXTURE.host}:${FIXTURE.projectId}`;

    const firstPage = await adapter.listThreads(channelId, { limit: 2 });
    expect(firstPage.threads).toHaveLength(2);
    expect(firstPage.nextCursor).toBe('2');

    const secondPage = await adapter.listThreads(channelId, {
      limit: 2,
      cursor: '2',
    });
    expect(secondPage.threads).toHaveLength(1);
    expect(secondPage.nextCursor).toBeUndefined();

    const thirdPage = await adapter.listThreads(channelId, {
      limit: 2,
      cursor: '3',
    });
    expect(thirdPage.threads).toHaveLength(0);
    expect(thirdPage.nextCursor).toBeUndefined();
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
  it('names the project and reports its key and formatting rule', async () => {
    const { adapter } = egressAdapter({ textFormattingRule: 'backlog' });
    const channelId = `backlog:${FIXTURE.host}:${FIXTURE.projectId}`;

    await expect(adapter.fetchChannelInfo(channelId)).resolves.toEqual({
      id: channelId,
      name: 'Example project',
      isDM: false,
      metadata: {
        host: FIXTURE.host,
        projectId: FIXTURE.projectId,
        projectKey: FIXTURE.projectKey,
        textFormattingRule: 'backlog',
      },
    });
  });
});

describe('BacklogAdapter.rehydrateAttachment', () => {
  it('a serialised attachment regains fetchData for a configured host', () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const attachment = {
      type: 'file' as const,
      name: 'log.txt',
      url: `https://${FIXTURE.host}/api/v2/issues/${FIXTURE.issueId}/attachments/42`,
    };

    const rehydrated = adapter.rehydrateAttachment(attachment);

    expect(typeof rehydrated.fetchData).toBe('function');
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
  async function onNotationProject(): Promise<BacklogAdapter> {
    const { adapter } = egressAdapter({ textFormattingRule: 'backlog' });
    await adapter.postMessage(EGRESS_THREAD_ID, {
      markdown: 'prime the cache',
    });
    return adapter;
  }

  it("rendering for a thread uses its project's cached rule", async () => {
    const adapter = await onNotationProject();

    expect(adapter.renderFormatted(BOLD_CONTENT, EGRESS_THREAD_ID)).toBe(
      "''bold''"
    );
  });

  it('without a target renders Markdown', () => {
    const adapter = new BacklogAdapter(validConfig());

    expect(adapter.renderFormatted(BOLD_CONTENT)).toBe('**bold**');
  });

  it("rendering for a channel uses that channel's cached rule", async () => {
    const adapter = await onNotationProject();

    expect(
      adapter.renderFormatted(
        BOLD_CONTENT,
        `backlog:${FIXTURE.host}:${FIXTURE.projectId}`
      )
    ).toBe("''bold''");
  });

  it('rendering for a target that is neither a thread nor a channel id renders markdown', async () => {
    const adapter = await onNotationProject();

    expect(adapter.renderFormatted(BOLD_CONTENT, 'not-an-id')).toBe('**bold**');
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
      userName: FIXTURE.bot.name,
    });
    chat.onNewMention(async (thread, message) => {
      await thread.post(`Thanks for the mention, ${message.author.fullName}!`);
      resolveMentionHandled?.();
    });
    await chat.initialize();

    const response = await adapter.handleWebhook(
      webhookRequest(
        issueCommented({
          text: `@${FIXTURE.bot.name} please help`,
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
    withProject(
      createBacklogAdapter({
        host: FIXTURE.host,
        apiKey: 'connect-key',
        botUserId: FIXTURE.bot.id,
        botUserName: FIXTURE.bot.name,
        webhookVerifier,
      })
    ),
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

/** Answers `GET /users/myself` with the fixture bot, and Get Project. */
function answeringMyself(adapter: BacklogAdapter) {
  const client = adapter.client();
  vi.spyOn(client, 'getProject').mockResolvedValue(exampleProject());
  return vi.spyOn(client, 'getMyself').mockResolvedValue(BOT as never);
}

function identitylessConfig() {
  return {
    host: FIXTURE.host,
    apiKey: 'test-api-key',
    webhookSecret: FIXTURE.webhookSecret,
  };
}

function selfAuthoredComment() {
  return issueCommented({
    createdUser: {
      id: FIXTURE.bot.id,
      name: FIXTURE.bot.name,
      userId: FIXTURE.bot.userId,
    },
  });
}

describe('BacklogAdapter bot identity (D23)', () => {
  it('a configured botUserId and botUserName cost no GET /users/myself at all', async () => {
    const adapter = createBacklogAdapter({
      ...identitylessConfig(),
      botUserId: FIXTURE.bot.id,
      botUserName: FIXTURE.bot.name,
    });
    const getMyself = answeringMyself(adapter);
    vi.spyOn(adapter.client(), 'getUser').mockResolvedValue(BOT as never);
    await adapter.initialize(mockChat());

    await adapter.handleWebhook(webhookRequest(issueCommented()));
    await adapter.handleWebhook(webhookRequest(selfAuthoredComment()));
    await adapter.getUser(`${FIXTURE.host}:${FIXTURE.bot.id}`);

    expect(getMyself).not.toHaveBeenCalled();
  });

  it('a configured botUserId without a name costs no GET /users/myself, and initialize warns once', async () => {
    const adapter = createBacklogAdapter({
      ...identitylessConfig(),
      botUserId: FIXTURE.bot.id,
    });
    const getMyself = answeringMyself(adapter);
    vi.spyOn(adapter.client(), 'getUser').mockResolvedValue(BOT as never);
    const logger = createMockLogger();
    const chat = mockChat(undefined, logger);
    await adapter.initialize(chat);

    await adapter.handleWebhook(webhookRequest(selfAuthoredComment()));
    await adapter.getUser(`${FIXTURE.host}:${FIXTURE.bot.id}`);

    expect(getMyself).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('BACKLOG_BOT_USER_NAME')
    );
    expect(chat).not.toHaveDispatched('processMessage');
    expect(adapter.userName).toBe('');
  });

  it('constructing without a bot identity validates synchronously and calls nothing', () => {
    const adapter = createBacklogAdapter(identitylessConfig());

    expect(adapter.name).toBe('backlog');
    expect(network).not.toHaveBeenCalled();
  });

  it('with neither configured, initialize reads both from one GET /users/myself', async () => {
    const adapter = createBacklogAdapter(identitylessConfig());
    const getMyself = answeringMyself(adapter);

    await adapter.initialize(mockChat());

    expect(getMyself).toHaveBeenCalledTimes(1);
    expect(adapter.userName).toBe(FIXTURE.bot.name);
  });

  it('the fetched id suppresses the bot’s own comments and the lookup is not repeated', async () => {
    const adapter = createBacklogAdapter(identitylessConfig());
    const getMyself = answeringMyself(adapter);
    const chat = mockChat();
    await adapter.initialize(chat);

    const self = await adapter.handleWebhook(
      webhookRequest(selfAuthoredComment())
    );
    expect(self.status).toBe(200);
    expect(chat).not.toHaveDispatched('processMessage');

    const other = await adapter.handleWebhook(webhookRequest(issueCommented()));
    expect(other.status).toBe(200);
    expect(chat).toHaveDispatched('processMessage');

    expect(getMyself).toHaveBeenCalledTimes(1);
  });

  it('a configured botUserName wins over the fetched name, and the id still comes from the API', async () => {
    const adapter = createBacklogAdapter({
      ...identitylessConfig(),
      botUserName: 'Support Bot',
    });
    answeringMyself(adapter);
    const chat = mockChat();
    await adapter.initialize(chat);

    expect(adapter.userName).toBe('Support Bot');
    await adapter.handleWebhook(webhookRequest(selfAuthoredComment()));
    expect(chat).not.toHaveDispatched('processMessage');
  });

  it('a failed lookup does not fail initialize; it is logged and retried by the next webhook', async () => {
    const adapter = createBacklogAdapter(identitylessConfig());
    const getMyself = answeringMyself(adapter);
    getMyself.mockRejectedValueOnce(new Error('network down'));
    const logger = createMockLogger();
    const chat = mockChat(undefined, logger);

    await expect(adapter.initialize(chat)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'bot identity lookup failed; retried on demand',
      { host: FIXTURE.host, error: 'network down' }
    );
    expect(adapter.userName).toBe('');

    const response = await adapter.handleWebhook(
      webhookRequest(selfAuthoredComment())
    );

    expect(response.status).toBe(200);
    expect(chat).not.toHaveDispatched('processMessage');
    expect(getMyself).toHaveBeenCalledTimes(2);
    expect(adapter.userName).toBe(FIXTURE.bot.name);
  });

  it('a webhook whose bot identity cannot be learned is answered 503 and not dispatched', async () => {
    // Dispatching without the id would skip the self-message check, and a
    // bot that answers its own comments answers them forever.
    const adapter = createBacklogAdapter(identitylessConfig());
    answeringMyself(adapter).mockRejectedValue(new Error('network down'));
    const chat = mockChat();
    await adapter.initialize(chat);

    const response = await adapter.handleWebhook(
      webhookRequest(issueCommented())
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Bot identity unavailable');
    expect(chat).not.toHaveDispatched('processMessage');
  });

  it('parseMessage before the identity is known is refused rather than guessed', () => {
    const adapter = createBacklogAdapter(identitylessConfig());

    let failure: unknown;
    try {
      adapter.parseMessage({
        kind: 'webhook',
        host: FIXTURE.host,
        payload: issueCommented() as unknown as BacklogWebhookPayload,
        changes: [],
      });
    } catch (cause) {
      failure = cause;
    }

    expect(failure).toBeInstanceOf(AdapterError);
    expect((failure as AdapterError).code).toBe('BOT_IDENTITY_UNRESOLVED');
  });

  it('a mention of the fetched name reaches a real Chat, which answers once', async () => {
    const adapter = createBacklogAdapter(identitylessConfig());
    answeringMyself(adapter);
    const postIssueComments = vi
      .spyOn(adapter.client(), 'postIssueComments')
      .mockResolvedValue(issueComment({ createdUser: BOT }) as never);
    let resolveMentionHandled: (() => void) | undefined;
    const mentionHandled = new Promise<void>((resolve) => {
      resolveMentionHandled = resolve;
    });
    const chat = new Chat({
      adapters: { backlog: adapter },
      state: new MemoryStateAdapter(),
      // Deliberately not the bot's name: the mention must match the name the
      // adapter learned, not a fallback the core would supply.
      userName: 'someone-else',
    });
    chat.onNewMention(async (thread) => {
      await thread.post('On it.');
      resolveMentionHandled?.();
    });
    await chat.initialize();

    await adapter.handleWebhook(
      webhookRequest(
        issueCommented({ text: `@${FIXTURE.bot.name} please help` })
      )
    );
    await mentionHandled;

    expect(postIssueComments).toHaveBeenCalledTimes(1);
  });
});

selfMessageContract({
  name: 'backlog (identity from GET /users/myself)',
  setup: async () => {
    const adapter = createBacklogAdapter(identitylessConfig());
    answeringMyself(adapter);
    const chat = mockChat();
    await adapter.initialize(chat);
    return { adapter, chat };
  },
  makeOtherMessageRequest: () => webhookRequest(issueCommented()),
  makeSelfMessageRequest: () => webhookRequest(selfAuthoredComment()),
});
