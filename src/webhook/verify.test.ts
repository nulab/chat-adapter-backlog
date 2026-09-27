import { createMockLogger } from '@chat-adapter/tests';
import { describe, expect, it, vi } from 'vitest';

import { verifyWebhookRequest } from './verify';

import type { BacklogWebhookVerifier, ResolvedInstallation } from '../types';

const HOST = 'example.backlog.com';
const OTHER_HOST = 'other.backlog.jp';
const SECRET = 's3cret-path-token';
const BODY = '{"type":3}';

function installation(
  host = HOST,
  webhookSecret?: string
): ResolvedInstallation {
  return {
    host,
    apiKey: 'key',
    ...(webhookSecret === undefined ? {} : { webhookSecret }),
  };
}

function request(
  options: { host?: string | null; token?: string | null } = {}
): Request {
  const url = new URL('https://app.example.com/api/webhooks/backlog');
  if (options.host !== null) {
    url.searchParams.set('host', options.host ?? HOST);
  }
  if (options.token !== null) {
    url.searchParams.set('token', options.token ?? SECRET);
  }
  return new Request(url, { method: 'POST', body: BODY });
}

function verify(
  req: Request,
  installations: ResolvedInstallation[] = [installation(HOST, SECRET)],
  webhookVerifier?: BacklogWebhookVerifier
) {
  return verifyWebhookRequest({
    request: req,
    webhookVerifier,
    installations: new Map(installations.map((entry) => [entry.host, entry])),
    logger: createMockLogger(),
  });
}

describe('verifyWebhookRequest with the path secret', () => {
  it('accepts the configured token and hands back the host and body', async () => {
    expect(await verify(request())).toEqual({ host: HOST, rawBody: BODY });
  });

  it.each([
    ['a missing token', request({ token: null })],
    ['a wrong token', request({ token: 'wrong-token' })],
    ['a token of another length', request({ token: `${SECRET}x` })],
    ['an unknown host', request({ host: 'nope.backlog.com' })],
  ])('rejects %s without reading the body', async (_case, req) => {
    expect(await verify(req)).toBeUndefined();
    expect(req.bodyUsed).toBe(false);
  });

  it('lets the host parameter be left out when one installation is configured', async () => {
    expect(await verify(request({ host: null }))).toEqual({
      host: HOST,
      rawBody: BODY,
    });
  });

  it('rejects a missing host parameter when several installations are configured', async () => {
    const both = [installation(HOST, SECRET), installation(OTHER_HOST, SECRET)];
    expect(await verify(request({ host: null }), both)).toBeUndefined();
  });

  it('compares the token against the secret of the host the request names', async () => {
    const both = [
      installation(HOST, SECRET),
      installation(OTHER_HOST, 'other-host-secret-value'),
    ];
    expect(await verify(request({ host: OTHER_HOST }), both)).toBeUndefined();
    expect(
      await verify(
        request({ host: OTHER_HOST, token: 'other-host-secret-value' }),
        both
      )
    ).toEqual({ host: OTHER_HOST, rawBody: BODY });
  });

  it('matches the host parameter case-insensitively', async () => {
    expect(await verify(request({ host: 'EXAMPLE.Backlog.com' }))).toEqual({
      host: HOST,
      rawBody: BODY,
    });
  });
});

describe('verifyWebhookRequest with a webhookVerifier', () => {
  it('hands the verifier the request and the raw body', async () => {
    const verifier = vi.fn().mockReturnValue(true);
    await verify(request(), undefined, verifier);
    expect(verifier).toHaveBeenCalledWith(expect.any(Request), BODY);
  });

  it.each([
    ['true', true],
    ['a string', 'matched-header'],
    ['an object', { subject: 'proxy' }],
  ])('accepts a verifier that resolves %s', async (_case, value) => {
    const verified = await verify(request(), undefined, async () => value);
    expect(verified).toEqual({ host: HOST, rawBody: BODY });
  });

  it.each([
    ['false', false],
    ['undefined', undefined],
    ['an empty string', ''],
    ['zero', 0],
  ])('rejects a verifier that returns %s', async (_case, value) => {
    expect(await verify(request(), undefined, () => value)).toBeUndefined();
  });

  it('rejects a verifier that throws, logging the error and not the body', async () => {
    const logger = createMockLogger();
    const verified = await verifyWebhookRequest({
      request: request(),
      webhookVerifier: () => {
        throw new Error('proxy assertion missing');
      },
      installations: new Map([[HOST, installation(HOST, SECRET)]]),
      logger,
    });
    expect(verified).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('webhook verifier threw', {
      error: 'proxy assertion missing',
    });
  });

  it('replaces the path secret, so no token and no configured secret are needed', async () => {
    const verified = await verify(
      request({ token: null }),
      [installation(HOST)],
      () => true
    );
    expect(verified).toEqual({ host: HOST, rawBody: BODY });
  });

  it('still rejects a host that is not configured', async () => {
    expect(
      await verify(request({ host: 'nope.backlog.com' }), undefined, () => true)
    ).toBeUndefined();
  });
});
