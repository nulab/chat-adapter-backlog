import { ValidationError } from '@chat-adapter/shared';

import type {
  BacklogChannelId,
  BacklogMessageId,
  BacklogSubjectRef,
  BacklogThreadId,
  BacklogUserId,
} from './types';

const HOST = '[a-z0-9.-]+';
const POSINT = '[1-9]\\d*';
const SUBJECT = `(?:issue:(?<issueId>${POSINT})|pr:(?<repositoryId>${POSINT}):(?<number>${POSINT}))`;

/** Shared with the config schema, so a configured host is one every id can carry. */
export const HOST_PATTERN = new RegExp(`^${HOST}$`);

const THREAD_ID = new RegExp(
  `^backlog:(?<host>${HOST}):(?<projectId>${POSINT}):${SUBJECT}$`
);
const CHANNEL_ID = new RegExp(
  `^backlog:(?<host>${HOST}):(?<projectId>${POSINT})$`
);
// `created` is an ISO timestamp, so the `u:` tail may itself contain ":".
const MESSAGE_ID = new RegExp(
  `^(?<host>${HOST}):${SUBJECT}:(?:r|c(?<commentId>${POSINT})|u:(?<created>.+))$`
);
const USER_ID = new RegExp(`^(?<host>${HOST}):(?<userId>${POSINT})$`);

type IdGroups = { host: string } & Partial<Record<string, string>>;
type Posint = (segment: string | undefined) => number;

/**
 * `posint` refuses digits past 2^53-1 rather than reading them: `Number` is
 * lossy there, so `issue:99999999999999999999` would decode to `1e20` and
 * re-encode as `issue:1e+20`, addressing something other than what it was
 * given.
 */
function grammar(pattern: RegExp, kind: string) {
  return (id: string): { groups: IdGroups; posint: Posint } => {
    const invalid = () =>
      new ValidationError(
        'backlog',
        `"${id}" is not a valid Backlog ${kind} id`
      );
    const groups = pattern.exec(id)?.groups;
    if (groups === undefined) {
      throw invalid();
    }
    const posint: Posint = (segment) => {
      const value = Number(segment);
      if (!Number.isSafeInteger(value)) {
        throw invalid();
      }
      return value;
    };
    return { groups: groups as IdGroups, posint };
  };
}

const parseThreadId = grammar(THREAD_ID, 'thread');
const parseChannelId = grammar(CHANNEL_ID, 'channel');
const parseMessageId = grammar(MESSAGE_ID, 'message');
const parseUserId = grammar(USER_ID, 'user');

function subjectOf(groups: IdGroups, posint: Posint): BacklogSubjectRef {
  return groups.issueId !== undefined
    ? { kind: 'issue', issueId: posint(groups.issueId) }
    : {
        kind: 'pullRequest',
        repositoryId: posint(groups.repositoryId),
        number: posint(groups.number),
      };
}

function encodeSubject(subject: BacklogSubjectRef): string {
  return subject.kind === 'issue'
    ? `issue:${subject.issueId}`
    : `pr:${subject.repositoryId}:${subject.number}`;
}

export function encodeThreadId(id: BacklogThreadId): string {
  return `backlog:${id.host}:${id.projectId}:${encodeSubject(id.subject)}`;
}

export function decodeThreadId(id: string): BacklogThreadId {
  const { groups, posint } = parseThreadId(id);
  return {
    host: groups.host,
    projectId: posint(groups.projectId),
    subject: subjectOf(groups, posint),
  };
}

export function encodeChannelId(id: BacklogChannelId): string {
  return `backlog:${id.host}:${id.projectId}`;
}

export function decodeChannelId(id: string): BacklogChannelId {
  const { groups, posint } = parseChannelId(id);
  return { host: groups.host, projectId: posint(groups.projectId) };
}

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
  const { groups, posint } = parseMessageId(id);
  const base = { host: groups.host, subject: subjectOf(groups, posint) };
  if (groups.created !== undefined) {
    return { ...base, part: 'update', created: groups.created };
  }
  if (groups.commentId !== undefined) {
    return {
      ...base,
      part: 'comment',
      commentId: posint(groups.commentId),
    };
  }
  return { ...base, part: 'root' };
}

export function decodeUserId(id: string): BacklogUserId {
  const { groups, posint } = parseUserId(id);
  return { host: groups.host, userId: posint(groups.userId) };
}

export function mentionUser(id: number): string {
  return `<@U${id}>`;
}

const REGEXP_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(value: string): string {
  return value.replace(REGEXP_METACHARACTERS, '\\$&');
}

/**
 * Case-sensitive, unlike the core's own `@<userName>` match: Japanese display
 * names have no case, and folding ASCII names over-matches (D9).
 */
export function mentionPattern(botUserName: string): RegExp {
  return new RegExp(`(?<![\\w@])@${escapeRegExp(botUserName)}(?![\\w-])`);
}
