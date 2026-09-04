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

import { BacklogAdapter, createBacklogAdapter } from './adapter';
import { createInMemoryBacklogApi } from './client/in-memory';
import { conformanceFixture } from './client/conformance';
import { encodeMessageId } from './ids';
import {
  FIXTURE,
  issueCommented,
  issueDeleted,
  issueMultiUpdated,
  issueUpdated,
  statusChanged,
  unrelatedActivity,
  webhookRequest,
} from './test/fixtures/webhooks';
import { UNAUTHORIZED_BODY } from './webhook/verify';
import type { BacklogThreadId, ResolvedInstallation } from './types';
import type { Adapter, ChatInstance, Message } from 'chat';

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

describe('BacklogAdapter credential resolution', () => {
  it('invokes a resolver function once per call rather than caching its result', async () => {
    const adapter = new BacklogAdapter(validConfig());
    const resolver = vi.fn(async () => 'resolved-token');

    const [installation] = [...adapter['installations'].values()];
    if (installation === undefined) {
      throw new Error('expected one installation');
    }
    const withResolver = { ...installation, apiKey: resolver };

    await adapter.resolveCredential(withResolver);
    await adapter.resolveCredential(withResolver);

    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('wraps a rejecting resolver in AuthenticationError', async () => {
    const adapter = new BacklogAdapter(validConfig());
    const [installation] = [...adapter['installations'].values()];
    if (installation === undefined) {
      throw new Error('expected one installation');
    }
    const withResolver = {
      ...installation,
      apiKey: () => Promise.reject(new Error('token expired')),
    };

    const { AuthenticationError } = await import('@chat-adapter/shared');
    await expect(adapter.resolveCredential(withResolver)).rejects.toThrow(
      AuthenticationError
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
    expect(adapter.isDM('backlog:example.backlog.com:500:8001')).toBe(false);
  });

  it('resolves startTyping as a no-op accepting all three parameters', async () => {
    const adapter = new BacklogAdapter(validConfig());
    await expect(
      adapter.startTyping('backlog:example.backlog.com:500:8001', 'typing', {
        initiatorUserId: '100',
      })
    ).resolves.toBeUndefined();
  });

  it('derives the channel id from a thread id', () => {
    const adapter = new BacklogAdapter(validConfig());
    expect(
      adapter.channelIdFromThreadId('backlog:example.backlog.com:500:8001')
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
      decoded: { host: 'example.backlog.com', projectId: 500, issueId: 8001 },
      encoded: 'backlog:example.backlog.com:500:8001',
    },
    {
      decoded: { host: 'example.backlog.jp', projectId: 500, issueId: 8001 },
      encoded: 'backlog:example.backlog.jp:500:8001',
    },
    {
      decoded: {
        host: 'example.backlogtool.com',
        projectId: 500,
        issueId: 8001,
      },
      encoded: 'backlog:example.backlogtool.com:500:8001',
    },
  ],
});

describe('BacklogAdapter port wiring', () => {
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

/** One installation matching `FIXTURE`, backed by an in-memory port pre-seeded with the fixture project so `ensureFormattingRule` resolves without a network call. */
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

  it.each([[14], [17], [99]])(
    'a bulk update is acknowledged and ignored (type %i)',
    async (type) => {
      const { adapter, chat } = await webhookAdapter();
      const payload =
        type === 14 ? issueMultiUpdated() : { ...unrelatedActivity(), type };

      const response = await adapter.handleWebhook(webhookRequest(payload));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Ignored');
      expect(chat).not.toHaveDispatched('processMessage');
    }
  );

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
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}:${FIXTURE.issueId}`
    );
    expect(event.messageId).toBe(`${FIXTURE.host}:${FIXTURE.issueId}:i`);
  });
});

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
    // Forces the factory to reject after `ensureFormattingRule` succeeds, by
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
    createApi: () => api,
  });

  return { adapter, api };
}

const EGRESS_THREAD_ID = `backlog:${FIXTURE.host}:${FIXTURE.projectId}:${FIXTURE.issueId}`;

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
      kind: 'issue',
      host: FIXTURE.host,
      issueId: FIXTURE.issueId,
    });
    await expect(
      adapter.editMessage(EGRESS_THREAD_ID, issueMessageId, { markdown: 'x' })
    ).rejects.toThrow(ValidationError);
  });

  it('a fieldchange update with no comment cannot be deleted', async () => {
    const { adapter } = egressAdapter();
    const updateMessageId = encodeMessageId({
      kind: 'update',
      host: FIXTURE.host,
      issueId: FIXTURE.issueId,
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
      kind: 'comment',
      host: FIXTURE.host,
      issueId: FIXTURE.issueId,
      commentId: 1,
    });
    await expect(
      adapter.editMessage(EGRESS_THREAD_ID, commentMessageId, {
        markdown: 'x',
        files: [{ filename: 'a.txt', data: Buffer.from('a') }],
      })
    ).rejects.toThrow(ValidationError);
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
    kind: 'comment',
    host: FIXTURE.host,
    issueId: FIXTURE.issueId,
    commentId: 1,
  });

  it('adding a reaction twice stars the comment once', async () => {
    const { adapter, api } = seedWithComment();
    await adapter.addReaction(EGRESS_THREAD_ID, commentMessageId, 'star');
    await adapter.addReaction(EGRESS_THREAD_ID, commentMessageId, 'star');
    expect(
      api.state.recordedInputs.filter((input) => input.method === 'addStar')
    ).toHaveLength(1);
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
      kind: 'issue',
      host: FIXTURE.host,
      issueId: FIXTURE.issueId,
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
        kind: 'issue',
        host: FIXTURE.host,
        issueId: FIXTURE.issueId,
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
        kind: 'issue',
        host: FIXTURE.host,
        issueId: FIXTURE.issueId,
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
});

describe('BacklogAdapter.markAsRead (§7.8)', () => {
  it('marking read finds the notification on the third page', async () => {
    const targetCommentId = 5;
    // 250 notifications, newest-first (highest notification id first), one
    // per page-of-100 boundary: notification id 250 down to 1. The target
    // comment is attached to the single **oldest** notification (id 1), so
    // it can only be found on the third `GET /notifications` page
    // (ids 50..1) — pages 1 and 2 (ids 250..51) must be exhausted first.
    const notifications = Array.from({ length: 250 }, (_, index) => {
      const notificationId = 250 - index;
      const isOldestNotification = notificationId === 1;
      return {
        id: notificationId,
        alreadyRead: false,
        project: {
          id: FIXTURE.projectId,
          projectKey: FIXTURE.projectKey,
          name: 'Example project',
        },
        issue: {
          id: FIXTURE.issueId,
          issueKey: `${FIXTURE.projectKey}-1`,
          summary: 'Deploy fails on the staging space',
        },
        comment: {
          id: isOldestNotification ? targetCommentId : 1000 + notificationId,
        },
        sender: ALICE_USER_REF,
        created: new Date('2026-01-01T00:00:00Z'),
      };
    });
    const { adapter, api } = egressAdapter({
      seed: { notifications },
    });
    const commentMessageId = encodeMessageId({
      kind: 'comment',
      host: FIXTURE.host,
      issueId: FIXTURE.issueId,
      commentId: targetCommentId,
    });

    await adapter.markAsRead(EGRESS_THREAD_ID, commentMessageId);

    expect(api.state.recordedInputs).toContainEqual({
      method: 'markNotificationAsRead',
      id: 1,
    });
  });

  it('marking an already-read notification makes no update call', async () => {
    const { adapter, api } = egressAdapter({
      seed: {
        notifications: [
          {
            id: 1,
            alreadyRead: true,
            project: {
              id: FIXTURE.projectId,
              projectKey: FIXTURE.projectKey,
              name: 'Example project',
            },
            issue: null,
            comment: { id: 7 },
            sender: ALICE_USER_REF,
            created: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      },
    });
    const commentMessageId = encodeMessageId({
      kind: 'comment',
      host: FIXTURE.host,
      issueId: FIXTURE.issueId,
      commentId: 7,
    });

    await adapter.markAsRead(EGRESS_THREAD_ID, commentMessageId);

    expect(
      api.state.recordedInputs.filter(
        (input) => input.method === 'markNotificationAsRead'
      )
    ).toHaveLength(0);
  });

  it('the issue body id makes no notification call', async () => {
    const { adapter, api } = egressAdapter();
    const issueMessageId = encodeMessageId({
      kind: 'issue',
      host: FIXTURE.host,
      issueId: FIXTURE.issueId,
    });

    await adapter.markAsRead(EGRESS_THREAD_ID, issueMessageId);

    expect(
      api.state.recordedInputs.filter(
        (input) => input.method === 'markNotificationAsRead'
      )
    ).toHaveLength(0);
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
});

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
