import { ValidationError } from '@chat-adapter/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  addReaction,
  bufferStream,
  editComment,
  postComment,
  removeReaction,
  requireCommentInThread,
} from './egress';
import { encodeMessageId } from './ids';
import {
  BOB,
  BOT,
  comment,
  REST,
  star,
  stubClient,
} from './test/fixtures/rest';

import type { SubjectClient } from './subject/client';
import type { BacklogPostableExtras, BacklogSubjectRef } from './types';
import type { PostableMarkdown } from 'chat';

const { host: HOST, projectId: PROJECT_ID } = REST;
const PULL_REQUEST_COMMENT_ID = 7000001;

const ISSUE: BacklogSubjectRef = { kind: 'issue', issueId: REST.issueId };
const PULL_REQUEST: BacklogSubjectRef = {
  kind: 'pullRequest',
  repositoryId: REST.repositoryId,
  number: REST.pullRequestNumber,
};

const THREAD_ID = `backlog:${HOST}:${PROJECT_ID}:issue:${REST.issueId}`;
const PULL_REQUEST_THREAD_ID = `backlog:${HOST}:${PROJECT_ID}:pr:${REST.repositoryId}:${REST.pullRequestNumber}`;

function subjectStub(
  ref: BacklogSubjectRef,
  members: Partial<SubjectClient> = {}
): SubjectClient {
  return { ref, ...members } as SubjectClient;
}

function noFiles(): Promise<Buffer> {
  return Promise.reject(new Error('no files expected'));
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
    { label: 'issue', threadId: THREAD_ID, subject: ISSUE, commentId: 42 },
    {
      label: 'pull request',
      threadId: PULL_REQUEST_THREAD_ID,
      subject: PULL_REQUEST,
      commentId: PULL_REQUEST_COMMENT_ID,
    },
  ])(
    'a comment id resolves its host, project, subject and comment on a $label thread',
    ({ threadId, subject, commentId }) => {
      const messageId = encodeMessageId({
        host: HOST,
        subject,
        part: 'comment',
        commentId,
      });
      expect(requireCommentInThread(threadId, messageId, 'starred')).toEqual({
        host: HOST,
        projectId: PROJECT_ID,
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

describe('postComment', () => {
  it.each([
    { label: 'issue', ref: ISSUE, threadId: THREAD_ID },
    {
      label: 'pull request',
      ref: PULL_REQUEST,
      threadId: PULL_REQUEST_THREAD_ID,
    },
  ])(
    'a reply on a $label thread is posted as a comment on that subject',
    async ({ ref, threadId }) => {
      const posted = comment({ id: 5, content: 'Any progress?' });
      const addComment = vi.fn().mockResolvedValue(posted);
      const result = await postComment({
        host: HOST,
        projectId: PROJECT_ID,
        subject: subjectStub(ref, { addComment }),
        client: stubClient({}),
        message: { markdown: 'Any progress?' },
        toBuffer: noFiles,
      });

      expect(addComment).toHaveBeenCalledWith({ content: 'Any progress?' });
      expect(result).toEqual({
        id: encodeMessageId({
          host: HOST,
          subject: ref,
          part: 'comment',
          commentId: 5,
        }),
        threadId,
        raw: {
          kind: 'comment',
          host: HOST,
          projectId: PROJECT_ID,
          subject: ref,
          comment: posted,
          changes: [],
        },
      });
    }
  );

  it('notifiedUserId reaches the comment as the users to notify', async () => {
    const addComment = vi.fn().mockResolvedValue(comment());
    const message: PostableMarkdown & BacklogPostableExtras = {
      markdown: 'Any progress?',
      notifiedUserId: [100],
    };
    await postComment({
      host: HOST,
      projectId: PROJECT_ID,
      subject: subjectStub(ISSUE, { addComment }),
      client: stubClient({}),
      message,
      toBuffer: noFiles,
    });

    expect(addComment).toHaveBeenCalledWith({
      content: 'Any progress?',
      notifiedUserId: [100],
    });
  });

  it('files are uploaded to the space and attached to the comment', async () => {
    const postSpaceAttachment = vi
      .fn()
      .mockResolvedValue({ id: 77, name: 'notes.txt', size: 5 });
    const addComment = vi.fn().mockResolvedValue(comment());
    await postComment({
      host: HOST,
      projectId: PROJECT_ID,
      subject: subjectStub(ISSUE, { addComment }),
      client: stubClient({ postSpaceAttachment }),
      message: {
        markdown: 'See attached',
        files: [{ filename: 'notes.txt', data: Buffer.from('hello') }],
      },
      toBuffer: (file) => Promise.resolve(Buffer.from(String(file.data))),
    });

    const form = postSpaceAttachment.mock.calls[0]?.[0] as FormData;
    const part = form.get('file') as File;
    expect(part.name).toBe('notes.txt');
    expect(await part.text()).toBe('hello');
    expect(addComment).toHaveBeenCalledWith({
      content: 'See attached',
      attachmentId: [77],
    });
  });

  it.each([
    { label: 'a mistyped', notifiedUserId: ['not-a-number'] },
    { label: 'a negative', notifiedUserId: [-1] },
  ])(
    '$label notifiedUserId is a validation error and posts nothing',
    async ({ notifiedUserId }) => {
      const addComment = vi.fn();
      const message = {
        markdown: 'hi',
        notifiedUserId,
      } as unknown as PostableMarkdown;

      await expect(
        postComment({
          host: HOST,
          projectId: PROJECT_ID,
          subject: subjectStub(ISSUE, { addComment }),
          client: stubClient({}),
          message,
          toBuffer: noFiles,
        })
      ).rejects.toThrow(ValidationError);
      expect(addComment).not.toHaveBeenCalled();
    }
  );

  it('a string postable is posted with no users to notify', async () => {
    const addComment = vi.fn().mockResolvedValue(comment());
    await postComment({
      host: HOST,
      projectId: PROJECT_ID,
      subject: subjectStub(ISSUE, { addComment }),
      client: stubClient({}),
      message: 'hi',
      toBuffer: noFiles,
    });

    expect(addComment).toHaveBeenCalledWith({ content: 'hi' });
  });

  it('stops uploading after a file fails, and posts no comment', async () => {
    const postSpaceAttachment = vi.fn().mockResolvedValue({ id: 77 });
    const addComment = vi.fn();
    await expect(
      postComment({
        host: HOST,
        projectId: PROJECT_ID,
        subject: subjectStub(ISSUE, { addComment }),
        client: stubClient({ postSpaceAttachment }),
        message: {
          markdown: 'See attached',
          files: [
            { filename: 'a.txt', data: Buffer.from('a') },
            { filename: 'b.txt', data: Buffer.from('b') },
            { filename: 'c.txt', data: Buffer.from('c') },
          ],
        },
        toBuffer: (file) =>
          file.filename === 'b.txt'
            ? Promise.reject(new Error('cannot read b'))
            : Promise.resolve(Buffer.from('a')),
      })
    ).rejects.toThrow('cannot read b');
    expect(postSpaceAttachment).toHaveBeenCalledOnce();
    expect(addComment).not.toHaveBeenCalled();
  });

  it('a failed comment call rejects instead of returning a synthetic message', async () => {
    await expect(
      postComment({
        host: HOST,
        projectId: PROJECT_ID,
        subject: subjectStub(ISSUE, {
          addComment: vi.fn().mockRejectedValue(new Error('boom')),
        }),
        client: stubClient({}),
        message: 'hi',
        toBuffer: noFiles,
      })
    ).rejects.toThrow('boom');
  });

  it('never mutates the caller-supplied message object', async () => {
    const message = { markdown: 'Any progress?', notifiedUserId: [100] };
    const snapshot = { ...message };
    await postComment({
      host: HOST,
      projectId: PROJECT_ID,
      subject: subjectStub(ISSUE, {
        addComment: vi.fn().mockResolvedValue(comment()),
      }),
      client: stubClient({}),
      message,
      toBuffer: noFiles,
    });
    expect(message).toEqual(snapshot);
  });
});

describe('editComment', () => {
  it('renders the postable and updates the comment', async () => {
    const updateComment = vi
      .fn()
      .mockResolvedValue(comment({ id: 1, content: 'Edited' }));
    const result = await editComment({
      host: HOST,
      projectId: PROJECT_ID,
      subject: subjectStub(ISSUE, { updateComment }),
      commentId: 1,
      message: { markdown: 'Edited' },
    });

    expect(updateComment).toHaveBeenCalledWith(1, 'Edited');
    expect(result.id).toBe(
      encodeMessageId({
        host: HOST,
        subject: ISSUE,
        part: 'comment',
        commentId: 1,
      })
    );
  });

  it('rejects files on an edit', async () => {
    await expect(
      editComment({
        host: HOST,
        projectId: PROJECT_ID,
        subject: subjectStub(ISSUE),
        commentId: 1,
        message: {
          markdown: 'x',
          files: [{ filename: 'a.txt', data: Buffer.from('a') }],
        },
      })
    ).rejects.toThrow(ValidationError);
  });

  it('rejects notifiedUserId on an edit', async () => {
    const message: PostableMarkdown & BacklogPostableExtras = {
      markdown: 'x',
      notifiedUserId: [100],
    };
    await expect(
      editComment({
        host: HOST,
        projectId: PROJECT_ID,
        subject: subjectStub(ISSUE),
        commentId: 1,
        message,
      })
    ).rejects.toThrow(ValidationError);
  });
});

describe('addReaction', () => {
  it("an unstarred comment is starred at the subject's star target", async () => {
    const postStar = vi.fn().mockResolvedValue(undefined);
    await addReaction({
      client: stubClient({ postStar }),
      subject: subjectStub(PULL_REQUEST, {
        getComment: vi.fn().mockResolvedValue(comment({ stars: [star(BOB)] })),
        starTarget: (commentId) => ({ pullRequestCommentId: commentId }),
      }),
      commentId: PULL_REQUEST_COMMENT_ID,
      botUserId: BOT.id,
    });

    expect(postStar).toHaveBeenCalledExactlyOnceWith({
      pullRequestCommentId: PULL_REQUEST_COMMENT_ID,
    });
  });

  it('a comment the bot has already starred is not starred again', async () => {
    const postStar = vi.fn();
    await addReaction({
      client: stubClient({ postStar }),
      subject: subjectStub(ISSUE, {
        getComment: vi.fn().mockResolvedValue(comment({ stars: [star(BOT)] })),
      }),
      commentId: 1,
      botUserId: BOT.id,
    });

    expect(postStar).not.toHaveBeenCalled();
  });
});

describe('removeReaction', () => {
  it("removes every star the bot gave and leaves other users' stars", async () => {
    const removeStar = vi.fn().mockResolvedValue(undefined);
    await removeReaction({
      client: stubClient({ removeStar }),
      subject: subjectStub(ISSUE, {
        getComment: vi
          .fn()
          .mockResolvedValue(
            comment({ stars: [star(BOT, 1), star(BOB, 2), star(BOT, 3)] })
          ),
      }),
      commentId: 1,
      botUserId: BOT.id,
    });

    expect(removeStar.mock.calls).toEqual([[1], [3]]);
  });

  it('a comment with no bot star makes no delete call', async () => {
    const removeStar = vi.fn();
    await removeReaction({
      client: stubClient({ removeStar }),
      subject: subjectStub(ISSUE, {
        getComment: vi.fn().mockResolvedValue(comment({ stars: [star(BOB)] })),
      }),
      commentId: 1,
      botUserId: BOT.id,
    });

    expect(removeStar).not.toHaveBeenCalled();
  });
});

describe('bufferStream', () => {
  it('concatenates text and markdown chunks and drops task updates', async () => {
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
    expect(await bufferStream(chunks())).toBe('Hello, world');
  });

  it('an empty stream buffers to an empty string', async () => {
    async function* chunks(): AsyncIterable<string> {}
    expect(await bufferStream(chunks())).toBe('');
  });
});
