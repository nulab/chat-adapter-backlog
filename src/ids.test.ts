import { ValidationError } from '@chat-adapter/shared';
import { describe, expect, it } from 'vitest';

import {
  channelIdFromThreadId,
  decodeChannelId,
  decodeMessageId,
  decodeThreadId,
  decodeUserId,
  encodeChannelId,
  encodeMessageId,
  encodeThreadId,
} from './ids';
import type { BacklogMessageId, BacklogThreadId } from './types';

const issueThread: BacklogThreadId = {
  host: 'example.backlog.com',
  projectId: 500,
  subject: { kind: 'issue', issueId: 8001 },
};

const pullRequestThread: BacklogThreadId = {
  host: 'example.backlog.com',
  projectId: 500,
  subject: { kind: 'pullRequest', repositoryId: 700, number: 12 },
};

describe('thread ids', () => {
  it.each<[string, BacklogThreadId]>([
    ['backlog:example.backlog.com:500:issue:8001', issueThread],
    ['backlog:example.backlog.com:500:pr:700:12', pullRequestThread],
    [
      'backlog:other.backlog.jp:500:issue:8001',
      { ...issueThread, host: 'other.backlog.jp' },
    ],
    [
      'backlog:other.backlog.jp:500:pr:700:12',
      { ...pullRequestThread, host: 'other.backlog.jp' },
    ],
    [
      'backlog:example.backlogtool.com:500:issue:8001',
      { ...issueThread, host: 'example.backlogtool.com' },
    ],
    [
      'backlog:example.backlogtool.com:500:pr:700:12',
      { ...pullRequestThread, host: 'example.backlogtool.com' },
    ],
  ])(
    'a thread id round-trips through its pinned encoding (%s)',
    (encoded, decoded) => {
      expect(encodeThreadId(decoded)).toBe(encoded);
      expect(decodeThreadId(encoded)).toEqual(decoded);
    }
  );

  it('an issue thread id carries the numeric issue id, never the issue key', () => {
    const encoded = encodeThreadId(issueThread);

    expect(encoded).toBe('backlog:example.backlog.com:500:issue:8001');
    expect(encoded).not.toContain('PROJECT-');
  });

  it('a pull request thread id carries the numeric repository id, never the repository name', () => {
    const encoded = encodeThreadId(pullRequestThread);

    expect(encoded).toBe('backlog:example.backlog.com:500:pr:700:12');
    expect(encoded).not.toContain('example-repo');
  });

  it('a pull request thread id carries the per-repository number, not the global pull request id', () => {
    expect(
      encodeThreadId({
        ...pullRequestThread,
        subject: { kind: 'pullRequest', repositoryId: 700, number: 12 },
      })
    ).not.toContain('90001');
  });

  it('the channel of an issue thread is its project', () => {
    const threadId = encodeThreadId(issueThread);

    expect(channelIdFromThreadId(threadId)).toBe(
      'backlog:example.backlog.com:500'
    );
    expect(channelIdFromThreadId(threadId)).toBe(
      encodeChannelId({ host: 'example.backlog.com', projectId: 500 })
    );
  });

  it('the channel of a pull request thread is its project, not its repository', () => {
    const threadId = encodeThreadId(pullRequestThread);

    expect(channelIdFromThreadId(threadId)).toBe(
      'backlog:example.backlog.com:500'
    );
    expect(channelIdFromThreadId(threadId)).not.toContain('700');
  });

  it('the two kinds of thread in one project share one channel', () => {
    expect(channelIdFromThreadId(encodeThreadId(issueThread))).toBe(
      channelIdFromThreadId(encodeThreadId(pullRequestThread))
    );
  });

  it('a thread id whose subject names no kind is rejected', () => {
    expect(() =>
      decodeThreadId('backlog:example.backlog.com:500:8001')
    ).toThrow(ValidationError);
  });

  it('a thread id with the wrong prefix is rejected', () => {
    expect(() =>
      decodeThreadId('other:example.backlog.com:500:issue:8001')
    ).toThrow(ValidationError);
  });

  it('a thread id with no subject at all is rejected', () => {
    expect(() => decodeThreadId('backlog:example.backlog.com:500')).toThrow(
      ValidationError
    );
  });

  it('an issue subject followed by nothing is rejected', () => {
    expect(() =>
      decodeThreadId('backlog:example.backlog.com:500:issue')
    ).toThrow(ValidationError);
  });

  it('a pull request subject with only one number is rejected', () => {
    expect(() =>
      decodeThreadId('backlog:example.backlog.com:500:pr:700')
    ).toThrow(ValidationError);
  });

  it('an unknown subject keyword is rejected', () => {
    expect(() =>
      decodeThreadId('backlog:example.backlog.com:500:wiki:1')
    ).toThrow(ValidationError);
  });

  it('a subject followed by further segments is rejected', () => {
    expect(() =>
      decodeThreadId('backlog:example.backlog.com:500:issue:8001:extra')
    ).toThrow(ValidationError);
    expect(() =>
      decodeThreadId('backlog:example.backlog.com:500:pr:700:12:extra')
    ).toThrow(ValidationError);
  });

  it('an empty host is rejected', () => {
    expect(() => decodeThreadId('backlog::500:issue:8001')).toThrow(
      ValidationError
    );
    expect(() => decodeThreadId('backlog::500:pr:700:12')).toThrow(
      ValidationError
    );
  });

  it('a host carrying a scheme is rejected', () => {
    expect(() =>
      decodeThreadId('backlog:https://example.backlog.com:500:issue:8001')
    ).toThrow(ValidationError);
  });

  it('a host carrying uppercase letters is rejected', () => {
    expect(() =>
      decodeThreadId('backlog:Example.Backlog.com:500:issue:8001')
    ).toThrow(ValidationError);
  });

  it.each(['0', '01', '', 'abc'])(
    'a project id of "%s" is rejected',
    (projectId) => {
      expect(() =>
        decodeThreadId(`backlog:example.backlog.com:${projectId}:issue:8001`)
      ).toThrow(ValidationError);
      expect(() =>
        decodeThreadId(`backlog:example.backlog.com:${projectId}:pr:700:12`)
      ).toThrow(ValidationError);
    }
  );

  it.each(['0', '01', '', 'abc'])(
    'an issue id of "%s" is rejected',
    (issueId) => {
      expect(() =>
        decodeThreadId(`backlog:example.backlog.com:500:issue:${issueId}`)
      ).toThrow(ValidationError);
    }
  );

  it.each(['0', '01', '', 'abc'])(
    'a repository id of "%s" is rejected',
    (repositoryId) => {
      expect(() =>
        decodeThreadId(`backlog:example.backlog.com:500:pr:${repositoryId}:12`)
      ).toThrow(ValidationError);
    }
  );

  it.each(['0', '01', '', 'abc'])(
    'a pull request number of "%s" is rejected',
    (number) => {
      expect(() =>
        decodeThreadId(`backlog:example.backlog.com:500:pr:700:${number}`)
      ).toThrow(ValidationError);
    }
  );
});

describe('channel ids', () => {
  it('a channel id round-trips through its pinned encoding', () => {
    const decoded = { host: 'example.backlog.com', projectId: 500 };

    expect(encodeChannelId(decoded)).toBe('backlog:example.backlog.com:500');
    expect(decodeChannelId(encodeChannelId(decoded))).toEqual(decoded);
  });

  it('a channel id with the wrong prefix is rejected', () => {
    expect(() => decodeChannelId('other:example.backlog.com:500')).toThrow(
      ValidationError
    );
  });

  it('a thread id is not accepted as a channel id', () => {
    expect(() =>
      decodeChannelId('backlog:example.backlog.com:500:issue:8001')
    ).toThrow(ValidationError);
    expect(() =>
      decodeChannelId('backlog:example.backlog.com:500:pr:700:12')
    ).toThrow(ValidationError);
  });

  it('a channel id with too few segments is rejected', () => {
    expect(() => decodeChannelId('backlog:example.backlog.com')).toThrow(
      ValidationError
    );
  });

  it('an empty host is rejected', () => {
    expect(() => decodeChannelId('backlog::500')).toThrow(ValidationError);
  });

  it.each(['0', '01', '', 'abc'])(
    'a project id of "%s" is rejected',
    (projectId) => {
      expect(() =>
        decodeChannelId(`backlog:example.backlog.com:${projectId}`)
      ).toThrow(ValidationError);
    }
  );
});

describe('message ids', () => {
  it.each<[string, BacklogMessageId]>([
    [
      'example.backlog.com:issue:8001:r',
      {
        host: 'example.backlog.com',
        subject: { kind: 'issue', issueId: 8001 },
        part: 'root',
      },
    ],
    [
      'example.backlog.com:issue:8001:c42',
      {
        host: 'example.backlog.com',
        subject: { kind: 'issue', issueId: 8001 },
        part: 'comment',
        commentId: 42,
      },
    ],
    [
      'example.backlog.com:issue:8001:u:2026-09-03T04:05:06Z',
      {
        host: 'example.backlog.com',
        subject: { kind: 'issue', issueId: 8001 },
        part: 'update',
        created: '2026-09-03T04:05:06Z',
      },
    ],
    [
      'example.backlog.com:pr:700:12:r',
      {
        host: 'example.backlog.com',
        subject: { kind: 'pullRequest', repositoryId: 700, number: 12 },
        part: 'root',
      },
    ],
    [
      'example.backlog.com:pr:700:12:c7000001',
      {
        host: 'example.backlog.com',
        subject: { kind: 'pullRequest', repositoryId: 700, number: 12 },
        part: 'comment',
        commentId: 7000001,
      },
    ],
    [
      'example.backlog.com:pr:700:12:u:2026-09-03T04:05:06Z',
      {
        host: 'example.backlog.com',
        subject: { kind: 'pullRequest', repositoryId: 700, number: 12 },
        part: 'update',
        created: '2026-09-03T04:05:06Z',
      },
    ],
    [
      'other.backlog.jp:issue:8001:r',
      {
        host: 'other.backlog.jp',
        subject: { kind: 'issue', issueId: 8001 },
        part: 'root',
      },
    ],
    [
      'other.backlog.jp:pr:700:12:r',
      {
        host: 'other.backlog.jp',
        subject: { kind: 'pullRequest', repositoryId: 700, number: 12 },
        part: 'root',
      },
    ],
    [
      'example.backlogtool.com:issue:8001:r',
      {
        host: 'example.backlogtool.com',
        subject: { kind: 'issue', issueId: 8001 },
        part: 'root',
      },
    ],
    [
      'example.backlogtool.com:pr:700:12:r',
      {
        host: 'example.backlogtool.com',
        subject: { kind: 'pullRequest', repositoryId: 700, number: 12 },
        part: 'root',
      },
    ],
  ])(
    'a message id round-trips through its pinned encoding (%s)',
    (encoded, decoded) => {
      expect(encodeMessageId(decoded)).toBe(encoded);
      expect(decodeMessageId(encoded)).toEqual(decoded);
    }
  );

  it('a timestamp containing colons survives the update round trip', () => {
    const decoded: BacklogMessageId = {
      host: 'example.backlog.com',
      subject: { kind: 'issue', issueId: 8001 },
      part: 'update',
      created: '2026-09-03T12:34:56Z',
    };
    const encoded = encodeMessageId(decoded);

    expect(encoded).toBe(
      'example.backlog.com:issue:8001:u:2026-09-03T12:34:56Z'
    );
    expect(decodeMessageId(encoded)).toEqual(decoded);
  });

  it('the same comment id under the two kinds yields two distinct message ids', () => {
    const issueComment = encodeMessageId({
      host: 'example.backlog.com',
      subject: { kind: 'issue', issueId: 8001 },
      part: 'comment',
      commentId: 7000001,
    });
    const pullRequestComment = encodeMessageId({
      host: 'example.backlog.com',
      subject: { kind: 'pullRequest', repositoryId: 700, number: 12 },
      part: 'comment',
      commentId: 7000001,
    });

    expect(issueComment).not.toBe(pullRequestComment);
  });

  it('the same message under two hosts yields two distinct message ids', () => {
    const here = encodeMessageId({
      host: 'example.backlog.com',
      subject: { kind: 'issue', issueId: 8001 },
      part: 'comment',
      commentId: 42,
    });
    const there = encodeMessageId({
      host: 'other.backlog.jp',
      subject: { kind: 'issue', issueId: 8001 },
      part: 'comment',
      commentId: 42,
    });

    expect(here).not.toBe(there);
  });

  it('a message id tagging its root anything but "r" is rejected', () => {
    expect(() => decodeMessageId('example.backlog.com:8001:i')).toThrow(
      ValidationError
    );
    expect(() => decodeMessageId('example.backlog.com:issue:8001:i')).toThrow(
      ValidationError
    );
  });

  it('a message id with an empty host is rejected', () => {
    expect(() => decodeMessageId(':issue:8001:r')).toThrow(ValidationError);
    expect(() => decodeMessageId(':pr:700:12:r')).toThrow(ValidationError);
  });

  it('an unknown subject keyword is rejected', () => {
    expect(() => decodeMessageId('example.backlog.com:wiki:1:r')).toThrow(
      ValidationError
    );
  });

  it('a pull request subject with only one number is rejected', () => {
    expect(() => decodeMessageId('example.backlog.com:pr:700:r')).toThrow(
      ValidationError
    );
  });

  it('a subject followed by nothing is rejected', () => {
    expect(() => decodeMessageId('example.backlog.com')).toThrow(
      ValidationError
    );
    expect(() => decodeMessageId('example.backlog.com:issue:8001')).toThrow(
      ValidationError
    );
    expect(() => decodeMessageId('example.backlog.com:pr:700:12')).toThrow(
      ValidationError
    );
  });

  it('a subject followed by an unknown part is rejected', () => {
    expect(() => decodeMessageId('example.backlog.com:issue:8001:x')).toThrow(
      ValidationError
    );
    expect(() => decodeMessageId('example.backlog.com:pr:700:12:x')).toThrow(
      ValidationError
    );
  });

  it('a root part followed by more segments is rejected', () => {
    expect(() =>
      decodeMessageId('example.backlog.com:issue:8001:r:extra')
    ).toThrow(ValidationError);
    expect(() =>
      decodeMessageId('example.backlog.com:pr:700:12:r:extra')
    ).toThrow(ValidationError);
  });

  it('a comment part followed by more segments is rejected', () => {
    expect(() =>
      decodeMessageId('example.backlog.com:issue:8001:c42:extra')
    ).toThrow(ValidationError);
    expect(() =>
      decodeMessageId('example.backlog.com:pr:700:12:c7000001:extra')
    ).toThrow(ValidationError);
  });

  it('"u:" with nothing after it is rejected', () => {
    expect(() => decodeMessageId('example.backlog.com:issue:8001:u:')).toThrow(
      ValidationError
    );
    expect(() => decodeMessageId('example.backlog.com:pr:700:12:u:')).toThrow(
      ValidationError
    );
  });

  it.each(['0', '01', '', 'abc'])(
    'an issue id of "%s" is rejected',
    (issueId) => {
      expect(() =>
        decodeMessageId(`example.backlog.com:issue:${issueId}:r`)
      ).toThrow(ValidationError);
    }
  );

  it.each(['0', '01', '', 'abc'])(
    'a repository id of "%s" is rejected',
    (repositoryId) => {
      expect(() =>
        decodeMessageId(`example.backlog.com:pr:${repositoryId}:12:r`)
      ).toThrow(ValidationError);
    }
  );

  it.each(['0', '01', '', 'abc'])(
    'a pull request number of "%s" is rejected',
    (number) => {
      expect(() =>
        decodeMessageId(`example.backlog.com:pr:700:${number}:r`)
      ).toThrow(ValidationError);
    }
  );

  it.each(['c0', 'c01', 'c', 'cabc'])(
    'a comment part of "%s" is rejected',
    (tag) => {
      expect(() =>
        decodeMessageId(`example.backlog.com:issue:8001:${tag}`)
      ).toThrow(ValidationError);
      expect(() =>
        decodeMessageId(`example.backlog.com:pr:700:12:${tag}`)
      ).toThrow(ValidationError);
    }
  );
});

describe('user ids', () => {
  it('a user id decodes to its host and numeric id', () => {
    expect(decodeUserId('example.backlog.com:100')).toEqual({
      host: 'example.backlog.com',
      userId: 100,
    });
  });

  it('a bare numeric user id is rejected', () => {
    expect(() => decodeUserId('999')).toThrow(ValidationError);
  });

  it('an empty host is rejected', () => {
    expect(() => decodeUserId(':100')).toThrow(ValidationError);
  });

  it.each(['0', '01', '', 'abc'])('a user id of "%s" is rejected', (userId) => {
    expect(() => decodeUserId(`example.backlog.com:${userId}`)).toThrow(
      ValidationError
    );
  });
});

describe('ids past 2^53-1, which Number would read as a float that re-encodes as a different id (1e20 for 99999999999999999999)', () => {
  const BIG = '99999999999999999999';
  const LARGEST = String(Number.MAX_SAFE_INTEGER);

  it('a project id past 2^53-1 is rejected, not read as a float', () => {
    const threadId = `backlog:example.backlog.com:${BIG}:issue:8001`;
    const channelId = `backlog:example.backlog.com:${BIG}`;

    expect(() => decodeThreadId(threadId)).toThrow(ValidationError);
    expect(() => decodeChannelId(channelId)).toThrow(ValidationError);
  });

  it('an issue id past 2^53-1 is rejected, not read as a float', () => {
    const threadId = `backlog:example.backlog.com:500:issue:${BIG}`;
    const messageId = `example.backlog.com:issue:${BIG}:r`;

    expect(() => decodeThreadId(threadId)).toThrow(ValidationError);
    expect(() => decodeMessageId(messageId)).toThrow(ValidationError);
  });

  it('a repository id or pull request number past 2^53-1 is rejected', () => {
    const repository = `backlog:example.backlog.com:500:pr:${BIG}:12`;
    const number = `backlog:example.backlog.com:500:pr:700:${BIG}`;

    expect(() => decodeThreadId(repository)).toThrow(ValidationError);
    expect(() => decodeThreadId(number)).toThrow(ValidationError);
  });

  it('a comment id past 2^53-1 is rejected', () => {
    const messageId = `example.backlog.com:issue:8001:c${BIG}`;

    expect(() => decodeMessageId(messageId)).toThrow(ValidationError);
  });

  it('a user id past 2^53-1 is rejected', () => {
    expect(() => decodeUserId(`example.backlog.com:${BIG}`)).toThrow(
      ValidationError
    );
  });

  it('the largest safe integer is still a valid id', () => {
    const encoded = `backlog:example.backlog.com:500:issue:${LARGEST}`;
    const decoded = decodeThreadId(encoded);

    expect(decoded.subject).toEqual({
      kind: 'issue',
      issueId: Number.MAX_SAFE_INTEGER,
    });
    expect(encodeThreadId(decoded)).toBe(encoded);
  });
});
