import { timingSafeEqual } from 'node:crypto';

import type { BacklogWebhookVerifier, ResolvedInstallation } from '../types';
import type { Logger } from 'chat';

/**
 * Every 401 in the response ladder (docs/specs/adapter.md §5.1) returns this
 * exact body, so an unauthenticated caller cannot distinguish "wrong secret"
 * from "unknown host" by response text alone (D2). Assert this constant with
 * string equality across all four causes rather than duplicating the literal.
 */
export const UNAUTHORIZED_BODY = 'Unauthorized';

export type WebhookRejection =
  | { status: 405; body: 'Method not allowed'; reason: 'method' }
  | { status: 400; body: 'Unreadable body'; reason: 'unreadable_body' }
  | { status: 413; body: 'Payload too large'; reason: 'too_large' }
  | { status: 401; body: typeof UNAUTHORIZED_BODY; reason: 'verifier' }
  | {
      status: 401;
      body: typeof UNAUTHORIZED_BODY;
      reason: 'unknown_host' | 'missing_host';
    }
  | {
      status: 401;
      body: typeof UNAUTHORIZED_BODY;
      reason: 'missing_token' | 'token_mismatch';
    };

export type WebhookAccepted = {
  host: string;
  installation: ResolvedInstallation;
  rawBody: string;
};

export type WebhookVerificationResult =
  | ({ ok: true } & WebhookAccepted)
  | ({ ok: false } & WebhookRejection);

function reject<T extends WebhookRejection>(rejection: T): { ok: false } & T {
  return { ok: false, ...rejection };
}

/**
 * Reads the body as text, enforcing `maxWebhookBodyBytes` (docs/specs/adapter.md
 * §5.1 step 2). `Content-Length` is checked before the body is read so an
 * oversized upload never has to be buffered in full; the byte length of the
 * decoded text is checked again afterward because `Content-Length` can be
 * absent (chunked transfer) or lie.
 */
async function readBody(
  request: Request,
  maxWebhookBodyBytes: number,
  logger: Logger
): Promise<
  { ok: true; rawBody: string } | { ok: false; rejection: WebhookRejection }
> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxWebhookBodyBytes) {
      logger.warn('webhook rejected', { reason: 'too_large' });
      return {
        ok: false,
        rejection: {
          status: 413,
          body: 'Payload too large',
          reason: 'too_large',
        },
      };
    }
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    logger.warn('webhook rejected', { reason: 'unreadable_body' });
    return {
      ok: false,
      rejection: {
        status: 400,
        body: 'Unreadable body',
        reason: 'unreadable_body',
      },
    };
  }

  if (Buffer.byteLength(rawBody, 'utf8') > maxWebhookBodyBytes) {
    logger.warn('webhook rejected', { reason: 'too_large' });
    return {
      ok: false,
      rejection: {
        status: 413,
        body: 'Payload too large',
        reason: 'too_large',
      },
    };
  }

  return { ok: true, rawBody };
}

/**
 * Constant-time token comparison. A length check runs first because
 * `timingSafeEqual` throws on mismatched buffer lengths rather than
 * returning `false` — the length check itself leaks only the presence of a
 * length difference, not which byte differs, which is the property the spec
 * requires (docs/specs/adapter.md §5.1 step 5).
 */
function tokenMatches(provided: string, expected: string): boolean {
  const providedBuffer = Buffer.from(provided, 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}

export interface VerifyWebhookRequestInput {
  request: Request;
  maxWebhookBodyBytes: number;
  webhookVerifier: BacklogWebhookVerifier | undefined;
  installations: Map<string, ResolvedInstallation>;
  logger: Logger;
}

type InstallationResolution =
  | { ok: true; host: string; installation: ResolvedInstallation }
  | { ok: false; rejection: WebhookRejection };

/** Response-ladder row 4 (docs/specs/adapter.md §5.1). */
function resolveInstallation(
  url: URL,
  installations: Map<string, ResolvedInstallation>,
  logger: Logger
): InstallationResolution {
  const hostParam = url.searchParams.get('host');
  let host: string;
  if (hostParam !== null) {
    host = hostParam.toLowerCase();
    if (!installations.has(host)) {
      logger.warn('webhook rejected', { reason: 'unknown_host' });
      return {
        ok: false,
        rejection: {
          status: 401,
          body: UNAUTHORIZED_BODY,
          reason: 'unknown_host',
        },
      };
    }
  } else if (installations.size === 1) {
    // D3: the host parameter is optional only when it is unambiguous —
    // exactly one installation configured.
    const [onlyHost] = installations.keys();
    host = onlyHost as string;
  } else {
    logger.warn('webhook rejected', { reason: 'missing_host' });
    return {
      ok: false,
      rejection: {
        status: 401,
        body: UNAUTHORIZED_BODY,
        reason: 'missing_host',
      },
    };
  }

  const installation = installations.get(host);
  if (installation === undefined) {
    // Unreachable: `host` above is either a key already confirmed present in
    // `installations` or the map's only key. Guards `noUncheckedIndexedAccess`
    // rather than asserting past it with a non-null assertion.
    logger.warn('webhook rejected', { reason: 'unknown_host' });
    return {
      ok: false,
      rejection: {
        status: 401,
        body: UNAUTHORIZED_BODY,
        reason: 'unknown_host',
      },
    };
  }

  return { ok: true, host, installation };
}

/**
 * Response-ladder row 5 (docs/specs/adapter.md §5.1), or `undefined` when the
 * request carries the installation's secret.
 */
function checkPathSecret(
  url: URL,
  installation: ResolvedInstallation,
  logger: Logger
): WebhookRejection | undefined {
  const token = url.searchParams.get('token');
  if (token === null) {
    logger.warn('webhook rejected', { reason: 'missing_token' });
    return {
      status: 401,
      body: UNAUTHORIZED_BODY,
      reason: 'missing_token',
    };
  }
  const expected = installation.webhookSecret;
  if (expected === undefined || !tokenMatches(token, expected)) {
    logger.warn('webhook rejected', { reason: 'token_mismatch' });
    return {
      status: 401,
      body: UNAUTHORIZED_BODY,
      reason: 'token_mismatch',
    };
  }
  return undefined;
}

/**
 * Runs response-ladder rows 1–5 (docs/specs/adapter.md §5.1): method, body
 * size, the optional verifier, installation resolution, and — only when no
 * verifier is configured — the path-secret token. Rows 6 onward (JSON
 * parsing, envelope, activity-type gate, schema, initialization, self
 * message) depend on the parsed body and the adapter's `chat`/`botUserId`
 * state, so they run in `handleWebhook` itself.
 *
 * The rows run in two orders, decided by whether a verifier is configured,
 * because only the verifier is given the body:
 *
 * - **With a verifier**: body, verifier, host. Step 3 before step 4 so a
 *   verifier-protected deployment never reveals whether a host is configured,
 *   which is also what `connectWebhookContract` requires — the verifier
 *   receives `(Request, string)` and wins over a configured secret.
 * - **Without one**: host, token, body. Nothing before step 5 needs the body,
 *   so reading it first would let any caller who has found the URL make the
 *   process buffer `maxWebhookBodyBytes` per request, and would answer 413 to
 *   a caller that never proved it knows the secret. Authenticating first
 *   costs an unauthenticated request nothing but its headers.
 *
 * Either way step 4 precedes step 5, because the secret being compared is per
 * installation.
 */
export async function verifyWebhookRequest(
  input: VerifyWebhookRequestInput
): Promise<WebhookVerificationResult> {
  const {
    request,
    maxWebhookBodyBytes,
    webhookVerifier,
    installations,
    logger,
  } = input;

  if (request.method !== 'POST') {
    logger.debug('webhook rejected', { reason: 'method' });
    return reject({
      status: 405,
      body: 'Method not allowed',
      reason: 'method',
    });
  }

  const url = new URL(request.url);

  if (webhookVerifier === undefined) {
    const resolved = resolveInstallation(url, installations, logger);
    if (!resolved.ok) {
      return reject(resolved.rejection);
    }
    const rejection = checkPathSecret(url, resolved.installation, logger);
    if (rejection !== undefined) {
      return reject(rejection);
    }
    const bodyResult = await readBody(request, maxWebhookBodyBytes, logger);
    if (!bodyResult.ok) {
      return reject(bodyResult.rejection);
    }
    return {
      ok: true,
      host: resolved.host,
      installation: resolved.installation,
      rawBody: bodyResult.rawBody,
    };
  }

  const bodyResult = await readBody(request, maxWebhookBodyBytes, logger);
  if (!bodyResult.ok) {
    return reject(bodyResult.rejection);
  }
  const { rawBody } = bodyResult;

  let verified: unknown;
  try {
    verified = await webhookVerifier(request, rawBody);
  } catch (cause) {
    logger.warn('webhook rejected', { reason: 'verifier' });
    logger.error(
      cause instanceof Error ? cause.message : 'webhook verifier threw'
    );
    return reject({
      status: 401,
      body: UNAUTHORIZED_BODY,
      reason: 'verifier',
    });
  }
  // Truthiness, not `=== true`: the verifier is typed to return `unknown`
  // (§3.2) so a deployment can hand back whatever its own check produces —
  // a matched header string, a resolved assertion object. `undefined`, the
  // return of a function that forgot to return at all, is falsy and so
  // rejects, which is the safe direction.
  if (!verified) {
    logger.warn('webhook rejected', { reason: 'verifier' });
    return reject({
      status: 401,
      body: UNAUTHORIZED_BODY,
      reason: 'verifier',
    });
  }

  const resolved = resolveInstallation(url, installations, logger);
  if (!resolved.ok) {
    return reject(resolved.rejection);
  }

  return {
    ok: true,
    host: resolved.host,
    installation: resolved.installation,
    rawBody,
  };
}
