import { timingSafeEqual } from 'node:crypto';

import { errorMessage } from '../client/errors';

import type { BacklogWebhookVerifier } from '../types';
import type { Logger } from 'chat';

export interface VerifyWebhookRequestInput {
  request: Request;
  webhookVerifier: BacklogWebhookVerifier | undefined;
  webhookSecret: string | undefined;
  logger: Logger;
}

/**
 * The body, or `undefined` for every cause of a 401 (D2).
 *
 * Without a verifier the token is compared before the body is read, so an
 * unauthenticated caller never makes the process buffer a body.
 */
export async function verifyWebhookRequest(
  input: VerifyWebhookRequestInput
): Promise<string | undefined> {
  const { request, webhookVerifier, webhookSecret, logger } = input;

  if (webhookVerifier === undefined) {
    const token = new URL(request.url).searchParams.get('token');
    if (
      webhookSecret === undefined ||
      token === null ||
      !tokenMatches(token, webhookSecret)
    ) {
      return undefined;
    }
    return request.text();
  }

  const rawBody = await request.text();
  let verified: unknown;
  try {
    verified = await webhookVerifier(request, rawBody);
  } catch (cause) {
    logger.error('webhook verifier threw', { error: errorMessage(cause) });
    return undefined;
  }
  // Truthiness, not `=== true`: the verifier may hand back whatever its own
  // check produced.
  return verified ? rawBody : undefined;
}

// `timingSafeEqual` throws on buffers of different lengths.
function tokenMatches(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  return (
    providedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(providedBuffer, expectedBuffer)
  );
}
