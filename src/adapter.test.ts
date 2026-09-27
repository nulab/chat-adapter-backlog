import {
  AdapterError,
  AdapterRateLimitError,
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

import { BacklogAdapter, createBacklogAdapter } from './adapter';
import { createInMemoryBacklogApi } from './client/in-memory';
import { conformanceFixture } from './client/conformance';
import { encodeMessageId } from './ids';
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
import type { BacklogApi, BacklogComment } from './client/port';
import type {
  BacklogAdapterConfig,
  BacklogRawMessage,
  BacklogSubjectRef,
  BacklogThreadId,
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

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
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
});

type ApiFactory = () => BacklogApi;

/**
 * Runs `adapter` on the port `createApi` builds instead of the `backlog-js`
 * one. Element access is the form TypeScript leaves open to a private member;
 * the public config has no field for this (docs/specs/adapter.md §3.1).
 */
function onPort(
  adapter: BacklogAdapter,
  createApi: ApiFactory
): BacklogAdapter {
  adapter['createTransport'] = () => ({ api: createApi() });
  return adapter;
}

function fixturePort(): BacklogApi {
  return createInMemoryBacklogApi({
    projects: [conformanceFixture.baseProject()],
  });
}

/**
 * The port is private to the adapter. Element access is the one form
 * TypeScript leaves open to a private member, and it is used only here so a
 * test that has to see the port a factory built says so in one place.
 */
function portOf(adapter: BacklogAdapter, host: string): BacklogApi {
  return adapter['api'](host);
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
  it('exposes "backlog" as its name', () => {
    const adapter = new BacklogAdapter(validConfig());
    expect(adapter.name).toBe('backlog');
  });

  it('is always not a DM', () => {
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

  it('a pull request thread id carries the repository id and number, never the repository name', () => {
    const adapter = new BacklogAdapter(validConfig());
    const decoded: BacklogThreadId = {
      host: 'example.backlog.com',
      projectId: 500,
      subject: { kind: 'pullRequest', repositoryId: 700, number: 12 },
    };

    const threadId = adapter.encodeThreadId(decoded);

    expect(threadId).toBe('backlog:example.backlog.com:500:pr:700:12');
    expect(threadId).not.toContain('example-repo');
    expect(adapter.decodeThreadId(threadId)).toEqual(decoded);
  });

  it('the channel of a pull request thread is its project', () => {
    const adapter = new BacklogAdapter(validConfig());
    expect(
      adapter.channelIdFromThreadId('backlog:example.backlog.com:500:pr:700:12')
    ).toBe('backlog:example.backlog.com:500');
  });

  it('stores the ChatInstance and swaps to its logger without making an API call', async () => {
    const adapter = new BacklogAdapter(validConfig());
    const debug = vi.fn();
    const chatInstance = {
      getLogger: () => ({
        debug,
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      }),
    } as unknown as import('chat').ChatInstance;

    await adapter.initialize(chatInstance);

    expect(adapter['chat']).toBe(chatInstance);
    expect(adapter['logger'].debug).toBe(debug);
  });
});

describe('BacklogAdapter optional members Backlog cannot support are absent', () => {
  it('has no openDM, postEphemeral, openModal, scheduleMessage, reply, postObject, editObject, postChannelMessage, markAsRead, fetchChannelMessages, endTyping, disconnect, onThreadSubscribe, getChannelVisibility, lockScope, persistThreadHistory, supportsTurnCancellation or botUserId', () => {
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

  it('implements every P6 optional member', () => {
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

describe('BacklogAdapter port wiring', () => {
  // One test below replaces the global `fetch` so a handed-out client can
  // answer without a network; nothing in this file restores spies globally.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const base = {
    host: 'example.backlog.com',
    botUserId: 999,
    botUserName: 'Chatbot',
    webhookSecret: 'test-webhook-secret',
  } as const;

  it('builds a port for a configured host without being given one', () => {
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });
    expect(typeof portOf(adapter, 'example.backlog.com').getIssue).toBe(
      'function'
    );
  });

  it('reuses one port across calls', () => {
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });
    expect(portOf(adapter, 'example.backlog.com')).toBe(
      portOf(adapter, 'example.backlog.com')
    );
  });

  it('refuses a host other than the configured space', () => {
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });
    expect(() => portOf(adapter, 'other.backlog.com')).toThrow(
      ResourceNotFoundError
    );
  });

  it('hands out one client across calls', () => {
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });

    expect(adapter.client()).toBe(adapter.client());
  });

  it('a 429 through the handed-out client surfaces as a rate-limit error, like one through the port', async () => {
    // The point of handing the client out rather than letting a consumer
    // construct one: a second client would reach Backlog without the
    // adapter's 429 handling and error mapping.
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });
    const resetSeconds = Math.floor(Date.now() / 1000) + 3_600;
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            errors: [{ message: 'Too many requests', code: 13 }],
          }),
          {
            status: 429,
            headers: { 'X-RateLimit-Reset': String(resetSeconds) },
          }
        )
    );

    await expect(
      adapter.client().getIssue(conformanceFixture.issueId)
    ).rejects.toBeInstanceOf(AdapterRateLimitError);
  });

  it('has no client to hand out when a custom port replaced the backlog-js one', () => {
    const adapter = onPort(
      createBacklogAdapter({
        ...base,
        apiKey: 'key',
      }),
      () => createInMemoryBacklogApi()
    );

    expect(() => adapter.client()).toThrow(AdapterError);
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
  config: Record<string, unknown> = {},
  createApi: ApiFactory = fixturePort
): Promise<{ adapter: BacklogAdapter; chat: ChatInstance }> {
  const adapter = onPort(
    createBacklogAdapter({ ...webhookAdapterConfig(), ...config }),
    createApi
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
    const adapter = onPort(
      createBacklogAdapter(webhookAdapterConfig()),
      fixturePort
    );

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
    const adapter = onPort(
      createBacklogAdapter(webhookAdapterConfig()),
      fixturePort
    );
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
    const adapter = onPort(
      createBacklogAdapter(webhookAdapterConfig()),
      fixturePort
    );
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
    const getProject = vi.fn(() =>
      Promise.resolve(conformanceFixture.baseProject())
    );
    const adapter = onPort(createBacklogAdapter(webhookAdapterConfig()), () => {
      const api = createInMemoryBacklogApi({
        projects: [conformanceFixture.baseProject()],
      });
      api.getProject = getProject;
      return api;
    });
    const dispatched = await initializeCapturingDispatches(adapter);

    await adapter.handleWebhook(webhookRequest(bulkFieldsChanged()));
    await vi.waitFor(() => expect(dispatched).toHaveLength(3));

    expect(getProject).toHaveBeenCalledTimes(1);
  });

  it("dispatches a pull-request comment into the pull request's thread", async () => {
    const adapter = onPort(
      createBacklogAdapter(webhookAdapterConfig()),
      fixturePort
    );
    const dispatched = await initializeCapturingDispatches(adapter);

    await adapter.handleWebhook(webhookRequest(pullRequestCommented()));

    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]?.threadId).toBe(PULL_REQUEST_THREAD_ID);
  });

  it('keeps the repository name a delivery carries, sparing the next thread read a lookup', async () => {
    const calls: string[] = [];
    const { adapter } = egressAdapter({
      seed: pullRequestSeed(),
      wrapApi: (api) => recordPortCalls(api, calls),
    });
    await initializeCapturingDispatches(adapter);

    await adapter.handleWebhook(webhookRequest(pullRequestCommented()));
    const thread = await adapter.fetchThread(PULL_REQUEST_THREAD_ID);

    expect(thread.metadata).toMatchObject({
      url: `https://${FIXTURE.host}/git/${FIXTURE.projectKey}/${FIXTURE.repositoryName}/pullRequests/${FIXTURE.pullRequestNumber}`,
    });
    expect(calls).not.toContain('getGitRepository');
  });

  it('formats the text with the rule of the project the delivery came from', async () => {
    const project = {
      ...conformanceFixture.baseProject(),
      textFormattingRule: 'backlog' as const,
    };
    const adapter = onPort(createBacklogAdapter(webhookAdapterConfig()), () =>
      createInMemoryBacklogApi({ projects: [project] })
    );
    const dispatched = await initializeCapturingDispatches(adapter);

    await adapter.handleWebhook(
      webhookRequest(issueCommented({ text: "''urgent''" }))
    );

    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]?.message.formatted).toEqual({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'strong', children: [{ type: 'text', value: 'urgent' }] },
          ],
        },
      ],
    });
  });
});

describe('BacklogAdapter.parseMessage', () => {
  async function delivered(
    payload: Record<string, unknown>
  ): Promise<Message<BacklogRawMessage>[]> {
    const adapter = onPort(
      createBacklogAdapter(webhookAdapterConfig()),
      fixturePort
    );
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
      comment: {
        id: 1,
        content: 'hello',
        createdUser: { id: FIXTURE.alice.id, name: FIXTURE.alice.name },
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
        changeLog: [],
        stars: [],
      },
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

/** `BacklogUserRef` fixtures matching the project's vocabulary (Chatbot 999, Alice 100, Bob 101). */
const ALICE_USER_REF = {
  id: FIXTURE.alice.id,
  userId: FIXTURE.alice.userId,
  name: FIXTURE.alice.name,
  mailAddress: null,
};
const BOB_USER_REF = {
  id: FIXTURE.bob.id,
  userId: FIXTURE.bob.userId,
  name: FIXTURE.bob.name,
  mailAddress: null,
};
const CHATBOT_USER_REF = {
  id: FIXTURE.bot.id,
  userId: FIXTURE.bot.userId,
  name: FIXTURE.bot.name,
  mailAddress: null,
};

/**
 * The two subjects every id in this file is built from. A pull request is
 * addressed by repository id and number, never by the global
 * `FIXTURE.pullRequestId`, which addresses no endpoint
 * (`.claude/rules/backlog-pull-request-facts.md` "Addressing").
 */
const ISSUE_SUBJECT: BacklogSubjectRef = {
  kind: 'issue',
  issueId: FIXTURE.issueId,
};
const PULL_REQUEST_SUBJECT: BacklogSubjectRef = {
  kind: 'pullRequest',
  repositoryId: FIXTURE.repositoryId,
  number: FIXTURE.pullRequestNumber,
};

/**
 * A `BacklogAdapter` backed by an in-memory port seeded with `FIXTURE`'s
 * project, issue and bot user — used by the egress/reads/stream/reactions
 * tests below, which exercise real port state rather than the webhook
 * ladder. `textFormattingRule` is overridable so a notation-project test
 * doesn't need its own bespoke config.
 */
function egressAdapter(
  options: {
    textFormattingRule?: 'markdown' | 'backlog';
    seed?: Partial<Parameters<typeof createInMemoryBacklogApi>[0]>;
    logger?: ReturnType<typeof createMockLogger>;
    /**
     * Wraps the port the adapter is handed, leaving the returned `api`
     * untouched for state assertions — the seam `recordPortCalls` uses to
     * count reads the in-memory port does not record.
     */
    wrapApi?: (api: BacklogApi) => BacklogApi;
  } = {}
): {
  adapter: BacklogAdapter;
  api: ReturnType<typeof createInMemoryBacklogApi>;
} {
  const api = createInMemoryBacklogApi({
    projects: [
      {
        id: FIXTURE.projectId,
        projectKey: FIXTURE.projectKey,
        name: 'Example project',
        textFormattingRule: options.textFormattingRule ?? 'markdown',
      },
    ],
    issues: [
      {
        id: FIXTURE.issueId,
        projectId: FIXTURE.projectId,
        issueKey: `${FIXTURE.projectKey}-1`,
        summary: 'Deploy fails on the staging space',
        description: 'Reproduces on every push to main.',
        issueType: { id: 1, name: 'Task' },
        priority: { id: 3, name: 'Normal' },
        status: { id: 1, name: 'Open' },
        assignee: null,
        createdUser: ALICE_USER_REF,
        created: new Date('2026-01-01T00:00:00Z'),
        updated: new Date('2026-01-01T00:00:00Z'),
      },
    ],
    users: [CHATBOT_USER_REF],
    me: CHATBOT_USER_REF,
    ...options.seed,
  });

  const adapter = onPort(
    createBacklogAdapter({
      host: FIXTURE.host,
      apiKey: 'test-api-key',
      botUserId: FIXTURE.bot.id,
      botUserName: FIXTURE.bot.name,
      webhookSecret: FIXTURE.webhookSecret,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }),
    () => options.wrapApi?.(api) ?? api
  );

  return { adapter, api };
}

/**
 * Records every port method the adapter calls, in order. The in-memory port
 * records writes only, so a `read`-bucket call nobody asked for is invisible
 * without this — and §7.3 and §7.4 budget those calls exactly.
 */
function recordPortCalls(api: BacklogApi, calls: string[]): BacklogApi {
  return new Proxy(api, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'function') {
        return value;
      }
      return (...args: unknown[]): unknown => {
        calls.push(property);
        return (value as (...rest: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

const EGRESS_THREAD_ID = `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.issueId}`;
const PULL_REQUEST_THREAD_ID = `backlog:${FIXTURE.host}:${FIXTURE.projectId}:pr:${FIXTURE.repositoryId}:${FIXTURE.pullRequestNumber}`;

/**
 * Seed for a project that also has a git repository holding one pull request,
 * so a pull-request thread resolves through the same adapter as an issue one.
 * Comment ids are seven-digit while the issue comments above are 1..n: the two
 * sequences are separate on a real space (measured 2026-09-06), and a fixture
 * where a bare comment id identified one kind would let a
 * `commentId`/`pullRequestCommentId` mix-up pass unnoticed.
 */
function pullRequestSeed(
  comments: Partial<BacklogComment>[] = []
): Partial<Parameters<typeof createInMemoryBacklogApi>[0]> {
  return {
    repositories: [
      conformanceFixture.baseGitRepository({
        name: FIXTURE.repositoryName,
      }),
    ],
    pullRequests: [conformanceFixture.basePullRequest()],
    pullRequestComments: {
      [`${FIXTURE.repositoryId}:${FIXTURE.pullRequestNumber}`]: comments.map(
        (overrides) => conformanceFixture.basePullRequestComment(overrides)
      ),
    },
  };
}

const PULL_REQUEST_COMMENT_ID = conformanceFixture.pullRequestCommentIds[0];

/** One issue comment authored by the bot, editable and deletable by it. */
function seededComment(): {
  id: number;
  issueId: number;
  content: string;
  changeLog: [];
  createdUser: typeof CHATBOT_USER_REF;
  created: Date;
  updated: Date;
  stars: [];
} {
  return {
    id: 1,
    issueId: FIXTURE.issueId,
    content: 'Original',
    changeLog: [],
    createdUser: CHATBOT_USER_REF,
    created: new Date('2026-01-01T00:00:00Z'),
    updated: new Date('2026-01-01T00:00:00Z'),
    stars: [],
  };
}

describe('BacklogAdapter.postMessage (§6.1)', () => {
  it('a reply is posted as a comment on the issue', async () => {
    const { adapter, api } = egressAdapter();
    const result = await adapter.postMessage(EGRESS_THREAD_ID, {
      markdown: 'Any progress on this?',
    });
    expect(result.threadId).toBe(EGRESS_THREAD_ID);
    expect(api.state.recordedInputs).toContainEqual({
      method: 'addComment',
      issueId: FIXTURE.issueId,
      input: { content: 'Any progress on this?' },
    });
  });

  it('a channel id, which channel.post() passes, is a validation error and creates nothing', async () => {
    const { adapter, api } = egressAdapter();
    await expect(
      adapter.postMessage(`backlog:${FIXTURE.host}:${FIXTURE.projectId}`, {
        markdown: 'Deploy fails on staging',
      })
    ).rejects.toThrow(ValidationError);
    expect(api.state.recordedInputs).toEqual([]);
  });

  it('files are uploaded and attached to the comment', async () => {
    const { adapter, api } = egressAdapter();
    await adapter.postMessage(EGRESS_THREAD_ID, {
      markdown: 'See attached',
      files: [{ filename: 'notes.txt', data: Buffer.from('hello') }],
    });
    expect(api.state.uploads).toHaveLength(1);
  });

  it('an ArrayBuffer and a Blob are uploaded like a Buffer, each with its own bytes', async () => {
    const { adapter, api } = egressAdapter();
    await adapter.postMessage(EGRESS_THREAD_ID, {
      markdown: 'See attached',
      files: [
        { filename: 'buffer.bin', data: Buffer.from('buf') },
        { filename: 'array.bin', data: new ArrayBuffer(4) },
        { filename: 'blob.txt', data: new Blob(['blob!']) },
      ],
    });
    expect(
      api.state.uploads.map((upload) => [upload.name, upload.size])
    ).toEqual([
      ['buffer.bin', 3],
      ['array.bin', 4],
      ['blob.txt', 5],
    ]);
  });

  it('a file whose data is neither a Buffer, an ArrayBuffer nor a Blob is rejected as a backlog error, and neither that file nor the comment reaches Backlog', async () => {
    const { adapter, api } = egressAdapter();
    const rejection = adapter.postMessage(EGRESS_THREAD_ID, {
      markdown: 'See attached',
      files: [{ filename: 'notes.txt', data: new ReadableStream() }],
    } as unknown as Parameters<BacklogAdapter['postMessage']>[1]);

    await expect(rejection).rejects.toThrow(ValidationError);
    await expect(rejection).rejects.toThrow(/notes\.txt/);
    await expect(rejection).rejects.toMatchObject({ adapter: 'backlog' });
    expect(api.state.uploads).toEqual([]);
    expect(
      api.state.recordedInputs.filter((input) => input.method === 'addComment')
    ).toEqual([]);
  });

  it('a mistyped notifiedUserId is a validation error', async () => {
    const { adapter } = egressAdapter();
    const message = {
      markdown: 'hi',
      notifiedUserId: ['not-a-number'],
    } as unknown as Parameters<BacklogAdapter['postMessage']>[1];
    await expect(
      adapter.postMessage(EGRESS_THREAD_ID, message)
    ).rejects.toThrow(ValidationError);
  });

  it('a bold reply on a notation project uses two quotes', async () => {
    const { adapter, api } = egressAdapter({ textFormattingRule: 'backlog' });
    await adapter.postMessage(EGRESS_THREAD_ID, { markdown: '**bold**' });
    const addComment = api.state.recordedInputs.find(
      (input) => input.method === 'addComment'
    );
    expect(addComment).toMatchObject({ input: { content: "''bold''" } });
  });

  it('an unreadable project setting degrades to markdown for one call', async () => {
    const { adapter, api } = egressAdapter();
    api.getProject = () => Promise.reject(new Error('project lookup failed'));
    await adapter.postMessage(EGRESS_THREAD_ID, { markdown: '**bold**' });
    const addComment = api.state.recordedInputs.find(
      (input) => input.method === 'addComment'
    );
    // Markdown passes `{ markdown }` through verbatim (§9.3), so a degraded
    // call still renders as GFM rather than being escaped or altered.
    expect(addComment).toMatchObject({ input: { content: '**bold**' } });
  });
});

describe('BacklogAdapter.editMessage / deleteMessage (§6.2, §6.3, D12)', () => {
  it('the issue body cannot be edited', async () => {
    const { adapter } = egressAdapter();
    const issueMessageId = encodeMessageId({
      host: FIXTURE.host,
      subject: ISSUE_SUBJECT,
      part: 'root',
    });
    await expect(
      adapter.editMessage(EGRESS_THREAD_ID, issueMessageId, { markdown: 'x' })
    ).rejects.toThrow(ValidationError);
  });

  it('a fieldchange update with no comment cannot be deleted', async () => {
    const { adapter } = egressAdapter();
    const updateMessageId = encodeMessageId({
      host: FIXTURE.host,
      subject: ISSUE_SUBJECT,
      part: 'update',
      created: '2026-09-03T04:05:06Z',
    });
    await expect(
      adapter.deleteMessage(EGRESS_THREAD_ID, updateMessageId)
    ).rejects.toThrow(ValidationError);
  });

  it('editMessage with files is rejected', async () => {
    const { adapter, api } = egressAdapter({
      seed: {
        comments: [
          {
            id: 1,
            issueId: FIXTURE.issueId,
            content: 'Original',
            changeLog: [],
            createdUser: CHATBOT_USER_REF,
            created: new Date('2026-01-01T00:00:00Z'),
            updated: new Date('2026-01-01T00:00:00Z'),
            stars: [],
          },
        ],
      },
    });
    void api;
    const commentMessageId = encodeMessageId({
      host: FIXTURE.host,
      subject: ISSUE_SUBJECT,
      part: 'comment',
      commentId: 1,
    });
    await expect(
      adapter.editMessage(EGRESS_THREAD_ID, commentMessageId, {
        markdown: 'x',
        files: [{ filename: 'a.txt', data: Buffer.from('a') }],
      })
    ).rejects.toThrow(ValidationError);
  });

  it('editing a message that belongs to another thread is rejected', async () => {
    const { adapter, api } = egressAdapter({
      seed: { comments: [seededComment()] },
    });
    const foreignMessageId = encodeMessageId({
      host: FIXTURE.host,
      subject: { kind: 'issue', issueId: FIXTURE.issueId + 1 },
      part: 'comment',
      commentId: 1,
    });

    await expect(
      adapter.editMessage(EGRESS_THREAD_ID, foreignMessageId, {
        markdown: 'rewritten',
      })
    ).rejects.toThrow(ValidationError);
    expect(api.state.comments[0]?.content).toBe('Original');
  });

  it('a message id naming another space is not edited in this one', async () => {
    const { adapter, api } = egressAdapter({
      seed: { comments: [seededComment()] },
    });
    const otherSpaceMessageId = encodeMessageId({
      host: 'other.backlog.jp',
      subject: ISSUE_SUBJECT,
      part: 'comment',
      commentId: 1,
    });

    await expect(
      adapter.editMessage(EGRESS_THREAD_ID, otherSpaceMessageId, {
        markdown: 'rewritten',
      })
    ).rejects.toThrow(ValidationError);
    expect(api.state.comments[0]?.content).toBe('Original');
  });

  it('deleting a pull request comment through an issue thread is rejected', async () => {
    const { adapter, api } = egressAdapter({
      seed: {
        comments: [seededComment()],
        ...pullRequestSeed([{ id: PULL_REQUEST_COMMENT_ID }]),
      },
    });
    const pullRequestMessageId = encodeMessageId({
      host: FIXTURE.host,
      subject: PULL_REQUEST_SUBJECT,
      part: 'comment',
      commentId: PULL_REQUEST_COMMENT_ID,
    });

    await expect(
      adapter.deleteMessage(EGRESS_THREAD_ID, pullRequestMessageId)
    ).rejects.toThrow(ValidationError);
    expect(api.state.recordedInputs).toEqual([]);
  });

  it('deleting an issue comment through a pull request thread is rejected before any request', async () => {
    const { adapter, api } = egressAdapter({
      seed: {
        comments: [seededComment()],
        ...pullRequestSeed([{ id: PULL_REQUEST_COMMENT_ID }]),
      },
    });
    const issueMessageId = encodeMessageId({
      host: FIXTURE.host,
      subject: ISSUE_SUBJECT,
      part: 'comment',
      commentId: 1,
    });

    await expect(
      adapter.deleteMessage(PULL_REQUEST_THREAD_ID, issueMessageId)
    ).rejects.toThrow(ValidationError);
    expect(api.state.recordedInputs).toEqual([]);
    expect(api.state.comments).toHaveLength(1);
  });

  it('deleting a pull request comment fails before any request because Backlog has no endpoint', async () => {
    const { adapter, api } = egressAdapter({
      seed: pullRequestSeed([{ id: PULL_REQUEST_COMMENT_ID }]),
    });
    const commentMessageId = encodeMessageId({
      host: FIXTURE.host,
      subject: PULL_REQUEST_SUBJECT,
      part: 'comment',
      commentId: PULL_REQUEST_COMMENT_ID,
    });

    const failure: unknown = await adapter
      .deleteMessage(PULL_REQUEST_THREAD_ID, commentMessageId)
      .then(() => undefined)
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(AdapterError);
    expect((failure as AdapterError).code).toBe('UNSUPPORTED_OPERATION');
    expect(api.state.recordedInputs).toEqual([]);
  });
});

describe('BacklogAdapter.stream (§6.4, D4)', () => {
  it('a streamed reply is posted once and never edited', async () => {
    const { adapter, api } = egressAdapter();
    async function* chunks() {
      yield 'Hello, ';
      yield { type: 'markdown_text' as const, text: 'world' };
    }
    const result = await adapter.stream(EGRESS_THREAD_ID, chunks());

    expect(result.threadId).toBe(EGRESS_THREAD_ID);
    expect(
      api.state.recordedInputs.filter((input) => input.method === 'addComment')
    ).toHaveLength(1);
    expect(
      api.state.recordedInputs.filter(
        (input) => input.method === 'updateComment'
      )
    ).toHaveLength(0);
    expect(api.state.recordedInputs).toContainEqual({
      method: 'addComment',
      issueId: FIXTURE.issueId,
      input: { content: 'Hello, world' },
    });
  });

  it('an empty stream posts a single space', async () => {
    const { adapter, api } = egressAdapter();
    async function* chunks(): AsyncIterable<string> {
      // no chunks
    }
    await adapter.stream(EGRESS_THREAD_ID, chunks());
    const addComment = api.state.recordedInputs.find(
      (input) => input.method === 'addComment'
    );
    expect(addComment).toMatchObject({ input: { content: ' ' } });
  });
});

describe('BacklogAdapter reactions (§6.5)', () => {
  function seedWithComment(
    presenters: {
      id: number;
      userId: string | null;
      name: string;
      mailAddress: string | null;
    }[] = []
  ) {
    return egressAdapter({
      seed: {
        comments: [
          {
            id: 1,
            issueId: FIXTURE.issueId,
            content: 'Any progress?',
            changeLog: [],
            createdUser: ALICE_USER_REF,
            created: new Date('2026-01-01T00:00:00Z'),
            updated: new Date('2026-01-01T00:00:00Z'),
            stars: presenters.map((presenter, index) => ({
              id: index + 1,
              comment: null,
              url: '',
              title: '',
              presenter,
              created: new Date('2026-01-01T00:00:00Z'),
            })),
          },
        ],
      },
    });
  }

  const commentMessageId = encodeMessageId({
    host: FIXTURE.host,
    subject: ISSUE_SUBJECT,
    part: 'comment',
    commentId: 1,
  });

  it('adding a reaction twice stars the comment once', async () => {
    const { adapter, api } = seedWithComment();
    await adapter.addReaction(EGRESS_THREAD_ID, commentMessageId, 'star');
    await adapter.addReaction(EGRESS_THREAD_ID, commentMessageId, 'star');
    expect(
      api.state.recordedInputs.filter((input) => input.method === 'addStar')
    ).toEqual([{ method: 'addStar', target: { commentId: 1 } }]);
  });

  it("removing a reaction leaves other users' stars", async () => {
    const { adapter, api } = seedWithComment([CHATBOT_USER_REF, BOB_USER_REF]);
    await adapter.removeReaction(EGRESS_THREAD_ID, commentMessageId, 'star');
    const remaining = api.state.comments.find((c) => c.id === 1)?.stars;
    expect(remaining?.map((star) => star.presenter.id)).toEqual([
      BOB_USER_REF.id,
    ]);
  });

  it('a non-comment id cannot be starred', async () => {
    const { adapter } = egressAdapter();
    const issueMessageId = encodeMessageId({
      host: FIXTURE.host,
      subject: ISSUE_SUBJECT,
      part: 'root',
    });
    await expect(
      adapter.addReaction(EGRESS_THREAD_ID, issueMessageId, 'star')
    ).rejects.toThrow(ValidationError);
  });
});

describe('BacklogAdapter.fetchMessages / fetchThread (§7.1, §7.3)', () => {
  it('backward paging ends with a page holding the issue body', async () => {
    const { adapter } = egressAdapter({
      seed: {
        comments: Array.from({ length: 4 }, (_, index) => ({
          id: index + 1,
          issueId: FIXTURE.issueId,
          content: `Comment ${index + 1}`,
          changeLog: [],
          createdUser: ALICE_USER_REF,
          created: new Date(
            Date.parse('2026-01-01T00:00:00Z') + (index + 1) * 60_000
          ),
          updated: new Date(
            Date.parse('2026-01-01T00:00:00Z') + (index + 1) * 60_000
          ),
          stars: [],
        })),
      },
    });

    let cursor: string | undefined;
    let last: Awaited<ReturnType<typeof adapter.fetchMessages>>['messages'] =
      [];
    for (;;) {
      const result = await adapter.fetchMessages(
        EGRESS_THREAD_ID,
        cursor === undefined
          ? { limit: 2, direction: 'backward' }
          : { limit: 2, cursor, direction: 'backward' }
      );
      last = result.messages;
      if (result.nextCursor === undefined) {
        break;
      }
      cursor = result.nextCursor;
    }
    expect(last).toHaveLength(1);
    expect(last[0]?.id).toBe(
      encodeMessageId({
        host: FIXTURE.host,
        subject: ISSUE_SUBJECT,
        part: 'root',
      })
    );
  });

  it('a comment edited on Backlog reports edited and editedAt', async () => {
    const editedAt = new Date('2026-01-02T00:00:00Z');
    const { adapter } = egressAdapter({
      seed: {
        comments: [
          {
            id: 1,
            issueId: FIXTURE.issueId,
            content: 'Edited content',
            changeLog: [],
            createdUser: ALICE_USER_REF,
            created: new Date('2026-01-01T00:00:00Z'),
            updated: editedAt,
            stars: [],
          },
        ],
      },
    });
    const result = await adapter.fetchMessages(EGRESS_THREAD_ID, {
      limit: 2,
      direction: 'backward',
    });
    const comment = result.messages.find((m) => m.text === 'Edited content');
    expect(comment?.metadata.edited).toBe(true);
    expect(comment?.metadata.editedAt).toEqual(editedAt);
  });

  it('fetchMessage parses a comment with the project formatting rule', async () => {
    const { adapter } = egressAdapter({
      textFormattingRule: 'backlog',
      seed: {
        comments: [
          {
            id: 1,
            issueId: FIXTURE.issueId,
            content: "''urgent''",
            changeLog: [],
            createdUser: ALICE_USER_REF,
            created: new Date('2026-01-01T00:01:00Z'),
            updated: new Date('2026-01-01T00:01:00Z'),
            stars: [],
          },
        ],
      },
    });

    const message = await adapter.fetchMessage(
      EGRESS_THREAD_ID,
      encodeMessageId({
        host: FIXTURE.host,
        subject: ISSUE_SUBJECT,
        part: 'comment',
        commentId: 1,
      })
    );

    expect(message?.formatted).toEqual({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'strong', children: [{ type: 'text', value: 'urgent' }] },
          ],
        },
      ],
    });
  });

  it('an id fetchMessage answers null for spends no project lookup', async () => {
    const calls: string[] = [];
    const { adapter } = egressAdapter({
      wrapApi: (port) => recordPortCalls(port, calls),
    });

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
    expect(calls).toEqual([]);
  });

  it('fetchMessages parses comments with the project formatting rule', async () => {
    const { adapter } = egressAdapter({
      textFormattingRule: 'backlog',
      seed: {
        comments: [
          {
            id: 1,
            issueId: FIXTURE.issueId,
            content: "''urgent''",
            changeLog: [],
            createdUser: ALICE_USER_REF,
            created: new Date('2026-01-01T00:01:00Z'),
            updated: new Date('2026-01-01T00:01:00Z'),
            stars: [],
          },
        ],
      },
    });

    const result = await adapter.fetchMessages(EGRESS_THREAD_ID, {
      limit: 2,
      direction: 'backward',
    });
    const comment = result.messages.find(
      (message) => message.text === "''urgent''"
    );

    expect(comment?.formatted).toEqual({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'strong', children: [{ type: 'text', value: 'urgent' }] },
          ],
        },
      ],
    });
  });

  it('a channel id passed to fetchMessages is a validation error', async () => {
    const { adapter } = egressAdapter();
    await expect(
      adapter.fetchMessages(`backlog:${FIXTURE.host}:${FIXTURE.projectId}`)
    ).rejects.toThrow(ValidationError);
  });

  it('fetchThread resolves the issue', async () => {
    const { adapter } = egressAdapter();
    const thread = await adapter.fetchThread(EGRESS_THREAD_ID);
    expect(thread).toMatchObject({
      channelId: `backlog:${FIXTURE.host}:${FIXTURE.projectId}`,
      channelName: FIXTURE.projectKey,
      isDM: false,
    });
  });

  it('thread info names its kind for both issues and pull requests', async () => {
    const { adapter } = egressAdapter({ seed: pullRequestSeed() });

    const issue = await adapter.fetchThread(EGRESS_THREAD_ID);
    const pullRequest = await adapter.fetchThread(PULL_REQUEST_THREAD_ID);

    expect(issue.metadata).toMatchObject({
      kind: 'issue',
      issueId: FIXTURE.issueId,
      url: `https://${FIXTURE.host}/view/${FIXTURE.projectKey}-1`,
    });
    expect(pullRequest).toMatchObject({
      channelId: `backlog:${FIXTURE.host}:${FIXTURE.projectId}`,
      channelName: FIXTURE.projectKey,
      isDM: false,
    });
    expect(pullRequest.metadata).toMatchObject({
      kind: 'pullRequest',
      repositoryId: FIXTURE.repositoryId,
      number: FIXTURE.pullRequestNumber,
      url: `https://${FIXTURE.host}/git/${FIXTURE.projectKey}/${FIXTURE.repositoryName}/pullRequests/${FIXTURE.pullRequestNumber}`,
    });
  });

  it('a pull request thread without a cached repository name is described without a url', async () => {
    const logger = createMockLogger();
    // The pull request exists, its repository does not answer: the name half
    // of the web URL cannot be resolved (docs/specs/adapter.md §7.3).
    const { adapter } = egressAdapter({
      logger,
      seed: { pullRequests: [conformanceFixture.basePullRequest()] },
    });

    const thread = await adapter.fetchThread(PULL_REQUEST_THREAD_ID);

    expect(thread.metadata).toMatchObject({ kind: 'pullRequest' });
    expect(thread.metadata).not.toHaveProperty('url');
    expect(logger.warn).toHaveBeenCalledWith(
      'repository name lookup failed; url omitted',
      expect.objectContaining({ repositoryId: FIXTURE.repositoryId })
    );
  });
});

describe('BacklogAdapter read budget (§7.3, §7.4)', () => {
  it('resolving an issue thread spends one read', async () => {
    const calls: string[] = [];
    const { adapter } = egressAdapter({
      wrapApi: (api) => recordPortCalls(api, calls),
    });

    const thread = await adapter.fetchThread(EGRESS_THREAD_ID);

    expect(thread.metadata).toMatchObject({ kind: 'issue' });
    expect(calls).toEqual(['getIssue']);
  });

  it('the subject of a serialised issue root spends none', async () => {
    const calls: string[] = [];
    const { adapter } = egressAdapter({
      wrapApi: (api) => recordPortCalls(api, calls),
    });
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
    calls.length = 0;

    const subject = await adapter.fetchSubject(message.raw);

    expect(subject).toMatchObject({ type: 'issue' });
    expect(calls).toEqual([]);
  });
});

describe('BacklogAdapter.listThreads (§7.6)', () => {
  it('threads are listed with an offset cursor and a trailing empty page', async () => {
    const { adapter } = egressAdapter({
      seed: {
        issues: Array.from({ length: 3 }, (_, index) => ({
          id: FIXTURE.issueId + index,
          projectId: FIXTURE.projectId,
          issueKey: `${FIXTURE.projectKey}-${index + 1}`,
          summary: `Issue ${index + 1}`,
          description: '',
          issueType: { id: 1, name: 'Task' },
          priority: { id: 3, name: 'Normal' },
          status: { id: 1, name: 'Open' },
          assignee: null,
          createdUser: ALICE_USER_REF,
          created: new Date('2026-01-01T00:00:00Z'),
          updated: new Date('2026-01-01T00:00:00Z'),
        })),
      },
    });
    const channelId = `backlog:${FIXTURE.host}:${FIXTURE.projectId}`;

    const firstPage = await adapter.listThreads(channelId, { limit: 2 });
    expect(firstPage.threads).toHaveLength(2);
    expect(firstPage.nextCursor).toBe('2');
    const firstCursor = firstPage.nextCursor;
    if (firstCursor === undefined) {
      throw new Error('expected a nextCursor after a full first page');
    }

    const secondPage = await adapter.listThreads(channelId, {
      limit: 2,
      cursor: firstCursor,
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

describe('BacklogAdapter.getUser (§7.7)', () => {
  it('a user id round-trips through getUser', async () => {
    const { adapter } = egressAdapter({
      seed: { users: [CHATBOT_USER_REF, ALICE_USER_REF] },
    });
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
    const { adapter } = egressAdapter();
    const user = await adapter.getUser(`${FIXTURE.host}:${FIXTURE.bot.id}`);
    expect(user?.isBot).toBe(true);
  });

  it('an unknown user id resolves to null', async () => {
    const { adapter } = egressAdapter();
    const user = await adapter.getUser(`${FIXTURE.host}:999999`);
    expect(user).toBeNull();
  });
});

describe('BacklogAdapter.fetchSubject (§7.4)', () => {
  it('the parent subject is the issue', async () => {
    const { adapter } = egressAdapter();
    const message = await adapter.fetchMessage(
      EGRESS_THREAD_ID,
      encodeMessageId({
        host: FIXTURE.host,
        subject: ISSUE_SUBJECT,
        part: 'root',
      })
    );
    expect(message).not.toBeNull();
    const subject =
      message === null ? null : await adapter.fetchSubject(message.raw);
    expect(subject).toMatchObject({
      id: EGRESS_THREAD_ID,
      type: 'issue',
      title: 'Deploy fails on the staging space',
      url: `https://${FIXTURE.host}/view/${FIXTURE.projectKey}-1`,
    });
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

describe('BacklogAdapter.rehydrateAttachment (§6.6)', () => {
  it('a serialised attachment regains fetchData for a configured host', () => {
    const { adapter } = egressAdapter();
    const attachment = {
      type: 'file' as const,
      name: 'log.txt',
      url: `https://${FIXTURE.host}/api/v2/issues/${FIXTURE.issueId}/attachments/42`,
    };
    const rehydrated = adapter.rehydrateAttachment(attachment);
    expect(typeof rehydrated.fetchData).toBe('function');
  });

  it('an attachment on a foreign host is returned unchanged', () => {
    const { adapter } = egressAdapter();
    const attachment = {
      type: 'file' as const,
      name: 'log.txt',
      url: `https://not-configured.backlog.com/api/v2/issues/${FIXTURE.issueId}/attachments/42`,
    };
    const rehydrated = adapter.rehydrateAttachment(attachment);
    expect(rehydrated).toEqual(attachment);
    expect(rehydrated.fetchData).toBeUndefined();
  });

  it('an attachment with no url is returned unchanged', () => {
    const { adapter } = egressAdapter();
    const attachment = { type: 'file' as const, name: 'log.txt' };
    expect(adapter.rehydrateAttachment(attachment)).toEqual(attachment);
  });

  it('rehydrating an attachment accepts both url shapes and refuses a foreign host for both', () => {
    const { adapter } = egressAdapter({ seed: pullRequestSeed() });
    const urls = [
      `https://${FIXTURE.host}/api/v2/issues/${FIXTURE.issueId}/attachments/42`,
      `https://${FIXTURE.host}/api/v2/projects/${FIXTURE.projectId}/git/repositories/${FIXTURE.repositoryId}/pullRequests/${FIXTURE.pullRequestNumber}/attachments/42`,
    ];

    for (const url of urls) {
      const rehydrated = adapter.rehydrateAttachment({
        type: 'file',
        name: 'log.txt',
        url,
      });
      expect(typeof rehydrated.fetchData).toBe('function');

      const foreign = adapter.rehydrateAttachment({
        type: 'file',
        name: 'log.txt',
        url: url.replace(FIXTURE.host, 'not-configured.backlog.com'),
      });
      expect(foreign.fetchData).toBeUndefined();
    }
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

describe('BacklogAdapter.renderFormatted (§9.1)', () => {
  it('a bold reply on a notation project uses two quotes', async () => {
    const { adapter } = egressAdapter({ textFormattingRule: 'backlog' });
    // Prime the cache the way egress would (one Get Project per channel).
    await adapter.postMessage(EGRESS_THREAD_ID, {
      markdown: 'prime the cache',
    });
    const rendered = adapter.renderFormatted(
      {
        type: 'root',
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
            ],
          },
        ],
      },
      EGRESS_THREAD_ID
    );
    expect(rendered).toBe("''bold''");
  });

  it('without a target renders Markdown', () => {
    const adapter = new BacklogAdapter(validConfig());
    const rendered = adapter.renderFormatted({
      type: 'root',
      children: [
        {
          type: 'paragraph',
          children: [
            { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
          ],
        },
      ],
    });
    expect(rendered).toBe('**bold**');
  });

  it("rendering for a channel uses that channel's cached rule", async () => {
    const { adapter } = egressAdapter({ textFormattingRule: 'backlog' });
    // Prime the cache the way egress would (one Get Project per channel).
    await adapter.postMessage(EGRESS_THREAD_ID, {
      markdown: 'prime the cache',
    });

    const rendered = adapter.renderFormatted(
      BOLD_CONTENT,
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}`
    );

    expect(rendered).toBe("''bold''");
  });

  it('rendering for a target that is neither a thread nor a channel id renders markdown', async () => {
    const { adapter } = egressAdapter({ textFormattingRule: 'backlog' });
    await adapter.postMessage(EGRESS_THREAD_ID, {
      markdown: 'prime the cache',
    });

    const rendered = adapter.renderFormatted(BOLD_CONTENT, 'not-an-id');

    expect(rendered).toBe('**bold**');
  });
});

describe('BacklogAdapter wiring with a real Chat instance', () => {
  it('a mention delivered through handleWebhook is answered with exactly one addComment', async () => {
    const api = createInMemoryBacklogApi({
      projects: [conformanceFixture.baseProject()],
      issues: [
        {
          id: FIXTURE.issueId,
          projectId: FIXTURE.projectId,
          issueKey: `${FIXTURE.projectKey}-1`,
          summary: 'Deploy fails on the staging space',
          description: 'Reproduces on every push to main.',
          issueType: { id: 1, name: 'Task' },
          priority: { id: 3, name: 'Normal' },
          status: { id: 1, name: 'Open' },
          assignee: null,
          createdUser: ALICE_USER_REF,
          created: new Date('2026-01-01T00:00:00Z'),
          updated: new Date('2026-01-01T00:00:00Z'),
        },
      ],
      users: [CHATBOT_USER_REF],
      me: CHATBOT_USER_REF,
    });
    const adapter = onPort(
      createBacklogAdapter({
        host: FIXTURE.host,
        apiKey: 'test-api-key',
        botUserId: FIXTURE.bot.id,
        botUserName: FIXTURE.bot.name,
        webhookSecret: FIXTURE.webhookSecret,
      }),
      () => api
    );

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

    const addCommentCalls = api.state.recordedInputs.filter(
      (input) => input.method === 'addComment'
    );
    expect(addCommentCalls).toHaveLength(1);
    expect(addCommentCalls[0]).toMatchObject({
      issueId: FIXTURE.issueId,
      input: { content: 'Thanks for the mention, Alice!' },
    });
  });
});

const CONNECT_BOT_USER_ID = 999;

connectWebhookContract({
  name: 'backlog',
  createChat: () => mockChat(),
  createAdapter: ({ webhookVerifier }) =>
    onPort(
      createBacklogAdapter({
        host: FIXTURE.host,
        apiKey: 'connect-key',
        botUserId: CONNECT_BOT_USER_ID,
        botUserName: FIXTURE.bot.name,
        webhookVerifier,
      }),
      () =>
        createInMemoryBacklogApi({
          projects: [conformanceFixture.baseProject()],
        })
    ),
  makeWebhookRequest: () => webhookRequest(issueCommented(), { token: null }),
});

selfMessageContract({
  name: 'backlog',
  setup: async () => {
    const adapter = onPort(
      createBacklogAdapter(webhookAdapterConfig()),
      fixturePort
    );
    const chat = mockChat();
    await adapter.initialize(chat);
    return { adapter, chat };
  },
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
  setup: async () => {
    const adapter = onPort(
      createBacklogAdapter(webhookAdapterConfig()),
      fixturePort
    );
    const chat = mockChat();
    await adapter.initialize(chat);
    return { adapter, chat };
  },
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

/**
 * A port whose `getMyself` answers the fixture bot and counts its calls, for
 * the configurations below that leave the identity to the API.
 */
function myselfCountingApi(host: string = FIXTURE.host) {
  const api = createInMemoryBacklogApi({
    projects: [conformanceFixture.baseProject()],
    issues: [conformanceFixture.baseIssue()],
    users: [CHATBOT_USER_REF],
    me: CHATBOT_USER_REF,
  });
  const getMyself = vi.spyOn(api, 'getMyself');
  return { api, getMyself, host };
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

describe('BacklogAdapter bot identity (§3.2, D23)', () => {
  it('a configured botUserId and botUserName cost no GET /users/myself at all', async () => {
    const { api, getMyself } = myselfCountingApi();
    const adapter = onPort(
      createBacklogAdapter({
        ...identitylessConfig(),
        botUserId: FIXTURE.bot.id,
        botUserName: FIXTURE.bot.name,
      }),
      () => api
    );
    const chat = mockChat();
    await adapter.initialize(chat);

    await adapter.handleWebhook(webhookRequest(issueCommented()));
    await adapter.handleWebhook(webhookRequest(selfAuthoredComment()));
    await adapter.getUser(`${FIXTURE.host}:${FIXTURE.bot.id}`);

    expect(getMyself).not.toHaveBeenCalled();
  });

  it('a configured botUserId without a name costs no GET /users/myself, and initialize warns once', async () => {
    const { api, getMyself } = myselfCountingApi();
    const logger = createMockLogger();
    const adapter = onPort(
      createBacklogAdapter({
        ...identitylessConfig(),
        botUserId: FIXTURE.bot.id,
      }),
      () => api
    );
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

  it('without a botUserName, a typed @name is not a mention but a notification to the bot is', async () => {
    const adapter = onPort(
      createBacklogAdapter({
        ...identitylessConfig(),
        botUserId: FIXTURE.bot.id,
      }),
      fixturePort
    );
    const dispatched = await initializeCapturingDispatches(adapter);

    await adapter.handleWebhook(
      webhookRequest(
        issueCommented({ text: `@${FIXTURE.bot.name} please help` })
      )
    );
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    await adapter.handleWebhook(
      webhookRequest(
        issueCommented({
          commentId: 3002,
          notifications: [
            {
              user: { id: FIXTURE.bot.id, name: FIXTURE.bot.name },
              reason: 2,
            },
          ],
        })
      )
    );
    await vi.waitFor(() => expect(dispatched).toHaveLength(2));

    expect(dispatched.map(({ message }) => message.isMention)).toEqual([
      false,
      true,
    ]);
  });

  it('constructing without a bot identity validates synchronously and calls nothing', () => {
    const createApi = vi.fn(() => myselfCountingApi().api);

    const adapter = onPort(
      createBacklogAdapter(identitylessConfig()),
      createApi
    );

    expect(adapter.name).toBe('backlog');
    expect(createApi).not.toHaveBeenCalled();
  });

  it('constructs from BACKLOG_HOST, BACKLOG_API_KEY and BACKLOG_WEBHOOK_SECRET alone', () => {
    process.env.BACKLOG_HOST = 'example.backlog.com';
    process.env.BACKLOG_API_KEY = 'env-api-key';
    process.env.BACKLOG_WEBHOOK_SECRET = 'env-webhook-secret';

    expect(() => createBacklogAdapter()).not.toThrow();
  });

  it('blank BACKLOG_BOT_USER_ID and BACKLOG_BOT_USER_NAME are looked up rather than rejected', async () => {
    process.env.BACKLOG_BOT_USER_ID = '';
    process.env.BACKLOG_BOT_USER_NAME = '';
    const { api, getMyself } = myselfCountingApi();
    const adapter = onPort(
      createBacklogAdapter(identitylessConfig()),
      () => api
    );

    await adapter.initialize(mockChat());

    expect(getMyself).toHaveBeenCalledTimes(1);
    expect(adapter.userName).toBe(FIXTURE.bot.name);
  });

  it('with neither configured, initialize reads both from one GET /users/myself', async () => {
    const { api, getMyself } = myselfCountingApi();
    const adapter = onPort(
      createBacklogAdapter(identitylessConfig()),
      () => api
    );
    const chat = mockChat();

    await adapter.initialize(chat);

    expect(getMyself).toHaveBeenCalledTimes(1);
    expect(adapter.userName).toBe(FIXTURE.bot.name);
  });

  it('the fetched id suppresses the bot’s own comments and the lookup is not repeated', async () => {
    const { api, getMyself } = myselfCountingApi();
    const adapter = onPort(
      createBacklogAdapter(identitylessConfig()),
      () => api
    );
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
    const { api } = myselfCountingApi();
    const adapter = onPort(
      createBacklogAdapter({
        ...identitylessConfig(),
        botUserName: 'Support Bot',
      }),
      () => api
    );
    const chat = mockChat();
    await adapter.initialize(chat);

    expect(adapter.userName).toBe('Support Bot');
    await adapter.handleWebhook(webhookRequest(selfAuthoredComment()));
    expect(chat).not.toHaveDispatched('processMessage');
  });

  it('a failed lookup does not fail initialize; it is logged and retried by the next webhook', async () => {
    const { api, getMyself } = myselfCountingApi();
    getMyself.mockRejectedValueOnce(new Error('network down'));
    const logger = createMockLogger();
    const adapter = onPort(
      createBacklogAdapter(identitylessConfig()),
      () => api
    );
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
    const { api, getMyself } = myselfCountingApi();
    getMyself.mockRejectedValue(new Error('network down'));
    const adapter = onPort(
      createBacklogAdapter(identitylessConfig()),
      () => api
    );
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
    const adapter = onPort(
      createBacklogAdapter(identitylessConfig()),
      () => myselfCountingApi().api
    );

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
    const { api } = myselfCountingApi();
    const adapter = onPort(
      createBacklogAdapter(identitylessConfig()),
      () => api
    );
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

    expect(
      api.state.recordedInputs.filter((input) => input.method === 'addComment')
    ).toHaveLength(1);
  });
});

selfMessageContract({
  name: 'backlog (identity from GET /users/myself)',
  setup: async () => {
    const adapter = onPort(
      createBacklogAdapter(identitylessConfig()),
      () => myselfCountingApi().api
    );
    const chat = mockChat();
    await adapter.initialize(chat);
    return { adapter, chat };
  },
  makeOtherMessageRequest: () => webhookRequest(issueCommented()),
  makeSelfMessageRequest: () => webhookRequest(selfAuthoredComment()),
});
