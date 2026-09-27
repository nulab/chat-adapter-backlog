import { ValidationError } from '@chat-adapter/shared';

import type {
  BacklogChannelId,
  BacklogMessageId,
  BacklogSubjectRef,
  BacklogThreadId,
  BacklogUserId,
} from './types';

const HOST_PATTERN = /^[a-z0-9.-]+$/;
const POSINT_PATTERN = /^[1-9]\d*$/;

function fail(message: string): never {
  throw new ValidationError('backlog', message);
}

/**
 * Backlog host, e.g. `example.backlog.com`, `example.backlog.jp` or
 * `example.backlogtool.com`. Backlog spaces live on several top-level
 * domains, so the host is carried verbatim rather than templated around a
 * fixed suffix (docs/specs/adapter.md §2, CLAUDE.md "Host").
 *
 * `HOST_PATTERN` is the only declaration of the host grammar in the package;
 * {@link validateHost} is the config path's entry point to it. A configured
 * installation's host and an id's host are the same string, so a second copy
 * of the pattern beside the constructor could accept a host every id built
 * from it is then rejected for.
 */
function assertValidHost(host: string): void {
  if (host.length === 0 || !HOST_PATTERN.test(host)) {
    fail(`"${host}" is not a valid Backlog host`);
  }
}

/**
 * The same grammar for a host that has not been through an id yet: config
 * accepts `Example.Backlog.com` and stores it lowercased, while an id carries
 * only the lowercased form (docs/specs/adapter.md §2.1, §3.2). The raw value
 * is checked for a scheme, path, port and whitespace **before** lowercasing,
 * so a rejection message shows what the caller passed rather than a silently
 * transformed value.
 */
export function validateHost(host: string, label: string): string {
  if (host.trim() !== host || /\s/.test(host)) {
    fail(`${label} must not contain whitespace`);
  }
  if (host.includes('://')) {
    fail(`${label} must not include a scheme`);
  }
  if (host.includes('/')) {
    fail(`${label} must not include a path`);
  }
  const lowered = host.toLowerCase();
  if (lowered.includes(':')) {
    fail(`${label} must not include a port`);
  }
  if (lowered.length === 0 || !HOST_PATTERN.test(lowered)) {
    fail(`${label} is not a valid Backlog host`);
  }
  return lowered;
}

/**
 * A `posint` segment as a number (docs/specs/adapter.md §2.1). Digits beyond
 * `Number.MAX_SAFE_INTEGER` are rejected rather than read: `Number` is lossy
 * there, so `issue:99999999999999999999` would decode to `1e20` and re-encode
 * as `issue:1e+20` — a round trip that quietly addresses something other than
 * what it was given.
 */
function decodePosint(segment: string, label: string): number {
  if (!POSINT_PATTERN.test(segment)) {
    fail(`"${segment}" is not a valid ${label}`);
  }
  const value = Number(segment);
  if (!Number.isSafeInteger(value)) {
    // No article before `${label}`: the labels are "issue id", "user id",
    // "project id" and "pull request number", so one hard-coded "a" reads
    // wrong on half of them.
    fail(
      `"${segment}" exceeds the largest ${label} an id can carry, ${Number.MAX_SAFE_INTEGER}`
    );
  }
  return value;
}

/**
 * The encoders' half of the same rule. An id is assembled from numbers a
 * caller supplies, and a value outside the grammar yields a string the
 * matching decoder rejects — so it is rejected here instead of handed out as
 * a thread id that cannot be read back. `ValidationError`, not the
 * `RangeError` of `mentionUser`: these encode adapter input, and the SDK
 * routes the value through `decodeThreadId` on the way back
 * (docs/specs/adapter.md §3.6).
 */
function assertEncodablePosint(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${value} is not a valid ${label}`);
  }
}

/**
 * `issue:<issueId>` or `pr:<repositoryId>:<number>` (docs/specs/adapter.md
 * §2.1). Shared by thread ids and message ids so the two grammars cannot
 * drift apart.
 */
function encodeSubject(subject: BacklogSubjectRef): string {
  if (subject.kind === 'issue') {
    assertEncodablePosint(subject.issueId, 'issue id');
    return `issue:${subject.issueId}`;
  }
  assertEncodablePosint(subject.repositoryId, 'repository id');
  assertEncodablePosint(subject.number, 'pull request number');
  return `pr:${subject.repositoryId}:${subject.number}`;
}

/**
 * Reads a subject starting at `segments[start]` and reports where it ended, so
 * a caller can go on to require exactly the segments its own grammar allows
 * after it. Returns `null` for an unknown keyword or a segment count the
 * keyword does not take; the caller turns that into a `ValidationError` naming
 * the whole id, which is more useful than naming the segment.
 */
function decodeSubject(
  segments: readonly string[],
  start: number
): { subject: BacklogSubjectRef; next: number } | null {
  const keyword = segments[start];
  if (keyword === 'issue') {
    const issueId = segments[start + 1];
    if (issueId === undefined) {
      return null;
    }
    return {
      subject: { kind: 'issue', issueId: decodePosint(issueId, 'issue id') },
      next: start + 2,
    };
  }
  if (keyword === 'pr') {
    const repositoryId = segments[start + 1];
    const number = segments[start + 2];
    if (repositoryId === undefined || number === undefined) {
      return null;
    }
    return {
      subject: {
        kind: 'pullRequest',
        repositoryId: decodePosint(repositoryId, 'repository id'),
        number: decodePosint(number, 'pull request number'),
      },
      next: start + 3,
    };
  }
  return null;
}

export function encodeThreadId(id: BacklogThreadId): string {
  assertValidHost(id.host);
  assertEncodablePosint(id.projectId, 'project id');
  return `backlog:${id.host}:${id.projectId}:${encodeSubject(id.subject)}`;
}

export function decodeThreadId(id: string): BacklogThreadId {
  const segments = id.split(':');
  const [prefix, host, projectId] = segments;
  if (
    segments.length < 5 ||
    prefix !== 'backlog' ||
    host === undefined ||
    projectId === undefined
  ) {
    throw invalidThreadId(id);
  }
  assertValidHost(host);
  const project = decodePosint(projectId, 'project id');

  const decoded = decodeSubject(segments, 3);
  if (decoded === null || decoded.next !== segments.length) {
    throw invalidThreadId(id);
  }

  return { host, projectId: project, subject: decoded.subject };
}

function invalidThreadId(id: string): ValidationError {
  return new ValidationError(
    'backlog',
    `"${id}" is not a valid Backlog thread id`
  );
}

export function encodeChannelId(id: BacklogChannelId): string {
  assertValidHost(id.host);
  assertEncodablePosint(id.projectId, 'project id');
  return `backlog:${id.host}:${id.projectId}`;
}

export function decodeChannelId(id: string): BacklogChannelId {
  const segments = id.split(':');
  if (segments.length !== 3 || segments[0] !== 'backlog') {
    throw new ValidationError(
      'backlog',
      `"${id}" is not a valid Backlog channel id`
    );
  }

  const [, host, projectId] = segments as [string, string, string];
  assertValidHost(host);

  return { host, projectId: decodePosint(projectId, 'project id') };
}

/**
 * The channel id is the thread id's first three segments for both kinds
 * (docs/specs/adapter.md §4.1 `channelIdFromThreadId`, D-PR1: a pull request
 * belongs to its project's channel, not to a channel of its own); decoding and
 * re-encoding keeps this file the single place that knows the grammar rather
 * than duplicating the prefix rule at each call site.
 */
export function channelIdFromThreadId(threadId: string): string {
  const { host, projectId } = decodeThreadId(threadId);
  return encodeChannelId({ host, projectId });
}

export function encodeMessageId(id: BacklogMessageId): string {
  assertValidHost(id.host);
  const prefix = `${id.host}:${encodeSubject(id.subject)}`;
  switch (id.part) {
    case 'root':
      return `${prefix}:r`;
    case 'comment':
      assertEncodablePosint(id.commentId, 'comment id');
      return `${prefix}:c${id.commentId}`;
    case 'update':
      // The decoder reads everything after `u:` as the timestamp and requires
      // at least one character, so an empty `created` is the one value that
      // makes this form unreadable — every other string, colons included,
      // round-trips.
      if (id.created.length === 0) {
        fail('an update message id must carry a timestamp after "u:"');
      }
      return `${prefix}:u:${id.created}`;
  }
}

export function decodeMessageId(id: string): BacklogMessageId {
  const segments = id.split(':');
  const host = segments[0];
  if (segments.length < 4 || host === undefined) {
    throw invalidMessageId(id);
  }
  assertValidHost(host);

  const decoded = decodeSubject(segments, 1);
  if (decoded === null) {
    throw invalidMessageId(id);
  }

  const tag = segments[decoded.next];
  if (tag === undefined) {
    throw invalidMessageId(id);
  }
  const base = { host, subject: decoded.subject };

  // `created` is opaque and may itself contain ":" (it is an ISO timestamp),
  // so the `u:` tail is rejoined rather than required to be a single segment.
  if (tag === 'u') {
    const created = segments.slice(decoded.next + 1).join(':');
    if (created.length === 0) {
      fail(`"${id}" is missing the timestamp after "u:"`);
    }
    return { ...base, part: 'update', created };
  }

  if (decoded.next !== segments.length - 1) {
    throw invalidMessageId(id);
  }
  if (tag === 'r') {
    return { ...base, part: 'root' };
  }
  if (tag.startsWith('c')) {
    return {
      ...base,
      part: 'comment',
      commentId: decodePosint(tag.slice(1), 'comment id'),
    };
  }

  throw new ValidationError('backlog', `"${id}" has an unknown message tag`);
}

function invalidMessageId(id: string): ValidationError {
  return new ValidationError(
    'backlog',
    `"${id}" is not a valid Backlog message id`
  );
}

export function encodeUserId(id: BacklogUserId): string {
  assertValidHost(id.host);
  assertEncodablePosint(id.userId, 'user id');
  return `${id.host}:${id.userId}`;
}

/**
 * Splits on the LAST colon rather than the first: `host` itself never
 * contains ":" (see assertValidHost), so either split point identifies the
 * same boundary today, but the last-colon rule is what the grammar specifies
 * (docs/specs/adapter.md §2.2) and is the form message ids rely on to find
 * their trailing tag, so user ids follow it for consistency rather than
 * introducing a second convention.
 */
export function decodeUserId(id: string): BacklogUserId {
  const lastColon = id.lastIndexOf(':');
  if (lastColon === -1) {
    fail(`"${id}" is not a valid Backlog user id`);
  }

  const host = id.slice(0, lastColon);
  const userIdSegment = id.slice(lastColon + 1);

  assertValidHost(host);

  return { host, userId: decodePosint(userIdSegment, 'user id') };
}

/**
 * `Number.isSafeInteger`, matching the `posint` range the codec enforces
 * (§2.1): a mention names the same user an id names, so `mentionUser(2 ** 53)`
 * rendering `<@U9007199254740992>` while `encodeUserId` rejects that user
 * would be two answers about one id. Backlog resolves a mention by the id in
 * the text, so a token built from a lossy number addresses whoever that
 * rounded value happens to be.
 */
function assertPositiveInteger(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new RangeError(`${id} is not a positive integer`);
  }
}

/**
 * Mention notation builders (docs/specs/adapter.md §5.4), used by ingress to
 * recognise a mention and not exported (§3.1). These are pure string builders
 * with no adapter context, so an invalid id throws the built-in `RangeError`
 * rather than the adapter's `ValidationError`.
 */
export function mentionUser(id: number): string {
  assertPositiveInteger(id);
  return `<@U${id}>`;
}

export function mentionTeam(id: number): string {
  assertPositiveInteger(id);
  return `<@T${id}>`;
}

export const MENTION_PROJECT_MEMBERS = '<@project>';

const REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(REGEXP_METACHARACTERS, '\\$&');
}

/**
 * Matches a hand-typed `@<botUserName>` mention in resolved message text
 * (docs/specs/adapter.md §5.4). Left-bounded against `\w` and `@` so
 * `foo@Chatbot` and `@@Chatbot` don't match, right-bounded against `\w-` so
 * `@Chatbot2` doesn't match; case-sensitive because Japanese display names
 * have no case and a case-insensitive match would over-match ASCII names
 * (docs/specs/adapter.md D9).
 */
export function mentionPattern(botUserName: string): RegExp {
  return new RegExp(`(?<![\\w@])@${escapeRegExp(botUserName)}(?![\\w-])`);
}
