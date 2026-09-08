import { describe, expect, it } from 'vitest';

import { ResourceNotFoundError } from '@chat-adapter/shared';

import {
  conformanceFixture,
  describeBacklogApiConformance,
} from './conformance.js';
import { createInMemoryBacklogApi } from './in-memory.js';

import type { InMemoryBacklogSeed } from './in-memory.js';

const {
  projectId,
  issueId,
  otherIssueId,
  repositoryId,
  otherRepositoryId,
  pullRequestNumber,
  otherPullRequestId,
  otherPullRequestNumber,
  pullRequestCommentIds,
  bot,
  alice,
  bob,
  baseProject,
  baseIssue,
  baseIssueTypes,
  basePriorities,
  baseComment,
  statusChangeLog,
  baseGitRepository,
  basePullRequest,
  basePullRequestComment,
  basePullRequestAttachment,
  pullRequestRef,
  baseNotifications,
} = conformanceFixture;

const pullRequestCommentsKey = `${repositoryId}:${pullRequestNumber}`;

function seed(): InMemoryBacklogSeed {
  return {
    me: bot,
    users: [alice, bob, bot],
    projects: [baseProject()],
    issues: [
      baseIssue({ id: issueId }),
      baseIssue({ id: otherIssueId, issueKey: 'PROJECT-2' }),
    ],
    comments: [
      baseComment({ id: 1, issueId }),
      baseComment({ id: 2, issueId, createdUser: bob }),
      baseComment({
        id: 3,
        issueId,
        createdUser: bob,
        changeLog: statusChangeLog,
      }),
      baseComment({ id: 4, issueId: otherIssueId }),
    ],
    issueTypes: { [projectId]: baseIssueTypes() },
    // Seeded rather than left to the factory's default, which happens to hold
    // the same three: a `createIssue` conformance test names priority 2 by id.
    priorities: basePriorities(),
    notifications: baseNotifications(),
    repositories: [
      baseGitRepository(),
      baseGitRepository({ id: otherRepositoryId, name: 'other-repo' }),
    ],
    pullRequests: [
      basePullRequest(),
      basePullRequest({
        id: otherPullRequestId,
        number: otherPullRequestNumber,
      }),
    ],
    pullRequestComments: {
      [pullRequestCommentsKey]: pullRequestCommentIds.map((id) =>
        basePullRequestComment({ id })
      ),
    },
    pullRequestAttachments: {
      [pullRequestCommentsKey]: [basePullRequestAttachment()],
    },
    now: () => new Date('2026-01-02T00:00:00Z'),
  };
}

describeBacklogApiConformance('createInMemoryBacklogApi', () =>
  createInMemoryBacklogApi(seed())
);

describe('createInMemoryBacklogApi', () => {
  it('exposes state for assertions on recorded inputs', async () => {
    const api = createInMemoryBacklogApi(seed());
    await api.addComment(issueId, { content: 'Recorded' });
    expect(api.state.recordedInputs).toContainEqual({
      method: 'addComment',
      issueId,
      input: { content: 'Recorded' },
    });
  });

  it('records a pull-request comment against the three coordinates it was addressed with', async () => {
    const api = createInMemoryBacklogApi(seed());
    const ref = pullRequestRef();
    // Edits its own comment rather than a seeded one: the port refuses to
    // update another user's, as Backlog does.
    const added = await api.addPullRequestComment(ref, { content: 'Recorded' });
    await api.updatePullRequestComment(ref, added.id, 'Edited');
    expect(api.state.recordedInputs).toContainEqual({
      method: 'addPullRequestComment',
      ref,
      input: { content: 'Recorded' },
    });
    expect(api.state.recordedInputs).toContainEqual({
      method: 'updatePullRequestComment',
      ref,
      commentId: added.id,
      content: 'Edited',
    });
  });

  it('records a star target whole, so which kind of comment was starred stays readable', async () => {
    const api = createInMemoryBacklogApi(seed());
    await api.addStar({ pullRequestCommentId: pullRequestCommentIds[0] });
    expect(api.state.recordedInputs).toContainEqual({
      method: 'addStar',
      target: { pullRequestCommentId: pullRequestCommentIds[0] },
    });
  });

  it('allocates new ids starting above every seeded id, issues included', async () => {
    const api = createInMemoryBacklogApi(seed());
    const created = await api.createIssue({
      projectId,
      summary: 'New',
      issueTypeId: 1,
      priorityId: 3,
    });
    expect(created.id).toBeGreaterThan(otherIssueId);
  });

  it('allocates new ids starting above every seeded id, pull-request comments included', async () => {
    const api = createInMemoryBacklogApi(seed());
    const added = await api.addPullRequestComment(pullRequestRef(), {
      content: 'New',
    });
    expect(added.id).toBeGreaterThan(Math.max(...pullRequestCommentIds));
  });

  it('seeding does not alias the caller-supplied seed objects', async () => {
    const mySeed = seed();
    const api = createInMemoryBacklogApi(mySeed);
    await api.createIssue({
      projectId,
      summary: 'New',
      issueTypeId: 1,
      priorityId: 3,
    });
    await api.addPullRequestComment(pullRequestRef(), { content: 'New' });
    expect(mySeed.issues).toHaveLength(2);
    expect(mySeed.pullRequestComments?.[pullRequestCommentsKey]).toHaveLength(
      pullRequestCommentIds.length
    );
  });

  it('holds the comments of a pull request in state under its repository and number', async () => {
    const api = createInMemoryBacklogApi(seed());
    const added = await api.addPullRequestComment(pullRequestRef(), {
      content: 'New',
    });
    expect(
      api.state.pullRequestComments[pullRequestCommentsKey]?.map((c) => c.id)
    ).toEqual([...pullRequestCommentIds, added.id]);
  });

  it('resolves a star target within its own kind, so an id from the other sequence is not found', async () => {
    const api = createInMemoryBacklogApi(seed());
    await expect(
      api.addStar({ pullRequestCommentId: 1 })
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(
      api.addStar({ commentId: pullRequestCommentIds[0] })
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('removes a star from the pull-request comment carrying it', async () => {
    const api = createInMemoryBacklogApi(seed());
    const ref = pullRequestRef();
    await api.addStar({ pullRequestCommentId: pullRequestCommentIds[0] });
    const starred = api.state.stars[api.state.stars.length - 1];
    if (starred === undefined) throw new Error('addStar recorded no star');
    await api.deleteStar(starred.id);
    const comments = await api.listPullRequestComments(ref, {
      count: 100,
      order: 'asc',
    });
    expect(comments[0]?.stars).toEqual([]);
  });

  it('downloads a file the test uploaded from any pull request, so an egress round trip needs no seeded attachment', async () => {
    const api = createInMemoryBacklogApi(seed());
    const uploaded = await api.uploadAttachment(
      'notes.txt',
      Buffer.from('hello')
    );
    await expect(
      api.downloadPullRequestAttachment(pullRequestRef(), uploaded.id)
    ).resolves.toMatchObject({ filename: 'notes.txt' });
  });

  it('gives an uploaded file back byte for byte, on both download paths', async () => {
    const api = createInMemoryBacklogApi(seed());
    const uploaded = await api.uploadAttachment(
      'notes.txt',
      Buffer.from('hello'),
      'text/plain'
    );

    const fromIssue = await api.downloadAttachment(issueId, uploaded.id);
    const fromPullRequest = await api.downloadPullRequestAttachment(
      pullRequestRef(),
      uploaded.id
    );

    expect(fromIssue.data.toString()).toBe('hello');
    expect(fromPullRequest.data.toString()).toBe('hello');
    // The two downloads report the content type differently on a real space:
    // the pull-request one answers the file's own, the issue one
    // `application/octet-stream` (measured 2026-09-06,
    // `.claude/rules/backlog-pull-request-facts.md` "Attachments").
    expect(fromPullRequest.contentType).toBe('text/plain');
    expect(fromIssue.contentType).toBe('application/octet-stream');
  });

  it('records the bytes an upload was given, as a copy the caller cannot rewrite', async () => {
    const api = createInMemoryBacklogApi(seed());
    const data = Buffer.from('hello');

    await api.uploadAttachment('notes.txt', data, 'text/plain');
    data.write('world');

    expect(api.state.recordedInputs).toContainEqual({
      method: 'uploadAttachment',
      filename: 'notes.txt',
      data: Buffer.from('hello'),
      mimeType: 'text/plain',
    });
  });
});
