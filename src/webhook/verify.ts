import { timingSafeEqual } from 'node:crypto';

import type { BacklogWebhookVerifier, ResolvedInstallation } from '../types';
import type { Logger } from 'chat';

export interface VerifyWebhookRequestInput {
  request: Request;
  webhookVerifier: BacklogWebhookVerifier | undefined;
  installations: Map<string, ResolvedInstallation>;
  logger: Logger;
}

/**
 * The authenticated host and body, or `undefined` for every cause of a 401 —
 * one answer, so a caller cannot tell a wrong secret from an unknown host
 * (D2).
 *
 * Without a verifier the token is compared before the body is read, so an
 * unauthenticated caller never makes the process buffer a body.
 */
export async function verifyWebhookRequest(
  input: VerifyWebhookRequestInput
): Promise<{ host: string; rawBody: string } | undefined> {
  const { request, webhookVerifier, installations, logger } = input;
  const url = new URL(request.url);

  if (webhookVerifier === undefined) {
    const host = hostOf(url, installations);
    const expected =
      host === undefined ? undefined : installations.get(host)?.webhookSecret;
    const token = url.searchParams.get('token');
    if (
      host === undefined ||
      expected === undefined ||
      token === null ||
      !tokenMatches(token, expected)
    ) {
      return undefined;
    }
    return { host, rawBody: await request.text() };
  }

  const rawBody = await request.text();
  let verified: unknown;
  try {
    verified = await webhookVerifier(request, rawBody);
  } catch (cause) {
    logger.error('webhook verifier threw', {
      error: cause instanceof Error ? cause.message : String(cause),
    });
    return undefined;
  }
  // Truthiness, not `=== true`: the verifier may hand back whatever its own
  // check produced.
  if (!verified) {
    return undefined;
  }
  const host = hostOf(url, installations);
  return host === undefined ? undefined : { host, rawBody };
}

function hostOf(
  url: URL,
  installations: Map<string, ResolvedInstallation>
): string | undefined {
  const param = url.searchParams.get('host');
  if (param !== null) {
    const host = param.toLowerCase();
    return installations.has(host) ? host : undefined;
  }
  // The parameter may be left out only when it is unambiguous (D3).
  return installations.size === 1
    ? installations.keys().next().value
    : undefined;
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
