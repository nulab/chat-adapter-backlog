import {
  AdapterError,
  AdapterRateLimitError,
  AuthenticationError,
  NetworkError,
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from '@chat-adapter/shared';
import { describe, expect, it } from 'vitest';

import {
  mapBacklogError,
  mapCredentialResolverError,
  mapTransportError,
  stripQueryString,
} from './errors';

describe('mapBacklogError', () => {
  it.each([
    [11, AuthenticationError],
    [4, PermissionError],
    [5, PermissionError],
    [6, ResourceNotFoundError],
    [7, ValidationError],
    [10, ValidationError],
  ])('maps error code %d to %s', (code, expectedClass) => {
    const error = mapBacklogError({
      status: 400,
      bodyError: { message: 'failed', code },
    });
    expect(error).toBeInstanceOf(expectedClass);
  });

  it('maps error code 13 to AdapterRateLimitError', () => {
    const error = mapBacklogError({
      status: 429,
      bodyError: { message: 'failed', code: 13 },
      retryAfterSeconds: 30,
    });
    expect(error).toBeInstanceOf(AdapterRateLimitError);
    expect((error as AdapterRateLimitError).retryAfter).toBe(30);
  });

  it.each([1, 2, 3, 8, 9, 12])(
    'maps error code %d to a generic AdapterError carrying the code',
    (code) => {
      const error = mapBacklogError({
        status: 500,
        bodyError: { message: 'failed', code },
      });
      expect(error).toBeInstanceOf(AdapterError);
      expect(error.code).toBe(String(code));
    }
  );

  it('error code 6 maps to ResourceNotFoundError even on a 400 status', () => {
    const error = mapBacklogError({
      status: 400,
      bodyError: { message: 'No such issue', code: 6 },
    });
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  it("keeps Backlog's own message on a code 6, whose class composes its own message", () => {
    const error = mapBacklogError({
      status: 404,
      bodyError: { message: 'No such issue', code: 6 },
    });

    expect(error.message).toContain('No such issue');
  });

  it("keeps Backlog's own message on a code 13, whose class takes only the retry delay", () => {
    const error = mapBacklogError({
      status: 429,
      bodyError: { message: 'Too many requests.', code: 13 },
      retryAfterSeconds: 30,
    });

    expect(error.message).toContain('Too many requests.');
  });

  it('does not repeat the message on a class that was constructed with it', () => {
    const error = mapBacklogError({
      status: 400,
      bodyError: { message: 'Invalid request', code: 7 },
    });

    expect(error.message.split('Invalid request')).toHaveLength(2);
  });

  it('leaves the message alone when the body carried none to keep', () => {
    const error = mapBacklogError({ status: 404 });

    expect(error.message).not.toContain('Backlog API request failed');
  });

  it.each([
    [401, AuthenticationError],
    [403, PermissionError],
    [404, ResourceNotFoundError],
    [400, ValidationError],
  ])(
    'falls back to HTTP status %d when the body carries no code',
    (status, expectedClass) => {
      const error = mapBacklogError({ status });
      expect(error).toBeInstanceOf(expectedClass);
    }
  );

  it('maps status 429 without a code to AdapterRateLimitError', () => {
    const error = mapBacklogError({ status: 429, retryAfterSeconds: 12 });
    expect(error).toBeInstanceOf(AdapterRateLimitError);
    expect((error as AdapterRateLimitError).retryAfter).toBe(12);
  });

  it('maps an unrecognised status to a generic AdapterError carrying the status', () => {
    const error = mapBacklogError({ status: 500 });
    expect(error).toBeInstanceOf(AdapterError);
    expect(error.code).toBe('500');
  });

  it('sets error.cause to a plain BacklogApiErrorDetail, never the backlog-js error', () => {
    const error = mapBacklogError({
      status: 400,
      bodyError: {
        message: 'No such issue',
        code: 6,
        moreInfo: 'https://example.com/more',
      },
      url: 'https://example.backlog.com/api/v2/issues/1',
    });

    expect(error.cause).toEqual({
      status: 400,
      code: 6,
      message: 'No such issue',
      moreInfo: 'https://example.com/more',
      url: 'https://example.backlog.com/api/v2/issues/1',
    });
  });

  it('strips the query string from cause.url', () => {
    const error = mapBacklogError({
      status: 401,
      url: stripQueryString(
        'https://example.backlog.com/api/v2/issues?apiKey=secret'
      ),
    });
    expect((error.cause as { url: string }).url).toBe(
      'https://example.backlog.com/api/v2/issues'
    );
  });
});

describe('mapTransportError', () => {
  it('maps a fetch rejection to NetworkError', () => {
    const error = mapTransportError(new TypeError('fetch failed'));
    expect(error).toBeInstanceOf(NetworkError);
  });

  it('maps a non-Error rejection to NetworkError without throwing', () => {
    const error = mapTransportError('DNS lookup failed');
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.message).toContain('DNS lookup failed');
  });
});

describe('mapCredentialResolverError', () => {
  it('maps a rejecting resolver to AuthenticationError', () => {
    const error = mapCredentialResolverError(new Error('vault unavailable'));
    expect(error).toBeInstanceOf(AuthenticationError);
  });
});

describe('stripQueryString', () => {
  it('removes everything from the first ? onward', () => {
    expect(
      stripQueryString(
        'https://example.backlog.com/api/v2/issues?apiKey=secret&count=10'
      )
    ).toBe('https://example.backlog.com/api/v2/issues');
  });

  it('returns a URL with no query string unchanged', () => {
    expect(
      stripQueryString('https://example.backlog.com/api/v2/issues/8001')
    ).toBe('https://example.backlog.com/api/v2/issues/8001');
  });
});
