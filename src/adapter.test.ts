import { ResourceNotFoundError, ValidationError } from '@chat-adapter/shared';
import { MemoryStateAdapter } from '@chat-adapter/state-memory';
import { threadIdContract } from '@chat-adapter/tests';
import { Chat } from 'chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BacklogAdapter, createBacklogAdapter } from './adapter';
import type { BacklogThreadId } from './types';
import type { Adapter } from 'chat';

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

describe('BacklogAdapter required members not yet implemented', () => {
  it.each([
    [
      'renderFormatted',
      () =>
        new BacklogAdapter(validConfig()).renderFormatted({
          type: 'root',
          children: [],
        }),
    ],
    [
      'handleWebhook',
      () =>
        new BacklogAdapter(validConfig()).handleWebhook(
          new Request('https://example.com')
        ),
    ],
    [
      'parseMessage',
      () =>
        new BacklogAdapter(validConfig()).parseMessage({
          kind: 'issue',
          host: 'example.backlog.com',
          issue: {
            id: 1,
            issueKey: 'X-1',
            projectId: 1,
            summary: '',
            description: '',
            createdUser: { id: 1, name: 'a' },
            created: '',
            updated: '',
          },
          changes: [],
        }),
    ],
    [
      'postMessage',
      () => new BacklogAdapter(validConfig()).postMessage('t', 'hi'),
    ],
    [
      'editMessage',
      () => new BacklogAdapter(validConfig()).editMessage('t', 'm', 'hi'),
    ],
    [
      'deleteMessage',
      () => new BacklogAdapter(validConfig()).deleteMessage('t', 'm'),
    ],
    [
      'addReaction',
      () => new BacklogAdapter(validConfig()).addReaction('t', 'm', 'star'),
    ],
    [
      'removeReaction',
      () => new BacklogAdapter(validConfig()).removeReaction('t', 'm', 'star'),
    ],
    [
      'fetchMessages',
      () => new BacklogAdapter(validConfig()).fetchMessages('t'),
    ],
    ['fetchThread', () => new BacklogAdapter(validConfig()).fetchThread('t')],
  ] as const)('%s throws a not-implemented AdapterError', (_name, invoke) => {
    expect(() => invoke()).toThrow(/not implemented/);
  });
});

describe('BacklogAdapter optional members not yet implemented are absent', () => {
  it('has no stream, openDM, postEphemeral, openModal, scheduleMessage, reply, postObject, editObject, fetchChannelMessages, endTyping, disconnect, onThreadSubscribe, getChannelVisibility, lockScope, persistThreadHistory, supportsTurnCancellation, botUserId, fetchMessage, fetchSubject, fetchChannelInfo, listThreads, postChannelMessage, getUser, markAsRead or rehydrateAttachment', () => {
    const adapter = new BacklogAdapter(validConfig());
    const optionalMembers = [
      'stream',
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
      'fetchMessage',
      'fetchSubject',
      'fetchChannelInfo',
      'listThreads',
      'postChannelMessage',
      'getUser',
      'markAsRead',
      'rehydrateAttachment',
    ] as const;

    for (const member of optionalMembers) {
      expect(
        (adapter as unknown as Record<string, unknown>)[member]
      ).toBeUndefined();
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
