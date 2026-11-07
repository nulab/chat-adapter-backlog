import { ValidationError } from '@chat-adapter/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import { parseConfig } from './config';
import type { BacklogAdapterConfig } from './types';

const ENV_KEYS = [
  'BACKLOG_HOST',
  'BACKLOG_API_KEY',
  'BACKLOG_BOT_USER_ID',
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

const valid = {
  host: 'example.backlog.com',
  apiKey: 'test-api-key',
  botUserId: 999,
  webhookSecret: 'test-webhook-secret',
} satisfies BacklogAdapterConfig;

function without(...keys: (keyof typeof valid)[]): BacklogAdapterConfig {
  const config: BacklogAdapterConfig = { ...valid };
  for (const key of keys) {
    delete config[key];
  }
  return config;
}

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  Object.assign(process.env, values);
}

function rejection(config: unknown): string {
  try {
    parseConfig(config as BacklogAdapterConfig);
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).message;
  }
  throw new Error('parseConfig accepted the config');
}

describe('parseConfig', () => {
  it('names the missing host and its variable when nothing is configured', () => {
    expect(rejection({})).toMatch(/host.*BACKLOG_HOST/);
  });

  it('reads every field from the environment when config is empty', () => {
    setEnv({
      BACKLOG_HOST: 'example.backlog.com',
      BACKLOG_API_KEY: 'env-api-key',
      BACKLOG_BOT_USER_ID: '999',
      BACKLOG_WEBHOOK_SECRET: 'env-webhook-secret',
    });

    expect(parseConfig({})).toMatchObject({
      host: 'example.backlog.com',
      botUserId: 999,
      webhookSecret: 'env-webhook-secret',
    });
  });

  it('prefers a configured field over its variable', () => {
    setEnv({ BACKLOG_HOST: 'env.backlog.com' });
    expect(parseConfig(valid).host).toBe('example.backlog.com');
  });

  it('lowercases the host', () => {
    expect(parseConfig({ ...valid, host: 'Example.Backlog.COM' }).host).toBe(
      'example.backlog.com'
    );
  });

  it.each([
    ['a scheme', 'https://example.backlog.com'],
    ['a port', 'example.backlog.com:443'],
    ['a path', 'example.backlog.com/api'],
    ['whitespace', ' example.backlog.com'],
    ['nothing', ''],
  ])('rejects a host with %s', (_case, host) => {
    expect(rejection({ ...valid, host })).toMatch(/host/);
  });

  it('rejects a missing apiKey, naming where to set it', () => {
    const message = rejection(without('apiKey'));
    expect(message).toMatch(/required/);
    expect(message).toMatch(/BACKLOG_API_KEY/);
  });

  it('treats an explicit empty apiKey as an error, not a reason to read the variable', () => {
    setEnv({ BACKLOG_API_KEY: 'from-env' });
    expect(rejection({ ...valid, apiKey: '' })).toMatch(/apiKey/);
  });

  it('calls a credential resolver on every use and never at parse time', async () => {
    let calls = 0;
    const { resolveApiKey } = parseConfig({
      ...valid,
      apiKey: () => {
        calls += 1;
        return `token-${calls}`;
      },
    });

    expect(calls).toBe(0);
    expect(await resolveApiKey()).toBe('token-1');
    expect(await resolveApiKey()).toBe('token-2');
  });

  it('requires a webhookSecret when no webhookVerifier is set', () => {
    expect(rejection(without('webhookSecret'))).toMatch(
      /webhookSecret is required/
    );
  });

  it('accepts a missing webhookSecret when a webhookVerifier is set', () => {
    expect(() =>
      parseConfig({ ...without('webhookSecret'), webhookVerifier: () => true })
    ).not.toThrow();
  });

  it('rejects a configured webhookSecret shorter than 16 bytes, even beside a webhookVerifier', () => {
    expect(rejection({ ...valid, webhookSecret: 'short' })).toMatch(/16 bytes/);
    expect(
      rejection({
        ...valid,
        webhookSecret: 'short',
        webhookVerifier: () => true,
      })
    ).toMatch(/16 bytes/);
  });

  it('ignores BACKLOG_WEBHOOK_SECRET beside a webhookVerifier, however short', () => {
    setEnv({ BACKLOG_WEBHOOK_SECRET: 'short' });
    const parsed = parseConfig({
      ...without('webhookSecret'),
      webhookVerifier: () => true,
    });
    expect(parsed.webhookSecret).toBeUndefined();
  });

  it('accepts a 16-byte webhookSecret', () => {
    expect(() =>
      parseConfig({ ...valid, webhookSecret: '0123456789abcdef' })
    ).not.toThrow();
  });

  it.each([
    ['zero', 0],
    ['a fraction', 1.5],
    ['2^53, which no id string can carry', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects a botUserId of %s', (_case, botUserId) => {
    expect(rejection({ ...valid, botUserId })).toMatch(/botUserId/);
  });

  it.each([
    ['not a number', 'not-a-number'],
    ['beyond 2^53-1', '99999999999999999999'],
    ['with a leading zero', '0999'],
  ])('rejects a BACKLOG_BOT_USER_ID %s', (_case, value) => {
    setEnv({ BACKLOG_BOT_USER_ID: value });
    expect(rejection(without('botUserId'))).toMatch(/BACKLOG_BOT_USER_ID/);
  });

  it('requires botUserId from config or BACKLOG_BOT_USER_ID', () => {
    const message = rejection(without('botUserId'));
    expect(message).toContain('required');
    expect(message).toContain('BACKLOG_BOT_USER_ID');
  });

  it('rejects a blank BACKLOG_BOT_USER_ID copied from .env.example as missing', () => {
    setEnv({ BACKLOG_BOT_USER_ID: '' });
    const message = rejection(without('botUserId'));
    expect(message).toContain('required');
    expect(message).toContain('BACKLOG_BOT_USER_ID');
  });

  it('rejects an option it does not know, so a removed one is not silently ignored', () => {
    expect(
      rejection({ ...valid, installations: [{ host: 'two.backlog.jp' }] })
    ).toMatch(/installations/);
  });
});
