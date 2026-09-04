import { createMockLogger } from '@chat-adapter/tests';
import { describe, expect, it, vi } from 'vitest';

import { UNAUTHORIZED_BODY, verifyWebhookRequest } from './verify';

import type { ResolvedInstallation } from '../types';

const HOST = 'example.backlog.com';
const OTHER_HOST = 'other.backlog.jp';
const SECRET = 's3cret-path-token';

function installation(
  overrides: Partial<ResolvedInstallation> = {}
): ResolvedInstallation {
  return {
    host: HOST,
    apiKey: 'key',
    botUserId: 999,
    botUserName: 'Chatbot',
    webhookSecret: SECRET,
    ...overrides,
  };
}

function installations(
  ...list: ResolvedInstallation[]
): Map<string, ResolvedInstallation> {
  return new Map(list.map((entry) => [entry.host, entry]));
}

function request(
  options: {
    method?: string;
    host?: string | null;
    token?: string | null;
    body?: string;
    headers?: Record<string, string>;
  } = {}
): Request {
  const url = new URL('https://app.example.com/api/webhooks/backlog');
  if (options.host !== null) {
    url.searchParams.set('host', options.host ?? HOST);
  }
  if (options.token !== null) {
    url.searchParams.set('token', options.token ?? SECRET);
  }
  const method = options.method ?? 'POST';
  const body = options.body ?? '{"type":3}';
  return new Request(url, {
    method,
    headers: options.headers ?? {},
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  });
}

describe('verifyWebhookRequest', () => {
  it('a non-POST request is rejected with 405', async () => {
    const logger = createMockLogger();
    const result = await verifyWebhookRequest({
      request: request({ method: 'GET' }),
      maxWebhookBodyBytes: 1024,
      webhookVerifier: undefined,
      installations: installations(installation()),
      logger,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 405,
      body: 'Method not allowed',
    });
  });

  it('a body larger than maxWebhookBodyBytes is rejected with 413 via Content-Length', async () => {
    const logger = createMockLogger();
    const bigBody = 'x'.repeat(100);
    const result = await verifyWebhookRequest({
      request: request({
        body: bigBody,
        headers: { 'content-length': String(bigBody.length) },
      }),
      maxWebhookBodyBytes: 10,
      webhookVerifier: undefined,
      installations: installations(installation()),
      logger,
    });

    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it('a body larger than maxWebhookBodyBytes with no Content-Length is still rejected with 413', async () => {
    const logger = createMockLogger();
    const bigBody = 'x'.repeat(100);
    const result = await verifyWebhookRequest({
      request: request({ body: bigBody }),
      maxWebhookBodyBytes: 10,
      webhookVerifier: undefined,
      installations: installations(installation()),
      logger,
    });

    expect(result).toMatchObject({ ok: false, status: 413 });
  });

  it('a request without a token is rejected with 401', async () => {
    const logger = createMockLogger();
    const result = await verifyWebhookRequest({
      request: request({ token: null }),
      maxWebhookBodyBytes: 1024,
      webhookVerifier: undefined,
      installations: installations(installation()),
      logger,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      body: UNAUTHORIZED_BODY,
      reason: 'missing_token',
    });
  });

  it('an unknown host gets the same 401 body as a wrong token', async () => {
    const logger = createMockLogger();

    const unknownHostResult = await verifyWebhookRequest({
      request: request({ host: 'nope.backlog.com' }),
      maxWebhookBodyBytes: 1024,
      webhookVerifier: undefined,
      installations: installations(installation()),
      logger,
    });
    const wrongTokenResult = await verifyWebhookRequest({
      request: request({ token: 'wrong-token' }),
      maxWebhookBodyBytes: 1024,
      webhookVerifier: undefined,
      installations: installations(installation()),
      logger,
    });

    expect(unknownHostResult).toMatchObject({ ok: false, status: 401 });
    expect(wrongTokenResult).toMatchObject({ ok: false, status: 401 });
    expect(!unknownHostResult.ok && unknownHostResult.body).toBe(
      UNAUTHORIZED_BODY
    );
    expect(!wrongTokenResult.ok && wrongTokenResult.body).toBe(
      UNAUTHORIZED_BODY
    );
    expect(!unknownHostResult.ok && unknownHostResult.body).toBe(
      !wrongTokenResult.ok && wrongTokenResult.body
    );
  });

  it('with one installation the host parameter is optional', async () => {
    const logger = createMockLogger();
    const result = await verifyWebhookRequest({
      request: request({ host: null }),
      maxWebhookBodyBytes: 1024,
      webhookVerifier: undefined,
      installations: installations(installation()),
      logger,
    });

    expect(result).toMatchObject({ ok: true, host: HOST });
  });

  it('with two installations a missing host is rejected', async () => {
    const logger = createMockLogger();
    const result = await verifyWebhookRequest({
      request: request({ host: null }),
      maxWebhookBodyBytes: 1024,
      webhookVerifier: undefined,
      installations: installations(
        installation(),
        installation({ host: OTHER_HOST, botUserId: 998 })
      ),
      logger,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      body: UNAUTHORIZED_BODY,
      reason: 'missing_host',
    });
  });

  it('with two installations an explicit host resolves to that installation', async () => {
    const logger = createMockLogger();
    const result = await verifyWebhookRequest({
      request: request({ host: OTHER_HOST, token: 'other-secret' }),
      maxWebhookBodyBytes: 1024,
      webhookVerifier: undefined,
      installations: installations(
        installation(),
        installation({
          host: OTHER_HOST,
          botUserId: 998,
          webhookSecret: 'other-secret',
        })
      ),
      logger,
    });

    expect(result).toMatchObject({ ok: true, host: OTHER_HOST });
  });

  it('the host parameter is lowercased before lookup', async () => {
    const logger = createMockLogger();
    const result = await verifyWebhookRequest({
      request: request({ host: HOST.toUpperCase() }),
      maxWebhookBodyBytes: 1024,
      webhookVerifier: undefined,
      installations: installations(installation()),
      logger,
    });

    expect(result).toMatchObject({ ok: true, host: HOST });
  });

  it('a verifier that returns false rejects even with a valid token', async () => {
    const logger = createMockLogger();
    const verifier = vi.fn().mockReturnValue(false);
    const result = await verifyWebhookRequest({
      request: request(),
      maxWebhookBodyBytes: 1024,
      webhookVerifier: verifier,
      installations: installations(installation()),
      logger,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 401,
      body: UNAUTHORIZED_BODY,
      reason: 'verifier',
    });
    expect(verifier).toHaveBeenCalledWith(expect.any(Request), '{"type":3}');
  });

  it('a verifier that throws rejects with 401 and logs the error message, not the body', async () => {
    const logger = createMockLogger();
    const verifier = vi.fn().mockImplementation(() => {
      throw new Error('verifier exploded');
    });
    const result = await verifyWebhookRequest({
      request: request(),
      maxWebhookBodyBytes: 1024,
      webhookVerifier: verifier,
      installations: installations(installation()),
      logger,
    });

    expect(result).toMatchObject({ ok: false, status: 401 });
    expect(logger.error).toHaveBeenCalledWith('verifier exploded');
  });

  it('a verifier wins even when no webhookSecret is configured on the installation', async () => {
    const logger = createMockLogger();
    const verifier = vi.fn().mockReturnValue(true);
    const noSecretInstallation = installation();
    delete (noSecretInstallation as { webhookSecret?: string }).webhookSecret;

    const result = await verifyWebhookRequest({
      request: request({ token: null }),
      maxWebhookBodyBytes: 1024,
      webhookVerifier: verifier,
      installations: installations(noSecretInstallation),
      logger,
    });

    expect(result).toMatchObject({ ok: true, host: HOST });
  });

  it('a verifier check runs before host resolution so an unknown host never gets a distinct response', async () => {
    const logger = createMockLogger();
    const verifier = vi.fn().mockReturnValue(false);
    const result = await verifyWebhookRequest({
      request: request({ host: 'unknown.backlog.com' }),
      maxWebhookBodyBytes: 1024,
      webhookVerifier: verifier,
      installations: installations(installation()),
      logger,
    });

    // The verifier ran (and failed) before host resolution would have been
    // reached; asserting the reason is "verifier" proves step 3 ran first.
    expect(result).toMatchObject({ ok: false, reason: 'verifier' });
    expect(verifier).toHaveBeenCalled();
  });
});
