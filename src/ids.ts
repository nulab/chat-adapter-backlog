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

/**
 * Backlog host, e.g. `example.backlog.com`, `example.backlog.jp` or
 * `example.backlogtool.com`. Backlog spaces live on several top-level
 * domains, so the host is carried verbatim rather than templated around a
 * fixed suffix (docs/specs/adapter.md §2, CLAUDE.md "Host").
 */
function assertValidHost(host: string): void {
  if (host.length === 0 || !HOST_PATTERN.test(host)) {
    throw new ValidationError(
      'backlog',
      `"${host}" is not a valid Backlog host`
    );
  }
}

function assertPosint(segment: string, label: string): void {
  if (!POSINT_PATTERN.test(segment)) {
    throw new ValidationError(
      'backlog',
      `"${segment}" is not a valid ${label}`
    );
  }
}

/**
 * `issue:<issueId>` or `pr:<repositoryId>:<number>` (docs/specs/adapter.md
 * §2.1). Shared by thread ids and message ids so the two grammars cannot
 * drift apart.
 */
function encodeSubject(subject: BacklogSubjectRef): string {
  return subject.kind === 'issue'
    ? `issue:${subject.issueId}`
    : `pr:${subject.repositoryId}:${subject.number}`;
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
    assertPosint(issueId, 'issue id');
    return {
      subject: { kind: 'issue', issueId: Number(issueId) },
      next: start + 2,
    };
  }
  if (keyword === 'pr') {
    const repositoryId = segments[start + 1];
    const number = segments[start + 2];
    if (repositoryId === undefined || number === undefined) {
      return null;
    }
    assertPosint(repositoryId, 'repository id');
    assertPosint(number, 'pull request number');
    return {
      subject: {
        kind: 'pullRequest',
        repositoryId: Number(repositoryId),
        number: Number(number),
      },
      next: start + 3,
    };
  }
  return null;
}

export function encodeThreadId(id: BacklogThreadId): string {
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
  assertPosint(projectId, 'project id');

  const decoded = decodeSubject(segments, 3);
  if (decoded === null || decoded.next !== segments.length) {
    throw invalidThreadId(id);
  }

  return { host, projectId: Number(projectId), subject: decoded.subject };
}

function invalidThreadId(id: string): ValidationError {
  return new ValidationError(
    'backlog',
    `"${id}" is not a valid Backlog thread id`
  );
}

export function encodeChannelId(id: BacklogChannelId): string {
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
  assertPosint(projectId, 'project id');

  return { host, projectId: Number(projectId) };
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
  const prefix = `${id.host}:${encodeSubject(id.subject)}`;
  switch (id.part) {
    case 'root':
      return `${prefix}:r`;
    case 'comment':
      return `${prefix}:c${id.commentId}`;
    case 'update':
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
      throw new ValidationError(
        'backlog',
        `"${id}" is missing the timestamp after "u:"`
      );
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
    assertPosint(tag.slice(1), 'comment id');
    return { ...base, part: 'comment', commentId: Number(tag.slice(1)) };
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
    throw new ValidationError(
      'backlog',
      `"${id}" is not a valid Backlog user id`
    );
  }

  const host = id.slice(0, lastColon);
  const userIdSegment = id.slice(lastColon + 1);

  assertValidHost(host);
  assertPosint(userIdSegment, 'user id');

  return { host, userId: Number(userIdSegment) };
}

function assertPositiveInteger(id: number): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new RangeError(`${id} is not a positive integer`);
  }
}

/**
 * Outbound mention helpers (docs/specs/adapter.md §5.4). These are pure
 * string builders with no adapter context, so an invalid id throws the
 * built-in `RangeError` rather than the adapter's `ValidationError`
 * (docs/specs/adapter.md §3.6).
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
