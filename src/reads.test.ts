import { ResourceNotFoundError, ValidationError } from '@chat-adapter/shared';
import { Message as MessageCtor } from 'chat';
import { describe, expect, it, vi } from 'vitest';

import { encodeMessageId } from './ids';
import {
  fetchMessage,
  fetchMessages,
  fetchSubject,
  fetchThread,
  rehydrateAttachment,
} from './reads';
import { subjectClientFor } from './subject/client';
import {
  ALICE,
  BOB,
  fileData,
  issue,
  issueComment,
  REST,
  stubClient,
} from './test/fixtures/rest';

import type { MessageBuilders } from './reads';
import type { ListCommentsOptions, SubjectClient } from './subject/client';
import type { BacklogRawComment, BacklogSubjectRef } from './types';
import type { Backlog } from 'backlog-js';
import type {
  Attachment,
  FetchDirection,
  FetchOptions,
  MessageData,
} from 'chat';

const { host: HOST, projectId: PROJECT_ID, issueId: ISSUE_ID } = REST;
const OTHER_HOST = 'other.backlog.jp';

const ISSUE_REF: BacklogSubjectRef = { kind: 'issue', issueId: ISSUE_ID };
const THREAD_ID = `backlog:${HOST}:${PROJECT_ID}:issue:${ISSUE_ID}`;
const CHANNEL_ID = `backlog:${HOST}:${PROJECT_ID}`;
const ROOT_MESSAGE_ID = encodeMessageId({
  host: HOST,
  subject: ISSUE_REF,
  part: 'root',
});

function commentMessageId(commentId: number): string {
  return encodeMessageId({
    host: HOST,
    subject: ISSUE_REF,
    part: 'comment',
    commentId,
  });
}

const ROOT = issue();

function makeComments(count: number): BacklogRawComment[] {
  return Array.from({ length: count }, (_, index) => {
    const created = new Date(
      Date.parse(ROOT.created) + (index + 1) * 60_000
    ).toISOString();
    return issueComment({
      id: index + 1,
      content: `Comment ${index + 1}`,
      created,
      updated: created,
    });
  });
}

/** Get Comment List as measured: exclusive `minId`/`maxId`, `count` cut from the head of `order`. */
function commentList(comments: BacklogRawComment[]) {
  return vi.fn(
    (_issueId: number, options: ListCommentsOptions): Promise<unknown> => {
      const { minId, maxId, count = 20, order = 'desc' } = options;
      const window = comments
        .filter(
          (comment) =>
            (minId === undefined || comment.id > minId) &&
            (maxId === undefined || comment.id < maxId)
        )
        .sort((a, b) => (order === 'asc' ? a.id - b.id : b.id - a.id));
      return Promise.resolve(window.slice(0, count));
    }
  );
}

function issueClient(comments: BacklogRawComment[] = []): Backlog {
  return stubClient({
    getIssue: vi.fn().mockResolvedValue(ROOT),
    getIssueComments: commentList(comments),
  });
}

function issueSubject(client: Backlog): SubjectClient {
  return subjectClientFor(client, ISSUE_REF, {
    host: HOST,
    projectId: PROJECT_ID,
  });
}

function fetchOptions(
  limit: number,
  cursor: string | undefined,
  direction: FetchDirection
): FetchOptions {
  return cursor === undefined
    ? { limit, direction }
    : { limit, cursor, direction };
}

function builders(): Omit<MessageBuilders, 'projectId' | 'subject'> {
  return {
    host: HOST,
    botUserId: 999,
    format: (value): MessageData['formatted'] => ({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
    }),
    MessageCtor,
  };
}

async function fetchAllPages(
  subject: SubjectClient,
  limit: number,
  direction: FetchDirection
) {
  const pages: Awaited<ReturnType<typeof fetchMessages>>['messages'][] = [];
  let cursor: string | undefined;
  for (;;) {
    if (pages.length > 200) {
      throw new Error('paging did not terminate');
    }
    const result = await fetchMessages({
      threadId: THREAD_ID,
      options: fetchOptions(limit, cursor, direction),
      subject,
      builders: builders(),
    });
    pages.push(result.messages);
    if (result.nextCursor === undefined) {
      return pages;
    }
    cursor = result.nextCursor;
  }
}

describe('fetchMessages cursor and threadId validation', () => {
  it.each([2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'a limit of %s is a validation error, not a 400 from Backlog',
    async (limit) => {
      await expect(
        fetchMessages({
          threadId: THREAD_ID,
          options: { limit },
          subject: issueSubject(stubClient({})),
          builders: builders(),
        })
      ).rejects.toThrow(ValidationError);
    }
  );

  it('a limit above 100 is clamped to 100, not rejected', async () => {
    const client = issueClient(makeComments(5));
    const result = await fetchMessages({
      threadId: THREAD_ID,
      options: { limit: 1000 },
      subject: issueSubject(client),
      builders: builders(),
    });

    expect(client.getIssueComments).toHaveBeenCalledWith(ISSUE_ID, {
      count: 100,
      order: 'desc',
    });
    expect(result.messages).toHaveLength(6);
  });

  it('a malformed cursor is a validation error', async () => {
    await expect(
      fetchMessages({
        threadId: THREAD_ID,
        options: { cursor: 'not-a-number' },
        subject: issueSubject(stubClient({})),
        builders: builders(),
      })
    ).rejects.toThrow(ValidationError);
  });

  it('a channel id passed as a thread id is a validation error', async () => {
    await expect(
      fetchMessages({
        threadId: CHANNEL_ID,
        options: undefined,
        subject: issueSubject(stubClient({})),
        builders: builders(),
      })
    ).rejects.toThrow(ValidationError);
  });
});

describe('fetchMessages paging', () => {
  const limits = [1, 2, 3, 5, 50, 100];
  const commentCounts = [0, 1, 4, 7, 150];
  const directions = ['backward', 'forward'] as const;

  for (const limit of limits) {
    for (const commentCount of commentCounts) {
      for (const direction of directions) {
        it(`limit=${limit} comments=${commentCount} direction=${direction}: pages are chronological, bounded and cover every message exactly once`, async () => {
          const pages = await fetchAllPages(
            issueSubject(issueClient(makeComments(commentCount))),
            limit,
            direction
          );

          const seen: string[] = [];
          for (const messages of pages) {
            expect(messages.length).toBeLessThanOrEqual(limit);
            const chronological = [...messages].sort(
              (a, b) =>
                a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime()
            );
            expect(messages).toEqual(chronological);
            seen.push(...messages.map((message) => message.id));
          }

          expect([...seen].sort()).toEqual(
            [
              ROOT_MESSAGE_ID,
              ...Array.from({ length: commentCount }, (_, index) =>
                commentMessageId(index + 1)
              ),
            ].sort()
          );
        });
      }
    }
  }

  it('backward paging ends with a page holding only the issue body', async () => {
    const pages = await fetchAllPages(
      issueSubject(issueClient(makeComments(4))),
      2,
      'backward'
    );

    expect(pages.at(-1)?.map((message) => message.id)).toEqual([
      ROOT_MESSAGE_ID,
    ]);
  });

  it('forward paging starts with the issue body using one slot', async () => {
    const result = await fetchMessages({
      threadId: THREAD_ID,
      options: { limit: 3, direction: 'forward' },
      subject: issueSubject(issueClient(makeComments(4))),
      builders: builders(),
    });

    expect(result.messages.map((message) => message.id)).toEqual([
      ROOT_MESSAGE_ID,
      commentMessageId(1),
      commentMessageId(2),
    ]);
  });
});

describe('fetchMessages REST comment mapping', () => {
  it('a comment edited on Backlog reports edited and editedAt', async () => {
    const edited = issueComment({
      id: 1,
      created: '2026-09-02T00:00:00Z',
      updated: '2026-09-03T00:00:00Z',
    });
    const result = await fetchMessages({
      threadId: THREAD_ID,
      options: { limit: 2, direction: 'backward' },
      subject: issueSubject(issueClient([edited])),
      builders: builders(),
    });

    const message = result.messages.find(
      (candidate) => candidate.id === commentMessageId(1)
    );
    expect(message?.metadata).toEqual({
      dateSent: new Date('2026-09-02T00:00:00Z'),
      edited: true,
      editedAt: new Date('2026-09-03T00:00:00Z'),
    });
  });

  it('a comment never updated since it was created reports edited: false', async () => {
    const result = await fetchMessages({
      threadId: THREAD_ID,
      options: { limit: 2, direction: 'backward' },
      subject: issueSubject(issueClient(makeComments(1))),
      builders: builders(),
    });

    const message = result.messages.find(
      (candidate) => candidate.id === commentMessageId(1)
    );
    expect(message?.metadata.edited).toBe(false);
  });

  it("a comment's raw carries the REST comment and its changeLog as changes", async () => {
    const withChange = issueComment({
      id: 1,
      changeLog: [
        {
          field: 'status',
          newValue: 'Closed',
          originalValue: 'Open',
          attachmentInfo: null,
        },
      ],
    });
    const result = await fetchMessages({
      threadId: THREAD_ID,
      options: { limit: 2, direction: 'backward' },
      subject: issueSubject(issueClient([withChange])),
      builders: builders(),
    });

    const message = result.messages.find(
      (candidate) => candidate.id === commentMessageId(1)
    );
    expect(message?.raw).toEqual({
      kind: 'comment',
      host: HOST,
      projectId: PROJECT_ID,
      subject: ISSUE_REF,
      comment: withChange,
      changes: [{ field: 'status', newValue: 'Closed', oldValue: 'Open' }],
    });
  });

  it('the issue root reports edited: false even after the issue was updated', async () => {
    const result = await fetchMessages({
      threadId: THREAD_ID,
      options: { limit: 1, direction: 'backward' },
      subject: issueSubject(
        stubClient({
          getIssue: vi
            .fn()
            .mockResolvedValue(issue({ updated: '2026-09-05T00:00:00Z' })),
          getIssueComments: commentList([]),
        })
      ),
      builders: builders(),
    });

    const root = result.messages.find(
      (message) => message.id === ROOT_MESSAGE_ID
    );
    expect(root?.metadata.edited).toBe(false);
  });
});

describe('fetchMessage', () => {
  it('returns the issue root for a root id', async () => {
    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: ROOT_MESSAGE_ID,
      subject: issueSubject(issueClient()),
      builders: async () => builders(),
    });

    expect(message?.text).toBe(`${ROOT.summary}\n\n${ROOT.description}`);
  });

  it('returns a comment for a comment id', async () => {
    const getIssueComment = vi
      .fn()
      .mockResolvedValue(issueComment({ id: 2, content: 'Comment 2' }));
    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: commentMessageId(2),
      subject: issueSubject(stubClient({ getIssueComment })),
      builders: async () => builders(),
    });

    expect(getIssueComment).toHaveBeenCalledWith(ISSUE_ID, 2);
    expect(message?.id).toBe(commentMessageId(2));
    expect(message?.text).toBe('Comment 2');
  });

  it('a message id from another issue is null without an API call, the bot identity included', async () => {
    const resolveBuilders = vi.fn(async () => builders());

    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: encodeMessageId({
        host: HOST,
        subject: { kind: 'issue', issueId: 9999 },
        part: 'comment',
        commentId: 1,
      }),
      subject: issueSubject(stubClient({})),
      builders: resolveBuilders,
    });

    expect(message).toBeNull();
    expect(resolveBuilders).not.toHaveBeenCalled();
  });

  it('a fieldchange update id is null, since no single-fetch API exists for it', async () => {
    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: encodeMessageId({
        host: HOST,
        subject: ISSUE_REF,
        part: 'update',
        created: '2026-09-03T04:05:06Z',
      }),
      subject: issueSubject(stubClient({})),
      builders: async () => builders(),
    });

    expect(message).toBeNull();
  });

  it('a comment Backlog does not find is null', async () => {
    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: commentMessageId(999),
      subject: issueSubject(
        stubClient({
          getIssueComment: vi
            .fn()
            .mockRejectedValue(
              new ResourceNotFoundError('backlog', 'comment', '999')
            ),
        })
      ),
      builders: async () => builders(),
    });

    expect(message).toBeNull();
  });
});

describe('fetchThread', () => {
  it('resolves the issue as a ThreadInfo', async () => {
    const thread = await fetchThread({
      threadId: THREAD_ID,
      subject: issueSubject(issueClient()),
      names: {},
    });

    expect(thread).toMatchObject({
      id: THREAD_ID,
      channelId: CHANNEL_ID,
      channelName: REST.projectKey,
      isDM: false,
    });
    expect(thread.metadata).toMatchObject({
      issueKey: REST.issueKey,
      summary: ROOT.summary,
      url: `https://${HOST}/view/${REST.issueKey}`,
    });
  });
});

describe('fetchSubject', () => {
  it("the subject of a comment is its thread's root, read from Backlog", async () => {
    const getIssue = vi.fn().mockResolvedValue(issue({ assignee: ALICE }));
    const subject = issueSubject(stubClient({ getIssue }));

    const resolved = await fetchSubject({
      raw: {
        kind: 'comment',
        host: HOST,
        projectId: PROJECT_ID,
        subject: ISSUE_REF,
        comment: issueComment(),
        changes: [],
      },
      subject,
      names: {},
      threadId: THREAD_ID,
    });

    expect(getIssue).toHaveBeenCalledWith(ISSUE_ID);
    expect(resolved).toMatchObject({
      id: THREAD_ID,
      type: 'issue',
      title: ROOT.summary,
      description: ROOT.description,
      status: ROOT.status.name,
      author: { id: `${HOST}:${BOB.id}`, name: BOB.name },
      assignee: { id: `${HOST}:${ALICE.id}`, name: ALICE.name },
      url: `https://${HOST}/view/${REST.issueKey}`,
    });
  });

  it('a raw that carries its root is resolved without a read, and an unassigned subject has no assignee', async () => {
    const resolved = await fetchSubject({
      raw: { kind: 'issue', host: HOST, issue: ROOT, changes: [] },
      subject: issueSubject(stubClient({})),
      names: {},
      threadId: THREAD_ID,
    });

    expect(resolved.title).toBe(ROOT.summary);
    expect(resolved).not.toHaveProperty('assignee');
  });
});

describe('rehydrateAttachment', () => {
  const pullRequestAttachmentUrl = (host: string) =>
    `https://${host}/api/v2/projects/${PROJECT_ID}/git/repositories/${REST.repositoryId}/pullRequests/${REST.pullRequestNumber}/attachments/4242`;

  it('a serialised attachment regains fetchData through the client for the configured host', async () => {
    const getPullRequestAttachment = vi
      .fn()
      .mockResolvedValue(fileData('trace'));
    const rehydrated = rehydrateAttachment({
      attachment: {
        type: 'file',
        name: 'trace.log',
        url: pullRequestAttachmentUrl(HOST),
      },
      host: HOST,
      client: stubClient({ getPullRequestAttachment }),
    });

    const data = await rehydrated.fetchData?.();
    expect(data?.toString()).toBe('trace');
    expect(getPullRequestAttachment).toHaveBeenCalledTimes(1);
  });

  it('an attachment url on a foreign host is returned unchanged', () => {
    const attachment: Attachment = {
      type: 'file',
      name: 'trace.log',
      url: pullRequestAttachmentUrl(OTHER_HOST),
    };

    expect(
      rehydrateAttachment({ attachment, host: HOST, client: stubClient({}) })
    ).toEqual(attachment);
  });

  it('an attachment with no url is returned unchanged', () => {
    const attachment: Attachment = { type: 'file', name: 'trace.log' };

    expect(
      rehydrateAttachment({ attachment, host: HOST, client: stubClient({}) })
    ).toEqual(attachment);
  });
});
