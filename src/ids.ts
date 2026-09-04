import { ValidationError } from '@chat-adapter/shared';

import type {
  BacklogChannelId,
  BacklogMessageId,
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

export function encodeThreadId(id: BacklogThreadId): string {
  return `backlog:${id.host}:${id.projectId}:${id.issueId}`;
}

export function decodeThreadId(id: string): BacklogThreadId {
  const segments = id.split(':');
  if (segments.length !== 4 || segments[0] !== 'backlog') {
    throw new ValidationError(
      'backlog',
      `"${id}" is not a valid Backlog thread id`
    );
  }

  const [, host, projectId, issueId] = segments as [
    string,
    string,
    string,
    string,
  ];
  assertValidHost(host);
  assertPosint(projectId, 'project id');
  assertPosint(issueId, 'issue id');

  return { host, projectId: Number(projectId), issueId: Number(issueId) };
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
 * The channel id is the thread id's first three segments (docs/specs/adapter.md
 * §4.1 `channelIdFromThreadId`); decoding and re-encoding keeps this file the
 * single place that knows the grammar rather than duplicating the prefix rule
 * at each call site.
 */
export function channelIdFromThreadId(threadId: string): string {
  const { host, projectId } = decodeThreadId(threadId);
  return encodeChannelId({ host, projectId });
}

export function encodeMessageId(id: BacklogMessageId): string {
  switch (id.kind) {
    case 'issue':
      return `${id.host}:${id.issueId}:i`;
    case 'comment':
      return `${id.host}:${id.issueId}:c${id.commentId}`;
    case 'update':
      return `${id.host}:${id.issueId}:u:${id.created}`;
  }
}

export function decodeMessageId(id: string): BacklogMessageId {
  const firstColon = id.indexOf(':');
  const secondColon = firstColon === -1 ? -1 : id.indexOf(':', firstColon + 1);
  if (firstColon === -1 || secondColon === -1) {
    throw new ValidationError(
      'backlog',
      `"${id}" is not a valid Backlog message id`
    );
  }

  const host = id.slice(0, firstColon);
  const issueIdSegment = id.slice(firstColon + 1, secondColon);
  const tag = id.slice(secondColon + 1);

  assertValidHost(host);
  assertPosint(issueIdSegment, 'issue id');
  const issueId = Number(issueIdSegment);

  if (tag === 'i') {
    return { kind: 'issue', host, issueId };
  }

  if (tag.startsWith('c')) {
    assertPosint(tag.slice(1), 'comment id');
    return { kind: 'comment', host, issueId, commentId: Number(tag.slice(1)) };
  }

  if (tag.startsWith('u:')) {
    const created = tag.slice(2);
    if (created.length === 0) {
      throw new ValidationError(
        'backlog',
        `"${id}" is missing the timestamp after "u:"`
      );
    }
    return { kind: 'update', host, issueId, created };
  }

  throw new ValidationError('backlog', `"${id}" has an unknown message tag`);
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
