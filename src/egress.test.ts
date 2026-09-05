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
  requireCommentId,
  uploadFiles,
} from './egress';
import { createInMemoryBacklogApi } from './client/in-memory';
import { converterFor } from './format/fallback';
import { encodeMessageId } from './ids';
import type { BacklogPostableExtras } from './types';
import type { PostableMarkdown } from 'chat';

const HOST = 'example.backlog.com';
const PROJECT_ID = 500;
const ISSUE_ID = 8001;
const BOT_USER_ID = 999;
const ALICE = { id: 100, userId: 'alice', name: 'Alice', mailAddress: null };
const BOB = { id: 101, userId: 'bob', name: 'Bob', mailAddress: null };
const CHATBOT = {
  id: BOT_USER_ID,
  userId: 'chatbot',
  name: 'Chatbot',
  mailAddress: null,
};

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
    ...overrides,
  });
}

function markdownConverter() {
  return converterFor('markdown', createMockLogger(), {
    host: HOST,
    projectId: PROJECT_ID,
  });
}

describe('requireCommentId', () => {
  it('the issue body cannot be edited', () => {
    const issueId = encodeMessageId({
      kind: 'issue',
      host: HOST,
      issueId: ISSUE_ID,
    });
    expect(() => requireCommentId(issueId, 'edited')).toThrow(ValidationError);
    expect(() => requireCommentId(issueId, 'edited')).toThrow(
      /is not a comment and cannot be edited/
    );
  });

  it('a fieldchange update with no comment cannot be deleted', () => {
    const updateId = encodeMessageId({
      kind: 'update',
      host: HOST,
      issueId: ISSUE_ID,
      created: '2026-09-03T04:05:06Z',
    });
    expect(() => requireCommentId(updateId, 'deleted')).toThrow(
      ValidationError
    );
  });

  it('a comment id resolves its host, issue and comment', () => {
    const commentId = encodeMessageId({
      kind: 'comment',
      host: HOST,
      issueId: ISSUE_ID,
      commentId: 42,
    });
    expect(requireCommentId(commentId, 'starred')).toEqual({
      host: HOST,
      issueId: ISSUE_ID,
      commentId: 42,
    });
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
      issueId: ISSUE_ID,
      api: backlogApi,
      converter: markdownConverter(),
      message: { markdown: 'Any progress?' },
      toBuffer: () => Promise.reject(new Error('no files expected')),
    });

    expect(result.threadId).toBe(`backlog:${HOST}:${PROJECT_ID}:${ISSUE_ID}`);
    expect(backlogApi.state.recordedInputs).toContainEqual({
      method: 'addComment',
      issueId: ISSUE_ID,
      input: { content: 'Any progress?' },
    });
  });

  it('files are uploaded and attached to the comment', async () => {
    const backlogApi = api();
    await postComment({
      host: HOST,
      projectId: PROJECT_ID,
      issueId: ISSUE_ID,
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
        issueId: ISSUE_ID,
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
      issueId: ISSUE_ID,
      api: backlogApi,
      converter: markdownConverter(),
      message,
      toBuffer: () => Promise.reject(new Error('no files expected')),
    });
    expect(message).toEqual(snapshot);
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
      issueId: ISSUE_ID,
      commentId: 1,
      api: backlogApi,
      converter: markdownConverter(),
      message: { markdown: 'Edited' },
    });
    expect(result.id).toBe(
      encodeMessageId({
        kind: 'comment',
        host: HOST,
        issueId: ISSUE_ID,
        commentId: 1,
      })
    );
    expect(backlogApi.state.comments.find((c) => c.id === 1)?.content).toBe(
      'Edited'
    );
  });

  it('rejects files on an edit', async () => {
    const backlogApi = api();
    await expect(
      editComment({
        host: HOST,
        projectId: PROJECT_ID,
        issueId: ISSUE_ID,
        commentId: 1,
        api: backlogApi,
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
        issueId: ISSUE_ID,
        commentId: 1,
        api: backlogApi,
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
      issueId: ISSUE_ID,
      commentId: 1,
      api: backlogApi,
      botUserId: BOT_USER_ID,
    });
    await addReaction({
      issueId: ISSUE_ID,
      commentId: 1,
      api: backlogApi,
      botUserId: BOT_USER_ID,
    });

    expect(
      backlogApi.state.recordedInputs.filter(
        (input) => input.method === 'addStar'
      )
    ).toEqual([{ method: 'addStar', target: { commentId: 1 } }]);
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
      issueId: ISSUE_ID,
      commentId: 1,
      api: backlogApi,
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
      issueId: ISSUE_ID,
      commentId: 1,
      api: backlogApi,
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
      issueId: ISSUE_ID,
      commentId: 1,
      api: backlogApi,
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
