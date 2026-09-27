import { AdapterError, ResourceNotFoundError } from '@chat-adapter/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  ALICE,
  BOB,
  REST,
  comment,
  fileData,
  issue,
  pullRequest,
  stubClient,
} from '../test/fixtures/rest';
import { createPullRequestSubjectClient } from './pull-request';

import type {
  BacklogRawComment,
  BacklogRawMessage,
  BacklogRawPullRequest,
  BacklogSubjectRef,
} from '../types';
import type { SubjectClient, SubjectNames, SubjectRoot } from './client';
import type { Backlog, Entity } from 'backlog-js';

const COMMENT_ID = 7000001;
const ATTACHMENT_ID = 4242;

const REF: Extract<BacklogSubjectRef, { kind: 'pullRequest' }> = {
  kind: 'pullRequest',
  repositoryId: REST.repositoryId,
  number: REST.pullRequestNumber,
};

/** The coordinates every pull-request endpoint of `backlog-js` takes first. */
const ENDPOINT = [
  REST.projectId,
  String(REST.repositoryId),
  REST.pullRequestNumber,
] as const;

const NAMES: SubjectNames = {
  projectKey: REST.projectKey,
  repositoryName: REST.repositoryName,
};

function subjectOn(client: Backlog = stubClient({})): SubjectClient {
  return createPullRequestSubjectClient(client, REF, {
    host: REST.host,
    projectId: REST.projectId,
  });
}

function pullRequestRaw(
  fixture: BacklogRawPullRequest = pullRequest()
): BacklogRawMessage {
  return {
    kind: 'pullRequest',
    host: REST.host,
    pullRequest: fixture,
    changes: [],
  };
}

function rootOf(
  subject: SubjectClient,
  fixture: BacklogRawPullRequest = pullRequest()
): SubjectRoot {
  const root = subject.rootFrom(pullRequestRaw(fixture));
  if (root === undefined) {
    throw new Error('a pull request raw did not yield a pull request root');
  }
  return root;
}

function attachmentComment(name: string): BacklogRawComment {
  return comment({
    id: COMMENT_ID,
    changeLog: [
      {
        field: 'attachment',
        newValue: name,
        originalValue: null,
        attachmentInfo: null,
      },
    ],
  });
}

function attachment(
  id: number,
  name: string,
  created: string
): Pick<Entity.File.PullRequestFileInfo, 'id' | 'name' | 'size' | 'created'> {
  return { id, name, size: 12, created };
}

describe('the pull request subject client', () => {
  it('addresses a pull request by its repository and number, never by its global id', async () => {
    const fixture = pullRequest({ assignee: BOB });
    const getPullRequest = vi.fn().mockResolvedValue(fixture);
    const subject = subjectOn(stubClient({ getPullRequest }));

    const root = await subject.fetchRoot();

    expect(getPullRequest).toHaveBeenCalledWith(...ENDPOINT);
    expect(root).toEqual({
      ref: REF,
      title: 'Add the thing',
      body: 'Body of the PR.',
      status: { id: 1, name: 'Open' },
      assignee: BOB,
      createdUser: ALICE,
      created: '2026-09-01T10:00:00Z',
      source: { kind: 'pullRequest', pullRequest: fixture },
    });
  });

  it('a single pull request comment is fetched through a one-element window', async () => {
    const getPullRequestComments = vi
      .fn()
      .mockResolvedValue([comment({ id: COMMENT_ID })]);
    const subject = subjectOn(stubClient({ getPullRequestComments }));

    const fetched = await subject.getComment(COMMENT_ID);

    expect(getPullRequestComments).toHaveBeenCalledWith(...ENDPOINT, {
      minId: COMMENT_ID - 1,
      maxId: COMMENT_ID + 1,
      count: 1,
      order: 'desc',
    });
    expect(fetched.id).toBe(COMMENT_ID);
  });

  it('an empty one-element window is a comment that does not exist', async () => {
    const subject = subjectOn(
      stubClient({ getPullRequestComments: vi.fn().mockResolvedValue([]) })
    );

    await expect(subject.getComment(COMMENT_ID)).rejects.toBeInstanceOf(
      ResourceNotFoundError
    );
  });

  it('a one-element window that comes back holding a different comment is not found', async () => {
    const subject = subjectOn(
      stubClient({
        getPullRequestComments: vi
          .fn()
          .mockResolvedValue([comment({ id: COMMENT_ID + 5 })]),
      })
    );

    await expect(subject.getComment(COMMENT_ID)).rejects.toBeInstanceOf(
      ResourceNotFoundError
    );
  });

  it('deleting a pull request comment fails before any request because Backlog has no endpoint', async () => {
    const subject = subjectOn();

    const rejection = await subject
      .deleteComment(COMMENT_ID)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AdapterError);
    expect(rejection).toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: 'Backlog has no endpoint to delete a pull request comment',
    });
  });

  it('a comment posted on a pull request carries its attachment ids to the pull request endpoint', async () => {
    const postPullRequestComments = vi
      .fn()
      .mockResolvedValue(comment({ id: COMMENT_ID }));
    const patchPullRequestComments = vi
      .fn()
      .mockResolvedValue(comment({ id: COMMENT_ID }));
    const getPullRequestComments = vi.fn().mockResolvedValue([]);
    const subject = subjectOn(
      stubClient({
        postPullRequestComments,
        patchPullRequestComments,
        getPullRequestComments,
      })
    );

    await subject.addComment({
      content: 'ship it',
      attachmentId: [ATTACHMENT_ID],
    });
    await subject.updateComment(COMMENT_ID, 'ship it now');
    await subject.listComments({ count: 20, order: 'desc' });

    expect(postPullRequestComments).toHaveBeenCalledWith(...ENDPOINT, {
      content: 'ship it',
      attachmentId: [ATTACHMENT_ID],
    });
    expect(patchPullRequestComments).toHaveBeenCalledWith(
      ...ENDPOINT,
      COMMENT_ID,
      { content: 'ship it now' }
    );
    expect(getPullRequestComments).toHaveBeenCalledWith(...ENDPOINT, {
      count: 20,
      order: 'desc',
    });
  });

  it('stars a pull request comment as a pull request comment', () => {
    expect(subjectOn().starTarget(COMMENT_ID)).toEqual({
      pullRequestCommentId: COMMENT_ID,
    });
  });

  it('carries the pull request it read into raw data unchanged', () => {
    const subject = subjectOn();
    const fixture = pullRequest();

    expect(subject.rootRaw(rootOf(subject, fixture))).toEqual(
      pullRequestRaw(fixture)
    );
  });

  it('the subject of a pull request raw is the pull request it carries, read without a request', () => {
    const subject = subjectOn();
    const fixture = pullRequest();

    expect(subject.subjectRaw(rootOf(subject, fixture))).toBe(fixture);
  });

  it('a root survives a JSON round trip through its raw', () => {
    const subject = subjectOn();
    const root = rootOf(subject);
    const serialised = JSON.parse(
      JSON.stringify(subject.rootRaw(root))
    ) as BacklogRawMessage;

    expect(subject.rootFrom(serialised)).toEqual(root);
  });

  it("a raw belonging to another kind is not mistaken for this subject's root", () => {
    const subject = subjectOn();

    expect(
      subject.rootFrom({
        kind: 'issue',
        host: REST.host,
        issue: issue(),
        changes: [],
      })
    ).toBeUndefined();
    expect(
      subject.rootFrom({
        kind: 'comment',
        host: REST.host,
        projectId: REST.projectId,
        subject: REF,
        comment: comment(),
        changes: [],
      })
    ).toBeUndefined();
  });

  it('an issue root is refused rather than read as a pull request', () => {
    const subject = subjectOn();
    const root: SubjectRoot = {
      ...rootOf(subject),
      source: { kind: 'issue', issue: issue() },
    };

    expect(() => subject.subjectLabels(root)).toThrow(AdapterError);
  });

  it('a pull request comment attachment resolves its id by name when it is first read', async () => {
    const getPullRequestAttachments = vi
      .fn()
      .mockResolvedValue([
        attachment(1, 'other.log', '2026-09-01T00:00:00Z'),
        attachment(ATTACHMENT_ID, 'trace.log', '2026-09-02T00:00:00Z'),
      ]);
    const getPullRequestAttachment = vi
      .fn()
      .mockResolvedValue(fileData('trace'));
    const subject = subjectOn(
      stubClient({ getPullRequestAttachments, getPullRequestAttachment })
    );

    const attachments = subject.commentAttachments(
      attachmentComment('trace.log')
    );

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ type: 'file', name: 'trace.log' });
    expect(attachments[0]?.url).toBeUndefined();
    expect(getPullRequestAttachments).not.toHaveBeenCalled();

    const data = await attachments[0]?.fetchData?.();

    expect(getPullRequestAttachments).toHaveBeenCalledWith(...ENDPOINT);
    expect(getPullRequestAttachment).toHaveBeenCalledWith(
      ...ENDPOINT,
      ATTACHMENT_ID
    );
    expect(data?.toString()).toBe('trace');
  });

  it('the newest attachment wins when two carry the same name', async () => {
    const getPullRequestAttachment = vi
      .fn()
      .mockResolvedValue(fileData('newest'));
    const subject = subjectOn(
      stubClient({
        getPullRequestAttachments: vi
          .fn()
          .mockResolvedValue([
            attachment(9, 'trace.log', '2026-09-04T00:00:00Z'),
            attachment(1, 'trace.log', '2026-09-01T00:00:00Z'),
          ]),
        getPullRequestAttachment,
      })
    );

    await subject
      .commentAttachments(attachmentComment('trace.log'))[0]
      ?.fetchData?.();

    expect(getPullRequestAttachment).toHaveBeenCalledWith(...ENDPOINT, 9);
  });

  it('two same-named attachments uploaded in the same instant resolve to the later id', async () => {
    const getPullRequestAttachment = vi
      .fn()
      .mockResolvedValue(fileData('later'));
    const subject = subjectOn(
      stubClient({
        getPullRequestAttachments: vi
          .fn()
          .mockResolvedValue([
            attachment(5, 'trace.log', '2026-09-04T00:00:00Z'),
            attachment(3, 'trace.log', '2026-09-04T00:00:00Z'),
          ]),
        getPullRequestAttachment,
      })
    );

    await subject
      .commentAttachments(attachmentComment('trace.log'))[0]
      ?.fetchData?.();

    expect(getPullRequestAttachment).toHaveBeenCalledWith(...ENDPOINT, 5);
  });

  it('a changelog name that matches no attachment fails when the file is read, not when the message is built', async () => {
    const subject = subjectOn(
      stubClient({ getPullRequestAttachments: vi.fn().mockResolvedValue([]) })
    );

    const attachments = subject.commentAttachments(
      attachmentComment('gone.log')
    );

    expect(attachments).toHaveLength(1);
    await expect(attachments[0]?.fetchData?.()).rejects.toBeInstanceOf(
      ResourceNotFoundError
    );
  });

  it('the attachment a webhook names resolves its id by name when it is first read', async () => {
    const getPullRequestAttachments = vi
      .fn()
      .mockResolvedValue([
        attachment(ATTACHMENT_ID, 'trace.log', '2026-09-02T00:00:00Z'),
      ]);
    const getPullRequestAttachment = vi
      .fn()
      .mockResolvedValue(fileData('trace'));
    const subject = subjectOn(
      stubClient({ getPullRequestAttachments, getPullRequestAttachment })
    );

    const named = subject.webhookChangeAttachment({
      field: 'attachment',
      newValue: 'trace.log',
      oldValue: '',
    });

    expect(named).toMatchObject({ type: 'file', name: 'trace.log' });
    expect(named?.url).toBeUndefined();
    expect(getPullRequestAttachments).not.toHaveBeenCalled();

    const data = await named?.fetchData?.();

    expect(getPullRequestAttachment).toHaveBeenCalledWith(
      ...ENDPOINT,
      ATTACHMENT_ID
    );
    expect(data?.toString()).toBe('trace');
  });

  it('a webhook change that names no file is no attachment', () => {
    expect(
      subjectOn().webhookChangeAttachment({
        field: 'attachment',
        newValue: null,
        oldValue: 'trace.log',
      })
    ).toBeUndefined();
  });

  it('a webhook attachment on a pull request points at the pull request endpoint', () => {
    expect(
      subjectOn().webhookAttachment({
        id: ATTACHMENT_ID,
        name: 'trace.log',
        size: 12,
      })
    ).toMatchObject({
      type: 'file',
      name: 'trace.log',
      size: 12,
      url: `https://${REST.host}/api/v2/projects/${REST.projectId}/git/repositories/${REST.repositoryId}/pullRequests/${REST.pullRequestNumber}/attachments/${ATTACHMENT_ID}`,
    });
  });

  it('a pull request web url needs the project key and the repository name', () => {
    const subject = subjectOn();
    const root = rootOf(subject);

    expect(subject.webUrl(root, NAMES)).toBe(
      'https://example.backlog.com/git/PROJECT/example-repo/pullRequests/12'
    );
    expect(
      subject.webUrl(root, { ...NAMES, repositoryName: undefined })
    ).toBeUndefined();
    expect(
      subject.webUrl(root, { ...NAMES, projectKey: undefined })
    ).toBeUndefined();
  });

  it('the channel of a pull request thread is named by its project, not its repository', () => {
    const subject = subjectOn();

    expect(subject.channelName(rootOf(subject), NAMES)).toBe(REST.projectKey);
  });

  it('a pull request thread carries its ids, summary, status and url, under its own kind', () => {
    const subject = subjectOn();

    expect(subject.threadMetadata(rootOf(subject), NAMES)).toEqual({
      kind: 'pullRequest',
      host: REST.host,
      projectId: REST.projectId,
      repositoryId: REST.repositoryId,
      number: REST.pullRequestNumber,
      summary: 'Add the thing',
      status: { id: 1, name: 'Open' },
      url: 'https://example.backlog.com/git/PROJECT/example-repo/pullRequests/12',
    });
  });

  it('a thread whose repository name is unknown omits the url rather than guessing', () => {
    const subject = subjectOn();

    const metadata = subject.threadMetadata(rootOf(subject), {
      ...NAMES,
      repositoryName: undefined,
    });

    expect(metadata).not.toHaveProperty('url');
    expect(metadata['number']).toBe(REST.pullRequestNumber);
  });

  it('describes a pull request subject by its status and the branches it joins', () => {
    const subject = subjectOn();

    expect(subject.subjectType).toBe('pull_request');
    expect(subject.subjectLabels(rootOf(subject))).toEqual([
      'Open',
      'main ← feature/thing',
    ]);
  });

  it('names the repository whose display name its url needs', () => {
    expect(subjectOn().repositoryIdForName).toBe(REST.repositoryId);
  });
});
