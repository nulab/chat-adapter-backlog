import { ValidationError } from '@chat-adapter/shared';
import { describe, expect, it } from 'vitest';

import {
  MENTION_PROJECT_MEMBERS,
  channelIdFromThreadId,
  decodeChannelId,
  decodeMessageId,
  decodeThreadId,
  decodeUserId,
  encodeChannelId,
  encodeMessageId,
  encodeThreadId,
  encodeUserId,
  mentionPattern,
  mentionTeam,
  mentionUser,
} from './ids';
import type { BacklogMessageId } from './types';

describe('thread ids', () => {
  it.each([
    ['example.backlog.com', 500, 8001],
    ['example.backlog.jp', 500, 8001],
    ['example.backlogtool.com', 500, 8001],
  ])(
    'thread ids round-trip for backlog.com, backlog.jp and backlogtool.com (%s)',
    (host, projectId, issueId) => {
      const decoded = { host, projectId, issueId };
      expect(decodeThreadId(encodeThreadId(decoded))).toEqual(decoded);
    }
  );

  it('a thread id never contains the issue key', () => {
    const encoded = encodeThreadId({
      host: 'example.backlog.com',
      projectId: 500,
      issueId: 8001,
    });

    expect(encoded).toBe('backlog:example.backlog.com:500:8001');
    expect(encoded).not.toContain('-');
  });

  it('the channel id is the first three segments', () => {
    const threadId = encodeThreadId({
      host: 'example.backlog.com',
      projectId: 500,
      issueId: 8001,
    });

    expect(channelIdFromThreadId(threadId)).toBe(
      'backlog:example.backlog.com:500'
    );
    expect(channelIdFromThreadId(threadId)).toBe(
      encodeChannelId({ host: 'example.backlog.com', projectId: 500 })
    );
  });

  it('rejects a thread id with the wrong prefix', () => {
    expect(() => decodeThreadId('other:example.backlog.com:500:8001')).toThrow(
      ValidationError
    );
  });

  it('rejects a thread id with too few segments', () => {
    expect(() => decodeThreadId('backlog:example.backlog.com:500')).toThrow(
      ValidationError
    );
  });

  it('rejects a thread id with too many segments', () => {
    expect(() =>
      decodeThreadId('backlog:example.backlog.com:500:8001:extra')
    ).toThrow(ValidationError);
  });

  it('rejects an empty host', () => {
    expect(() => decodeThreadId('backlog::500:8001')).toThrow(ValidationError);
  });

  it('rejects a host carrying a scheme', () => {
    expect(() =>
      decodeThreadId('backlog:https://example.backlog.com:500:8001')
    ).toThrow(ValidationError);
  });

  it('rejects a non-posint project id', () => {
    expect(() => decodeThreadId('backlog:example.backlog.com:0:8001')).toThrow(
      ValidationError
    );
    expect(() => decodeThreadId('backlog:example.backlog.com:01:8001')).toThrow(
      ValidationError
    );
    expect(() =>
      decodeThreadId('backlog:example.backlog.com:abc:8001')
    ).toThrow(ValidationError);
  });

  it('rejects a non-posint issue id', () => {
    expect(() => decodeThreadId('backlog:example.backlog.com:500:0')).toThrow(
      ValidationError
    );
    expect(() => decodeThreadId('backlog:example.backlog.com:500:abc')).toThrow(
      ValidationError
    );
  });
});

describe('channel ids', () => {
  it('round-trip', () => {
    const decoded = { host: 'example.backlog.com', projectId: 500 };
    expect(decodeChannelId(encodeChannelId(decoded))).toEqual(decoded);
  });

  it('rejects a channel id with the wrong prefix', () => {
    expect(() => decodeChannelId('other:example.backlog.com:500')).toThrow(
      ValidationError
    );
  });

  it('rejects a channel id with too many segments', () => {
    expect(() =>
      decodeChannelId('backlog:example.backlog.com:500:8001')
    ).toThrow(ValidationError);
  });

  it('rejects a channel id with too few segments', () => {
    expect(() => decodeChannelId('backlog:example.backlog.com')).toThrow(
      ValidationError
    );
  });

  it('rejects an empty host', () => {
    expect(() => decodeChannelId('backlog::500')).toThrow(ValidationError);
  });

  it('rejects a non-posint project id', () => {
    expect(() => decodeChannelId('backlog:example.backlog.com:0')).toThrow(
      ValidationError
    );
  });
});

describe('message ids', () => {
  it('round-trips the issue root message', () => {
    const decoded: BacklogMessageId = {
      kind: 'issue',
      host: 'example.backlog.com',
      issueId: 8001,
    };
    expect(encodeMessageId(decoded)).toBe('example.backlog.com:8001:i');
    expect(decodeMessageId(encodeMessageId(decoded))).toEqual(decoded);
  });

  it('round-trips a comment message', () => {
    const decoded: BacklogMessageId = {
      kind: 'comment',
      host: 'example.backlog.com',
      issueId: 8001,
      commentId: 42,
    };
    expect(encodeMessageId(decoded)).toBe('example.backlog.com:8001:c42');
    expect(decodeMessageId(encodeMessageId(decoded))).toEqual(decoded);
  });

  it('round-trips a u: update message whose created timestamp contains colons', () => {
    const decoded: BacklogMessageId = {
      kind: 'update',
      host: 'example.backlog.com',
      issueId: 8001,
      created: '2026-09-03T12:34:56Z',
    };
    const encoded = encodeMessageId(decoded);

    expect(encoded).toBe('example.backlog.com:8001:u:2026-09-03T12:34:56Z');
    expect(decodeMessageId(encoded)).toEqual(decoded);
  });

  it('rejects a message id with an empty host', () => {
    expect(() => decodeMessageId(':8001:i')).toThrow(ValidationError);
  });

  it('rejects a message id with a non-posint issue id', () => {
    expect(() => decodeMessageId('example.backlog.com:0:i')).toThrow(
      ValidationError
    );
    expect(() => decodeMessageId('example.backlog.com:abc:i')).toThrow(
      ValidationError
    );
  });

  it('rejects an unknown message tag', () => {
    expect(() => decodeMessageId('example.backlog.com:8001:x')).toThrow(
      ValidationError
    );
  });

  it('rejects an "i" tag followed by further segments', () => {
    expect(() => decodeMessageId('example.backlog.com:8001:i:extra')).toThrow(
      ValidationError
    );
  });

  it('rejects a "c<id>" tag followed by further segments', () => {
    expect(() => decodeMessageId('example.backlog.com:8001:c42:extra')).toThrow(
      ValidationError
    );
  });

  it('rejects a comment tag with a non-posint comment id', () => {
    expect(() => decodeMessageId('example.backlog.com:8001:c0')).toThrow(
      ValidationError
    );
    expect(() => decodeMessageId('example.backlog.com:8001:c')).toThrow(
      ValidationError
    );
  });

  it('rejects "u:" with nothing after it', () => {
    expect(() => decodeMessageId('example.backlog.com:8001:u:')).toThrow(
      ValidationError
    );
  });

  it('rejects a message id missing the issue-id segment', () => {
    expect(() => decodeMessageId('example.backlog.com')).toThrow(
      ValidationError
    );
  });
});

describe('user ids', () => {
  it('round-trips', () => {
    const decoded = { host: 'example.backlog.com', userId: 100 };
    expect(encodeUserId(decoded)).toBe('example.backlog.com:100');
    expect(decodeUserId(encodeUserId(decoded))).toEqual(decoded);
  });

  it('a bare numeric user id is rejected even with one installation', () => {
    expect(() => decodeUserId('100')).toThrow(ValidationError);
  });

  it('splits on the last colon, not the first', () => {
    // A host is never expected to contain a colon, but the decoder's split
    // point is specified as "the last colon" (docs/specs/adapter.md §2.2);
    // this proves it finds the trailing numeric segment rather than the
    // first one it encounters.
    expect(decodeUserId('example.backlog.com:100')).toEqual({
      host: 'example.backlog.com',
      userId: 100,
    });
  });

  it('rejects an empty host', () => {
    expect(() => decodeUserId(':100')).toThrow(ValidationError);
  });

  it('rejects a non-posint user id', () => {
    expect(() => decodeUserId('example.backlog.com:0')).toThrow(
      ValidationError
    );
    expect(() => decodeUserId('example.backlog.com:abc')).toThrow(
      ValidationError
    );
  });
});

describe('mentionUser', () => {
  it('renders a Backlog user mention token', () => {
    expect(mentionUser(100)).toBe('<@U100>');
  });

  it('rejects a non-positive-integer id', () => {
    expect(() => mentionUser(0)).toThrow(RangeError);
    expect(() => mentionUser(-1)).toThrow(RangeError);
    expect(() => mentionUser(1.5)).toThrow(RangeError);
  });

  it('rejects with a built-in RangeError, not a ValidationError', () => {
    expect(() => mentionUser(0)).not.toThrow(ValidationError);
  });
});

describe('mentionTeam', () => {
  it('renders a Backlog team mention token', () => {
    expect(mentionTeam(7)).toBe('<@T7>');
  });

  it('rejects a non-positive-integer id', () => {
    expect(() => mentionTeam(0)).toThrow(RangeError);
  });
});

describe('MENTION_PROJECT_MEMBERS', () => {
  it('is the project-wide mention token', () => {
    expect(MENTION_PROJECT_MEMBERS).toBe('<@project>');
  });
});

describe('mentionPattern', () => {
  it.each(['@Chatbot', '@Chatbotさん', '(@Chatbot)'])('matches %s', (text) => {
    expect(mentionPattern('Chatbot').test(text)).toBe(true);
  });

  it.each([
    '@Chatbot2',
    'foo@Chatbot',
    '@@Chatbot',
    'unresolved mention <@U999>',
  ])('does not match %s', (text) => {
    expect(mentionPattern('Chatbot').test(text)).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(mentionPattern('Chatbot').test('@chatbot')).toBe(false);
  });

  it('escapes regex metacharacters in the bot user name', () => {
    expect(mentionPattern('Chat.Bot+1').test('@Chat.Bot+1')).toBe(true);
    expect(mentionPattern('Chat.Bot+1').test('@ChatXBot+1')).toBe(false);
  });
});
