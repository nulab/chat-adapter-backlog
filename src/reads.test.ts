import { ValidationError } from '@chat-adapter/shared';
import { Message as MessageCtor } from 'chat';
import { describe, expect, it } from 'vitest';

import { createInMemoryBacklogApi } from './client/in-memory';
import { fetchMessage, fetchMessages, fetchThread } from './reads';
import { encodeMessageId } from './ids';

import type { BacklogApi, BacklogComment, BacklogIssue } from './client/port';
import type { MessageBuilders } from './reads';
import type { FetchDirection, FetchOptions } from 'chat';

const HOST = 'example.backlog.com';
const PROJECT_ID = 500;
const ISSUE_ID = 8001;
const THREAD_ID = `backlog:${HOST}:${PROJECT_ID}:${ISSUE_ID}`;
const CHANNEL_ID = `backlog:${HOST}:${PROJECT_ID}`;

function baseIssue(overrides: Partial<BacklogIssue> = {}): BacklogIssue {
  return {
    id: ISSUE_ID,
    projectId: PROJECT_ID,
    issueKey: 'PROJECT-1',
    summary: 'Deploy fails on the staging space',
    description: 'Reproduces on every push to main.',
    issueType: { id: 1, name: 'Task' },
    priority: { id: 3, name: 'Normal' },
    status: { id: 1, name: 'Open' },
    assignee: null,
    createdUser: { userId: '100', name: 'Alice', mailAddress: null },
    created: new Date('2026-01-01T00:00:00Z'),
    updated: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const ISSUE_CREATED = new Date('2026-01-01T00:00:00Z');

function makeComments(count: number): BacklogComment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    issueId: ISSUE_ID,
    content: `Comment ${index + 1}`,
    changeLog: [],
    createdUser: { userId: '100', name: 'Alice', mailAddress: null },
    // Strictly after the issue's `created` (`ISSUE_CREATED`) so a
    // chronological sort never ties the root against the first comment.
    // Built from `.getTime() + ms`, not `new Date(y, m, d, h, m, s)`, which
    // constructs in the runner's local timezone rather than UTC.
    created: new Date(ISSUE_CREATED.getTime() + (index + 1) * 60_000),
    updated: new Date(ISSUE_CREATED.getTime() + (index + 1) * 60_000),
    stars: [],
  }));
}

function apiWith(
  commentCount: number,
  issue: BacklogIssue = baseIssue()
): BacklogApi {
  return createInMemoryBacklogApi({
    projects: [
      {
        id: PROJECT_ID,
        projectKey: 'PROJECT',
        name: 'Project',
        textFormattingRule: 'markdown',
      },
    ],
    issues: [issue],
    comments: makeComments(commentCount),
  });
}

/** Builds `FetchOptions` conditionally so an absent `cursor` is omitted, not `undefined` (`exactOptionalPropertyTypes`). */
function fetchOptions(
  limit: number,
  cursor: string | undefined,
  direction: FetchDirection
): FetchOptions {
  return cursor === undefined
    ? { limit, direction }
    : { limit, cursor, direction };
}

function builders(): Omit<MessageBuilders, 'projectId' | 'issueId'> {
  return {
    host: HOST,
    botUserIdString: '999',
    fetchAttachment: () => Promise.reject(new Error('no attachments expected')),
    MessageCtor,
  };
}

describe('fetchMessages cursor and threadId validation', () => {
  it('a malformed cursor is a validation error', async () => {
    const api = apiWith(5);
    await expect(
      fetchMessages({
        threadId: THREAD_ID,
        options: { cursor: 'not-a-number' },
        api,
        builders: builders(),
      })
    ).rejects.toThrow(ValidationError);
  });

  it('a channel id passed as a thread id is a validation error', async () => {
    const api = apiWith(5);
    await expect(
      fetchMessages({
        threadId: CHANNEL_ID,
        options: undefined,
        api,
        builders: builders(),
      })
    ).rejects.toThrow(ValidationError);
  });
});

describe('fetchMessages (§7.1 property sweep)', () => {
  const limits = [1, 2, 3, 5, 50, 100];
  const commentCounts = [0, 1, 4, 7, 150];
  const directions = ['backward', 'forward'] as const;

  for (const limit of limits) {
    for (const commentCount of commentCounts) {
      for (const direction of directions) {
        it(`limit=${limit} comments=${commentCount} direction=${direction}: pages are chronological, bounded and cover every message exactly once`, async () => {
          const api = apiWith(commentCount);
          const seenIds = new Set<string>();
          let cursor: string | undefined;
          let pageCount = 0;
          const maxPages = commentCount + 5;

          for (;;) {
            pageCount += 1;
            if (pageCount > maxPages) {
              throw new Error('paging did not terminate');
            }
            const result = await fetchMessages({
              threadId: THREAD_ID,
              options: fetchOptions(limit, cursor, direction),
              api,
              builders: builders(),
            });

            expect(result.messages.length).toBeLessThanOrEqual(limit);

            const ids = result.messages.map((message) => message.id);
            const sortedByDate = [...result.messages].sort(
              (a, b) =>
                a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime()
            );
            expect(ids).toEqual(sortedByDate.map((message) => message.id));

            for (const id of ids) {
              seenIds.add(id);
            }

            if (result.nextCursor === undefined) {
              break;
            }
            cursor = result.nextCursor;
          }

          // root + every comment, exactly once.
          expect(seenIds.size).toBe(commentCount + 1);
          expect(
            seenIds.has(
              encodeMessageId({ kind: 'issue', host: HOST, issueId: ISSUE_ID })
            )
          ).toBe(true);
          for (let commentId = 1; commentId <= commentCount; commentId += 1) {
            expect(
              seenIds.has(
                encodeMessageId({
                  kind: 'comment',
                  host: HOST,
                  issueId: ISSUE_ID,
                  commentId,
                })
              )
            ).toBe(true);
          }
        });
      }
    }
  }

  it('backward paging ends with a page holding the issue body', async () => {
    const api = apiWith(4);
    let cursor: string | undefined;
    let lastPageMessages: Awaited<
      ReturnType<typeof fetchMessages>
    >['messages'] = [];
    for (;;) {
      const result = await fetchMessages({
        threadId: THREAD_ID,
        options: fetchOptions(2, cursor, 'backward'),
        api,
        builders: builders(),
      });
      lastPageMessages = result.messages;
      if (result.nextCursor === undefined) {
        break;
      }
      cursor = result.nextCursor;
    }
    expect(lastPageMessages).toHaveLength(1);
    expect(lastPageMessages[0]?.id).toBe(
      encodeMessageId({ kind: 'issue', host: HOST, issueId: ISSUE_ID })
    );
  });

  it('forward paging starts with the issue body using one slot', async () => {
    const api = apiWith(4);
    const result = await fetchMessages({
      threadId: THREAD_ID,
      options: { limit: 3, direction: 'forward' },
      api,
      builders: builders(),
    });
    expect(result.messages[0]?.id).toBe(
      encodeMessageId({ kind: 'issue', host: HOST, issueId: ISSUE_ID })
    );
    // limit 3, one slot for the root, so at most 2 comments follow.
    expect(result.messages.length).toBeLessThanOrEqual(3);
  });

  it('every comment appears exactly once across all pages', async () => {
    const api = apiWith(7);
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const result = await fetchMessages({
        threadId: THREAD_ID,
        options: fetchOptions(3, cursor, 'backward'),
        api,
        builders: builders(),
      });
      for (const message of result.messages) {
        expect(seen.has(message.id)).toBe(false);
        seen.add(message.id);
      }
      if (result.nextCursor === undefined) {
        break;
      }
      cursor = result.nextCursor;
    }
    expect(seen.size).toBe(8); // 7 comments + root
  });
});

describe('fetchMessages REST comment mapping', () => {
  it('a comment edited on Backlog reports edited and editedAt', async () => {
    const editedAt = new Date('2026-01-02T00:00:00Z');
    const api = createInMemoryBacklogApi({
      projects: [
        {
          id: PROJECT_ID,
          projectKey: 'PROJECT',
          name: 'Project',
          textFormattingRule: 'markdown',
        },
      ],
      issues: [baseIssue()],
      comments: [
        {
          id: 1,
          issueId: ISSUE_ID,
          content: 'Edited content',
          changeLog: [],
          createdUser: { userId: '100', name: 'Alice', mailAddress: null },
          created: new Date('2026-01-01T00:00:00Z'),
          updated: editedAt,
          stars: [],
        },
      ],
    });

    const result = await fetchMessages({
      threadId: THREAD_ID,
      options: { limit: 2, direction: 'backward' },
      api,
      builders: builders(),
    });

    const comment = result.messages.find(
      (message) => message.text === 'Edited content'
    );
    expect(comment?.metadata.edited).toBe(true);
    expect(comment?.metadata.editedAt).toEqual(editedAt);
  });

  it('the issue root message always reports edited: false', async () => {
    const api = apiWith(0);
    const result = await fetchMessages({
      threadId: THREAD_ID,
      options: { limit: 1, direction: 'backward' },
      api,
      builders: builders(),
    });
    const root = result.messages.find(
      (message) =>
        message.id ===
        encodeMessageId({ kind: 'issue', host: HOST, issueId: ISSUE_ID })
    );
    expect(root?.metadata.edited).toBe(false);
  });
});

describe('fetchMessage', () => {
  it('returns the issue root for an :i id', async () => {
    const api = apiWith(2);
    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: encodeMessageId({
        kind: 'issue',
        host: HOST,
        issueId: ISSUE_ID,
      }),
      api,
      builders: builders(),
    });
    expect(message?.text).toContain('Deploy fails on the staging space');
  });

  it('returns a comment for a :c id', async () => {
    const api = apiWith(2);
    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: encodeMessageId({
        kind: 'comment',
        host: HOST,
        issueId: ISSUE_ID,
        commentId: 1,
      }),
      api,
      builders: builders(),
    });
    expect(message?.text).toBe('Comment 1');
  });

  it('a message id from another issue is null without an API call', async () => {
    const api = apiWith(2);
    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: encodeMessageId({
        kind: 'comment',
        host: HOST,
        issueId: 9999,
        commentId: 1,
      }),
      api,
      builders: builders(),
    });
    expect(message).toBeNull();
  });

  it('a :u: id is null (no single-fetch API exists for it)', async () => {
    const api = apiWith(2);
    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: encodeMessageId({
        kind: 'update',
        host: HOST,
        issueId: ISSUE_ID,
        created: '2026-09-03T04:05:06Z',
      }),
      api,
      builders: builders(),
    });
    expect(message).toBeNull();
  });

  it('a 404 from the API is null', async () => {
    const api = apiWith(2);
    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: encodeMessageId({
        kind: 'comment',
        host: HOST,
        issueId: ISSUE_ID,
        commentId: 999,
      }),
      api,
      builders: builders(),
    });
    expect(message).toBeNull();
  });
});

describe('fetchThread', () => {
  it('resolves the issue as a ThreadInfo', async () => {
    const api = apiWith(0);
    const thread = await fetchThread({ threadId: THREAD_ID, api });
    expect(thread).toMatchObject({
      id: THREAD_ID,
      channelId: CHANNEL_ID,
      channelName: 'PROJECT',
      isDM: false,
    });
    expect(thread.metadata).toMatchObject({
      issueKey: 'PROJECT-1',
      summary: 'Deploy fails on the staging space',
      url: `https://${HOST}/view/PROJECT-1`,
    });
  });
});
