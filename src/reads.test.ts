import { ValidationError } from '@chat-adapter/shared';
import { Message as MessageCtor } from 'chat';
import { describe, expect, it, vi } from 'vitest';

import { createInMemoryBacklogApi } from './client/in-memory';
import { encodeMessageId } from './ids';
import {
  fetchMessage,
  fetchMessages,
  fetchSubject,
  fetchThread,
  rehydrateAttachment,
} from './reads';
import { subjectClientFor } from './subject/client';

import type {
  BacklogApi,
  BacklogComment,
  BacklogIssue,
  BacklogIssueComment,
  BacklogProject,
  BacklogPullRequest,
  ListCommentsOptions,
} from './client/port';
import type { MessageBuilders } from './reads';
import type { SubjectClient } from './subject/client';
import type { BacklogSubjectRef } from './types';
import type {
  Attachment,
  FetchDirection,
  FetchOptions,
  MessageData,
} from 'chat';

const HOST = 'example.backlog.com';
const OTHER_HOST = 'other.backlog.jp';
const PROJECT_ID = 500;
const ISSUE_ID = 8001;
const REPOSITORY_ID = 700;
const REPOSITORY_NAME = 'example-repo';
const PULL_REQUEST_NUMBER = 12;
const PULL_REQUEST_ID = 90001;

const ISSUE_REF: BacklogSubjectRef = { kind: 'issue', issueId: ISSUE_ID };
const PULL_REQUEST_REF: BacklogSubjectRef = {
  kind: 'pullRequest',
  repositoryId: REPOSITORY_ID,
  number: PULL_REQUEST_NUMBER,
};

const THREAD_ID = `backlog:${HOST}:${PROJECT_ID}:issue:${ISSUE_ID}`;
const PULL_REQUEST_THREAD_ID = `backlog:${HOST}:${PROJECT_ID}:pr:${REPOSITORY_ID}:${PULL_REQUEST_NUMBER}`;
const CHANNEL_ID = `backlog:${HOST}:${PROJECT_ID}`;
const ALICE = { id: 100, userId: 'alice', name: 'Alice', mailAddress: null };

const ROOT_CREATED = new Date('2026-01-01T00:00:00Z');

/**
 * Pull-request comment ids are 7-digit where issue comment ids are small: the
 * two sequences are separate on a real space and may overlap (measured
 * 2026-09-06, `.claude/rules/backlog-pull-request-facts.md`), which is why
 * every message id carries its subject's kind.
 */
const PULL_REQUEST_COMMENT_ID_BASE = 7_000_000;

const PROJECT: BacklogProject = {
  id: PROJECT_ID,
  projectKey: 'PROJECT',
  name: 'Project',
  textFormattingRule: 'markdown',
};

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
    createdUser: ALICE,
    created: ROOT_CREATED,
    updated: ROOT_CREATED,
    ...overrides,
  };
}

function basePullRequest(
  overrides: Partial<BacklogPullRequest> = {}
): BacklogPullRequest {
  return {
    id: PULL_REQUEST_ID,
    projectId: PROJECT_ID,
    repositoryId: REPOSITORY_ID,
    number: PULL_REQUEST_NUMBER,
    summary: 'Retry a 429 with the reset header',
    description: 'Backs off until X-RateLimit-Reset.',
    base: 'main',
    branch: 'retry-429',
    status: { id: 1, name: 'Open' },
    assignee: null,
    issue: null,
    baseCommit: null,
    branchCommit: null,
    mergeCommit: null,
    closeAt: null,
    mergeAt: null,
    createdUser: ALICE,
    created: ROOT_CREATED,
    updated: ROOT_CREATED,
    stars: [],
    ...overrides,
  };
}

/**
 * Strictly after the root's `created` (`ROOT_CREATED`) so a chronological sort
 * never ties the root against the first comment. Built from `.getTime() + ms`,
 * not `new Date(y, m, d, h, m, s)`, which constructs in the runner's local
 * timezone rather than UTC.
 */
function commentTimestamp(index: number): Date {
  return new Date(ROOT_CREATED.getTime() + (index + 1) * 60_000);
}

function makeComments(count: number): BacklogIssueComment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    issueId: ISSUE_ID,
    content: `Comment ${index + 1}`,
    changeLog: [],
    createdUser: ALICE,
    created: commentTimestamp(index),
    updated: commentTimestamp(index),
    stars: [],
  }));
}

function makePullRequestComments(count: number): BacklogComment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: PULL_REQUEST_COMMENT_ID_BASE + index + 1,
    content: `Comment ${index + 1}`,
    changeLog: [],
    createdUser: ALICE,
    created: commentTimestamp(index),
    updated: commentTimestamp(index),
    stars: [],
  }));
}

function apiWith(
  commentCount: number,
  issue: BacklogIssue = baseIssue()
): BacklogApi {
  return createInMemoryBacklogApi({
    projects: [PROJECT],
    issues: [issue],
    comments: makeComments(commentCount),
  });
}

function pullRequestApiWith(
  commentCount: number,
  pullRequest: BacklogPullRequest = basePullRequest()
): BacklogApi {
  return createInMemoryBacklogApi({
    projects: [PROJECT],
    repositories: [
      {
        id: REPOSITORY_ID,
        projectId: PROJECT_ID,
        name: REPOSITORY_NAME,
        description: '',
      },
    ],
    pullRequests: [pullRequest],
    pullRequestComments: {
      [`${REPOSITORY_ID}:${PULL_REQUEST_NUMBER}`]:
        makePullRequestComments(commentCount),
    },
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

function subjectOf(api: BacklogApi, ref: BacklogSubjectRef): SubjectClient {
  return subjectClientFor(api, ref, { host: HOST, projectId: PROJECT_ID });
}

/**
 * One thread of each kind, described by everything the §7.1 guarantees are
 * stated in terms of, so the same assertions run twice against the two
 * endpoint families Backlog serves comments from.
 */
interface SubjectFixture {
  kind: string;
  threadId: string;
  rootMessageId: string;
  commentId: (index: number) => number;
  commentMessageId: (commentId: number) => string;
  api: (commentCount: number) => BacklogApi;
  subject: (api: BacklogApi) => SubjectClient;
}

const ISSUE_FIXTURE: SubjectFixture = {
  kind: 'issue',
  threadId: THREAD_ID,
  rootMessageId: encodeMessageId({
    host: HOST,
    subject: ISSUE_REF,
    part: 'root',
  }),
  commentId: (index) => index + 1,
  commentMessageId: (commentId) =>
    encodeMessageId({
      host: HOST,
      subject: ISSUE_REF,
      part: 'comment',
      commentId,
    }),
  api: (commentCount) => apiWith(commentCount),
  subject: (api) => subjectOf(api, ISSUE_REF),
};

const PULL_REQUEST_FIXTURE: SubjectFixture = {
  kind: 'pull request',
  threadId: PULL_REQUEST_THREAD_ID,
  rootMessageId: encodeMessageId({
    host: HOST,
    subject: PULL_REQUEST_REF,
    part: 'root',
  }),
  commentId: (index) => PULL_REQUEST_COMMENT_ID_BASE + index + 1,
  commentMessageId: (commentId) =>
    encodeMessageId({
      host: HOST,
      subject: PULL_REQUEST_REF,
      part: 'comment',
      commentId,
    }),
  api: (commentCount) => pullRequestApiWith(commentCount),
  subject: (api) => subjectOf(api, PULL_REQUEST_REF),
};

const SUBJECT_FIXTURES = [ISSUE_FIXTURE, PULL_REQUEST_FIXTURE];

describe('fetchMessages cursor and threadId validation', () => {
  it.each([2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'a limit of %s is a validation error, not a 400 from Backlog',
    async (limit) => {
      const api = apiWith(5);

      await expect(
        fetchMessages({
          threadId: THREAD_ID,
          options: { limit },
          subject: subjectOf(api, ISSUE_REF),
          builders: builders(),
        })
      ).rejects.toThrow(ValidationError);
    }
  );

  it('a limit outside [1, 100] is clamped, not rejected', async () => {
    const api = apiWith(5);
    const result = await fetchMessages({
      threadId: THREAD_ID,
      options: { limit: 1000 },
      subject: subjectOf(api, ISSUE_REF),
      builders: builders(),
    });

    expect(result.messages).toHaveLength(6);
  });

  it('a malformed cursor is a validation error', async () => {
    const api = apiWith(5);
    await expect(
      fetchMessages({
        threadId: THREAD_ID,
        options: { cursor: 'not-a-number' },
        subject: subjectOf(api, ISSUE_REF),
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
        subject: subjectOf(api, ISSUE_REF),
        builders: builders(),
      })
    ).rejects.toThrow(ValidationError);
  });
});

describe('fetchMessages (§7.1 property sweep, one specification over both kinds)', () => {
  const limits = [1, 2, 3, 5, 50, 100];
  const commentCounts = [0, 1, 4, 7, 150];
  const directions = ['backward', 'forward'] as const;

  for (const fixture of SUBJECT_FIXTURES) {
    describe(`a ${fixture.kind} thread`, () => {
      for (const limit of limits) {
        for (const commentCount of commentCounts) {
          for (const direction of directions) {
            it(`limit=${limit} comments=${commentCount} direction=${direction}: pages are chronological, bounded and cover every message exactly once`, async () => {
              const api = fixture.api(commentCount);
              const subject = fixture.subject(api);
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
                  threadId: fixture.threadId,
                  options: fetchOptions(limit, cursor, direction),
                  subject,
                  builders: builders(),
                });

                expect(result.messages.length).toBeLessThanOrEqual(limit);

                const ids = result.messages.map((message) => message.id);
                const sortedByDate = [...result.messages].sort(
                  (a, b) =>
                    a.metadata.dateSent.getTime() -
                    b.metadata.dateSent.getTime()
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
              expect(seenIds.has(fixture.rootMessageId)).toBe(true);
              for (let index = 0; index < commentCount; index += 1) {
                expect(
                  seenIds.has(
                    fixture.commentMessageId(fixture.commentId(index))
                  )
                ).toBe(true);
              }
            });
          }
        }
      }
    });
  }

  it('backward paging ends with a page holding the issue body', async () => {
    const api = apiWith(4);
    const subject = subjectOf(api, ISSUE_REF);
    let cursor: string | undefined;
    let lastPageMessages: Awaited<
      ReturnType<typeof fetchMessages>
    >['messages'] = [];
    for (;;) {
      const result = await fetchMessages({
        threadId: THREAD_ID,
        options: fetchOptions(2, cursor, 'backward'),
        subject,
        builders: builders(),
      });
      lastPageMessages = result.messages;
      if (result.nextCursor === undefined) {
        break;
      }
      cursor = result.nextCursor;
    }
    expect(lastPageMessages).toHaveLength(1);
    expect(lastPageMessages[0]?.id).toBe(ISSUE_FIXTURE.rootMessageId);
  });

  it('backward paging of a pull request ends with a page holding its body', async () => {
    const api = pullRequestApiWith(4);
    const subject = subjectOf(api, PULL_REQUEST_REF);
    let cursor: string | undefined;
    let lastPageMessages: Awaited<
      ReturnType<typeof fetchMessages>
    >['messages'] = [];
    for (;;) {
      const result = await fetchMessages({
        threadId: PULL_REQUEST_THREAD_ID,
        options: fetchOptions(2, cursor, 'backward'),
        subject,
        builders: builders(),
      });
      lastPageMessages = result.messages;
      if (result.nextCursor === undefined) {
        break;
      }
      cursor = result.nextCursor;
    }
    expect(lastPageMessages).toHaveLength(1);
    expect(lastPageMessages[0]?.id).toBe(PULL_REQUEST_FIXTURE.rootMessageId);
    expect(lastPageMessages[0]?.text).toContain(
      'Retry a 429 with the reset header'
    );
  });

  it('forward paging starts with the issue body using one slot', async () => {
    const api = apiWith(4);
    const result = await fetchMessages({
      threadId: THREAD_ID,
      options: { limit: 3, direction: 'forward' },
      subject: subjectOf(api, ISSUE_REF),
      builders: builders(),
    });
    expect(result.messages[0]?.id).toBe(ISSUE_FIXTURE.rootMessageId);
    // limit 3, one slot for the root, so at most 2 comments follow.
    expect(result.messages.length).toBeLessThanOrEqual(3);
  });

  it('every comment appears exactly once across all pages', async () => {
    const api = apiWith(7);
    const subject = subjectOf(api, ISSUE_REF);
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const result = await fetchMessages({
        threadId: THREAD_ID,
        options: fetchOptions(3, cursor, 'backward'),
        subject,
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
      projects: [PROJECT],
      issues: [baseIssue()],
      comments: [
        {
          id: 1,
          issueId: ISSUE_ID,
          content: 'Edited content',
          changeLog: [],
          createdUser: ALICE,
          created: ROOT_CREATED,
          updated: editedAt,
          stars: [],
        },
      ],
    });

    const result = await fetchMessages({
      threadId: THREAD_ID,
      options: { limit: 2, direction: 'backward' },
      subject: subjectOf(api, ISSUE_REF),
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
      subject: subjectOf(api, ISSUE_REF),
      builders: builders(),
    });
    const root = result.messages.find(
      (message) => message.id === ISSUE_FIXTURE.rootMessageId
    );
    expect(root?.metadata.edited).toBe(false);
  });
});

describe('fetchMessage', () => {
  it('returns the issue root for an :r id', async () => {
    const api = apiWith(2);
    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: ISSUE_FIXTURE.rootMessageId,
      subject: subjectOf(api, ISSUE_REF),
      builders: async () => builders(),
    });
    expect(message?.text).toContain('Deploy fails on the staging space');
  });

  it('returns a comment for a :c id', async () => {
    const api = apiWith(2);
    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: ISSUE_FIXTURE.commentMessageId(1),
      subject: subjectOf(api, ISSUE_REF),
      builders: async () => builders(),
    });
    expect(message?.text).toBe('Comment 1');
  });

  it('a message id from another issue is null without an API call, the formatting rule included', async () => {
    const api = apiWith(2);
    const resolveBuilders = vi.fn(async () => builders());

    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: encodeMessageId({
        host: HOST,
        subject: { kind: 'issue', issueId: 9999 },
        part: 'comment',
        commentId: 1,
      }),
      subject: subjectOf(api, ISSUE_REF),
      builders: resolveBuilders,
    });

    expect(message).toBeNull();
    expect(resolveBuilders).not.toHaveBeenCalled();
  });

  it('a :u: id is null (no single-fetch API exists for it)', async () => {
    const api = apiWith(2);
    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: encodeMessageId({
        host: HOST,
        subject: ISSUE_REF,
        part: 'update',
        created: '2026-09-03T04:05:06Z',
      }),
      subject: subjectOf(api, ISSUE_REF),
      builders: async () => builders(),
    });
    expect(message).toBeNull();
  });

  it('a 404 from the API is null', async () => {
    const api = apiWith(2);
    const message = await fetchMessage({
      threadId: THREAD_ID,
      messageId: ISSUE_FIXTURE.commentMessageId(999),
      subject: subjectOf(api, ISSUE_REF),
      builders: async () => builders(),
    });
    expect(message).toBeNull();
  });

  it('a single pull request comment is fetched through a one-element window', async () => {
    const api = pullRequestApiWith(4);
    const windows: ListCommentsOptions[] = [];
    const recording: BacklogApi = {
      ...api,
      listPullRequestComments(ref, options) {
        windows.push(options);
        return api.listPullRequestComments(ref, options);
      },
    };
    const commentId = PULL_REQUEST_FIXTURE.commentId(1);

    const message = await fetchMessage({
      threadId: PULL_REQUEST_THREAD_ID,
      messageId: PULL_REQUEST_FIXTURE.commentMessageId(commentId),
      subject: subjectOf(recording, PULL_REQUEST_REF),
      builders: async () => builders(),
    });

    expect(message?.text).toBe('Comment 2');
    expect(windows).toEqual([
      { minId: commentId - 1, maxId: commentId + 1, count: 1, order: 'desc' },
    ]);
  });
});

describe('fetchThread', () => {
  it('resolves the issue as a ThreadInfo', async () => {
    const api = apiWith(0);
    const thread = await fetchThread({
      threadId: THREAD_ID,
      subject: subjectOf(api, ISSUE_REF),
      names: {},
    });
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

describe('fetchSubject', () => {
  it('the subject of a pull request comment is the pull request', async () => {
    const api = pullRequestApiWith(1);
    const subject = subjectOf(api, PULL_REQUEST_REF);
    const commentId = PULL_REQUEST_FIXTURE.commentId(0);
    const message = await fetchMessage({
      threadId: PULL_REQUEST_THREAD_ID,
      messageId: PULL_REQUEST_FIXTURE.commentMessageId(commentId),
      subject,
      builders: async () => builders(),
    });
    if (message === null) {
      throw new Error('the pull request comment was not returned');
    }

    const resolved = await fetchSubject({
      raw: message.raw,
      subject,
      names: { projectKey: 'PROJECT', repositoryName: REPOSITORY_NAME },
      threadId: PULL_REQUEST_THREAD_ID,
    });

    expect(resolved).toMatchObject({
      id: PULL_REQUEST_THREAD_ID,
      type: 'pull_request',
      title: 'Retry a 429 with the reset header',
      status: 'Open',
      url: `https://${HOST}/git/PROJECT/${REPOSITORY_NAME}/pullRequests/${PULL_REQUEST_NUMBER}`,
    });
    expect(resolved.labels).toEqual(['Open', 'main ← retry-429']);
  });
});

describe('rehydrateAttachment', () => {
  const pullRequestAttachmentUrl = (host: string) =>
    `https://${host}/api/v2/projects/${PROJECT_ID}/git/repositories/${REPOSITORY_ID}/pullRequests/${PULL_REQUEST_NUMBER}/attachments/4242`;

  it('a serialised pull request attachment regains fetchData for a configured host', async () => {
    const downloadPullRequestAttachment = vi.fn().mockResolvedValue({
      filename: 'trace.log',
      contentType: 'text/plain',
      data: Buffer.from('trace'),
    });
    const api = vi.fn(
      () => ({ downloadPullRequestAttachment }) as unknown as BacklogApi
    );
    const rehydrated = rehydrateAttachment({
      attachment: {
        type: 'file',
        name: 'trace.log',
        url: pullRequestAttachmentUrl(HOST),
      },
      host: HOST,
      api,
    });

    const data = await rehydrated.fetchData?.();
    expect(data?.toString()).toBe('trace');
    expect(api).toHaveBeenCalledTimes(1);
    expect(downloadPullRequestAttachment).toHaveBeenCalledWith(
      {
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        number: PULL_REQUEST_NUMBER,
      },
      4242
    );
  });

  it('a pull request attachment url on a foreign host is returned unchanged', () => {
    const attachment: Attachment = {
      type: 'file',
      name: 'trace.log',
      url: pullRequestAttachmentUrl(OTHER_HOST),
    };
    expect(
      rehydrateAttachment({
        attachment,
        host: HOST,
        api: () => {
          throw new Error('no download expected');
        },
      })
    ).toEqual(attachment);
  });
});
