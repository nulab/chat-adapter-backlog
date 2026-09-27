import { AdapterError, ResourceNotFoundError } from '@chat-adapter/shared';
import { describe, expect, it, vi } from 'vitest';

import { createIssueSubjectClient } from './issue';
import { createPullRequestSubjectClient } from './pull-request';

import type {
  BacklogApi,
  BacklogComment,
  BacklogIssue,
  BacklogPullRequest,
  BacklogUserRef,
} from '../client/port';
import type { BacklogRawMessage, BacklogSubjectRef } from '../types';
import type { SubjectClient, SubjectNames, SubjectRoot } from './client';

const HOST = 'example.backlog.com';
const PROJECT_ID = 500;
const REPOSITORY_ID = 700;
const REPOSITORY_NAME = 'example-repo';
const PROJECT_KEY = 'PROJECT';
const PULL_REQUEST_NUMBER = 12;
const PULL_REQUEST_ID = 90001;
const COMMENT_ID = 7000001;
const ATTACHMENT_ID = 4242;

const ALICE: BacklogUserRef = {
  id: 100,
  userId: 'alice',
  name: 'Alice',
  mailAddress: null,
};
const BOB: BacklogUserRef = {
  id: 101,
  userId: 'bob',
  name: 'Bob',
  mailAddress: null,
};

const REF: Extract<BacklogSubjectRef, { kind: 'pullRequest' }> = {
  kind: 'pullRequest',
  repositoryId: REPOSITORY_ID,
  number: PULL_REQUEST_NUMBER,
};

/** The three coordinates every pull-request endpoint is keyed by. */
const ENDPOINT_REF = {
  projectId: PROJECT_ID,
  repositoryId: REPOSITORY_ID,
  number: PULL_REQUEST_NUMBER,
};

const PULL_REQUEST: BacklogPullRequest = {
  id: PULL_REQUEST_ID,
  projectId: PROJECT_ID,
  repositoryId: REPOSITORY_ID,
  number: PULL_REQUEST_NUMBER,
  summary: 'Retry the login request once',
  description: 'Retries a failed login once before giving up',
  base: 'main',
  branch: 'feature/login-retry',
  status: { id: 1, name: 'Open' },
  assignee: ALICE,
  issue: { id: 8001, issueKey: 'PROJECT-42' },
  baseCommit: 'aaa',
  branchCommit: 'bbb',
  mergeCommit: null,
  closeAt: null,
  mergeAt: null,
  createdUser: BOB,
  created: new Date('2026-09-01T10:00:00.000Z'),
  updated: new Date('2026-09-02T11:30:00.000Z'),
  stars: [],
};

const ISSUE: BacklogIssue = {
  id: 8001,
  projectId: PROJECT_ID,
  issueKey: 'PROJECT-42',
  summary: 'Login fails on retry',
  description: 'Steps to reproduce',
  issueType: { id: 1, name: 'Bug' },
  priority: { id: 3, name: 'Normal' },
  status: { id: 1, name: 'Open' },
  assignee: ALICE,
  createdUser: BOB,
  created: new Date('2026-09-01T10:00:00.000Z'),
  updated: new Date('2026-09-02T11:30:00.000Z'),
};

function comment(
  id: number,
  changeLog: BacklogComment['changeLog'] = []
): BacklogComment {
  return {
    id,
    content: 'looks good',
    changeLog,
    createdUser: BOB,
    created: new Date('2026-09-02T11:30:00.000Z'),
    updated: new Date('2026-09-02T11:30:00.000Z'),
    stars: [],
  };
}

function attachmentChange(name: string): BacklogComment['changeLog'][number] {
  return {
    field: 'attachment',
    newValue: name,
    oldValue: '',
    attachmentInfo: null,
  };
}

/** See `stubApi` in `./issue.test.ts`: unstubbed methods fail loudly and every call is recorded. */
function stubApi(overrides: Partial<BacklogApi> = {}): {
  api: BacklogApi;
  calls: string[];
} {
  const calls: string[] = [];
  const api = new Proxy(overrides as BacklogApi, {
    get(target, property, receiver): unknown {
      const member: unknown = Reflect.get(target, property, receiver);
      return (...args: unknown[]): unknown => {
        calls.push(String(property));
        if (typeof member !== 'function') {
          throw new Error(
            `the subject client called an unstubbed port method: ${String(property)}`
          );
        }
        return (member as (...called: unknown[]) => unknown)(...args);
      };
    },
  });
  return { api, calls };
}

function clientWith(overrides: Partial<BacklogApi> = {}): {
  subject: SubjectClient;
  calls: string[];
} {
  const { api, calls } = stubApi(overrides);
  return {
    subject: createPullRequestSubjectClient(api, REF, {
      host: HOST,
      projectId: PROJECT_ID,
    }),
    calls,
  };
}

function rootOf(pullRequest: BacklogPullRequest = PULL_REQUEST): SubjectRoot {
  return {
    ref: REF,
    title: pullRequest.summary,
    body: pullRequest.description,
    status: pullRequest.status,
    assignee: pullRequest.assignee,
    createdUser: pullRequest.createdUser,
    created: pullRequest.created,
    updated: pullRequest.updated,
    source: { kind: 'pullRequest', pullRequest },
  };
}

/**
 * An issue's root and a comment, as `message.raw` carries them: neither
 * describes a pull request's root, however much of the same thread they are
 * about.
 */
const ISSUE_RAW: BacklogRawMessage = {
  kind: 'issue',
  host: HOST,
  changes: [],
  issue: {
    id: ISSUE.id,
    issueKey: 'PROJECT-42',
    projectId: PROJECT_ID,
    summary: ISSUE.summary,
    description: ISSUE.description,
    status: { id: 1, name: 'Open' },
    issueType: { id: 1, name: 'Bug' },
    priority: { id: 3, name: 'Normal' },
    assignee: { id: ALICE.id, name: ALICE.name },
    createdUser: { id: BOB.id, name: BOB.name, userId: BOB.userId },
    created: '2026-09-01T10:00:00.000Z',
    updated: '2026-09-02T11:30:00.000Z',
  },
};

const COMMENT_RAW: BacklogRawMessage = {
  kind: 'comment',
  host: HOST,
  projectId: PROJECT_ID,
  subject: REF,
  changes: [],
  comment: {
    id: COMMENT_ID,
    content: 'looks good',
    createdUser: { id: BOB.id, name: BOB.name, userId: BOB.userId },
    created: '2026-09-02T11:30:00.000Z',
    updated: '2026-09-02T11:30:00.000Z',
    changeLog: [],
    stars: [],
  },
};

const NAMES: SubjectNames = {
  projectKey: PROJECT_KEY,
  repositoryName: REPOSITORY_NAME,
};

/** See `subjectView` in `./issue.test.ts`. */
function subjectView(
  subject: SubjectClient,
  root: SubjectRoot,
  names: SubjectNames
): Record<string, unknown> {
  return {
    title: root.title,
    description: root.body,
    status: root.status.name,
    author: { id: root.createdUser.id, name: root.createdUser.name },
    assignee:
      root.assignee === null
        ? null
        : { id: root.assignee.id, name: root.assignee.name },
    labels: subject.subjectLabels(root),
    url: subject.webUrl(root, names),
    channelName: subject.channelName(root, names),
    metadata: subject.threadMetadata(root, names),
  };
}

/** See `rootFrom` in `./issue.test.ts`. */
function rootFrom(subject: SubjectClient, raw: BacklogRawMessage): SubjectRoot {
  const root = subject.rootFrom(raw);
  if (root === undefined) {
    throw new Error('the raw did not describe this subject root');
  }
  return root;
}

describe('the pull request subject client', () => {
  it('addresses a pull request by its repository and number, never by its global id', async () => {
    const getPullRequest = vi.fn().mockResolvedValue(PULL_REQUEST);
    const { subject } = clientWith({ getPullRequest });

    const root = await subject.fetchRoot();

    expect(getPullRequest).toHaveBeenCalledWith(ENDPOINT_REF);
    expect(root).toMatchObject({
      ref: REF,
      title: 'Retry the login request once',
      body: 'Retries a failed login once before giving up',
      status: { id: 1, name: 'Open' },
      assignee: ALICE,
      createdUser: BOB,
      source: { kind: 'pullRequest', pullRequest: PULL_REQUEST },
    });
  });

  it('normalises a root into the fields the adapter reads and no others', async () => {
    const { subject } = clientWith({
      getPullRequest: vi.fn().mockResolvedValue(PULL_REQUEST),
    });

    const root = await subject.fetchRoot();

    expect(Object.keys(root).sort()).toEqual([
      'assignee',
      'body',
      'created',
      'createdUser',
      'ref',
      'source',
      'status',
      'title',
      'updated',
    ]);
  });

  it('a single pull request comment is fetched through a one-element window', async () => {
    const listPullRequestComments = vi
      .fn()
      .mockResolvedValue([comment(COMMENT_ID)]);
    const { subject, calls } = clientWith({ listPullRequestComments });

    const fetched = await subject.getComment(COMMENT_ID);

    expect(listPullRequestComments).toHaveBeenCalledWith(ENDPOINT_REF, {
      minId: COMMENT_ID - 1,
      maxId: COMMENT_ID + 1,
      count: 1,
      order: 'desc',
    });
    expect(calls).toEqual(['listPullRequestComments']);
    expect(fetched.id).toBe(COMMENT_ID);
  });

  it('an empty one-element window is a comment that does not exist', async () => {
    const { subject } = clientWith({
      listPullRequestComments: vi.fn().mockResolvedValue([]),
    });

    await expect(subject.getComment(COMMENT_ID)).rejects.toBeInstanceOf(
      ResourceNotFoundError
    );
  });

  it('a one-element window that comes back holding a different comment is not found', async () => {
    const { subject } = clientWith({
      listPullRequestComments: vi
        .fn()
        .mockResolvedValue([comment(COMMENT_ID + 5)]),
    });

    await expect(subject.getComment(COMMENT_ID)).rejects.toBeInstanceOf(
      ResourceNotFoundError
    );
  });

  it('deleting a pull request comment fails before any request because Backlog has no endpoint', async () => {
    const { subject, calls } = clientWith();

    const rejection = await subject
      .deleteComment(COMMENT_ID)
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(AdapterError);
    expect(rejection).toMatchObject({
      code: 'UNSUPPORTED_OPERATION',
      message: 'Backlog has no endpoint to delete a pull request comment',
    });
    expect(calls).toEqual([]);
  });

  it('the subject of a serialised pull request root is read without a call', () => {
    const { subject, calls } = clientWith();

    const root = rootFrom(subject, subject.rootRaw(rootOf()));

    expect(calls).toEqual([]);
    expect(subject.subjectRaw(root)).toEqual({
      ...PULL_REQUEST,
      assignee: { ...ALICE, userId: null },
    });
  });

  it("a raw belonging to the other kind is not mistaken for this subject's root", () => {
    const { subject, calls } = clientWith();

    expect(subject.rootFrom(ISSUE_RAW)).toBeUndefined();
    expect(subject.rootFrom(COMMENT_RAW)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('the round trip through a serialised root keeps every field the subject shows', () => {
    const { subject } = clientWith();
    const serialised = JSON.parse(
      JSON.stringify(subject.rootRaw(rootOf()))
    ) as BacklogRawMessage;

    const root = rootFrom(subject, serialised);

    expect(subjectView(subject, root, NAMES)).toEqual(
      subjectView(subject, rootOf(), NAMES)
    );
  });

  it('a comment posted on a pull request carries its attachment ids to the pull request endpoint', async () => {
    const addPullRequestComment = vi
      .fn()
      .mockResolvedValue(comment(COMMENT_ID));
    const updatePullRequestComment = vi
      .fn()
      .mockResolvedValue(comment(COMMENT_ID));
    const listPullRequestComments = vi.fn().mockResolvedValue([]);
    const { subject } = clientWith({
      addPullRequestComment,
      updatePullRequestComment,
      listPullRequestComments,
    });

    await subject.addComment({
      content: 'ship it',
      attachmentId: [ATTACHMENT_ID],
    });
    await subject.updateComment(COMMENT_ID, 'ship it now');
    await subject.listComments({ count: 20, order: 'desc' });

    expect(addPullRequestComment).toHaveBeenCalledWith(ENDPOINT_REF, {
      content: 'ship it',
      attachmentId: [ATTACHMENT_ID],
    });
    expect(updatePullRequestComment).toHaveBeenCalledWith(
      ENDPOINT_REF,
      COMMENT_ID,
      'ship it now'
    );
    expect(listPullRequestComments).toHaveBeenCalledWith(ENDPOINT_REF, {
      count: 20,
      order: 'desc',
    });
  });

  it('stars a pull request comment as a pull request comment', () => {
    const { subject } = clientWith();

    expect(subject.starTarget(COMMENT_ID)).toEqual({
      pullRequestCommentId: COMMENT_ID,
    });
  });

  it('carries the root into raw data with timestamps a queue can serialise', () => {
    const { subject } = clientWith();

    expect(
      subject.rootRaw(
        rootOf({
          ...PULL_REQUEST,
          mergeAt: new Date('2026-09-03T09:00:00.000Z'),
          closeAt: new Date('2026-09-03T09:00:00.000Z'),
        })
      )
    ).toEqual({
      kind: 'pullRequest',
      host: HOST,
      changes: [],
      pullRequest: {
        id: PULL_REQUEST_ID,
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        number: PULL_REQUEST_NUMBER,
        summary: 'Retry the login request once',
        description: 'Retries a failed login once before giving up',
        base: 'main',
        branch: 'feature/login-retry',
        status: { id: 1, name: 'Open' },
        assignee: { id: ALICE.id, name: ALICE.name },
        issue: { id: 8001, issueKey: 'PROJECT-42' },
        baseCommit: 'aaa',
        branchCommit: 'bbb',
        mergeCommit: null,
        closeAt: '2026-09-03T09:00:00.000Z',
        mergeAt: '2026-09-03T09:00:00.000Z',
        createdUser: { id: BOB.id, name: BOB.name, userId: BOB.userId },
        created: '2026-09-01T10:00:00.000Z',
        updated: '2026-09-02T11:30:00.000Z',
      },
    });
  });

  it('a pull request comment attachment resolves its id by name when it is first read', async () => {
    const listPullRequestAttachments = vi.fn().mockResolvedValue([
      {
        id: 1,
        name: 'other.log',
        size: 3,
        created: new Date('2026-09-01T00:00:00.000Z'),
      },
      {
        id: ATTACHMENT_ID,
        name: 'trace.log',
        size: 12,
        created: new Date('2026-09-02T00:00:00.000Z'),
      },
    ]);
    const downloadPullRequestAttachment = vi.fn().mockResolvedValue({
      filename: 'trace.log',
      contentType: 'text/plain',
      data: Buffer.from('trace'),
    });
    const { subject, calls } = clientWith({
      listPullRequestAttachments,
      downloadPullRequestAttachment,
    });

    const attachments = subject.commentAttachments(
      comment(COMMENT_ID, [attachmentChange('trace.log')])
    );

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ type: 'file', name: 'trace.log' });
    expect(attachments[0]?.url).toBeUndefined();
    expect(calls).toEqual([]);

    const data = await attachments[0]?.fetchData?.();

    expect(calls).toEqual([
      'listPullRequestAttachments',
      'downloadPullRequestAttachment',
    ]);
    expect(downloadPullRequestAttachment).toHaveBeenCalledWith(
      ENDPOINT_REF,
      ATTACHMENT_ID
    );
    expect(Buffer.from(data as Buffer).toString()).toBe('trace');
  });

  it('the newest attachment wins when two carry the same name', async () => {
    const listPullRequestAttachments = vi.fn().mockResolvedValue([
      {
        id: 9,
        name: 'trace.log',
        size: 3,
        created: new Date('2026-09-04T00:00:00.000Z'),
      },
      {
        id: 1,
        name: 'trace.log',
        size: 12,
        created: new Date('2026-09-01T00:00:00.000Z'),
      },
    ]);
    const downloadPullRequestAttachment = vi.fn().mockResolvedValue({
      filename: 'trace.log',
      contentType: 'text/plain',
      data: Buffer.from('newest'),
    });
    const { subject } = clientWith({
      listPullRequestAttachments,
      downloadPullRequestAttachment,
    });

    const attachments = subject.commentAttachments(
      comment(COMMENT_ID, [attachmentChange('trace.log')])
    );
    await attachments[0]?.fetchData?.();

    expect(downloadPullRequestAttachment).toHaveBeenCalledWith(ENDPOINT_REF, 9);
  });

  it('a changelog name that matches no attachment fails when the file is read, not when the message is built', async () => {
    const { subject } = clientWith({
      listPullRequestAttachments: vi.fn().mockResolvedValue([]),
    });

    const attachments = subject.commentAttachments(
      comment(COMMENT_ID, [attachmentChange('gone.log')])
    );

    expect(attachments).toHaveLength(1);
    await expect(attachments[0]?.fetchData?.()).rejects.toBeInstanceOf(
      ResourceNotFoundError
    );
  });

  it('the attachment a webhook names resolves its id by name when it is first read', async () => {
    const listPullRequestAttachments = vi.fn().mockResolvedValue([
      {
        id: ATTACHMENT_ID,
        name: 'trace.log',
        size: 12,
        created: new Date('2026-09-02T00:00:00.000Z'),
      },
    ]);
    const downloadPullRequestAttachment = vi.fn().mockResolvedValue({
      filename: 'trace.log',
      contentType: 'text/plain',
      data: Buffer.from('trace'),
    });
    const { subject, calls } = clientWith({
      listPullRequestAttachments,
      downloadPullRequestAttachment,
    });

    const attachment = subject.webhookChangeAttachment({
      field: 'attachment',
      newValue: 'trace.log',
      oldValue: '',
    });

    expect(attachment).toMatchObject({ type: 'file', name: 'trace.log' });
    expect(attachment?.url).toBeUndefined();
    expect(calls).toEqual([]);

    const data = await attachment?.fetchData?.();

    expect(downloadPullRequestAttachment).toHaveBeenCalledWith(
      ENDPOINT_REF,
      ATTACHMENT_ID
    );
    expect(Buffer.from(data as Buffer).toString()).toBe('trace');
  });

  it('a webhook attachment on a pull request points at the pull request endpoint', () => {
    const { subject } = clientWith();

    expect(
      subject.webhookAttachment({
        id: ATTACHMENT_ID,
        name: 'trace.log',
        size: 12,
      })
    ).toMatchObject({
      type: 'file',
      name: 'trace.log',
      size: 12,
      url: `https://${HOST}/api/v2/projects/${PROJECT_ID}/git/repositories/${REPOSITORY_ID}/pullRequests/${PULL_REQUEST_NUMBER}/attachments/${ATTACHMENT_ID}`,
    });
  });

  it('a pull request web url needs the project key and the repository name', () => {
    const { subject } = clientWith();
    const root = rootOf();

    expect(
      subject.webUrl(root, {
        projectKey: PROJECT_KEY,
        repositoryName: REPOSITORY_NAME,
      })
    ).toBe(
      'https://example.backlog.com/git/PROJECT/example-repo/pullRequests/12'
    );
    expect(
      subject.webUrl(root, {
        projectKey: PROJECT_KEY,
        repositoryName: undefined,
      })
    ).toBeUndefined();
    expect(
      subject.webUrl(root, {
        projectKey: undefined,
        repositoryName: REPOSITORY_NAME,
      })
    ).toBeUndefined();
  });

  it('the channel of a pull request thread is named by its project, not its repository', () => {
    const { subject } = clientWith();

    expect(
      subject.channelName(rootOf(), {
        projectKey: PROJECT_KEY,
        repositoryName: REPOSITORY_NAME,
      })
    ).toBe(PROJECT_KEY);
  });

  it('a pull request thread carries its ids, summary, status and url, under its own kind', () => {
    const { subject } = clientWith();

    expect(
      subject.threadMetadata(rootOf(), {
        projectKey: PROJECT_KEY,
        repositoryName: REPOSITORY_NAME,
      })
    ).toEqual({
      kind: 'pullRequest',
      host: HOST,
      projectId: PROJECT_ID,
      repositoryId: REPOSITORY_ID,
      number: PULL_REQUEST_NUMBER,
      summary: 'Retry the login request once',
      status: { id: 1, name: 'Open' },
      url: 'https://example.backlog.com/git/PROJECT/example-repo/pullRequests/12',
    });
  });

  it('a thread whose repository name is unknown omits the url rather than guessing', () => {
    const { subject } = clientWith();

    const metadata = subject.threadMetadata(rootOf(), {
      projectKey: PROJECT_KEY,
      repositoryName: undefined,
    });

    expect(metadata).not.toHaveProperty('url');
    expect(metadata['number']).toBe(PULL_REQUEST_NUMBER);
  });

  it('describes a pull request subject by its status and the branches it joins', () => {
    const { subject } = clientWith();

    expect(subject.subjectType).toBe('pull_request');
    expect(subject.subjectLabels(rootOf())).toEqual([
      'Open',
      'main ← feature/login-retry',
    ]);
  });

  it('names the repository whose display name its url needs', () => {
    const { subject } = clientWith();

    expect(subject.repositoryIdForName).toBe(REPOSITORY_ID);
  });
});

describe('the two kinds side by side', () => {
  it('thread info names its kind for both issues and pull requests', () => {
    const { api } = stubApi();
    const issue = createIssueSubjectClient(
      api,
      { kind: 'issue', issueId: ISSUE.id },
      { host: HOST, projectId: PROJECT_ID }
    );
    const pullRequest = createPullRequestSubjectClient(api, REF, {
      host: HOST,
      projectId: PROJECT_ID,
    });
    const issueRoot: SubjectRoot = {
      ref: { kind: 'issue', issueId: ISSUE.id },
      title: ISSUE.summary,
      body: ISSUE.description,
      status: ISSUE.status,
      assignee: ISSUE.assignee,
      createdUser: ISSUE.createdUser,
      created: ISSUE.created,
      updated: ISSUE.updated,
      source: { kind: 'issue', issue: ISSUE },
    };
    const names = {
      projectKey: PROJECT_KEY,
      repositoryName: REPOSITORY_NAME,
    };

    expect(issue.threadMetadata(issueRoot, names)['kind']).toBe('issue');
    expect(pullRequest.threadMetadata(rootOf(), names)['kind']).toBe(
      'pullRequest'
    );
    expect([issue.subjectType, pullRequest.subjectType]).toEqual([
      'issue',
      'pull_request',
    ]);
  });

  it('a subject client refuses a root of the other kind rather than reading the wrong fields', () => {
    const { api } = stubApi();
    const pullRequest = createPullRequestSubjectClient(api, REF, {
      host: HOST,
      projectId: PROJECT_ID,
    });
    const issueRoot = {
      ...rootOf(),
      source: { kind: 'issue', issue: ISSUE },
    } as unknown as SubjectRoot;

    expect(() => pullRequest.subjectLabels(issueRoot)).toThrow(AdapterError);
  });
});
