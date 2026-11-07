import { AdapterError, ResourceNotFoundError } from '@chat-adapter/shared';
import { describe, expect, it, vi } from 'vite-plus/test';

import {
  ALICE,
  BOB,
  REST,
  comment,
  fileData,
  issue,
  issueComment,
  pullRequest,
  stubClient,
} from '../test/fixtures/rest';
import { createIssueSubjectClient } from './issue';

import type {
  BacklogRawIssue,
  BacklogRawMessage,
  BacklogSubjectRef,
} from '../types';
import type { SubjectClient, SubjectRoot } from './client';
import type { Backlog } from 'backlog-js';

const COMMENT_ID = 3;
const ATTACHMENT_ID = 4242;

const REF: Extract<BacklogSubjectRef, { kind: 'issue' }> = {
  kind: 'issue',
  issueId: REST.issueId,
};

function subjectOn(client: Backlog = stubClient({})): SubjectClient {
  return createIssueSubjectClient(client, REF, {
    host: REST.host,
    projectId: REST.projectId,
  });
}

function issueRaw(fixture: BacklogRawIssue = issue()): BacklogRawMessage {
  return { kind: 'issue', host: REST.host, issue: fixture, changes: [] };
}

async function rootOf(
  subject: SubjectClient,
  fixture: BacklogRawIssue = issue()
): Promise<SubjectRoot> {
  const root = await subject.rootFrom(issueRaw(fixture));
  if (root === undefined) {
    throw new Error('an issue raw did not yield an issue root');
  }
  return root;
}

describe('the issue subject client', () => {
  it('reads a thread root from the issue its id names', async () => {
    const fixture = issue({ assignee: ALICE });
    const getIssue = vi.fn().mockResolvedValue(fixture);
    const subject = subjectOn(stubClient({ getIssue }));

    const root = await subject.fetchRoot();

    expect(getIssue).toHaveBeenCalledWith(REST.issueId);
    expect(root).toMatchObject({
      title: 'Login fails on retry',
      body: 'Steps to reproduce',
      status: fixture.status,
      assignee: ALICE,
      createdUser: BOB,
      created: '2026-09-01T10:00:00Z',
    });
  });

  it('addresses every comment operation by the issue id', async () => {
    const getIssueComments = vi.fn().mockResolvedValue([]);
    const getIssueComment = vi
      .fn()
      .mockResolvedValue(issueComment({ id: COMMENT_ID }));
    const postIssueComments = vi.fn().mockResolvedValue(issueComment());
    const patchIssueComment = vi.fn().mockResolvedValue(issueComment());
    const subject = subjectOn(
      stubClient({
        getIssueComments,
        getIssueComment,
        postIssueComments,
        patchIssueComment,
      })
    );

    await subject.listComments({ count: 20, order: 'desc' });
    await subject.getComment(COMMENT_ID);
    await subject.addComment({
      content: 'hello',
      attachmentId: [ATTACHMENT_ID],
    });
    await subject.updateComment(COMMENT_ID, 'edited');

    expect(getIssueComments).toHaveBeenCalledWith(REST.issueId, {
      count: 20,
      order: 'desc',
    });
    expect(getIssueComment).toHaveBeenCalledWith(REST.issueId, COMMENT_ID);
    expect(postIssueComments).toHaveBeenCalledWith(REST.issueId, {
      content: 'hello',
      attachmentId: [ATTACHMENT_ID],
    });
    expect(patchIssueComment).toHaveBeenCalledWith(REST.issueId, COMMENT_ID, {
      content: 'edited',
    });
  });

  it('a comment id that belongs to another issue is not found on this one', async () => {
    const subject = subjectOn(
      stubClient({
        getIssueComment: vi
          .fn()
          .mockResolvedValue({ ...comment({ id: COMMENT_ID }), issueId: 9999 }),
      })
    );

    await expect(subject.getComment(COMMENT_ID)).rejects.toBeInstanceOf(
      ResourceNotFoundError
    );
  });

  it('deletes an issue comment that records no change', async () => {
    const deleteIssueComment = vi.fn().mockResolvedValue(issueComment());
    const subject = subjectOn(
      stubClient({
        getIssueComment: vi.fn().mockResolvedValue(issueComment()),
        deleteIssueComment,
      })
    );

    await expect(subject.deleteComment(COMMENT_ID)).resolves.toBeUndefined();

    expect(deleteIssueComment).toHaveBeenCalledWith(REST.issueId, COMMENT_ID);
  });

  it('refuses to delete an issue comment that records a change, which Backlog would keep', async () => {
    const deleteIssueComment = vi.fn();
    const subject = subjectOn(
      stubClient({
        getIssueComment: vi.fn().mockResolvedValue(
          issueComment({
            changeLog: [
              {
                field: 'attachment',
                newValue: 'trace.log',
                originalValue: null,
                attachmentInfo: { id: ATTACHMENT_ID },
              },
            ],
          })
        ),
        deleteIssueComment,
      })
    );

    const failure: unknown = await subject
      .deleteComment(COMMENT_ID)
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(AdapterError);
    expect((failure as AdapterError).code).toBe('UNSUPPORTED_OPERATION');
    expect(deleteIssueComment).not.toHaveBeenCalled();
  });

  it('stars an issue comment as an issue comment', () => {
    expect(subjectOn().starTarget(COMMENT_ID)).toEqual({
      commentId: COMMENT_ID,
    });
  });

  it('the root message raw and the subject raw carry the issue it read unchanged', async () => {
    const subject = subjectOn();
    const fixture = issue();

    const root = await rootOf(subject, fixture);

    expect(root.raw).toEqual({
      kind: 'issue',
      host: REST.host,
      issue: fixture,
      changes: [],
    });
    expect(root.subject.raw).toBe(fixture);
  });

  it('a root survives a JSON round trip through its raw', async () => {
    const subject = subjectOn();
    const root = await rootOf(subject);
    const serialised = JSON.parse(
      JSON.stringify(root.raw)
    ) as BacklogRawMessage;

    expect(await subject.rootFrom(serialised)).toEqual(root);
  });

  it("a raw belonging to another kind is not mistaken for this subject's root", async () => {
    const subject = subjectOn();

    expect(
      await subject.rootFrom({
        kind: 'pullRequest',
        host: REST.host,
        pullRequest: pullRequest(),
        changes: [],
      })
    ).toBeUndefined();
    expect(
      await subject.rootFrom({
        kind: 'comment',
        host: REST.host,
        projectId: REST.projectId,
        subject: REF,
        comment: comment(),
        changes: [],
      })
    ).toBeUndefined();
  });

  it('an issue comment attachment takes its id from the changelog rather than a lookup', async () => {
    const getIssueAttachment = vi.fn().mockResolvedValue(fileData('trace'));
    const subject = subjectOn(stubClient({ getIssueAttachment }));

    const attachments = subject.commentAttachments(
      comment({
        changeLog: [
          {
            field: 'attachment',
            newValue: 'trace.log',
            originalValue: null,
            attachmentInfo: { id: ATTACHMENT_ID },
          },
        ],
      })
    );

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      type: 'file',
      name: 'trace.log',
      url: `https://${REST.host}/api/v2/issues/${REST.issueId}/attachments/${ATTACHMENT_ID}`,
    });
    expect(getIssueAttachment).not.toHaveBeenCalled();

    const data = await attachments[0]?.fetchData?.();

    expect(getIssueAttachment).toHaveBeenCalledWith(
      REST.issueId,
      ATTACHMENT_ID
    );
    expect(data?.toString()).toBe('trace');
  });

  it('an attachment the changelog records as removed is not offered as a file', () => {
    const subject = subjectOn();

    expect(
      subject.commentAttachments(
        comment({
          changeLog: [
            {
              field: 'attachment',
              newValue: null,
              originalValue: 'trace.log',
              attachmentInfo: { id: ATTACHMENT_ID },
            },
            {
              field: 'status',
              newValue: 'Closed',
              originalValue: 'Open',
              attachmentInfo: null,
            },
          ],
        })
      )
    ).toEqual([]);
  });

  it('a webhook attachment on an issue keeps the size the payload carried', () => {
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
      url: `https://${REST.host}/api/v2/issues/${REST.issueId}/attachments/${ATTACHMENT_ID}`,
    });
  });

  it("an issue webhook's changes carry no attachment", () => {
    expect(
      subjectOn().webhookChangeAttachment({
        field: 'attachment',
        newValue: 'trace.log',
        oldValue: '',
      })
    ).toBeUndefined();
  });

  it('names the channel from the issue key rather than looking the project up', async () => {
    const getProject = vi.fn();
    const subject = subjectOn(stubClient({ getProject }));

    expect((await rootOf(subject)).channelName).toBe('PROJECT');
    expect(getProject).not.toHaveBeenCalled();
  });

  it('keeps the project key of a key that holds several dashes', async () => {
    const subject = subjectOn();

    const root = await rootOf(subject, issue({ issueKey: 'MY-PROJECT-42' }));

    expect(root.channelName).toBe('MY-PROJECT');
  });

  it('an issue thread carries its ids, key, summary, status and url, under its own kind', async () => {
    const root = await rootOf(subjectOn());

    expect(root.threadMetadata).toEqual({
      kind: 'issue',
      host: REST.host,
      projectId: REST.projectId,
      issueId: REST.issueId,
      issueKey: 'PROJECT-42',
      summary: 'Login fails on retry',
      status: { id: 1, name: 'Open' },
      url: 'https://example.backlog.com/view/PROJECT-42',
    });
  });

  it('describes an issue subject by its type, its issue type and priority, and its url', async () => {
    const { subject } = await rootOf(subjectOn());

    expect(subject).toMatchObject({
      type: 'issue',
      labels: ['Bug', 'Normal'],
      url: 'https://example.backlog.com/view/PROJECT-42',
    });
  });
});
