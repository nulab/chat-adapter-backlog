import {
  AdapterError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from '@chat-adapter/shared';

import { rateLimitError } from './rate-limit.js';

import type { BacklogApiErrorDetail } from './port.js';

/** One entry of a Backlog error body, per https://developer.nulab.com/docs/backlog/error-response/. */
export interface BacklogErrorBodyEntry {
  message: string;
  code: number;
  moreInfo?: string;
}

export interface MapBacklogErrorInput {
  status?: number;
  /** The first entry of `errors[]`, when the body parsed as the documented envelope. */
  bodyError?: BacklogErrorBodyEntry;
  /** The request URL with its query string already stripped. */
  url?: string;
  /** Seconds to report on a rate-limit error that gives up without retrying. */
  retryAfterSeconds?: number;
  /** Names the resource a 404 (code 6 or status 404) is reported against. */
  resourceType?: string;
  resourceId?: string;
}

/**
 * Maps a Backlog API failure to a `@chat-adapter/shared` error class.
 * Precedence is `errors[0].code`, then HTTP status, then transport
 * (docs/specs/adapter.md §8.5) — the code is more specific than the status
 * because Backlog reuses one HTTP status for several codes (e.g. 400 covers
 * both InvalidRequestError and NoResourceError).
 *
 * `error.cause` is set to a plain `BacklogApiErrorDetail` on every mapped
 * error instead of the `backlog-js` error instance, so nothing
 * `backlog-js`-shaped or secret-bearing (the request carries credentials)
 * escapes the port.
 */
export function mapBacklogError(input: MapBacklogErrorInput): AdapterError {
  const {
    status,
    bodyError,
    url,
    retryAfterSeconds,
    resourceType,
    resourceId,
  } = input;
  const message =
    bodyError?.message ??
    `Backlog API request failed${status === undefined ? '' : ` with status ${status}`}`;

  const detail: BacklogApiErrorDetail = {
    message,
    ...(status !== undefined && { status }),
    ...(bodyError !== undefined && { code: bodyError.code }),
    ...(bodyError?.moreInfo !== undefined && { moreInfo: bodyError.moreInfo }),
    ...(url !== undefined && { url }),
  };

  const error = mapByCodeOrStatus(
    bodyError?.code,
    status,
    message,
    retryAfterSeconds,
    resourceType,
    resourceId
  );
  error.cause = detail;
  return withBacklogMessage(error, bodyError?.message);
}

/**
 * Appends what Backlog said to an error whose class composed its own message.
 *
 * Two of the classes take no message at all —
 * `ResourceNotFoundError(adapter, resourceType, resourceId?)` and
 * `AdapterRateLimitError(adapter, retryAfterSeconds?)` — so a code 6's "No
 * such issue" reached the caller only on `cause`, invisible to every log line
 * and test assertion that prints the error. Appending rather than replacing
 * keeps the class's own wording, which is what a caller matching on it reads,
 * and the containment check leaves the classes that were already constructed
 * with the message untouched.
 */
function withBacklogMessage<E extends AdapterError>(
  error: E,
  message: string | undefined
): E {
  if (message === undefined || error.message.includes(message)) {
    return error;
  }
  error.message = `${error.message}: ${message}`;
  return error;
}

function mapByCodeOrStatus(
  code: number | undefined,
  status: number | undefined,
  message: string,
  retryAfterSeconds: number | undefined,
  resourceType: string | undefined,
  resourceId: string | undefined
): AdapterError {
  switch (code) {
    case 11:
      return new AuthenticationError('backlog', message);
    case 4:
    case 5:
      return new PermissionError('backlog', message);
    case 6:
      return new ResourceNotFoundError(
        'backlog',
        resourceType ?? 'resource',
        resourceId
      );
    case 7:
      return new ValidationError('backlog', message);
    case 10:
      return new ValidationError('backlog', message);
    case 13:
      return rateLimitError(retryAfterSeconds ?? 0);
    case 1:
    case 2:
    case 3:
    case 8:
    case 9:
    case 12:
      return new AdapterError(message, 'backlog', String(code));
    default:
      return mapByStatus(
        status,
        message,
        retryAfterSeconds,
        resourceType,
        resourceId
      );
  }
}

function mapByStatus(
  status: number | undefined,
  message: string,
  retryAfterSeconds: number | undefined,
  resourceType: string | undefined,
  resourceId: string | undefined
): AdapterError {
  switch (status) {
    case 401:
      return new AuthenticationError('backlog', message);
    case 403:
      return new PermissionError('backlog', message);
    case 404:
      return new ResourceNotFoundError(
        'backlog',
        resourceType ?? 'resource',
        resourceId
      );
    case 400:
      return new ValidationError('backlog', message);
    case 429:
      return rateLimitError(retryAfterSeconds ?? 0);
    default:
      return new AdapterError(
        message,
        'backlog',
        status === undefined ? undefined : String(status)
      );
  }
}

/** Maps a transport-level failure (fetch rejection, abort, DNS failure). */
export function mapTransportError(cause: unknown): NetworkError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new NetworkError(
    'backlog',
    message,
    cause instanceof Error ? cause : undefined
  );
}

/**
 * Maps a credential the resolver did not produce usably
 * (docs/specs/adapter.md §8.5): the resolver rejected, or it returned a value
 * `backlog-js` refuses at construction. Both are `AuthenticationError` rather
 * than `NetworkError`, because neither is a request that failed — no request
 * was made — and neither becomes true on a retry.
 */
export function mapCredentialResolverError(
  cause: unknown
): AuthenticationError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new AuthenticationError('backlog', message);
}

/**
 * Maps a response body that failed zod validation. Never a `ZodError`
 * (docs/specs/adapter.md §8.1, §8.5): a schema mismatch names the endpoint
 * and the failing path so a caller can act on it without importing zod.
 */
export function mapSchemaError(endpoint: string, issues: string): AdapterError {
  return new AdapterError(
    `Backlog response for ${endpoint} failed schema validation: ${issues}`,
    'backlog',
    'SCHEMA'
  );
}

/** Strips the query string from a URL, per docs/specs/adapter.md §8.5 (never leak a secret in `apiKey=`). */
export function stripQueryString(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}
