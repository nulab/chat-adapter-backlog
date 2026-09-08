import { ValidationError } from '@chat-adapter/shared';
import { createMockLogger } from '@chat-adapter/tests';
import { describe, expect, it } from 'vitest';

import {
  addReaction,
  bufferStream,
  editComment,
  extractNotifiedUserId,
  postComment,
  removeReaction,
  requireCommentInThread,
  resolveSummaryAndDescription,
  uploadFiles,
} from './egress';
import { createInMemoryBacklogApi } from './client/in-memory';
import { converterFor } from './format/fallback';
import { encodeMessageId } from './ids';
import { subjectClientFor } from './subject/client';
import type { InMemoryBacklogApi } from './client/in-memory';
import type { BacklogComment } from './client/port';
import type { SubjectClient } from './subject/client';
import type { BacklogPostableExtras, BacklogSubjectRef } from './types';
import type { CardElement, PostableMarkdown } from 'chat';

const HOST = 'example.backlog.com';
const PROJECT_ID = 500;
const ISSUE_ID = 8001;
const REPOSITORY_ID = 700;
const PULL_REQUEST_NUMBER = 12;
const PULL_REQUEST_ID = 90001;
const PULL_REQUEST_KEY = `${REPOSITORY_ID}:${PULL_REQUEST_NUMBER}`;
const PULL_REQUEST_COMMENT_ID = 7000001;
const BOT_USER_ID = 999;
const ALICE = { id: 100, userId: 'alice', name: 'Alice', mailAddress: null };
const BOB = { id: 101, userId: 'bob', name: 'Bob', mailAddress: null };
const CHATBOT = {
  id: BOT_USER_ID,
  userId: 'chatbot',
  name: 'Chatbot',
  mailAddress: null,
};

const ISSUE: BacklogSubjectRef = { kind: 'issue', issueId: ISSUE_ID };
const PULL_REQUEST: BacklogSubjectRef = {
  kind: 'pullRequest',
  repositoryId: REPOSITORY_ID,
  number: PULL_REQUEST_NUMBER,
};

const THREAD_ID = `backlog:${HOST}:${PROJECT_ID}:issue:${ISSUE_ID}`;
const PULL_REQUEST_THREAD_ID = `backlog:${HOST}:${PROJECT_ID}:pr:${REPOSITORY_ID}:${PULL_REQUEST_NUMBER}`;

function api(overrides: Parameters<typeof createInMemoryBacklogApi>[0] = {}) {
  return createInMemoryBacklogApi({
    projects: [
      {
        id: PROJECT_ID,
        projectKey: 'PROJECT',
        name: 'Project',
        textFormattingRule: 'markdown',
      },
    ],
    issues: [
      {
        id: ISSUE_ID,
        projectId: PROJECT_ID,
        issueKey: 'PROJECT-1',
        summary: 'Deploy fails',
        description: '',
        issueType: { id: 1, name: 'Task' },
        priority: { id: 3, name: 'Normal' },
        status: { id: 1, name: 'Open' },
        assignee: null,
        createdUser: ALICE,
        created: new Date('2026-01-01T00:00:00Z'),
        updated: new Date('2026-01-01T00:00:00Z'),
      },
    ],
    repositories: [
      {
        id: REPOSITORY_ID,
        projectId: PROJECT_ID,
        name: 'example-repo',
        description: '',
      },
    ],
    pullRequests: [
      {
        id: PULL_REQUEST_ID,
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        number: PULL_REQUEST_NUMBER,
        summary: 'Fix the deploy',
        description: '',
        base: 'main',
        branch: 'fix-deploy',
        status: { id: 1, name: 'Open' },
        assignee: null,
        issue: null,
        baseCommit: null,
        branchCommit: null,
        mergeCommit: null,
        closeAt: null,
        mergeAt: null,
        createdUser: ALICE,
        created: new Date('2026-01-01T00:00:00Z'),
        updated: new Date('2026-01-01T00:00:00Z'),
        stars: [],
      },
    ],
    ...overrides,
  });
}

function subjectOf(
  backlogApi: InMemoryBacklogApi,
  ref: BacklogSubjectRef
): SubjectClient {
  return subjectClientFor(backlogApi, ref, {
    host: HOST,
    projectId: PROJECT_ID,
  });
}

function markdownConverter() {
  return converterFor('markdown', createMockLogger(), {
    host: HOST,
    projectId: PROJECT_ID,
  });
}

function notationConverter() {
  return converterFor('backlog', createMockLogger(), {
    host: HOST,
    projectId: PROJECT_ID,
  });
}

/** A card bold in both places a card puts bold: title and field label. */
const CARD: CardElement = {
  type: 'card',
  title: 'Deploy failed',
  subtitle: 'staging',
  children: [
    { type: 'text', content: 'The deploy job exited 1.' },
    {
      type: 'fields',
      children: [
        { type: 'field', label: 'Environment', value: 'production' },
        { type: 'field', label: 'Attempt', value: '3' },
      ],
    },
  ],
};

function pullRequestComment(
  overrides: Partial<BacklogComment> = {}
): BacklogComment {
  return {
    id: PULL_REQUEST_COMMENT_ID,
    content: 'Any progress?',
    changeLog: [],
    createdUser: ALICE,
    created: new Date('2026-01-01T00:00:00Z'),
    updated: new Date('2026-01-01T00:00:00Z'),
    stars: [],
    ...overrides,
  };
}

describe('requireCommentInThread', () => {
  it('the issue body cannot be edited', () => {
    const rootId = encodeMessageId({
      host: HOST,
      subject: ISSUE,
      part: 'root',
    });
    expect(() => requireCommentInThread(THREAD_ID, rootId, 'edited')).toThrow(
      ValidationError
    );
    expect(() => requireCommentInThread(THREAD_ID, rootId, 'edited')).toThrow(
      /is not a comment and cannot be edited/
    );
  });

  it('a fieldchange update with no comment cannot be deleted', () => {
    const updateId = encodeMessageId({
      host: HOST,
      subject: ISSUE,
      part: 'update',
      created: '2026-09-03T04:05:06Z',
    });
    expect(() =>
      requireCommentInThread(THREAD_ID, updateId, 'deleted')
    ).toThrow(ValidationError);
  });

  it.each([
    {
      label: 'issue',
      threadId: THREAD_ID,
      subject: ISSUE,
      commentId: 42,
      projectId: PROJECT_ID,
    },
    {
      label: 'pull request',
      threadId: PULL_REQUEST_THREAD_ID,
      subject: PULL_REQUEST,
      commentId: PULL_REQUEST_COMMENT_ID,
      projectId: PROJECT_ID,
    },
  ])(
    'a comment id resolves its host, project, subject and comment on a $label thread',
    ({ threadId, subject, commentId, projectId }) => {
      const messageId = encodeMessageId({
        host: HOST,
        subject,
        part: 'comment',
        commentId,
      });
      expect(requireCommentInThread(threadId, messageId, 'starred')).toEqual({
        host: HOST,
        projectId,
        subject,
        commentId,
      });
    }
  );

  it('a message id naming another subject is rejected', () => {
    const messageId = encodeMessageId({
      host: HOST,
      subject: PULL_REQUEST,
      part: 'comment',
      commentId: PULL_REQUEST_COMMENT_ID,
    });
    expect(() =>
      requireCommentInThread(THREAD_ID, messageId, 'deleted')
    ).toThrow(/does not name a message in thread/);
  });

  it('a message id naming another space is rejected', () => {
    const messageId = encodeMessageId({
      host: 'other.backlog.jp',
      subject: ISSUE,
      part: 'comment',
      commentId: 42,
    });
    expect(() =>
      requireCommentInThread(THREAD_ID, messageId, 'edited')
    ).toThrow(/does not name a message in thread/);
  });
});

describe('extractNotifiedUserId', () => {
  it('a mistyped notifiedUserId is a validation error', () => {
    const message = {
      markdown: 'hi',
      notifiedUserId: ['not-a-number'],
    } as unknown as Parameters<typeof extractNotifiedUserId>[0];
    expect(() => extractNotifiedUserId(message)).toThrow(ValidationError);
  });

  it('a negative notifiedUserId is a validation error', () => {
    const message = {
      markdown: 'hi',
      notifiedUserId: [-1],
    } as unknown as Parameters<typeof extractNotifiedUserId>[0];
    expect(() => extractNotifiedUserId(message)).toThrow(ValidationError);
  });

  it('a well-typed notifiedUserId passes through', () => {
    const message: PostableMarkdown & BacklogPostableExtras = {
      markdown: 'hi',
      notifiedUserId: [100, 101],
    };
    expect(extractNotifiedUserId(message)).toEqual([100, 101]);
  });

  it('a postable without notifiedUserId has no extras', () => {
    expect(extractNotifiedUserId({ markdown: 'hi' })).toBeUndefined();
  });

  it('a string postable has no extras', () => {
    expect(extractNotifiedUserId('hi')).toBeUndefined();
  });
});

describe('postComment', () => {
  it('a reply is posted as a comment on the issue', async () => {
    const backlogApi = api();
    const result = await postComment({
      host: HOST,
      projectId: PROJECT_ID,
      subject: subjectOf(backlogApi, ISSUE),
      api: backlogApi,
      converter: markdownConverter(),
      message: { markdown: 'Any progress?' },
      toBuffer: () => Promise.reject(new Error('no files expected')),
    });

    expect(result.threadId).toBe(
      `backlog:${HOST}:${PROJECT_ID}:issue:${ISSUE_ID}`
    );
    expect(backlogApi.state.recordedInputs).toContainEqual({
      method: 'addComment',
      issueId: ISSUE_ID,
      input: { content: 'Any progress?' },
    });
  });

  it('a reply on a pull request thread is posted as a pull request comment', async () => {
    const backlogApi = api();
    const result = await postComment({
      host: HOST,
      projectId: PROJECT_ID,
      subject: subjectOf(backlogApi, PULL_REQUEST),
      api: backlogApi,
      converter: markdownConverter(),
      message: { markdown: 'Any progress?' },
      toBuffer: () => Promise.reject(new Error('no files expected')),
    });

    expect(result.threadId).toBe(
      `backlog:${HOST}:${PROJECT_ID}:pr:${REPOSITORY_ID}:${PULL_REQUEST_NUMBER}`
    );
    expect(backlogApi.state.recordedInputs).toEqual([
      {
        method: 'addPullRequestComment',
        ref: {
          projectId: PROJECT_ID,
          repositoryId: REPOSITORY_ID,
          number: PULL_REQUEST_NUMBER,
        },
        input: { content: 'Any progress?' },
      },
    ]);
  });

  it('files are uploaded and attached to the comment', async () => {
    const backlogApi = api();
    await postComment({
      host: HOST,
      projectId: PROJECT_ID,
      subject: subjectOf(backlogApi, ISSUE),
      api: backlogApi,
      converter: markdownConverter(),
      message: {
        markdown: 'See attached',
        files: [{ filename: 'notes.txt', data: Buffer.from('hello') }],
      },
      toBuffer: (file) => Promise.resolve(Buffer.from(String(file.data))),
    });

    expect(backlogApi.state.uploads).toHaveLength(1);
    expect(backlogApi.state.uploads[0]).toMatchObject({ name: 'notes.txt' });
    const addCommentInput = backlogApi.state.recordedInputs.find(
      (input) => input.method === 'addComment'
    );
    expect(addCommentInput).toMatchObject({
      input: { attachmentId: [backlogApi.state.uploads[0]?.id] },
    });
  });

  it('a failed comment call rejects instead of returning a synthetic message', async () => {
    const backlogApi = api();
    backlogApi.addComment = () => Promise.reject(new Error('boom'));
    await expect(
      postComment({
        host: HOST,
        projectId: PROJECT_ID,
        subject: subjectOf(backlogApi, ISSUE),
        api: backlogApi,
        converter: markdownConverter(),
        message: 'hi',
        toBuffer: () => Promise.reject(new Error('no files expected')),
      })
    ).rejects.toThrow('boom');
  });

  it('never mutates the caller-supplied message object', async () => {
    const backlogApi = api();
    const message = { markdown: 'Any progress?', notifiedUserId: [100] };
    const snapshot = { ...message };
    await postComment({
      host: HOST,
      projectId: PROJECT_ID,
      subject: subjectOf(backlogApi, ISSUE),
      api: backlogApi,
      converter: markdownConverter(),
      message,
      toBuffer: () => Promise.reject(new Error('no files expected')),
    });
    expect(message).toEqual(snapshot);
  });

  it('a card comment on a Markdown project is bold with asterisks', async () => {
    const backlogApi = api();

    await postComment({
      host: HOST,
      projectId: PROJECT_ID,
      subject: subjectOf(backlogApi, ISSUE),
      api: backlogApi,
      converter: markdownConverter(),
      message: CARD,
      toBuffer: () => Promise.reject(new Error('no files expected')),
    });

    expect(backlogApi.state.recordedInputs).toContainEqual({
      method: 'addComment',
      issueId: ISSUE_ID,
      input: {
        content: [
          '**Deploy failed**',
          'staging',
          'The deploy job exited 1.',
          '**Environment**: production',
          '**Attempt**: 3',
        ].join('\n'),
      },
    });
  });

  it("a card comment on a notation project uses '' and no asterisks", async () => {
    const backlogApi = api();

    await postComment({
      host: HOST,
      projectId: PROJECT_ID,
      subject: subjectOf(backlogApi, ISSUE),
      api: backlogApi,
      converter: notationConverter(),
      message: CARD,
      toBuffer: () => Promise.reject(new Error('no files expected')),
    });

    const [posted] = backlogApi.state.recordedInputs;
    expect(posted).toEqual({
      method: 'addComment',
      issueId: ISSUE_ID,
      input: {
        content: [
          "''Deploy failed''",
          'staging',
          'The deploy job exited 1.',
          "''Environment'': production",
          "''Attempt'': 3",
        ].join('\n'),
      },
    });
    expect(JSON.stringify(posted)).not.toContain('*');
  });

  it('a caller-supplied fallback text is posted verbatim', async () => {
    for (const converter of [markdownConverter(), notationConverter()]) {
      const backlogApi = api();

      await postComment({
        host: HOST,
        projectId: PROJECT_ID,
        subject: subjectOf(backlogApi, ISSUE),
        api: backlogApi,
        converter,
        message: { card: CARD, fallbackText: 'Deploy failed on staging' },
        toBuffer: () => Promise.reject(new Error('no files expected')),
      });

      expect(backlogApi.state.recordedInputs).toContainEqual({
        method: 'addComment',
        issueId: ISSUE_ID,
        input: { content: 'Deploy failed on staging' },
      });
    }
  });
});

describe('resolveSummaryAndDescription', () => {
  it("a card's summary is the plain-text title under either rule", () => {
    for (const converter of [markdownConverter(), notationConverter()]) {
      expect(resolveSummaryAndDescription(CARD, converter).summary).toBe(
        'Deploy failed'
      );
    }
  });

  it("a card's description is rendered in the project's own markup", () => {
    expect(resolveSummaryAndDescription(CARD, markdownConverter())).toEqual({
      summary: 'Deploy failed',
      description: [
        'staging',
        'The deploy job exited 1.',
        '**Environment**: production',
        '**Attempt**: 3',
      ].join('\n'),
    });

    expect(resolveSummaryAndDescription(CARD, notationConverter())).toEqual({
      summary: 'Deploy failed',
      description: [
        'staging',
        'The deploy job exited 1.',
        "''Environment'': production",
        "''Attempt'': 3",
      ].join('\n'),
    });
  });

  it("a caller-supplied fallback text's first line is the summary", () => {
    expect(
      resolveSummaryAndDescription(
        { card: CARD, fallbackText: 'Deploy failed\nstaging, attempt 3' },
        notationConverter()
      )
    ).toEqual({ summary: 'Deploy failed', description: 'staging, attempt 3' });
  });
});

describe('editComment', () => {
  it('renders the postable and updates the comment', async () => {
    const backlogApi = api({
      comments: [
        {
          id: 1,
          issueId: ISSUE_ID,
          content: 'Original',
          changeLog: [],
          createdUser: CHATBOT,
          created: new Date('2026-01-01T00:00:00Z'),
          updated: new Date('2026-01-01T00:00:00Z'),
          stars: [],
        },
      ],
    });
    const result = await editComment({
      host: HOST,
      projectId: PROJECT_ID,
      subject: subjectOf(backlogApi, ISSUE),
      commentId: 1,
      converter: markdownConverter(),
      message: { markdown: 'Edited' },
    });
    expect(result.id).toBe(
      encodeMessageId({
        host: HOST,
        subject: ISSUE,
        part: 'comment',
        commentId: 1,
      })
    );
    expect(backlogApi.state.comments.find((c) => c.id === 1)?.content).toBe(
      'Edited'
    );
  });

  it('editing a pull request comment updates it through the pull request endpoint', async () => {
    const backlogApi = api({
      pullRequestComments: {
        [PULL_REQUEST_KEY]: [
          pullRequestComment({ content: 'Original', createdUser: CHATBOT }),
        ],
      },
    });
    const result = await editComment({
      host: HOST,
      projectId: PROJECT_ID,
      subject: subjectOf(backlogApi, PULL_REQUEST),
      commentId: PULL_REQUEST_COMMENT_ID,
      converter: markdownConverter(),
      message: { markdown: 'Edited' },
    });
    expect(result.id).toBe(
      encodeMessageId({
        host: HOST,
        subject: PULL_REQUEST,
        part: 'comment',
        commentId: PULL_REQUEST_COMMENT_ID,
      })
    );
    expect(backlogApi.state.recordedInputs).toContainEqual({
      method: 'updatePullRequestComment',
      ref: {
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        number: PULL_REQUEST_NUMBER,
      },
      commentId: PULL_REQUEST_COMMENT_ID,
      content: 'Edited',
    });
    expect(
      backlogApi.state.pullRequestComments[PULL_REQUEST_KEY]?.[0]?.content
    ).toBe('Edited');
  });

  it('rejects files on an edit', async () => {
    const backlogApi = api();
    await expect(
      editComment({
        host: HOST,
        projectId: PROJECT_ID,
        subject: subjectOf(backlogApi, ISSUE),
        commentId: 1,
        converter: markdownConverter(),
        message: {
          markdown: 'x',
          files: [{ filename: 'a.txt', data: Buffer.from('a') }],
        },
      })
    ).rejects.toThrow(ValidationError);
  });

  it('rejects notifiedUserId on an edit', async () => {
    const backlogApi = api();
    const message: PostableMarkdown & BacklogPostableExtras = {
      markdown: 'x',
      notifiedUserId: [100],
    };
    await expect(
      editComment({
        host: HOST,
        projectId: PROJECT_ID,
        subject: subjectOf(backlogApi, ISSUE),
        commentId: 1,
        converter: markdownConverter(),
        message,
      })
    ).rejects.toThrow(ValidationError);
  });
});

describe('addReaction', () => {
  function seededComment() {
    return {
      id: 1,
      issueId: ISSUE_ID,
      content: 'Any progress?',
      changeLog: [],
      createdUser: ALICE,
      created: new Date('2026-01-01T00:00:00Z'),
      updated: new Date('2026-01-01T00:00:00Z'),
      stars: [] as {
        id: number;
        comment: null;
        url: string;
        title: string;
        presenter: {
          id: number;
          userId: string | null;
          name: string;
          mailAddress: string | null;
        };
        created: Date;
      }[],
    };
  }

  it('adding a reaction twice stars the comment once', async () => {
    const backlogApi = api({ comments: [seededComment()] });
    await addReaction({
      api: backlogApi,
      subject: subjectOf(backlogApi, ISSUE),
      commentId: 1,
      botUserId: BOT_USER_ID,
    });
    await addReaction({
      api: backlogApi,
      subject: subjectOf(backlogApi, ISSUE),
      commentId: 1,
      botUserId: BOT_USER_ID,
    });

    expect(
      backlogApi.state.recordedInputs.filter(
        (input) => input.method === 'addStar'
      )
    ).toEqual([{ method: 'addStar', target: { commentId: 1 } }]);
  });

  it('reacting to a pull request comment stars it as a pull request comment', async () => {
    const backlogApi = api({
      pullRequestComments: { [PULL_REQUEST_KEY]: [pullRequestComment()] },
    });
    await addReaction({
      api: backlogApi,
      subject: subjectOf(backlogApi, PULL_REQUEST),
      commentId: PULL_REQUEST_COMMENT_ID,
      botUserId: BOT_USER_ID,
    });

    expect(
      backlogApi.state.recordedInputs.filter(
        (input) => input.method === 'addStar'
      )
    ).toEqual([
      {
        method: 'addStar',
        target: { pullRequestCommentId: PULL_REQUEST_COMMENT_ID },
      },
    ]);
  });
});

describe('removeReaction', () => {
  it("removing a reaction leaves other users' stars", async () => {
    const backlogApi = api({
      comments: [
        {
          id: 1,
          issueId: ISSUE_ID,
          content: 'Any progress?',
          changeLog: [],
          createdUser: ALICE,
          created: new Date('2026-01-01T00:00:00Z'),
          updated: new Date('2026-01-01T00:00:00Z'),
          stars: [
            {
              id: 1,
              comment: null,
              url: '',
              title: '',
              presenter: CHATBOT,
              created: new Date('2026-01-01T00:00:00Z'),
            },
            {
              id: 2,
              comment: null,
              url: '',
              title: '',
              presenter: BOB,
              created: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        },
      ],
    });

    await removeReaction({
      api: backlogApi,
      subject: subjectOf(backlogApi, ISSUE),
      commentId: 1,
      botUserId: BOT_USER_ID,
    });

    const remaining = backlogApi.state.comments.find((c) => c.id === 1)?.stars;
    expect(remaining?.map((star) => star.presenter.id)).toEqual([BOB.id]);
  });

  it('a comment with no bot star makes no delete call', async () => {
    const backlogApi = api({
      comments: [
        {
          id: 1,
          issueId: ISSUE_ID,
          content: 'Any progress?',
          changeLog: [],
          createdUser: ALICE,
          created: new Date('2026-01-01T00:00:00Z'),
          updated: new Date('2026-01-01T00:00:00Z'),
          stars: [
            {
              id: 2,
              comment: null,
              url: '',
              title: '',
              presenter: BOB,
              created: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        },
      ],
    });

    await removeReaction({
      api: backlogApi,
      subject: subjectOf(backlogApi, ISSUE),
      commentId: 1,
      botUserId: BOT_USER_ID,
    });

    expect(
      backlogApi.state.recordedInputs.filter(
        (input) => input.method === 'deleteStar'
      )
    ).toHaveLength(0);
  });

  it('deletes only the bot star when another user has also starred the comment', async () => {
    const backlogApi = api({
      comments: [
        {
          id: 1,
          issueId: ISSUE_ID,
          content: 'Any progress?',
          changeLog: [],
          createdUser: ALICE,
          created: new Date('2026-01-01T00:00:00Z'),
          updated: new Date('2026-01-01T00:00:00Z'),
          stars: [
            {
              id: 1,
              comment: null,
              url: '',
              title: '',
              presenter: BOB,
              created: new Date('2026-01-01T00:00:00Z'),
            },
            {
              id: 2,
              comment: null,
              url: '',
              title: '',
              presenter: CHATBOT,
              created: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        },
      ],
    });

    await removeReaction({
      api: backlogApi,
      subject: subjectOf(backlogApi, ISSUE),
      commentId: 1,
      botUserId: BOT_USER_ID,
    });

    expect(backlogApi.state.recordedInputs).toContainEqual({
      method: 'deleteStar',
      starId: 2,
    });
    expect(backlogApi.state.recordedInputs).not.toContainEqual({
      method: 'deleteStar',
      starId: 1,
    });
    const remaining = backlogApi.state.comments.find((c) => c.id === 1)?.stars;
    expect(remaining?.map((star) => star.presenter.id)).toEqual([BOB.id]);
  });
});

describe('bufferStream', () => {
  it('a streamed reply is posted once and never edited', async () => {
    async function* chunks() {
      yield 'Hello';
      yield { type: 'markdown_text' as const, text: ', world' };
      yield {
        type: 'task_update' as const,
        id: 't1',
        title: 'step',
        status: 'complete' as const,
      };
    }
    const buffered = await bufferStream(chunks(), undefined);
    expect(buffered).toBe('Hello, world');
  });

  it('an empty stream buffers to an empty string', async () => {
    async function* chunks(): AsyncIterable<string> {
      // no chunks
    }
    const buffered = await bufferStream(chunks(), undefined);
    expect(buffered).toBe('');
  });

  it('an aborted signal ends consumption and keeps what was buffered', async () => {
    const controller = new AbortController();
    async function* chunks() {
      yield 'first';
      controller.abort();
      yield 'never seen';
    }
    const buffered = await bufferStream(chunks(), controller.signal);
    expect(buffered).toBe('first');
  });
});

describe('uploadFiles', () => {
  it('abandons no upload but stops issuing new ones after a failure', async () => {
    const backlogApi = api();
    await expect(
      uploadFiles(
        backlogApi,
        [
          { filename: 'a.txt', data: Buffer.from('a') },
          { filename: 'b.txt', data: Buffer.from('b') },
        ],
        (file) =>
          file.filename === 'b.txt'
            ? Promise.reject(new Error('cannot read b'))
            : Promise.resolve(Buffer.from('a'))
      )
    ).rejects.toThrow('cannot read b');
    expect(backlogApi.state.uploads).toHaveLength(1);
  });
});
