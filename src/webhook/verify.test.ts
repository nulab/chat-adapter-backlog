import { createMockLogger } from '@chat-adapter/tests';
import { describe, expect, it, vi } from 'vite-plus/test';

import { verifyWebhookRequest } from './verify';

import type { BacklogWebhookVerifier } from '../types';

const SECRET = 's3cret-path-token';
const BODY = '{"type":3}';

function request(options: { token?: string | null } = {}): Request {
  const url = new URL('https://app.example.com/api/webhooks/backlog');
  if (options.token !== null) {
    url.searchParams.set('token', options.token ?? SECRET);
  }
  return new Request(url, { method: 'POST', body: BODY });
}

function verify(
  req: Request,
  webhookSecret: string | undefined = SECRET,
  webhookVerifier?: BacklogWebhookVerifier
) {
  return verifyWebhookRequest({
    request: req,
    webhookVerifier,
    webhookSecret,
    logger: createMockLogger(),
  });
}

describe('verifyWebhookRequest with the path secret', () => {
  it('accepts the configured token and hands back the body', async () => {
    expect(await verify(request())).toBe(BODY);
  });

  it.each([
    ['a missing token', request({ token: null })],
    ['a wrong token', request({ token: 'wrong-token' })],
    ['a token of another length', request({ token: `${SECRET}x` })],
  ])('rejects %s without reading the body', async (_case, req) => {
    expect(await verify(req)).toBeUndefined();
    expect(req.bodyUsed).toBe(false);
  });
});

describe('verifyWebhookRequest with a webhookVerifier', () => {
  it('hands the verifier the request and the raw body', async () => {
    const verifier = vi.fn().mockReturnValue(true);
    await verify(request(), SECRET, verifier);
    expect(verifier).toHaveBeenCalledWith(expect.any(Request), BODY);
  });

  it.each([
    ['true', true],
    ['a string', 'matched-header'],
    ['an object', { subject: 'proxy' }],
  ])('accepts a verifier that resolves %s', async (_case, value) => {
    expect(await verify(request(), SECRET, async () => value)).toBe(BODY);
  });

  it.each([
    ['false', false],
    ['undefined', undefined],
    ['an empty string', ''],
    ['zero', 0],
  ])('rejects a verifier that returns %s', async (_case, value) => {
    expect(await verify(request(), SECRET, () => value)).toBeUndefined();
  });

  it('rejects a verifier that throws, logging the error and not the body', async () => {
    const logger = createMockLogger();
    const verified = await verifyWebhookRequest({
      request: request(),
      webhookVerifier: () => {
        throw new Error('proxy assertion missing');
      },
      webhookSecret: SECRET,
      logger,
    });
    expect(verified).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith('webhook verifier threw', {
      error: 'proxy assertion missing',
    });
  });

  it('replaces the path secret, so no token and no configured secret are needed', async () => {
    expect(await verify(request({ token: null }), undefined, () => true)).toBe(
      BODY
    );
  });
});
