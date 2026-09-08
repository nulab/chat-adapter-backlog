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

import { BacklogAdapter, createBacklogAdapter } from './adapter';
import { createFakeBacklogServer } from './client/backlog-js.fake-fetch';
import { createInMemoryBacklogApi } from './client/in-memory';
import { conformanceFixture } from './client/conformance';
import { encodeMessageId } from './ids';
import {
  assigneeChanged,
  bulkFieldsChanged,
  bulkStatusChangedOnOneIssue,
  FIXTURE,
  gitPushed,
  issueCommented,
  issueDeleted,
  issueMultiUpdated,
  issueUpdated,
  pullRequestAdded,
  pullRequestAssigneeChanged,
  pullRequestCommented,
  pullRequestDeleted,
  statusChanged,
  unrelatedActivity,
  webhookRequest,
} from './test/fixtures/webhooks';
import { UNAUTHORIZED_BODY } from './webhook/verify';
import type {
  BacklogApi,
  BacklogComment,
  BacklogNotification,
} from './client/port';
import type {
  BacklogBulkUpdatePayload,
  BacklogRawMessage,
  BacklogSubjectRef,
  BacklogThreadId,
  BacklogWebhookPayload,
  ResolvedInstallation,
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
  it('constructing with no config and no environment names the first missing variable', () => {
    expect(() => new BacklogAdapter({})).toThrow(ValidationError);
    expect(() => new BacklogAdapter({})).toThrow(/host/);
    expect(() => new BacklogAdapter({})).toThrow(/BACKLOG_HOST/);
  });

  it('an explicit empty apiKey is an error, not a fallback', () => {
    process.env.BACKLOG_API_KEY = 'from-env';
    expect(
      () =>
        new BacklogAdapter({
          host: 'example.backlog.com',
          apiKey: '',
          botUserId: 999,
          botUserName: 'Chatbot',
          webhookSecret: 'secret',
        })
    ).toThrow(ValidationError);
  });

  it('installations and single-space fields together are rejected', () => {
    expect(
      () =>
        new BacklogAdapter({
          host: 'example.backlog.com',
          installations: [
            {
              host: 'example.backlog.com',
              apiKey: 'k',
              botUserId: 999,
              botUserName: 'Chatbot',
              webhookSecret: 's',
            },
          ],
        })
    ).toThrow(ValidationError);
  });

  it('two installations on the same host are rejected', () => {
    expect(
      () =>
        new BacklogAdapter({
          installations: [
            {
              host: 'example.backlog.com',
              apiKey: 'k1',
              botUserId: 999,
              botUserName: 'Chatbot',
              webhookSecret: 's1',
            },
            {
              host: 'EXAMPLE.backlog.com',
              apiKey: 'k2',
              botUserId: 998,
              botUserName: 'Chatbot2',
              webhookSecret: 's2',
            },
          ],
        })
    ).toThrow(ValidationError);
  });

  it('a host with a scheme is rejected', () => {
    expect(
      () =>
        new BacklogAdapter({
          ...validConfig(),
          host: 'https://example.backlog.com',
        })
    ).toThrow(ValidationError);
  });

  it('a missing webhookSecret without a verifier is rejected', () => {
    const config = validConfig();
    expect(
      () =>
        new BacklogAdapter({
          host: config.host,
          apiKey: config.apiKey,
          botUserId: config.botUserId,
          botUserName: config.botUserName,
        })
    ).toThrow(ValidationError);
  });

  it('a missing webhookSecret is accepted when a webhookVerifier is set', () => {
    const config = validConfig();
    expect(
      () =>
        new BacklogAdapter({
          host: config.host,
          apiKey: config.apiKey,
          botUserId: config.botUserId,
          botUserName: config.botUserName,
          webhookVerifier: () => true,
        })
    ).not.toThrow();
  });

  it('a bare numeric user id is rejected even with one installation', () => {
    process.env.BACKLOG_BOT_USER_ID = 'not-a-number';
    expect(
      () =>
        new BacklogAdapter({
          host: 'example.backlog.com',
          apiKey: 'k',
          botUserName: 'Chatbot',
          webhookSecret: 's',
        })
    ).toThrow(ValidationError);
  });

  it("userName defaults to the first installation's bot name", () => {
    const adapter = new BacklogAdapter(validConfig());
    expect(adapter.userName).toBe('Chatbot');
  });

  it("userName is overridable independently of the first installation's bot name", () => {
    const adapter = new BacklogAdapter({
      ...validConfig(),
      userName: 'Support Bot',
    });
    expect(adapter.userName).toBe('Support Bot');
  });

  it('api("unknown.backlog.com") reports the installation as not found', () => {
    const adapter = new BacklogAdapter(validConfig());
    expect(() => adapter.api('unknown.backlog.com')).toThrow(
      ResourceNotFoundError
    );
  });

  it("botUserName reports each installation's own display name", () => {
    const adapter = new BacklogAdapter({
      installations: [
        {
          host: 'one.backlog.com',
          apiKey: 'k1',
          botUserId: 999,
          botUserName: 'Chatbot',
          webhookSecret: 's1',
        },
        {
          host: 'two.backlog.jp',
          apiKey: 'k2',
          botUserId: 998,
          botUserName: 'Helperbot',
          webhookSecret: 's2',
        },
      ],
    });

    expect(adapter.botUserName('one.backlog.com')).toBe('Chatbot');
    expect(adapter.botUserName('two.backlog.jp')).toBe('Helperbot');
    expect(adapter.userName).toBe('Chatbot');
  });

  it('botUserName ignores a userName override', () => {
    const adapter = new BacklogAdapter({
      ...validConfig(),
      userName: 'Support Bot',
    });

    expect(adapter.userName).toBe('Support Bot');
    expect(adapter.botUserName('example.backlog.com')).toBe('Chatbot');
  });

  it('botUserName("unknown.backlog.com") reports the installation as not found', () => {
    const adapter = new BacklogAdapter(validConfig());
    expect(() => adapter.botUserName('unknown.backlog.com')).toThrow(
      ResourceNotFoundError
    );
  });

  it('constructs from environment variables when config is empty', () => {
    process.env.BACKLOG_HOST = 'example.backlog.com';
    process.env.BACKLOG_API_KEY = 'env-api-key';
    process.env.BACKLOG_BOT_USER_ID = '999';
    process.env.BACKLOG_BOT_USER_NAME = 'Chatbot';
    process.env.BACKLOG_WEBHOOK_SECRET = 'env-secret';

    const adapter = createBacklogAdapter();
    expect(adapter.userName).toBe('Chatbot');
  });

  it('rejects exactly one of apiKey or accessToken when both are given', () => {
    expect(
      () =>
        new BacklogAdapter({
          host: 'example.backlog.com',
          apiKey: 'k',
          accessToken: 'a',
          botUserId: 999,
          botUserName: 'Chatbot',
          webhookSecret: 's',
        })
    ).toThrow(ValidationError);
  });

  it('rejects a negative rateLimit.maxWaitMs', () => {
    expect(
      () =>
        new BacklogAdapter({ ...validConfig(), rateLimit: { maxWaitMs: -1 } })
    ).toThrow(ValidationError);
  });

  it('rejects a non-integer rateLimit.maxRetries', () => {
    expect(
      () =>
        new BacklogAdapter({ ...validConfig(), rateLimit: { maxRetries: 1.5 } })
    ).toThrow(ValidationError);
  });

  it('rejects a non-positive maxWebhookBodyBytes', () => {
    expect(
      () => new BacklogAdapter({ ...validConfig(), maxWebhookBodyBytes: 0 })
    ).toThrow(ValidationError);
  });

  it('rejects an empty installations array', () => {
    expect(() => new BacklogAdapter({ installations: [] })).toThrow(
      ValidationError
    );
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

  it('defaults rateLimit and maxWebhookBodyBytes, and carries a configured webhookVerifier', () => {
    const adapter = new BacklogAdapter(validConfig());
    expect(adapter['ingressConfig']).toEqual({
      rateLimit: { maxWaitMs: 60_000, maxRetries: 1 },
      maxWebhookBodyBytes: 5 * 1024 * 1024,
      webhookVerifier: undefined,
    });

    const verifier = () => true;
    const withVerifier = new BacklogAdapter({
      host: 'example.backlog.com',
      apiKey: 'k',
      botUserId: 999,
      botUserName: 'Chatbot',
      webhookVerifier: verifier,
      rateLimit: { maxWaitMs: 1000, maxRetries: 3 },
      maxWebhookBodyBytes: 1024,
    });
    expect(withVerifier['ingressConfig']).toEqual({
      rateLimit: { maxWaitMs: 1000, maxRetries: 3 },
      maxWebhookBodyBytes: 1024,
      webhookVerifier: verifier,
    });
  });
});

describe('BacklogAdapter optional members Backlog cannot support are absent', () => {
  it('has no openDM, postEphemeral, openModal, scheduleMessage, reply, postObject, editObject, fetchChannelMessages, endTyping, disconnect, onThreadSubscribe, getChannelVisibility, lockScope, persistThreadHistory, supportsTurnCancellation or botUserId', () => {
    const adapter = new BacklogAdapter(validConfig());
    const optionalMembers = [
      'openDM',
      'postEphemeral',
      'openModal',
      'scheduleMessage',
      'reply',
      'postObject',
      'editObject',
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
      'postChannelMessage',
      'listThreads',
      'getUser',
      'fetchSubject',
      'fetchChannelInfo',
      'markAsRead',
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
    webhookSecret: 'secret',
  } as const;

  it('builds a port for a configured host without being given one', () => {
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });
    expect(typeof adapter.api('example.backlog.com').getIssue).toBe('function');
  });

  it('reuses one port per host across calls', () => {
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });
    expect(adapter.api('example.backlog.com')).toBe(
      adapter.api('example.backlog.com')
    );
  });

  it('reports an unknown host as a missing installation', () => {
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });
    expect(() => adapter.api('other.backlog.com')).toThrow(
      ResourceNotFoundError
    );
    expect(() => adapter.rateLimit('other.backlog.com')).toThrow(
      ResourceNotFoundError
    );
  });

  it('reports no rate-limit buckets before any request', () => {
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });
    expect(adapter.rateLimit('example.backlog.com')).toEqual({});
  });

  it('hands out one client per host, and it is the one the port speaks through', async () => {
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });
    const client = adapter.client('example.backlog.com');

    expect(client).toBe(adapter.client('example.backlog.com'));
  });

  it('a call through the handed-out client is counted in the adapter’s own rate-limit snapshot', async () => {
    // The point of handing the client out rather than letting a consumer
    // construct one: a second client would spend the same per-user budget
    // without the adapter ever seeing it.
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });
    const server = createFakeBacklogServer();
    vi.spyOn(globalThis, 'fetch').mockImplementation(server.fetch);

    await adapter
      .client('example.backlog.com')
      .getIssue(conformanceFixture.issueId);

    expect(adapter.rateLimit('example.backlog.com').read).toBeDefined();
  });

  it('reports an unknown host as a missing installation when asked for a client', () => {
    const adapter = createBacklogAdapter({ ...base, apiKey: 'key' });
    expect(() => adapter.client('other.backlog.com')).toThrow(
      ResourceNotFoundError
    );
  });

  it('has no client to hand out when a custom createApi replaced the port', () => {
    const adapter = createBacklogAdapter({
      ...base,
      apiKey: 'key',
      createApi: () => createInMemoryBacklogApi(),
    });

    expect(() => adapter.client('example.backlog.com')).toThrow(AdapterError);
  });

  it('passes the resolved installation to a supplied createApi', () => {
    const createApi = vi.fn((_installation: ResolvedInstallation) =>
      createInMemoryBacklogApi()
    );
    const adapter = createBacklogAdapter({
      ...base,
      host: 'EXAMPLE.Backlog.com',
      apiKey: 'key',
      createApi,
    });

    adapter.api('example.backlog.com');

    expect(createApi).toHaveBeenCalledTimes(1);
    expect(createApi.mock.calls[0]?.[0]).toMatchObject({
      host: 'example.backlog.com',
      botUserId: 999,
      botUserName: 'Chatbot',
    });
  });

  it('hands the port the credential resolver itself, not a resolved value', () => {
    // The port awaits the resolver on every request, so an adapter that
    // resolved it once at construction would pin the first token for the
    // lifetime of the process (docs/specs/adapter.md §3.2).
    let calls = 0;
    const createApi = vi.fn((_installation: ResolvedInstallation) =>
      createInMemoryBacklogApi()
    );
    const adapter = createBacklogAdapter({
      ...base,
      apiKey: () => {
        calls += 1;
        return `token-${calls}`;
      },
      createApi,
    });

    adapter.api('example.backlog.com');

    const resolvable = createApi.mock.calls[0]?.[0].apiKey;
    expect(typeof resolvable).toBe('function');
    expect(calls).toBe(0);

    const resolver = resolvable as () => string;
    expect(resolver()).toBe('token-1');
    expect(resolver()).toBe('token-2');
  });
});

/** One installation matching `FIXTURE`, backed by an in-memory port pre-seeded with the fixture project so `ensureProject` resolves without a network call. */
function webhookAdapterConfig(overrides: Partial<ResolvedInstallation> = {}) {
  return {
    host: FIXTURE.host,
    apiKey: 'test-api-key',
    botUserId: FIXTURE.bot.id,
    botUserName: FIXTURE.bot.name,
    webhookSecret: FIXTURE.webhookSecret,
    createApi: () =>
      createInMemoryBacklogApi({
        projects: [conformanceFixture.baseProject()],
      }),
    ...overrides,
  };
}

async function webhookAdapter(
  config: Record<string, unknown> = {}
): Promise<{ adapter: BacklogAdapter; chat: ChatInstance }> {
  const adapter = createBacklogAdapter({
    ...webhookAdapterConfig(),
    ...config,
  });
  const chat = createMockChatInstance({ logger: createMockLogger() });
  await adapter.initialize(chat);
  return { adapter, chat };
}

describe('BacklogAdapter.handleWebhook — response ladder (§5.1)', () => {
  it('a non-POST request is rejected with 405', async () => {
    const { adapter } = await webhookAdapter();
    const response = await adapter.handleWebhook(
      webhookRequest(issueCommented(), { method: 'GET' })
    );
    expect(response.status).toBe(405);
    expect(await response.text()).toBe('Method not allowed');
  });

  it('a body larger than maxWebhookBodyBytes is rejected with 413', async () => {
    const { adapter } = await webhookAdapter({ maxWebhookBodyBytes: 10 });
    const response = await adapter.handleWebhook(
      webhookRequest(issueCommented())
    );
    expect(response.status).toBe(413);
    expect(await response.text()).toBe('Payload too large');
  });

  it('a request without a token is rejected with 401', async () => {
    const { adapter } = await webhookAdapter();
    const response = await adapter.handleWebhook(
      webhookRequest(issueCommented(), { token: null })
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe(UNAUTHORIZED_BODY);
  });

  it('an unknown host gets the same 401 body as a wrong token', async () => {
    const { adapter } = await webhookAdapter();

    const unknownHost = await adapter.handleWebhook(
      webhookRequest(issueCommented(), { host: 'nope.backlog.com' })
    );
    const wrongToken = await adapter.handleWebhook(
      webhookRequest(issueCommented(), { token: 'wrong' })
    );

    expect(unknownHost.status).toBe(401);
    expect(wrongToken.status).toBe(401);
    const [unknownHostBody, wrongTokenBody] = await Promise.all([
      unknownHost.text(),
      wrongToken.text(),
    ]);
    expect(unknownHostBody).toBe(wrongTokenBody);
    expect(unknownHostBody).toBe(UNAUTHORIZED_BODY);
  });

  it('with one installation the host parameter is optional', async () => {
    const { adapter } = await webhookAdapter();
    const response = await adapter.handleWebhook(
      webhookRequest(issueCommented(), { host: null })
    );
    expect(response.status).toBe(200);
  });

  it('with two installations a missing host is rejected', async () => {
    const { adapter } = await webhookAdapter({
      host: undefined,
      apiKey: undefined,
      botUserId: undefined,
      botUserName: undefined,
      webhookSecret: undefined,
      createApi: undefined,
      installations: [
        {
          host: FIXTURE.host,
          apiKey: 'k1',
          botUserId: FIXTURE.bot.id,
          botUserName: FIXTURE.bot.name,
          webhookSecret: FIXTURE.webhookSecret,
        },
        {
          host: FIXTURE.otherHost,
          apiKey: 'k2',
          botUserId: 998,
          botUserName: 'Chatbot2',
          webhookSecret: 'other-secret',
        },
      ],
    });

    const response = await adapter.handleWebhook(
      webhookRequest(issueCommented(), { host: null })
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe(UNAUTHORIZED_BODY);
  });

  it('invalid JSON is rejected with 400', async () => {
    const { adapter } = await webhookAdapter();
    const response = await adapter.handleWebhook(
      webhookRequest(undefined, { body: 'not json' })
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid JSON');
  });

  it('a JSON body that is not an object is rejected with 400', async () => {
    const { adapter } = await webhookAdapter();
    const response = await adapter.handleWebhook(
      webhookRequest(undefined, { body: '"just a string"' })
    );
    expect(response.status).toBe(400);
  });

  it('an envelope with no numeric type is rejected with 400', async () => {
    const { adapter } = await webhookAdapter();
    const response = await adapter.handleWebhook(
      webhookRequest({ notAType: true })
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid payload');
  });

  it.each([[17], [21], [99]])(
    'an activity type the adapter maps to nothing is acknowledged and ignored (type %i)',
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

  it('a bulk update is accepted and dispatched, once per issue it touched', async () => {
    const { adapter, chat } = await webhookAdapter();

    const response = await adapter.handleWebhook(
      webhookRequest(issueMultiUpdated())
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
    expect(chat.processMessage).toHaveBeenCalledTimes(2);
    expect(threadIdsProcessedBy(chat)).toEqual([
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.issueId}`,
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.otherIssueId}`,
    ]);
  });

  it('a bulk update of three issues dispatches three times, one thread each', async () => {
    const { adapter, chat } = await webhookAdapter();

    const response = await adapter.handleWebhook(
      webhookRequest(bulkFieldsChanged())
    );

    expect(response.status).toBe(200);
    expect(chat.processMessage).toHaveBeenCalledTimes(3);
    expect(threadIdsProcessedBy(chat)).toEqual([
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.issueId}`,
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.otherIssueId}`,
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.thirdIssueId}`,
    ]);
  });

  it('a bulk update of one issue is dispatched once and still as a bulk update', async () => {
    const { adapter, chat } = await webhookAdapter();

    const response = await adapter.handleWebhook(
      webhookRequest(bulkStatusChangedOnOneIssue())
    );

    expect(response.status).toBe(200);
    expect(chat.processMessage).toHaveBeenCalledTimes(1);
    const [message] = await Promise.all(
      messageFactoriesOf(chat).map((factory) => factory())
    );
    // A single-issue batch reaches a handler as `bulkUpdate`, not as the
    // `webhook` kind a type 2 produces: what a handler reads from `raw` may
    // not depend on how many issues the person happened to tick.
    expect(message?.raw?.kind).toBe('bulkUpdate');
  });

  it('a bulk update made by the bot itself dispatches nothing', async () => {
    const { adapter, chat } = await webhookAdapter();

    const response = await adapter.handleWebhook(
      webhookRequest(
        issueMultiUpdated({
          createdUser: { id: FIXTURE.bot.id, name: FIXTURE.bot.name },
        })
      )
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
    expect(chat).not.toHaveDispatched('processMessage');
  });

  it('a bulk update naming no issues is accepted and dispatches nothing', async () => {
    const { adapter, chat } = await webhookAdapter();

    const response = await adapter.handleWebhook(
      webhookRequest(issueMultiUpdated({ issues: [] }))
    );

    expect(response.status).toBe(200);
    expect(chat).not.toHaveDispatched('processMessage');
  });

  it('a bulk update whose link entry has no usable issue id is rejected with 400', async () => {
    const { adapter } = await webhookAdapter();
    const payload = issueMultiUpdated();
    const content = payload['content'] as Record<string, unknown>;
    const links = content['link'] as Record<string, unknown>[];
    links[0]!['id'] = 'not-a-number';

    const response = await adapter.handleWebhook(webhookRequest(payload));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid payload');
  });

  it('a bulk update looks the project up once, however many issues it touched', async () => {
    const getProject = vi.fn(() =>
      Promise.resolve(conformanceFixture.baseProject())
    );
    const { adapter, chat } = await webhookAdapter({
      createApi: () => {
        const api = createInMemoryBacklogApi({
          projects: [conformanceFixture.baseProject()],
        });
        api.getProject = getProject;
        return api;
      },
    });

    await adapter.handleWebhook(webhookRequest(issueMultiUpdated()));
    await Promise.all(messageFactoriesOf(chat).map((factory) => factory()));

    expect(getProject).toHaveBeenCalledTimes(1);
  });

  it('bulk factories use their validated targets without re-entering parseMessage', async () => {
    const { adapter, chat } = await webhookAdapter();
    const parseMessage = vi.spyOn(adapter, 'parseMessage');

    await adapter.handleWebhook(webhookRequest(bulkFieldsChanged()));
    await Promise.all(messageFactoriesOf(chat).map((factory) => factory()));

    expect(parseMessage).not.toHaveBeenCalled();
  });

  it('each message of a bulk update carries the batch changes and its own comment', async () => {
    const { adapter, chat } = await webhookAdapter();

    await adapter.handleWebhook(
      webhookRequest(
        issueMultiUpdated({
          text: 'Moving these to done.',
          changes: [
            { field: 'status', new_value: '4' },
            { field: 'assigner', new_value: FIXTURE.bot.name },
          ],
        })
      )
    );

    const messages = await Promise.all(
      messageFactoriesOf(chat).map((factory) => factory())
    );
    expect(messages.map((message) => message.id)).toEqual([
      `${FIXTURE.host}:issue:${FIXTURE.issueId}:c3101`,
      `${FIXTURE.host}:issue:${FIXTURE.otherIssueId}:c3102`,
    ]);
    for (const message of messages) {
      expect(message.text).toBe('Moving these to done.');
      expect(message.raw?.changes).toEqual([
        { field: 'status', newValue: '4', oldValue: null },
        { field: 'assigner', newValue: FIXTURE.bot.name, oldValue: null },
      ]);
      expect(message.isMention).toBe(true);
    }
  });

  it('a payload failing its type-specific schema is rejected with 400', async () => {
    const { adapter } = await webhookAdapter();
    const payload = issueCommented();
    delete (payload as Record<string, unknown>)['createdUser'];

    const response = await adapter.handleWebhook(webhookRequest(payload));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid payload');
  });

  it('a webhook before initialize() has run gets 503', async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const response = await adapter.handleWebhook(
      webhookRequest(issueCommented())
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('Adapter not initialized');
  });

  it("the bot's own comment is acknowledged but not dispatched", async () => {
    const { adapter, chat } = await webhookAdapter();
    const response = await adapter.handleWebhook(
      webhookRequest(
        issueCommented({
          createdUser: {
            id: FIXTURE.bot.id,
            name: FIXTURE.bot.name,
            userId: FIXTURE.bot.userId,
          },
        })
      )
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
    expect(chat).not.toHaveDispatched('processMessage');
  });

  it('a comment from another user is dispatched and answered with 200', async () => {
    const { adapter, chat } = await webhookAdapter();
    const response = await adapter.handleWebhook(
      webhookRequest(issueCommented())
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('OK');
    expect(chat).toHaveDispatched('processMessage');
  });

  it('a deleted issue is reported as a deleted root message', async () => {
    const { adapter, chat } = await webhookAdapter();
    const response = await adapter.handleWebhook(
      webhookRequest(issueDeleted())
    );

    expect(response.status).toBe(200);
    expect(chat).toHaveDispatched('processMessageDeleted');
    const processMessageDeleted = chat.processMessageDeleted as unknown as {
      mock: { calls: unknown[][] };
    };
    const [event] = processMessageDeleted.mock.calls[0] as [
      { platform: string; threadId: string; messageId: string },
    ];
    expect(event.platform).toBe('backlog');
    expect(event.threadId).toBe(
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.issueId}`
    );
    expect(event.messageId).toBe(`${FIXTURE.host}:issue:${FIXTURE.issueId}:r`);
  });
});

describe('BacklogAdapter.handleWebhook — identity fields that are not ids (§5.1 step 9)', () => {
  /**
   * Resolves to whatever the call produced — the `Response` or the reason it
   * rejected with — so "it threw instead of answering" is an assertable value
   * rather than a test that fails with the adapter's own error.
   */
  async function outcomeOf(
    adapter: BacklogAdapter,
    payload: unknown
  ): Promise<unknown> {
    return adapter
      .handleWebhook(webhookRequest(payload))
      .catch((cause: unknown) => cause);
  }

  async function expectInvalidPayload(outcome: unknown): Promise<void> {
    expect(outcome).toBeInstanceOf(Response);
    const response = outcome as Response;
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid payload');
  }

  const NOT_AN_ID: readonly [string, number][] = [
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
  ];

  it.each(NOT_AN_ID)(
    'a webhook whose issue id is %s is rejected with 400',
    async (_label, id) => {
      const { adapter, chat } = await webhookAdapter();
      const payload = issueCommented();
      (payload['content'] as Record<string, unknown>)['id'] = id;

      await expectInvalidPayload(await outcomeOf(adapter, payload));
      expect(chat).not.toHaveDispatched('processMessage');
    }
  );

  it.each(NOT_AN_ID)(
    'a deletion whose issue id is %s is rejected with 400 rather than throwing',
    async (_label, id) => {
      // The type-4 branch decodes the thread id it just built synchronously,
      // outside the dispatched promise, so an id the codec rejects surfaced
      // here as a rejected `handleWebhook` — a 500 from a host route that
      // awaits it, an unhandled rejection from one that does not.
      const { adapter, chat } = await webhookAdapter();
      const payload = issueDeleted();
      (payload['content'] as Record<string, unknown>)['id'] = id;

      await expectInvalidPayload(await outcomeOf(adapter, payload));
      expect(chat).not.toHaveDispatched('processMessageDeleted');
    }
  );

  it.each(NOT_AN_ID)(
    'a pull request webhook whose number is %s is rejected with 400',
    async (_label, number) => {
      const { adapter, chat } = await webhookAdapter();
      const payload = pullRequestAdded();
      (payload['content'] as Record<string, unknown>)['number'] = number;

      await expectInvalidPayload(await outcomeOf(adapter, payload));
      expect(chat).not.toHaveDispatched('processMessage');
    }
  );

  it.each(NOT_AN_ID)(
    'a pull request webhook whose repository id is %s is rejected with 400',
    async (_label, id) => {
      const { adapter, chat } = await webhookAdapter();
      const payload = pullRequestCommented();
      const content = payload['content'] as Record<string, unknown>;
      (content['repository'] as Record<string, unknown>)['id'] = id;

      await expectInvalidPayload(await outcomeOf(adapter, payload));
      expect(chat).not.toHaveDispatched('processMessage');
    }
  );

  it('every one of them answers with a Response instead of rejecting', async () => {
    const { adapter } = await webhookAdapter();
    const bodies = [
      (): unknown => {
        const payload = issueCommented();
        (payload['content'] as Record<string, unknown>)['id'] = 0;
        return payload;
      },
      (): unknown => {
        const payload = issueDeleted();
        (payload['content'] as Record<string, unknown>)['id'] = 0;
        return payload;
      },
      (): unknown => {
        const payload = pullRequestAdded();
        (payload['content'] as Record<string, unknown>)['number'] = 0;
        return payload;
      },
      (): unknown => {
        const payload = pullRequestCommented();
        const content = payload['content'] as Record<string, unknown>;
        (content['repository'] as Record<string, unknown>)['id'] = 0;
        return payload;
      },
    ];

    for (const body of bodies) {
      expect(await outcomeOf(adapter, body())).toBeInstanceOf(Response);
    }
  });
});

/**
 * The `(adapter, threadId, factory)` triples a mock chat instance was handed.
 * A bulk update is the only ingress that dispatches more than once per
 * request, so the two helpers below exist for it.
 */
function processMessageCallsOf(
  chat: ChatInstance
): [Adapter, string, () => Promise<Message<BacklogRawMessage>>][] {
  const processMessage = chat.processMessage as unknown as {
    mock: {
      calls: [Adapter, string, () => Promise<Message<BacklogRawMessage>>][];
    };
  };
  return processMessage.mock.calls;
}

function threadIdsProcessedBy(chat: ChatInstance): string[] {
  return processMessageCallsOf(chat).map(([, threadId]) => threadId);
}

function messageFactoriesOf(
  chat: ChatInstance
): (() => Promise<Message<BacklogRawMessage>>)[] {
  return processMessageCallsOf(chat).map(([, , factory]) => factory);
}

describe('BacklogAdapter.handleWebhook — dispatch ordering and error handling', () => {
  it('processing starts after the response is returned', async () => {
    let releaseProcessing: (() => void) | undefined;
    const factoryResolved = vi.fn();
    const processMessage = vi.fn(
      async (
        _adapter: Adapter,
        _threadId: string,
        message: Message | (() => Promise<Message>)
      ) => {
        // A deferred factory, per the plan's acceptance criterion ("assert
        // ordering with a deferred factory") rather than assuming ordering
        // from call sequence alone: the factory only resolves once this test
        // releases it, so `factoryResolved` firing before `handleWebhook`
        // returns would prove the response waited on processing.
        if (typeof message === 'function') {
          await new Promise<void>((resolve) => {
            releaseProcessing = resolve;
          });
          await message();
          factoryResolved();
        }
      }
    );
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const chat = createMockChatInstance({
      logger: createMockLogger(),
      overrides: { processMessage },
    });
    await adapter.initialize(chat);

    const response = await adapter.handleWebhook(
      webhookRequest(issueCommented())
    );

    // The response already came back although the factory is still blocked
    // on the deferred promise above — proving §5.1 step 12 ("returned
    // before processing completes").
    expect(response.status).toBe(200);
    expect(factoryResolved).not.toHaveBeenCalled();

    releaseProcessing?.();
    await vi.waitFor(() => expect(factoryResolved).toHaveBeenCalled());
  });

  it('a factory that throws is logged at error and does not reject handleWebhook', async () => {
    const logger = createMockLogger();
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    // `createMockChatInstance`'s default `processMessage` never calls the
    // factory it is handed, so this override reproduces what the real core
    // does (`ChatInstance.processMessage` resolves the factory itself,
    // `.claude/rules/chat-sdk-core-facts.md`) closely enough to exercise a
    // factory failure: it invokes the factory and lets a rejection surface
    // as `processMessage`'s own rejection, the shape `handleWebhook`'s
    // `.catch` is written to log.
    const chat = createMockChatInstance({
      logger,
      overrides: {
        processMessage: vi.fn(
          async (
            _adapter: Adapter,
            _threadId: string,
            message: Message | (() => Promise<Message>)
          ) => {
            if (typeof message === 'function') {
              await message();
            }
          }
        ),
      },
    });
    await adapter.initialize(chat);
    // Forces the factory to reject after `ensureProject` succeeds, by
    // making `parseMessage` itself throw — the simplest reliable way to
    // exercise "a factory that throws" without depending on which internal
    // step happens to fail for a given fixture.
    vi.spyOn(adapter, 'parseMessage').mockImplementation(() => {
      throw new Error('parseMessage exploded');
    });

    const response = await adapter.handleWebhook(
      webhookRequest(issueCommented())
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        'inbound processing failed',
        expect.objectContaining({ host: FIXTURE.host })
      );
    });
  });
});

describe('BacklogAdapter.handleWebhook — fixture-driven §5.3 mapping', () => {
  it('an assignee change with the bot as the new assignee is a mention', async () => {
    const { adapter, chat } = await webhookAdapter();
    const response = await adapter.handleWebhook(
      webhookRequest(
        issueUpdated({
          text: null,
          changes: [
            { field: 'assigner', new_value: FIXTURE.bot.name, old_value: '' },
          ],
        })
      )
    );

    expect(response.status).toBe(200);
    expect(chat).toHaveDispatched('processMessage');
  });

  it('a status-only change dispatches a message the handler can read raw.changes from', async () => {
    const capturedMessages: unknown[] = [];
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const chat = createMockChatInstance({
      logger: createMockLogger(),
      overrides: {
        processMessage: vi.fn(
          async (
            _adapter: Adapter,
            _threadId: string,
            message: Message | (() => Promise<Message>)
          ) => {
            const resolved =
              typeof message === 'function' ? await message() : message;
            capturedMessages.push(resolved);
          }
        ),
      },
    });
    await adapter.initialize(chat);

    await adapter.handleWebhook(webhookRequest(statusChanged()));
    await vi.waitFor(() => expect(capturedMessages).toHaveLength(1));

    const [message] = capturedMessages as [
      { text: string; raw: { changes: { field: string }[] } },
    ];
    expect(message.text).toBe('');
    expect(message.raw.changes).toEqual([
      { field: 'status', newValue: '4', oldValue: '3' },
    ]);
  });

  it('unknown payload keys survive into raw.payload', async () => {
    const capturedMessages: unknown[] = [];
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const chat = createMockChatInstance({
      logger: createMockLogger(),
      overrides: {
        processMessage: vi.fn(
          async (
            _adapter: Adapter,
            _threadId: string,
            message: Message | (() => Promise<Message>)
          ) => {
            const resolved =
              typeof message === 'function' ? await message() : message;
            capturedMessages.push(resolved);
          }
        ),
      },
    });
    await adapter.initialize(chat);

    await adapter.handleWebhook(webhookRequest(issueCommented()));
    await vi.waitFor(() => expect(capturedMessages).toHaveLength(1));

    const [message] = capturedMessages as [
      { raw: { payload: Record<string, unknown> } },
    ];
    expect(message.raw.payload['notifications']).toEqual([]);
  });

  it('the same fixture sent to two configured hosts yields two thread ids, two message ids and two ports used', async () => {
    const otherApi = createInMemoryBacklogApi({
      projects: [{ ...conformanceFixture.baseProject() }],
    });
    const firstApi = createInMemoryBacklogApi({
      projects: [conformanceFixture.baseProject()],
    });
    const createApi = vi
      .fn()
      .mockReturnValueOnce(firstApi)
      .mockReturnValueOnce(otherApi);

    const adapter = createBacklogAdapter({
      installations: [
        {
          host: FIXTURE.host,
          apiKey: 'k1',
          botUserId: FIXTURE.bot.id,
          botUserName: FIXTURE.bot.name,
          webhookSecret: FIXTURE.webhookSecret,
        },
        {
          host: FIXTURE.otherHost,
          apiKey: 'k2',
          botUserId: 998,
          botUserName: 'Chatbot2',
          webhookSecret: 'other-secret',
        },
      ],
      createApi,
    });
    const capturedMessages: { threadId: string; message: { id: string } }[] =
      [];
    const chat = createMockChatInstance({
      logger: createMockLogger(),
      overrides: {
        processMessage: vi.fn(
          async (
            _adapter: Adapter,
            threadId: string,
            message: Message | (() => Promise<Message>)
          ) => {
            const resolved =
              typeof message === 'function' ? await message() : message;
            capturedMessages.push({ threadId, message: resolved });
          }
        ),
      },
    });
    await adapter.initialize(chat);

    await adapter.handleWebhook(
      webhookRequest(issueCommented(), { host: FIXTURE.host })
    );
    await adapter.handleWebhook(
      webhookRequest(issueCommented(), {
        host: FIXTURE.otherHost,
        token: 'other-secret',
      })
    );
    await vi.waitFor(() => expect(capturedMessages).toHaveLength(2));

    expect(capturedMessages[0]?.threadId).not.toBe(
      capturedMessages[1]?.threadId
    );
    expect(capturedMessages[0]?.message.id).not.toBe(
      capturedMessages[1]?.message.id
    );
    expect(adapter.api(FIXTURE.host)).toBe(firstApi);
    expect(adapter.api(FIXTURE.otherHost)).toBe(otherApi);
  });
});

/**
 * Activity types Backlog emits around a pull request that name no thread.
 *
 * Type 21 is the interesting one: the Get Activity page calls it "Pull Request
 * Deleted" and `backlog-js` 0.20.1 calls it `PullRequestMerged`, and **neither
 * was observed** — merging (from the UI or by pushing the merge to the base
 * branch) and closing both arrive as type 19 status changes, no operation
 * deleting a pull request exists in the UI or the API, and the whole activity
 * history of the measured project holds no type 21 (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md`). Acknowledging it and
 * dropping it (D-PR5) is the only answer that does not guess which of the two
 * meanings a delivery would have.
 */
describe('BacklogAdapter.handleWebhook — git and pull-request activities with no thread meaning', () => {
  it('a git push is acknowledged and ignored', async () => {
    const { adapter, chat } = await webhookAdapter();

    const response = await adapter.handleWebhook(webhookRequest(gitPushed()));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Ignored');
    expect(chat).not.toHaveDispatched('processMessage');
  });

  it('a git repository creation is acknowledged and ignored', async () => {
    const { adapter, chat } = await webhookAdapter();
    // No type-13 body was captured, and none is needed: the type gate answers
    // before any schema runs, so the git-shaped body under a type 13 exercises
    // exactly what this asserts.
    const response = await adapter.handleWebhook(
      webhookRequest({ ...gitPushed(), type: 13 })
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Ignored');
    expect(chat).not.toHaveDispatched('processMessage');
  });

  it('a pull request deletion activity is acknowledged and ignored', async () => {
    const { adapter, chat } = await webhookAdapter();

    const response = await adapter.handleWebhook(
      webhookRequest(pullRequestDeleted())
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Ignored');
    expect(chat).not.toHaveDispatched('processMessage');
  });
});

/**
 * Captures what `handleWebhook` dispatches, resolved the way the core resolves
 * it. `createMockChatInstance`'s default `processMessage` never calls the
 * factory it is handed, while the real `ChatInstance.processMessage` resolves
 * it itself (`.claude/rules/chat-sdk-core-facts.md`), so a test asserting on
 * the message rather than on the fact of dispatch has to stand in for that
 * step. Takes an already-built adapter because a two-installation adapter
 * cannot be expressed as an override of the single-space config.
 */
async function initializeCapturingDispatches(
  adapter: BacklogAdapter
): Promise<{ threadId: string; message: Message }[]> {
  const dispatched: { threadId: string; message: Message }[] = [];
  const chat = createMockChatInstance({
    logger: createMockLogger(),
    overrides: {
      processMessage: vi.fn(
        async (
          _adapter: Adapter,
          threadId: string,
          message: Message | (() => Promise<Message>)
        ) => {
          const resolved =
            typeof message === 'function' ? await message() : message;
          dispatched.push({ threadId, message: resolved });
        }
      ),
    },
  });
  await adapter.initialize(chat);
  return dispatched;
}

describe('BacklogAdapter.handleWebhook — pull-request activities (§5.3)', () => {
  it('a new pull request is a root message on a pull request thread', async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const dispatched = await initializeCapturingDispatches(adapter);

    const response = await adapter.handleWebhook(
      webhookRequest(
        pullRequestAdded({
          summary: 'Retry the deploy step on a 5xx',
          description: 'Fixes the flaky staging deploy.',
        })
      )
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]?.threadId).toBe(PULL_REQUEST_THREAD_ID);
    expect(dispatched[0]?.message.id).toBe(
      encodeMessageId({
        host: FIXTURE.host,
        subject: PULL_REQUEST_SUBJECT,
        part: 'root',
      })
    );
    expect(dispatched[0]?.message.text).toBe(
      'Retry the deploy step on a 5xx\n\nFixes the flaky staging deploy.'
    );
  });

  it("a comment on a pull request is dispatched to the pull request's thread", async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const dispatched = await initializeCapturingDispatches(adapter);

    const response = await adapter.handleWebhook(
      webhookRequest(
        pullRequestCommented({
          commentId: 7000001,
          text: 'Looks good, one question about the timeout.',
        })
      )
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]?.threadId).toBe(PULL_REQUEST_THREAD_ID);
    expect(dispatched[0]?.message.id).toBe(
      encodeMessageId({
        host: FIXTURE.host,
        subject: PULL_REQUEST_SUBJECT,
        part: 'comment',
        commentId: 7000001,
      })
    );
    expect(dispatched[0]?.message.text).toBe(
      'Looks good, one question about the timeout.'
    );
  });

  it("a pull request linked to an issue does not route to the issue's thread", async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const dispatched = await initializeCapturingDispatches(adapter);

    const response = await adapter.handleWebhook(
      webhookRequest(pullRequestAdded({ linkedIssue: true }))
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]?.threadId).toBe(PULL_REQUEST_THREAD_ID);
    expect(dispatched[0]?.threadId).not.toBe(
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.issueId}`
    );
    // The link itself still reaches a handler; it is display data, not
    // routing (D-PR6), and the pull request stays its own thread.
    const raw = dispatched[0]?.message.raw as {
      payload: { content: { issue: { id: number } | null } };
    };
    expect(raw.payload.content.issue?.id).toBe(FIXTURE.issueId);
  });

  it('assigning the bot to a pull request is a mention', async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const dispatched = await initializeCapturingDispatches(adapter);

    const response = await adapter.handleWebhook(
      webhookRequest(
        pullRequestAssigneeChanged({ assigneeName: FIXTURE.bot.name })
      )
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]?.message.isMention).toBe(true);
  });

  it('a pull request payload missing its repository is rejected with 400', async () => {
    const { adapter, chat } = await webhookAdapter();
    const payload = pullRequestAdded();
    const content = payload['content'] as Record<string, unknown>;
    delete content['repository'];

    const response = await adapter.handleWebhook(webhookRequest(payload));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid payload');
    expect(chat).not.toHaveDispatched('processMessage');
  });

  it('a pull request payload missing its number is rejected with 400', async () => {
    const { adapter } = await webhookAdapter();
    const payload = pullRequestCommented();
    const content = payload['content'] as Record<string, unknown>;
    delete content['number'];

    const response = await adapter.handleWebhook(webhookRequest(payload));

    expect(response.status).toBe(400);
    expect(await response.text()).toBe('Invalid payload');
  });

  it('the repository name from a webhook spares the next thread read a lookup', async () => {
    const calls: string[] = [];
    const { adapter } = egressAdapter({
      seed: pullRequestSeed(),
      wrapApi: (api) => recordPortCalls(api, calls),
    });
    await initializeCapturingDispatches(adapter);

    const response = await adapter.handleWebhook(
      webhookRequest(pullRequestCommented())
    );
    expect(response.status).toBe(200);

    const thread = await adapter.fetchThread(PULL_REQUEST_THREAD_ID);

    expect(thread.metadata).toMatchObject({
      repositoryName: FIXTURE.repositoryName,
      url: `https://${FIXTURE.host}/git/${FIXTURE.projectKey}/${FIXTURE.repositoryName}/pullRequests/${FIXTURE.pullRequestNumber}`,
    });
    expect(calls).toContain('getPullRequest');
    expect(calls).not.toContain('getGitRepository');
  });

  it('the same pull request payload sent to two configured hosts yields two thread ids and two ports used', async () => {
    const firstApi = createInMemoryBacklogApi({
      projects: [conformanceFixture.baseProject()],
    });
    const otherApi = createInMemoryBacklogApi({
      projects: [{ ...conformanceFixture.baseProject() }],
    });
    const createApi = vi
      .fn()
      .mockReturnValueOnce(firstApi)
      .mockReturnValueOnce(otherApi);
    const adapter = createBacklogAdapter({
      installations: [
        {
          host: FIXTURE.host,
          apiKey: 'k1',
          botUserId: FIXTURE.bot.id,
          botUserName: FIXTURE.bot.name,
          webhookSecret: FIXTURE.webhookSecret,
        },
        {
          host: FIXTURE.otherHost,
          apiKey: 'k2',
          botUserId: 998,
          botUserName: 'Chatbot2',
          webhookSecret: 'other-secret',
        },
      ],
      createApi,
    });
    const dispatched = await initializeCapturingDispatches(adapter);

    await adapter.handleWebhook(
      webhookRequest(pullRequestAdded(), { host: FIXTURE.host })
    );
    await adapter.handleWebhook(
      webhookRequest(pullRequestAdded(), {
        host: FIXTURE.otherHost,
        token: 'other-secret',
      })
    );
    await vi.waitFor(() => expect(dispatched).toHaveLength(2));

    expect(dispatched[0]?.threadId).toBe(PULL_REQUEST_THREAD_ID);
    expect(dispatched[1]?.threadId).toBe(
      `backlog:${FIXTURE.otherHost}:${FIXTURE.projectId}:pr:${FIXTURE.repositoryId}:${FIXTURE.pullRequestNumber}`
    );
    expect(dispatched[0]?.message.id).not.toBe(dispatched[1]?.message.id);
    expect(adapter.api(FIXTURE.host)).toBe(firstApi);
    expect(adapter.api(FIXTURE.otherHost)).toBe(otherApi);
  });
});

/**
 * The read side of a dispatched message, exercised through `handleWebhook` and
 * the factory it dispatches rather than against the schema alone
 * (docs/specs/adapter.md §5.2 `notifications[]`, §5.4 rule 6).
 *
 * `payload.test.ts` proves the schema falls back to `[]`; these prove the
 * fallback is what the mapping reads, which is a different claim: `raw.payload`
 * is the body as received, so a `notifications[]` the schema would have
 * replaced is still on it when the message arrives, and a read side that
 * trusted the declared type never saw the fallback at all.
 */
describe('BacklogAdapter.handleWebhook — a notifications[] the adapter cannot read', () => {
  function withoutNotifications(
    body: Record<string, unknown>
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(body).filter(([key]) => key !== 'notifications')
    );
  }

  it('an issue comment with no notifications key is dispatched, with mention detection falling back to the text', async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const dispatched = await initializeCapturingDispatches(adapter);

    const response = await adapter.handleWebhook(
      webhookRequest(withoutNotifications(issueCommented({ commentId: 3001 })))
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]?.message.id).toBe(
      encodeMessageId({
        host: FIXTURE.host,
        subject: { kind: 'issue', issueId: FIXTURE.issueId },
        part: 'comment',
        commentId: 3001,
      })
    );
    expect(dispatched[0]?.message.isMention).toBe(false);
    // The body reaches the handler as Backlog sent it (§5.2 "not a stripped
    // copy"), so the key the mapping read through a fallback is still absent.
    const raw = dispatched[0]?.message.raw as {
      payload: Record<string, unknown>;
    };
    expect('notifications' in raw.payload).toBe(false);
  });

  it('an issue comment whose notifications entry names no user is dispatched', async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const dispatched = await initializeCapturingDispatches(adapter);

    const response = await adapter.handleWebhook(
      webhookRequest({
        ...issueCommented({ text: `@${FIXTURE.bot.name} take a look` }),
        notifications: [{ user: null }],
      })
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]?.message.text).toBe(
      `@${FIXTURE.bot.name} take a look`
    );
    // The unreadable array costs the notification rule, not the message: the
    // textual rule still sees the mention (§5.4 rule 6).
    expect(dispatched[0]?.message.isMention).toBe(true);
  });

  it('an issue assignment with no notifications key is still a mention through changes[]', async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const dispatched = await initializeCapturingDispatches(adapter);

    const response = await adapter.handleWebhook(
      webhookRequest(
        withoutNotifications(
          assigneeChanged({ assigneeName: FIXTURE.bot.name })
        )
      )
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]?.message.isMention).toBe(true);
  });

  it('a new pull request with no notifications key is dispatched as a root message', async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const dispatched = await initializeCapturingDispatches(adapter);

    const response = await adapter.handleWebhook(
      webhookRequest(
        withoutNotifications(
          pullRequestAdded({ summary: 'Retry the deploy step on a 5xx' })
        )
      )
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]?.threadId).toBe(PULL_REQUEST_THREAD_ID);
    expect(dispatched[0]?.message.id).toBe(
      encodeMessageId({
        host: FIXTURE.host,
        subject: PULL_REQUEST_SUBJECT,
        part: 'root',
      })
    );
    expect(dispatched[0]?.message.isMention).toBe(false);
  });

  it('a pull-request comment whose notifications entry names no user is dispatched', async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const dispatched = await initializeCapturingDispatches(adapter);

    const response = await adapter.handleWebhook(
      webhookRequest({
        ...pullRequestCommented({
          commentId: 7000001,
          text: 'Looks good, one question about the timeout.',
        }),
        notifications: [{ user: null }],
      })
    );

    expect(response.status).toBe(200);
    await vi.waitFor(() => expect(dispatched).toHaveLength(1));
    expect(dispatched[0]?.threadId).toBe(PULL_REQUEST_THREAD_ID);
    expect(dispatched[0]?.message.id).toBe(
      encodeMessageId({
        host: FIXTURE.host,
        subject: PULL_REQUEST_SUBJECT,
        part: 'comment',
        commentId: 7000001,
      })
    );
    expect(dispatched[0]?.message.isMention).toBe(false);
  });
});

describe('BacklogAdapter.parseMessage', () => {
  it('rejects a non-webhook raw message kind as a defect, not a recoverable input', () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    expect(() =>
      adapter.parseMessage({
        kind: 'issue',
        host: FIXTURE.host,
        issue: {
          id: FIXTURE.issueId,
          issueKey: 'EXAMPLE-1',
          projectId: FIXTURE.projectId,
          summary: '',
          description: '',
          status: { id: 1, name: 'Open' },
          issueType: { id: 1, name: 'Task' },
          priority: { id: 3, name: 'Normal' },
          assignee: null,
          createdUser: { id: 1, name: 'a' },
          created: '',
          updated: '',
        },
        changes: [],
      })
    ).toThrow(ValidationError);
  });

  it('builds one issue of a bulk update from the delivery and the issue id', () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const payload = issueMultiUpdated({
      text: 'Moving these to done.',
    }) as unknown as BacklogBulkUpdatePayload;

    const message = adapter.parseMessage({
      kind: 'bulkUpdate',
      host: FIXTURE.host,
      payload,
      issueId: FIXTURE.otherIssueId,
      changes: [],
    });

    expect(message.id).toBe(
      `${FIXTURE.host}:issue:${FIXTURE.otherIssueId}:c3102`
    );
    expect(message.threadId).toBe(
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.otherIssueId}`
    );
    expect(message.text).toBe('Moving these to done.');
  });

  it('rejects a webhook raw message whose payload does not parse as its activity type', () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const parse = () =>
      adapter.parseMessage({
        kind: 'webhook',
        host: FIXTURE.host,
        payload: {
          ...issueCommented(),
          content: { id: 0 },
        } as unknown as BacklogWebhookPayload,
        changes: [],
      });

    expect(parse).toThrow(ValidationError);
    expect(parse).toThrow(/not a valid type 3 activity/);
  });

  it('rejects a bulk update raw message naming an issue the delivery does not cover', () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());

    expect(() =>
      adapter.parseMessage({
        kind: 'bulkUpdate',
        host: FIXTURE.host,
        payload: issueMultiUpdated() as unknown as BacklogBulkUpdatePayload,
        issueId: 123456,
        changes: [],
      })
    ).toThrow(ValidationError);
  });

  it('rejects a bulk update raw message whose payload is not a type-14 activity', () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());

    expect(() =>
      adapter.parseMessage({
        kind: 'bulkUpdate',
        host: FIXTURE.host,
        payload: issueCommented() as unknown as BacklogBulkUpdatePayload,
        issueId: FIXTURE.issueId,
        changes: [],
      })
    ).toThrow(ValidationError);
  });
});

describe('BacklogAdapter inbound formatting (§9.1)', () => {
  it('a webhook factory parses Backlog notation with the looked-up project rule', async () => {
    const project = {
      ...conformanceFixture.baseProject(),
      textFormattingRule: 'backlog' as const,
    };
    const adapter = createBacklogAdapter({
      ...webhookAdapterConfig(),
      createApi: () => createInMemoryBacklogApi({ projects: [project] }),
    });
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

  const adapter = createBacklogAdapter({
    host: FIXTURE.host,
    apiKey: 'test-api-key',
    botUserId: FIXTURE.bot.id,
    botUserName: FIXTURE.bot.name,
    webhookSecret: FIXTURE.webhookSecret,
    createApi: () => options.wrapApi?.(api) ?? api,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

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

  it('files are uploaded and attached to the comment', async () => {
    const { adapter, api } = egressAdapter();
    await adapter.postMessage(EGRESS_THREAD_ID, {
      markdown: 'See attached',
      files: [{ filename: 'notes.txt', data: Buffer.from('hello') }],
    });
    expect(api.state.uploads).toHaveLength(1);
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
      repositoryName: FIXTURE.repositoryName,
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
    expect(thread.metadata).not.toHaveProperty('repositoryName');
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

describe('BacklogAdapter.postChannelMessage (§6.7)', () => {
  it('posting to a channel creates an issue whose summary is the first block as plain text', async () => {
    const { adapter, api } = egressAdapter({
      seed: { issueTypes: { [FIXTURE.projectId]: [{ id: 1, name: 'Task' }] } },
    });
    const channelId = `backlog:${FIXTURE.host}:${FIXTURE.projectId}`;
    await adapter.postChannelMessage(channelId, {
      markdown: '# Deploy is broken\n\nSee the logs for details.',
    });
    expect(api.state.recordedInputs).toContainEqual({
      method: 'createIssue',
      input: {
        projectId: FIXTURE.projectId,
        summary: 'Deploy is broken',
        issueTypeId: 1,
        priorityId: 3,
        description: 'See the logs for details.',
      },
    });
  });

  it('stale cached defaults are refreshed once after a validation error', async () => {
    const { adapter, api } = egressAdapter({
      seed: { issueTypes: { [FIXTURE.projectId]: [{ id: 1, name: 'Task' }] } },
    });
    const channelId = `backlog:${FIXTURE.host}:${FIXTURE.projectId}`;
    // Warm the cache with the default issue type, then remove it from the
    // port so a create using the cached id fails validation — simulating a
    // project setting that changed after the cache was populated.
    await adapter.postChannelMessage(channelId, { markdown: 'First issue' });
    const originalCreateIssue = api.createIssue.bind(api);
    let calls = 0;
    api.createIssue = (input) => {
      calls += 1;
      if (calls === 1 && input.issueTypeId === 1) {
        return Promise.reject(
          new ValidationError('backlog', 'issueTypeId no longer exists')
        );
      }
      return originalCreateIssue(input);
    };
    api.listIssueTypes = () => Promise.resolve([{ id: 2, name: 'Bug' }]);

    const result = await adapter.postChannelMessage(channelId, {
      markdown: 'Second issue',
    });

    expect(calls).toBe(2);
    expect(result.threadId).toMatch(
      new RegExp(`^backlog:${FIXTURE.host}:${FIXTURE.projectId}:`)
    );
    const secondCreate = api.state.recordedInputs.filter(
      (input) => input.method === 'createIssue'
    );
    expect(secondCreate[1]).toMatchObject({ input: { issueTypeId: 2 } });
  });

  it('explicit issue type and priority are never retried', async () => {
    const { adapter, api } = egressAdapter();
    const channelId = `backlog:${FIXTURE.host}:${FIXTURE.projectId}`;
    let calls = 0;
    api.createIssue = () => {
      calls += 1;
      return Promise.reject(
        new ValidationError('backlog', 'summary already exists')
      );
    };

    await expect(
      adapter.postChannelMessage(channelId, {
        markdown: 'Explicit ids',
        issueTypeId: 1,
        priorityId: 3,
      } as unknown as Parameters<BacklogAdapter['postChannelMessage']>[1])
    ).rejects.toThrow(ValidationError);
    expect(calls).toBe(1);
  });

  it('an empty summary is a validation error', async () => {
    const { adapter } = egressAdapter();
    const channelId = `backlog:${FIXTURE.host}:${FIXTURE.projectId}`;
    await expect(
      adapter.postChannelMessage(channelId, { markdown: '' })
    ).rejects.toThrow(ValidationError);
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

describe('BacklogAdapter.fetchChannelInfo (§7.5)', () => {
  it('fetching channel info replaces the cached formatting rule', async () => {
    const { adapter, api } = egressAdapter({ textFormattingRule: 'markdown' });
    const channelId = `backlog:${FIXTURE.host}:${FIXTURE.projectId}`;

    // Warm the cache with the seeded "markdown" rule.
    await adapter.postMessage(EGRESS_THREAD_ID, { markdown: '**bold**' });
    api.state.projects[0] = {
      ...(api.state.projects[0] as (typeof api.state.projects)[number]),
      textFormattingRule: 'backlog',
    };

    const info = await adapter.fetchChannelInfo(channelId);
    expect(info.metadata).toMatchObject({ textFormattingRule: 'backlog' });

    await adapter.postMessage(EGRESS_THREAD_ID, { markdown: '**bold**' });
    const addComment = api.state.recordedInputs.filter(
      (input) => input.method === 'addComment'
    );
    expect(addComment[addComment.length - 1]).toMatchObject({
      input: { content: "''bold''" },
    });
  });

  it('clearing channel info forgets the host\u2019s repository names', async () => {
    const calls: string[] = [];
    const { adapter } = egressAdapter({
      seed: pullRequestSeed(),
      wrapApi: (api) => recordPortCalls(api, calls),
    });
    const channelId = `backlog:${FIXTURE.host}:${FIXTURE.projectId}`;

    await adapter.fetchThread(PULL_REQUEST_THREAD_ID);
    calls.length = 0;
    await adapter.fetchThread(PULL_REQUEST_THREAD_ID);
    expect(calls).not.toContain('getGitRepository');

    await adapter.fetchChannelInfo(channelId);
    calls.length = 0;
    const thread = await adapter.fetchThread(PULL_REQUEST_THREAD_ID);

    expect(calls).toContain('getGitRepository');
    expect(thread.metadata).toMatchObject({
      repositoryName: FIXTURE.repositoryName,
    });
  });

  it('clearing channel info leaves another space untouched', async () => {
    const calls = new Map<string, string[]>([
      [FIXTURE.host, []],
      [FIXTURE.otherHost, []],
    ]);
    const ports = new Map<string, BacklogApi>(
      [FIXTURE.host, FIXTURE.otherHost].map((host) => [
        host,
        recordPortCalls(
          createInMemoryBacklogApi({
            projects: [
              {
                id: FIXTURE.projectId,
                projectKey: FIXTURE.projectKey,
                name: 'Example project',
                textFormattingRule: 'markdown',
              },
            ],
            users: [CHATBOT_USER_REF],
            me: CHATBOT_USER_REF,
            ...pullRequestSeed(),
          }),
          calls.get(host) as string[]
        ),
      ])
    );
    const adapter = createBacklogAdapter({
      installations: [FIXTURE.host, FIXTURE.otherHost].map((host) => ({
        host,
        apiKey: 'test-api-key',
        botUserId: FIXTURE.bot.id,
        botUserName: FIXTURE.bot.name,
        webhookSecret: FIXTURE.webhookSecret,
      })),
      createApi: (installation) => ports.get(installation.host) as BacklogApi,
    });
    const threadOn = (host: string): string =>
      `backlog:${host}:${FIXTURE.projectId}:pr:${FIXTURE.repositoryId}:${FIXTURE.pullRequestNumber}`;

    await adapter.fetchThread(threadOn(FIXTURE.host));
    await adapter.fetchThread(threadOn(FIXTURE.otherHost));
    await adapter.fetchChannelInfo(
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}`
    );
    for (const recorded of calls.values()) {
      recorded.length = 0;
    }

    await adapter.fetchThread(threadOn(FIXTURE.host));
    await adapter.fetchThread(threadOn(FIXTURE.otherHost));

    expect(calls.get(FIXTURE.host)).toContain('getGitRepository');
    expect(calls.get(FIXTURE.otherHost)).not.toContain('getGitRepository');
  });
});

describe('BacklogAdapter.markAsRead (§7.8)', () => {
  /**
   * One entry of the bot's own notification feed. `comment` and
   * `pullRequestComment` both default to `null` and every test below names
   * the one it means: which of the two carries the comment id is the whole
   * subject of §7.8's matching rule, so a default for either would be a
   * default for the variable under test.
   */
  function botNotification(
    overrides: Partial<BacklogNotification> & { id: number }
  ): BacklogNotification {
    return {
      alreadyRead: false,
      resourceAlreadyRead: false,
      project: {
        id: FIXTURE.projectId,
        projectKey: FIXTURE.projectKey,
        name: 'Example project',
      },
      issue: null,
      comment: null,
      pullRequest: null,
      pullRequestComment: null,
      sender: ALICE_USER_REF,
      created: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    };
  }

  /**
   * `pageCount * 100` notifications, newest-first by id, with the target
   * comment attached to the **oldest** one so it can only be reached after
   * every earlier page of 100 has been exhausted.
   */
  function feedEndingWith(
    pageCount: number,
    target: Pick<BacklogNotification, 'comment' | 'pullRequestComment'>
  ): BacklogNotification[] {
    const total = pageCount * 100;
    return Array.from({ length: total }, (_, index) => {
      const notificationId = total - index;
      return botNotification(
        notificationId === 1
          ? { id: 1, ...target }
          : { id: notificationId, comment: { id: 1000 + notificationId } }
      );
    });
  }

  const issueCommentMessageId = (commentId: number) =>
    encodeMessageId({
      host: FIXTURE.host,
      subject: ISSUE_SUBJECT,
      part: 'comment',
      commentId,
    });
  const pullRequestCommentMessageId = (commentId: number) =>
    encodeMessageId({
      host: FIXTURE.host,
      subject: PULL_REQUEST_SUBJECT,
      part: 'comment',
      commentId,
    });

  it('marking read finds the notification on the third page', async () => {
    const targetCommentId = 5;
    const { adapter, api } = egressAdapter({
      seed: {
        notifications: feedEndingWith(3, {
          comment: { id: targetCommentId },
          pullRequestComment: null,
        }),
      },
    });

    await adapter.markAsRead(
      EGRESS_THREAD_ID,
      issueCommentMessageId(targetCommentId)
    );

    expect(api.state.recordedInputs).toContainEqual({
      method: 'markNotificationAsRead',
      id: 1,
    });
  });

  it('marking a pull request comment read finds the notification on the third page', async () => {
    const { adapter, api } = egressAdapter({
      seed: {
        ...pullRequestSeed([{ id: PULL_REQUEST_COMMENT_ID }]),
        notifications: feedEndingWith(3, {
          comment: null,
          pullRequestComment: { id: PULL_REQUEST_COMMENT_ID },
        }),
      },
    });

    await adapter.markAsRead(
      PULL_REQUEST_THREAD_ID,
      pullRequestCommentMessageId(PULL_REQUEST_COMMENT_ID)
    );

    expect(api.state.recordedInputs).toContainEqual({
      method: 'markNotificationAsRead',
      id: 1,
    });
  });

  it('a pull request comment beyond three pages of notifications is left unmarked', async () => {
    const calls: string[] = [];
    const logger = createMockLogger();
    const { adapter, api } = egressAdapter({
      logger,
      wrapApi: (port) => recordPortCalls(port, calls),
      seed: {
        ...pullRequestSeed([{ id: PULL_REQUEST_COMMENT_ID }]),
        notifications: feedEndingWith(4, {
          comment: null,
          pullRequestComment: { id: PULL_REQUEST_COMMENT_ID },
        }),
      },
    });

    await adapter.markAsRead(
      PULL_REQUEST_THREAD_ID,
      pullRequestCommentMessageId(PULL_REQUEST_COMMENT_ID)
    );

    expect(calls.filter((call) => call === 'listNotifications')).toHaveLength(
      3
    );
    expect(api.state.recordedInputs).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      'markAsRead: no matching notification found within 3 pages',
      expect.objectContaining({ commentId: PULL_REQUEST_COMMENT_ID })
    );
  });

  it('marking a pull request comment read matches the pull request notification, not an issue comment with the same id', async () => {
    const sharedCommentId = PULL_REQUEST_COMMENT_ID;
    const { adapter, api } = egressAdapter({
      seed: {
        ...pullRequestSeed([{ id: sharedCommentId }]),
        // Newest first, so the issue notification is the one examined first:
        // matching on the number alone would mark notification 2.
        notifications: [
          botNotification({ id: 2, comment: { id: sharedCommentId } }),
          botNotification({
            id: 1,
            pullRequestComment: { id: sharedCommentId },
          }),
        ],
      },
    });

    await adapter.markAsRead(
      PULL_REQUEST_THREAD_ID,
      pullRequestCommentMessageId(sharedCommentId)
    );

    expect(api.state.recordedInputs).toEqual([
      { method: 'markNotificationAsRead', id: 1 },
    ]);
  });

  it('marking an issue comment read matches the issue notification, not a pull request comment with the same id', async () => {
    const sharedCommentId = PULL_REQUEST_COMMENT_ID;
    const { adapter, api } = egressAdapter({
      seed: {
        ...pullRequestSeed([{ id: sharedCommentId }]),
        notifications: [
          botNotification({
            id: 2,
            pullRequestComment: { id: sharedCommentId },
          }),
          botNotification({ id: 1, comment: { id: sharedCommentId } }),
        ],
      },
    });

    await adapter.markAsRead(
      EGRESS_THREAD_ID,
      issueCommentMessageId(sharedCommentId)
    );

    expect(api.state.recordedInputs).toEqual([
      { method: 'markNotificationAsRead', id: 1 },
    ]);
  });

  it('marking an already-read notification makes no update call', async () => {
    const { adapter, api } = egressAdapter({
      seed: {
        notifications: [
          botNotification({
            id: 1,
            resourceAlreadyRead: true,
            comment: { id: 7 },
          }),
        ],
      },
    });

    await adapter.markAsRead(EGRESS_THREAD_ID, issueCommentMessageId(7));

    expect(
      api.state.recordedInputs.filter(
        (input) => input.method === 'markNotificationAsRead'
      )
    ).toHaveLength(0);
  });

  it('marking an already-read pull request notification makes no update call', async () => {
    const { adapter, api } = egressAdapter({
      seed: {
        ...pullRequestSeed([{ id: PULL_REQUEST_COMMENT_ID }]),
        notifications: [
          botNotification({
            id: 1,
            resourceAlreadyRead: true,
            pullRequestComment: { id: PULL_REQUEST_COMMENT_ID },
          }),
        ],
      },
    });

    await adapter.markAsRead(
      PULL_REQUEST_THREAD_ID,
      pullRequestCommentMessageId(PULL_REQUEST_COMMENT_ID)
    );

    expect(api.state.recordedInputs).toEqual([]);
  });

  it('an inbox-cleared notification whose resource is still unread still gets marked', async () => {
    // `alreadyRead` is the badge flag the reset-unread-count endpoint sets on
    // every notification; `resourceAlreadyRead` is what `markAsRead`'s own
    // endpoint sets on this one. A seed with the former true and the latter
    // false proves the short-circuit no longer keys off the wrong flag
    // (measured 2026-09-06, `.claude/rules/backlog-api-facts.md`).
    const { adapter, api } = egressAdapter({
      seed: {
        notifications: [
          botNotification({
            id: 1,
            alreadyRead: true,
            resourceAlreadyRead: false,
            comment: { id: 7 },
          }),
        ],
      },
    });

    await adapter.markAsRead(EGRESS_THREAD_ID, issueCommentMessageId(7));

    expect(api.state.recordedInputs).toContainEqual({
      method: 'markNotificationAsRead',
      id: 1,
    });
  });

  it('marking a comment read through the wrong kind of thread is rejected', async () => {
    const { adapter, api } = egressAdapter({
      seed: {
        ...pullRequestSeed([{ id: PULL_REQUEST_COMMENT_ID }]),
        notifications: [
          botNotification({
            id: 1,
            comment: { id: PULL_REQUEST_COMMENT_ID },
          }),
        ],
      },
    });

    await expect(
      adapter.markAsRead(
        EGRESS_THREAD_ID,
        pullRequestCommentMessageId(PULL_REQUEST_COMMENT_ID)
      )
    ).rejects.toThrow(ValidationError);
    expect(api.state.recordedInputs).toEqual([]);
  });

  it('the issue body id makes no notification call', async () => {
    const calls: string[] = [];
    const { adapter } = egressAdapter({
      wrapApi: (port) => recordPortCalls(port, calls),
    });

    await adapter.markAsRead(
      EGRESS_THREAD_ID,
      encodeMessageId({
        host: FIXTURE.host,
        subject: ISSUE_SUBJECT,
        part: 'root',
      })
    );

    expect(calls).toEqual([]);
  });

  it('a pull request message id naming no comment makes no notification call', async () => {
    const calls: string[] = [];
    const { adapter } = egressAdapter({
      seed: pullRequestSeed(),
      wrapApi: (port) => recordPortCalls(port, calls),
    });

    await adapter.markAsRead(
      PULL_REQUEST_THREAD_ID,
      encodeMessageId({
        host: FIXTURE.host,
        subject: PULL_REQUEST_SUBJECT,
        part: 'root',
      })
    );
    await adapter.markAsRead(
      PULL_REQUEST_THREAD_ID,
      encodeMessageId({
        host: FIXTURE.host,
        subject: PULL_REQUEST_SUBJECT,
        part: 'update',
        created: '2026-01-01T00:00:00Z',
      })
    );

    expect(calls).toEqual([]);
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

  it('without a target renders Markdown and warns once', () => {
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

  it('rendering for an unparseable target warns and falls back to markdown', async () => {
    const logger = createMockLogger();
    const { adapter } = egressAdapter({
      textFormattingRule: 'backlog',
      logger,
    });
    await adapter.postMessage(EGRESS_THREAD_ID, {
      markdown: 'prime the cache',
    });

    const rendered = adapter.renderFormatted(BOLD_CONTENT, 'not-an-id');

    expect(rendered).toBe('**bold**');
    expect(logger.warn).toHaveBeenCalledWith(
      'textFormattingRule uncached; assuming markdown',
      { target: 'not-an-id' }
    );
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
    const adapter = createBacklogAdapter({
      host: FIXTURE.host,
      apiKey: 'test-api-key',
      botUserId: FIXTURE.bot.id,
      botUserName: FIXTURE.bot.name,
      webhookSecret: FIXTURE.webhookSecret,
      createApi: () => api,
    });

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
  createAdapter: ({ webhookVerifier }) =>
    createBacklogAdapter({
      host: FIXTURE.host,
      apiKey: 'connect-key',
      botUserId: CONNECT_BOT_USER_ID,
      botUserName: FIXTURE.bot.name,
      webhookVerifier,
      createApi: () =>
        createInMemoryBacklogApi({
          projects: [conformanceFixture.baseProject()],
        }),
    }),
  makeWebhookRequest: () => webhookRequest(issueCommented(), { token: null }),
});

selfMessageContract({
  name: 'backlog',
  setup: async () => {
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const chat = createMockChatInstance({ logger: createMockLogger() });
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
    const adapter = createBacklogAdapter(webhookAdapterConfig());
    const chat = createMockChatInstance({ logger: createMockLogger() });
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
