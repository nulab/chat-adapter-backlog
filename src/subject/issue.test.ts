import { describe, expect, it, vi } from 'vitest';

import { createIssueSubjectClient } from './issue';

import type {
  BacklogApi,
  BacklogComment,
  BacklogIssue,
  BacklogNotification,
  BacklogUserRef,
} from '../client/port';
import type { BacklogRawMessage, BacklogSubjectRef } from '../types';
import type { SubjectClient, SubjectNames, SubjectRoot } from './client';

const HOST = 'example.backlog.com';
const PROJECT_ID = 500;
const ISSUE_ID = 8001;
const COMMENT_ID = 3;
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

const REF: Extract<BacklogSubjectRef, { kind: 'issue' }> = {
  kind: 'issue',
  issueId: ISSUE_ID,
};

const ISSUE: BacklogIssue = {
  id: ISSUE_ID,
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

function comment(changeLog: BacklogComment['changeLog']): BacklogComment {
  return {
    id: COMMENT_ID,
    content: 'a file for you',
    changeLog,
    createdUser: BOB,
    created: new Date('2026-09-02T11:30:00.000Z'),
    updated: new Date('2026-09-02T11:30:00.000Z'),
    stars: [],
  };
}

/**
 * A port double whose every method is recorded, and whose unstubbed methods
 * fail loudly: a test that asserts "no request was made" must be able to tell
 * "nothing was called" apart from "something was called and happened to
 * resolve".
 */
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
    subject: createIssueSubjectClient(api, REF, {
      host: HOST,
      projectId: PROJECT_ID,
    }),
    calls,
  };
}

function rootOf(issue: BacklogIssue = ISSUE): SubjectRoot {
  return {
    ref: REF,
    title: issue.summary,
    body: issue.description,
    status: issue.status,
    assignee: issue.assignee,
    createdUser: issue.createdUser,
    created: issue.created,
    updated: issue.updated,
    source: { kind: 'issue', issue },
  };
}

/**
 * Everything §7.4 and §7.3 show of a root, so a test can compare two roots by
 * what a consumer sees rather than by fields no member reads.
 */
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

function rootFrom(subject: SubjectClient, raw: BacklogRawMessage): SubjectRoot {
  const root = subject.rootFrom(raw);
  if (root === undefined) {
    throw new Error('the raw did not describe this subject root');
  }
  return root;
}

/**
 * A pull request's root and a comment, as `message.raw` carries them: neither
 * describes an issue's root, however much of the same thread they are about.
 */
const PULL_REQUEST_RAW: BacklogRawMessage = {
  kind: 'pullRequest',
  host: HOST,
  changes: [],
  pullRequest: {
    id: 90001,
    projectId: PROJECT_ID,
    repositoryId: 700,
    number: 12,
    summary: 'Retry the login request once',
    description: 'Retries a failed login once before giving up',
    base: 'main',
    branch: 'feature/login-retry',
    status: { id: 1, name: 'Open' },
    assignee: { id: ALICE.id, name: ALICE.name },
    issue: { id: ISSUE_ID, issueKey: 'PROJECT-42' },
    baseCommit: 'aaa',
    branchCommit: 'bbb',
    mergeCommit: null,
    closeAt: null,
    mergeAt: null,
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
    content: 'a file for you',
    createdUser: { id: BOB.id, name: BOB.name, userId: BOB.userId },
    created: '2026-09-02T11:30:00.000Z',
    updated: '2026-09-02T11:30:00.000Z',
    changeLog: [],
    stars: [],
  },
};

describe('the issue subject client', () => {
  it('reads a thread root as the issue summary and description', async () => {
    const { subject } = clientWith({
      getIssue: vi.fn().mockResolvedValue(ISSUE),
    });

    const root = await subject.fetchRoot();

    expect(root).toMatchObject({
      ref: REF,
      title: 'Login fails on retry',
      body: 'Steps to reproduce',
      status: { id: 1, name: 'Open' },
      assignee: ALICE,
      createdUser: BOB,
      source: { kind: 'issue', issue: ISSUE },
    });
  });

  it('normalises a root into the fields the adapter reads and no others', async () => {
    const { subject } = clientWith({
      getIssue: vi.fn().mockResolvedValue(ISSUE),
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

  it('addresses every comment operation by the issue id', async () => {
    const listComments = vi.fn().mockResolvedValue([]);
    const getComment = vi.fn().mockResolvedValue(comment([]));
    const addComment = vi.fn().mockResolvedValue(comment([]));
    const updateComment = vi.fn().mockResolvedValue(comment([]));
    const { subject } = clientWith({
      listComments,
      getComment,
      addComment,
      updateComment,
    });

    await subject.listComments({ count: 20, order: 'desc' });
    await subject.getComment(COMMENT_ID);
    await subject.addComment({
      content: 'hello',
      attachmentId: [ATTACHMENT_ID],
    });
    await subject.updateComment(COMMENT_ID, 'edited');

    expect(listComments).toHaveBeenCalledWith(ISSUE_ID, {
      count: 20,
      order: 'desc',
    });
    expect(getComment).toHaveBeenCalledWith(ISSUE_ID, COMMENT_ID);
    expect(addComment).toHaveBeenCalledWith(ISSUE_ID, {
      content: 'hello',
      attachmentId: [ATTACHMENT_ID],
    });
    expect(updateComment).toHaveBeenCalledWith(ISSUE_ID, COMMENT_ID, 'edited');
  });

  it('deletes an issue comment, which Backlog supports', async () => {
    const deleteComment = vi.fn().mockResolvedValue(comment([]));
    const { subject } = clientWith({ deleteComment });

    await expect(subject.deleteComment(COMMENT_ID)).resolves.toBeUndefined();

    expect(subject.capabilities.deleteComment).toBe(true);
    expect(deleteComment).toHaveBeenCalledWith(ISSUE_ID, COMMENT_ID);
  });

  it('stars an issue comment as an issue comment', () => {
    const { subject } = clientWith();

    expect(subject.starTarget(COMMENT_ID)).toEqual({ commentId: COMMENT_ID });
  });

  it('carries the root into raw data with timestamps a queue can serialise', () => {
    const { subject } = clientWith();

    expect(subject.rootRaw(rootOf())).toEqual({
      kind: 'issue',
      host: HOST,
      changes: [],
      issue: {
        id: ISSUE_ID,
        issueKey: 'PROJECT-42',
        projectId: PROJECT_ID,
        summary: 'Login fails on retry',
        description: 'Steps to reproduce',
        status: { id: 1, name: 'Open' },
        issueType: { id: 1, name: 'Bug' },
        priority: { id: 3, name: 'Normal' },
        assignee: { id: ALICE.id, name: ALICE.name },
        createdUser: { id: BOB.id, name: BOB.name, userId: BOB.userId },
        created: '2026-09-01T10:00:00.000Z',
        updated: '2026-09-02T11:30:00.000Z',
      },
    });
  });

  it('the subject of a serialised issue root is read without a call', () => {
    const { subject, calls } = clientWith();

    const root = rootFrom(subject, subject.rootRaw(rootOf()));

    expect(calls).toEqual([]);
    expect(subject.subjectRaw(root)).toEqual({
      ...ISSUE,
      assignee: { ...ALICE, userId: null },
    });
  });

  it("a raw belonging to the other kind is not mistaken for this subject's root", () => {
    const { subject, calls } = clientWith();

    expect(subject.rootFrom(PULL_REQUEST_RAW)).toBeUndefined();
    expect(subject.rootFrom(COMMENT_RAW)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('the round trip through a serialised root keeps every field the subject shows', () => {
    const { subject } = clientWith();
    const direct = rootOf();
    const serialised = JSON.parse(
      JSON.stringify(subject.rootRaw(direct))
    ) as BacklogRawMessage;

    const root = rootFrom(subject, serialised);

    expect(subjectView(subject, root, {})).toEqual(
      subjectView(subject, rootOf(), {})
    );
  });

  it('an issue comment attachment takes its id from the changelog rather than a lookup', async () => {
    const downloadAttachment = vi.fn().mockResolvedValue({
      filename: 'trace.log',
      contentType: 'text/plain',
      data: Buffer.from('trace'),
    });
    const { subject, calls } = clientWith({ downloadAttachment });

    const attachments = subject.commentAttachments(
      comment([
        {
          field: 'attachment',
          newValue: 'trace.log',
          oldValue: null,
          attachmentInfo: { id: ATTACHMENT_ID, name: 'trace.log', size: 12 },
        },
      ])
    );

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      type: 'file',
      name: 'trace.log',
      url: `https://${HOST}/api/v2/issues/${ISSUE_ID}/attachments/${ATTACHMENT_ID}`,
    });
    expect(calls).toEqual([]);

    const data = await attachments[0]?.fetchData?.();

    expect(downloadAttachment).toHaveBeenCalledWith(ISSUE_ID, ATTACHMENT_ID);
    expect(calls).toEqual(['downloadAttachment']);
    expect(Buffer.from(data as Buffer).toString()).toBe('trace');
  });

  it('an attachment the changelog records as removed is not offered as a file', () => {
    const { subject } = clientWith();

    expect(
      subject.commentAttachments(
        comment([
          {
            field: 'attachment',
            newValue: null,
            oldValue: 'trace.log',
            attachmentInfo: { id: ATTACHMENT_ID, name: 'trace.log', size: 12 },
          },
          {
            field: 'status',
            newValue: 'Closed',
            oldValue: 'Open',
            attachmentInfo: null,
          },
        ])
      )
    ).toEqual([]);
  });

  it('a webhook attachment on an issue keeps the size the payload carried', () => {
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
      url: `https://${HOST}/api/v2/issues/${ISSUE_ID}/attachments/${ATTACHMENT_ID}`,
    });
  });

  it("an issue webhook's changes carry no attachment", () => {
    const { subject, calls } = clientWith();

    expect(
      subject.webhookChangeAttachment({
        field: 'attachment',
        newValue: 'trace.log',
        oldValue: '',
      })
    ).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('names the channel from the issue key rather than looking the project up', () => {
    const { subject, calls } = clientWith();

    expect(subject.channelName(rootOf(), {})).toBe('PROJECT');
    expect(calls).toEqual([]);
  });

  it('keeps the project key of a key that holds several dashes', () => {
    const { subject } = clientWith();

    expect(
      subject.channelName(rootOf({ ...ISSUE, issueKey: 'MY-PROJECT-42' }), {})
    ).toBe('MY-PROJECT');
  });

  it('an issue web url needs no name the read did not already fetch', () => {
    const { subject } = clientWith();

    expect(subject.webUrl(rootOf(), {})).toBe(
      'https://example.backlog.com/view/PROJECT-42'
    );
  });

  it('an issue thread carries the issue fields §7.3 lists, under its own kind', () => {
    const { subject } = clientWith();

    expect(subject.threadMetadata(rootOf(), {})).toEqual({
      kind: 'issue',
      host: HOST,
      issueId: ISSUE_ID,
      issueKey: 'PROJECT-42',
      projectId: PROJECT_ID,
      summary: 'Login fails on retry',
      description: 'Steps to reproduce',
      status: { id: 1, name: 'Open' },
      assignee: { id: ALICE.id, name: ALICE.name },
      issueType: { id: 1, name: 'Bug' },
      priority: { id: 3, name: 'Normal' },
      createdUserId: BOB.id,
      created: ISSUE.created,
      updated: ISSUE.updated,
      url: 'https://example.backlog.com/view/PROJECT-42',
    });
  });

  it('describes an issue subject by its type and its priority', () => {
    const { subject } = clientWith();

    expect(subject.subjectType).toBe('issue');
    expect(subject.subjectLabels(rootOf())).toEqual(['Bug', 'Normal']);
  });

  it('an issue thread needs no repository name', () => {
    const { subject } = clientWith();

    expect(subject.repositoryIdForName).toBeUndefined();
  });

  it('a read receipt on an issue matches the issue comment id, never a pull request comment sharing it', () => {
    const { subject } = clientWith();
    const notification = {
      comment: { id: COMMENT_ID },
      pullRequestComment: { id: 7000001 },
    } as unknown as BacklogNotification;

    expect(subject.notificationCommentId(notification)).toBe(COMMENT_ID);
    expect(
      subject.notificationCommentId({
        ...notification,
        comment: null,
      } as unknown as BacklogNotification)
    ).toBeUndefined();
  });
});
