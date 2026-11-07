import { Backlog } from 'backlog-js';
import { z } from 'zod';

import {
  mapBacklogError,
  mapCredentialResolverError,
  mapTransportError,
  stripQueryString,
} from './errors';
import { decideRetry } from './rate-limit';

import type { BacklogErrorBodyEntry } from './errors';
import type { RetryDecision } from './rate-limit';
import type { Logger } from 'chat';

type Fetch = typeof globalThis.fetch;

const REQUEST_TIMEOUT_MS = 30_000;

export interface CreateBacklogClientOptions {
  host: string;
  resolveApiKey: () => Promise<string>;
  /**
   * An accessor rather than a `Logger`, because `initialize` replaces the
   * adapter's logger after this client has been built and cached.
   */
  logger: () => Logger;
}

const errorBodySchema = z.object({
  errors: z.tuple(
    [
      z.object({
        message: z.string(),
        code: z.number(),
        moreInfo: z.string().optional(),
      }),
    ],
    z.unknown()
  ),
});

/**
 * The client every Backlog call goes through, the adapter's own and a
 * consumer's through `client()` alike. The credential, the error mapping
 * and the 429 retry live in the injected `fetch` rather than around the
 * adapter's call sites, because it is the one seam every `backlog-js` method
 * funnels through. The client itself is built holding no credential, so it
 * carries no secret when it is handed out.
 */
export function createBacklogClient(
  options: CreateBacklogClientOptions
): Backlog {
  const { host, resolveApiKey, logger } = options;

  async function attemptFetch(
    input: Parameters<Fetch>[0],
    init: Parameters<Fetch>[1],
    attempt: number
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    await applyApiKey(headers);

    let response: Response;
    try {
      // The signal also bounds reading the body, which happens after this
      // function returns: a proxy can answer the headers and then stall.
      response = await fetch(input, {
        ...init,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw mapTransportError(cause);
    }
    if (response.ok) {
      return response;
    }

    const url = stripQueryString(
      input instanceof Request ? input.url : String(input)
    );
    const bodyError = await readBodyError(response);
    if (response.status === 429 || bodyError?.code === 13) {
      const decision = decideRetry(
        attempt,
        response.headers.get('X-RateLimit-Reset'),
        Date.now()
      );
      if (decision.shouldRetry) {
        logRateLimit(
          'rate limited; waiting for the limit to reset',
          response.headers,
          decision,
          attempt
        );
        await new Promise((resolve) => setTimeout(resolve, decision.waitMs));
        return attemptFetch(input, init, attempt + 1);
      }
      logRateLimit(
        'rate limited; not retrying',
        response.headers,
        decision,
        attempt
      );
      throw mapBacklogError({
        status: response.status,
        url,
        retryAfterSeconds: decision.retryAfterSeconds,
        ...(bodyError !== undefined && { bodyError }),
      });
    }
    throw mapBacklogError({
      status: response.status,
      url,
      ...(bodyError !== undefined && { bodyError }),
    });
  }

  /**
   * Resolved again on every attempt and never memoised, so a key
   * rotated between calls is picked up. `backlog-js` would reject a CR/LF
   * credential at construction, but this client is built without one, so
   * `Headers` is what refuses it here.
   */
  async function applyApiKey(headers: Headers): Promise<void> {
    try {
      headers.set('Backlog-API-Key', await resolveApiKey());
    } catch (cause) {
      throw mapCredentialResolverError(cause);
    }
  }

  /**
   * Only the two moments an operator acts on are logged: a `remaining` line
   * per request would be one entry per call against a per-minute limit.
   */
  function logRateLimit(
    message: string,
    headers: Headers,
    decision: RetryDecision,
    attempt: number
  ): void {
    const remaining = Number(headers.get('X-RateLimit-Remaining') ?? NaN);
    logger().warn(message, {
      ...(Number.isFinite(remaining) && { remaining }),
      ...(decision.resetAt !== undefined && {
        resetAt: decision.resetAt.toISOString(),
      }),
      waitMs: decision.waitMs,
      attempt: attempt + 1,
    });
  }

  return new Backlog({
    host,
    fetch: (input, init) => attemptFetch(input, init, 0),
  });
}

/**
 * `undefined` when the body is not the documented envelope: a 502 from in
 * front of Backlog is HTML, and losing the status to a parse failure would
 * be the worse outcome.
 */
async function readBodyError(
  response: Response
): Promise<BacklogErrorBodyEntry | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  const parsed = errorBodySchema.safeParse(body);
  if (!parsed.success) {
    return undefined;
  }
  const [{ message, code, moreInfo }] = parsed.data.errors;
  return { message, code, ...(moreInfo !== undefined && { moreInfo }) };
}
