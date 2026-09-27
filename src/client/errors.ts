import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from '@chat-adapter/shared';

/**
 * The shape carried on `error.cause` for every mapped error. `url` never
 * carries a query string.
 */
export interface BacklogApiErrorDetail {
  status?: number;
  code?: number;
  message: string;
  moreInfo?: string;
  url?: string;
}

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
}

/**
 * `errors[0].code` wins over the HTTP status because Backlog reuses one
 * status for several codes (400 covers both InvalidRequestError and
 * NoResourceError). `cause` is a plain object rather than the request or a
 * `backlog-js` error, either of which could carry the credential.
 */
export function mapBacklogError(input: MapBacklogErrorInput): AdapterError {
  const { status, bodyError, url, retryAfterSeconds } = input;
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
    retryAfterSeconds
  );
  error.cause = detail;
  return withBacklogMessage(error, bodyError?.message);
}

/**
 * `ResourceNotFoundError` and `AdapterRateLimitError` take no message, so
 * without this a code 6's "No such issue" would reach the caller only on
 * `cause`, invisible to every log line that prints the error. Appending
 * rather than replacing keeps the class's own wording, which is what a caller
 * matching on it reads.
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
  retryAfterSeconds: number | undefined
): AdapterError {
  switch (code) {
    case 11:
      return new AuthenticationError('backlog', message);
    case 4:
    case 5:
      return new PermissionError('backlog', message);
    case 6:
      return new ResourceNotFoundError('backlog', 'resource');
    case 7:
    case 10:
      return new ValidationError('backlog', message);
    case 13:
      return new AdapterRateLimitError('backlog', retryAfterSeconds ?? 0);
    case 1:
    case 2:
    case 3:
    case 8:
    case 9:
    case 12:
      return new AdapterError(message, 'backlog', String(code));
    default:
      return mapByStatus(status, message, retryAfterSeconds);
  }
}

function mapByStatus(
  status: number | undefined,
  message: string,
  retryAfterSeconds: number | undefined
): AdapterError {
  switch (status) {
    case 401:
      return new AuthenticationError('backlog', message);
    case 403:
      return new PermissionError('backlog', message);
    case 404:
      return new ResourceNotFoundError('backlog', 'resource');
    case 400:
      return new ValidationError('backlog', message);
    case 429:
      return new AdapterRateLimitError('backlog', retryAfterSeconds ?? 0);
    default:
      return new AdapterError(
        message,
        'backlog',
        status === undefined ? undefined : String(status)
      );
  }
}

export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function mapTransportError(cause: unknown): NetworkError {
  return new NetworkError(
    'backlog',
    errorMessage(cause),
    cause instanceof Error ? cause : undefined
  );
}

/** An `AdapterError` the injected `fetch` already mapped passes through unchanged. */
export function asAdapterError(cause: unknown): AdapterError {
  return cause instanceof AdapterError ? cause : mapTransportError(cause);
}

/**
 * A resolver that rejected, or resolved a value the header refuses (CR/LF),
 * is an `AuthenticationError` rather than a `NetworkError`: no request was
 * made, and a retry would not make one succeed.
 */
export function mapCredentialResolverError(
  cause: unknown
): AuthenticationError {
  return new AuthenticationError('backlog', errorMessage(cause));
}

/** A query string can carry `apiKey=`, so it never reaches an error. */
export function stripQueryString(url: string): string {
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}
