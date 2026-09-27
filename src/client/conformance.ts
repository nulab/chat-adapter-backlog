import { describe, expect, it } from 'vitest';

import {
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from '@chat-adapter/shared';

import type {
  BacklogApi,
  BacklogComment,
  BacklogGitRepository,
  BacklogIssue,
  BacklogIssueComment,
  BacklogProject,
  BacklogPullRequest,
  BacklogPullRequestAttachment,
  BacklogUserRef,
  PullRequestRef,
} from './port.js';

/** A fresh, seeded `BacklogApi` for one test. */
export type BacklogApiFactory = () => BacklogApi | Promise<BacklogApi>;

const HOST = 'example.backlog.com';
const PROJECT_ID = 500;
const ISSUE_ID = 8001;
const OTHER_ISSUE_ID = 8002;
const REPOSITORY_ID = 700;
const OTHER_REPOSITORY_ID = 701;
const PULL_REQUEST_NUMBER = 12;
const PULL_REQUEST_ID = 90001;
const OTHER_PULL_REQUEST_NUMBER = 13;
const OTHER_PULL_REQUEST_ID = 90002;
const PULL_REQUEST_ATTACHMENT_ID = 9101;
/**
 * Seven-digit while the issue comments above are 1..4: the two sequences are
 * separate on a real space (`.claude/rules/backlog-pull-request-facts.md`
 * "Ids"), so a fixture where a bare comment id identifies one kind would let
 * a `commentId`/`pullRequestCommentId` mix-up pass unnoticed.
 */
const PULL_REQUEST_COMMENT_IDS = [7000001, 7000002, 7000003, 7000004] as const;
const BOT: BacklogUserRef = {
  id: 999,
  userId: 'chatbot',
  name: 'Chatbot',
  mailAddress: null,
};
const ALICE: BacklogUserRef = {
  id: 100,
  userId: 'alice',
  name: 'Alice',
  mailAddress: 'alice@example.com',
};
const BOB: BacklogUserRef = {
  id: 101,
  userId: 'bob',
  name: 'Bob',
  mailAddress: 'bob@example.com',
};

function baseProject(): BacklogProject {
  return {
    id: PROJECT_ID,
    projectKey: 'PROJECT',
    name: 'Project',
    textFormattingRule: 'markdown',
  };
}

function baseIssue(overrides: Partial<BacklogIssue> = {}): BacklogIssue {
  return {
    id: ISSUE_ID,
    projectId: PROJECT_ID,
    issueKey: 'PROJECT-1',
    summary: 'Seeded issue',
    description: '',
    issueType: { id: 1, name: 'Task' },
    priority: { id: 3, name: 'Normal' },
    status: { id: 1, name: 'Open' },
    assignee: null,
    createdUser: ALICE,
    created: new Date('2026-01-01T00:00:00Z'),
    updated: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function baseComment(
  overrides: Partial<BacklogIssueComment> = {}
): BacklogIssueComment {
  return {
    id: 1,
    issueId: ISSUE_ID,
    content: 'Seeded comment',
    changeLog: [],
    createdUser: ALICE,
    created: new Date('2026-01-01T00:00:00Z'),
    updated: new Date('2026-01-01T00:00:00Z'),
    stars: [],
    ...overrides,
  };
}

function baseGitRepository(
  overrides: Partial<BacklogGitRepository> = {}
): BacklogGitRepository {
  return {
    id: REPOSITORY_ID,
    projectId: PROJECT_ID,
    name: 'example-repo',
    description: '',
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
    summary: 'Add the thing',
    description: 'Body of the PR.',
    base: 'main',
    branch: 'feature/thing',
    status: { id: 1, name: 'Open' },
    assignee: null,
    issue: { id: ISSUE_ID, issueKey: 'PROJECT-1' },
    baseCommit: null,
    branchCommit: null,
    mergeCommit: null,
    closeAt: null,
    mergeAt: null,
    createdUser: ALICE,
    created: new Date('2026-01-01T00:00:00Z'),
    updated: new Date('2026-01-01T00:00:00Z'),
    stars: [],
    ...overrides,
  };
}

function basePullRequestComment(
  overrides: Partial<BacklogComment> = {}
): BacklogComment {
  return {
    id: PULL_REQUEST_COMMENT_IDS[0],
    content: 'Seeded pull request comment',
    changeLog: [],
    createdUser: ALICE,
    created: new Date('2026-01-01T00:00:00Z'),
    updated: new Date('2026-01-01T00:00:00Z'),
    stars: [],
    ...overrides,
  };
}

function basePullRequestAttachment(
  overrides: Partial<BacklogPullRequestAttachment> = {}
): BacklogPullRequestAttachment {
  return {
    id: PULL_REQUEST_ATTACHMENT_ID,
    name: 'diagram.png',
    size: 4096,
    created: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function pullRequestRef(
  overrides: Partial<PullRequestRef> = {}
): PullRequestRef {
  return {
    projectId: PROJECT_ID,
    repositoryId: REPOSITORY_ID,
    number: PULL_REQUEST_NUMBER,
    ...overrides,
  };
}

/**
 * Runs the behavioural guarantees of docs/specs/adapter.md §8.6 against a
 * `BacklogApi`. Both `createBacklogJsApi` (over a fake `fetch`) and
 * `createInMemoryBacklogApi` pass this exact suite — one factory of
 * expectations, two implementations under test — so a divergence between
 * them shows up as a conformance failure rather than as a silent behaviour
 * difference discovered later in the adapter.
 */
export function describeBacklogApiConformance(
  name: string,
  factory: BacklogApiFactory
): void {
  describe(`${name} (Backlog API conformance)`, () => {
    it('fetches an issue, a project, a user and a comment', async () => {
      const api = await factory();
      await expect(api.getIssue(ISSUE_ID)).resolves.toMatchObject({
        id: ISSUE_ID,
      });
      await expect(api.getProject(PROJECT_ID)).resolves.toMatchObject({
        id: PROJECT_ID,
      });
      await expect(api.getUser(100)).resolves.toMatchObject({
        id: 100,
        userId: 'alice',
      });
      await expect(api.getComment(ISSUE_ID, 1)).resolves.toMatchObject({
        id: 1,
      });
    });

    it('the authenticated user is the bot the credential belongs to', async () => {
      const api = await factory();
      await expect(api.getMyself()).resolves.toMatchObject({
        id: BOT.id,
        name: BOT.name,
      });
    });

    it('a missing issue, project, user or comment is a ResourceNotFoundError', async () => {
      const api = await factory();
      await expect(api.getIssue(999_999)).rejects.toBeInstanceOf(
        ResourceNotFoundError
      );
      await expect(api.getProject(999_999)).rejects.toBeInstanceOf(
        ResourceNotFoundError
      );
      await expect(api.getUser(999_999)).rejects.toBeInstanceOf(
        ResourceNotFoundError
      );
      await expect(api.getComment(ISSUE_ID, 999_999)).rejects.toBeInstanceOf(
        ResourceNotFoundError
      );
    });

    it('a comment id belonging to another issue is not found', async () => {
      const api = await factory();
      await expect(api.getComment(OTHER_ISSUE_ID, 1)).rejects.toBeInstanceOf(
        ResourceNotFoundError
      );
    });

    it("a comment's previous value arrives as originalValue and is read as oldValue", async () => {
      const api = await factory();
      const comments = await api.listComments(ISSUE_ID, {
        count: 100,
        order: 'asc',
      });
      const changed = comments.find((c) => c.changeLog.length > 0);
      expect(
        changed,
        'fixture must seed one comment with a changeLog'
      ).toBeDefined();
      expect(changed?.changeLog[0]).toMatchObject({
        field: 'status',
        newValue: '4',
        oldValue: '3',
      });
    });

    it('adding, editing and deleting a comment is reflected in the list', async () => {
      const api = await factory();
      const added = await api.addComment(ISSUE_ID, { content: 'New comment' });
      const afterAdd = await api.listComments(ISSUE_ID, {
        count: 100,
        order: 'asc',
      });
      expect(afterAdd.map((c) => c.id)).toContain(added.id);

      const edited = await api.updateComment(
        ISSUE_ID,
        added.id,
        'Edited comment'
      );
      expect(edited.content).toBe('Edited comment');

      const deleted = await api.deleteComment(ISSUE_ID, added.id);
      expect(deleted.id).toBe(added.id);
      const afterDelete = await api.listComments(ISSUE_ID, {
        count: 100,
        order: 'asc',
      });
      expect(afterDelete.map((c) => c.id)).not.toContain(added.id);
    });

    it('addComment accepts notifiedUserId and attachmentId', async () => {
      const api = await factory();
      await expect(
        api.addComment(ISSUE_ID, {
          content: 'Notify',
          notifiedUserId: [100],
          attachmentId: [1],
        })
      ).resolves.toMatchObject({ content: 'Notify' });
    });

    it('listing with minId and maxId excludes both bounds', async () => {
      const api = await factory();
      const all = await api.listComments(ISSUE_ID, {
        count: 100,
        order: 'asc',
      });
      const ids = all.map((c) => c.id).sort((a, b) => a - b);
      // Requires at least 3 seeded comments on ISSUE_ID to bracket a middle id.
      expect(ids.length).toBeGreaterThanOrEqual(3);
      const first = ids[0];
      const third = ids[2];
      if (first === undefined || third === undefined) {
        throw new Error(
          'fixture must seed at least three comments on ISSUE_ID'
        );
      }
      const withBothBounds = await api.listComments(ISSUE_ID, {
        count: 100,
        order: 'asc',
        minId: first,
        maxId: third,
      });
      expect(withBothBounds.map((c) => c.id)).not.toContain(first);
      expect(withBothBounds.map((c) => c.id)).not.toContain(third);
    });

    it('issue list paging honours count and offset', async () => {
      const api = await factory();
      const firstPage = await api.listIssues(PROJECT_ID, {
        count: 1,
        offset: 0,
      });
      const secondPage = await api.listIssues(PROJECT_ID, {
        count: 1,
        offset: 1,
      });
      expect(firstPage).toHaveLength(1);
      expect(secondPage).toHaveLength(1);
      expect(firstPage[0]?.id).not.toBe(secondPage[0]?.id);
    });

    it('a comment with no content is a ValidationError, on an issue and on a pull request', async () => {
      const api = await factory();
      await expect(
        api.addComment(ISSUE_ID, { content: '' })
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        api.addPullRequestComment(pullRequestRef(), { content: '' })
      ).rejects.toBeInstanceOf(ValidationError);

      // Own comments, so the update reaches the content check rather than
      // stopping at the ownership one.
      const added = await api.addComment(ISSUE_ID, { content: 'Body' });
      await expect(
        api.updateComment(ISSUE_ID, added.id, '')
      ).rejects.toBeInstanceOf(ValidationError);

      const addedToPullRequest = await api.addPullRequestComment(
        pullRequestRef(),
        { content: 'Body' }
      );
      await expect(
        api.updatePullRequestComment(
          pullRequestRef(),
          addedToPullRequest.id,
          ''
        )
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it('a single space is a comment body, because that is what an empty stream posts', async () => {
      // `stream()` posts `" "` for a stream that yields nothing
      // (docs/specs/adapter.md §4.2 `stream` and §15 question 7, settled;
      // `.claude/rules/chat-sdk-core-facts.md` for the core's own fallback),
      // so an implementation that trimmed before rejecting an empty body
      // would refuse the adapter's own documented path.
      const api = await factory();
      await expect(
        api.addComment(ISSUE_ID, { content: ' ' })
      ).resolves.toMatchObject({ content: ' ' });
    });

    it("editing or deleting another user's issue comment is a PermissionError, and leaves it unchanged", async () => {
      const api = await factory();
      const seeded = await api.listComments(ISSUE_ID, {
        count: 100,
        order: 'asc',
      });
      const foreign = seeded.find((c) => c.createdUser.id !== BOT.id);
      if (foreign === undefined) {
        throw new Error(
          'fixture must seed a comment written by somebody other than the credential owner'
        );
      }
      // Read out as a primitive before the refused call. An implementation
      // may hand out live references to its own records, and comparing
      // `foreign.content` afterwards would then compare a mutated value with
      // itself — an implementation that wrote the content and only then
      // refused would pass.
      const contentBefore = foreign.content;

      await expect(
        api.updateComment(ISSUE_ID, foreign.id, 'rewritten')
      ).rejects.toBeInstanceOf(PermissionError);
      await expect(
        api.deleteComment(ISSUE_ID, foreign.id)
      ).rejects.toBeInstanceOf(PermissionError);

      const after = await api.listComments(ISSUE_ID, {
        count: 100,
        order: 'asc',
      });
      expect(after.find((c) => c.id === foreign.id)?.content).toBe(
        contentBefore
      );
    });

    it("editing another user's pull request comment is a PermissionError, and leaves it unchanged", async () => {
      const api = await factory();
      const seeded = await api.listPullRequestComments(pullRequestRef(), {
        count: 100,
        order: 'asc',
      });
      const foreign = seeded.find((c) => c.createdUser.id !== BOT.id);
      if (foreign === undefined) {
        throw new Error(
          'fixture must seed a pull request comment written by somebody other than the credential owner'
        );
      }
      // A primitive snapshot, for the reason given on the issue-side test.
      const contentBefore = foreign.content;

      await expect(
        api.updatePullRequestComment(pullRequestRef(), foreign.id, 'rewritten')
      ).rejects.toBeInstanceOf(PermissionError);

      const after = await api.listPullRequestComments(pullRequestRef(), {
        count: 100,
        order: 'asc',
      });
      expect(after.find((c) => c.id === foreign.id)?.content).toBe(
        contentBefore
      );
    });

    it('stars carry the presenter as a numeric id, matching the credential owner, and are removable by star id', async () => {
      const api = await factory();
      await api.addStar({ commentId: 1 });
      const comment = await api.getComment(ISSUE_ID, 1);
      expect(comment.stars.length).toBeGreaterThan(0);
      const star = comment.stars[comment.stars.length - 1];
      // `presenter.id` is what docs/specs/adapter.md §6.5 compares against
      // `botUserId` to decide whether a star is the bot's own — a
      // `presenter` with no usable numeric id would make that comparison
      // impossible, so this asserts the field is a number, not just present.
      expect(star?.presenter.id).toBe(BOT.id);
      if (star !== undefined) {
        await api.deleteStar(star.id);
      }
    });

    it('deleting a missing star is a ResourceNotFoundError', async () => {
      const api = await factory();
      await expect(api.deleteStar(999_999)).rejects.toBeInstanceOf(
        ResourceNotFoundError
      );
    });

    it('an upload reports the name and the byte length of the file it was given', async () => {
      const api = await factory();
      const uploaded = await api.uploadAttachment(
        'notes.txt',
        Buffer.from('hello'),
        'text/plain'
      );
      // `size` is the only place the bytes are observable through this
      // interface, so it is what separates an implementation that sent the
      // file from one that sent an empty part.
      expect(uploaded).toMatchObject({ name: 'notes.txt', size: 5 });
    });

    it('a repository and a pull request are fetched by their ids, and a missing one is a ResourceNotFoundError', async () => {
      const api = await factory();
      await expect(api.listGitRepositories(PROJECT_ID)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: REPOSITORY_ID, name: 'example-repo' }),
          expect.objectContaining({ id: OTHER_REPOSITORY_ID }),
        ])
      );
      await expect(
        api.getGitRepository(PROJECT_ID, REPOSITORY_ID)
      ).resolves.toMatchObject({ id: REPOSITORY_ID, name: 'example-repo' });
      await expect(api.getPullRequest(pullRequestRef())).resolves.toMatchObject(
        { id: PULL_REQUEST_ID, number: PULL_REQUEST_NUMBER }
      );

      await expect(
        api.getGitRepository(PROJECT_ID, 999_999)
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
      await expect(
        api.getPullRequest(pullRequestRef({ number: 999_999 }))
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it('a pull request is addressed by project, repository and number, never by its global id', async () => {
      const api = await factory();
      await expect(
        api.getPullRequest(pullRequestRef({ number: PULL_REQUEST_ID }))
      ).rejects.toBeInstanceOf(ResourceNotFoundError);
    });

    it('the pull request list pages with count and offset', async () => {
      const api = await factory();
      const firstPage = await api.listPullRequests(PROJECT_ID, REPOSITORY_ID, {
        count: 1,
        offset: 0,
      });
      const secondPage = await api.listPullRequests(PROJECT_ID, REPOSITORY_ID, {
        count: 1,
        offset: 1,
      });
      expect(firstPage).toHaveLength(1);
      expect(secondPage).toHaveLength(1);
      expect(firstPage[0]?.number).not.toBe(secondPage[0]?.number);

      const wholeRepository = await api.listPullRequests(
        PROJECT_ID,
        REPOSITORY_ID,
        { count: 100 }
      );
      expect(
        wholeRepository.map((p) => p.number).sort((a, b) => a - b)
      ).toEqual([PULL_REQUEST_NUMBER, OTHER_PULL_REQUEST_NUMBER]);
    });

    it('a pull request comment has no parent reference and is looked up through its pull request', async () => {
      const api = await factory();
      const comments = await api.listPullRequestComments(pullRequestRef(), {
        count: 100,
        order: 'asc',
      });
      expect(comments.map((c) => c.id)).toEqual([...PULL_REQUEST_COMMENT_IDS]);
      const first = comments[0];
      if (first === undefined) {
        throw new Error('fixture must seed pull request comments');
      }
      expect(Object.keys(first)).not.toContain('issueId');
    });

    it('listing pull request comments with minId and maxId excludes both bounds', async () => {
      const api = await factory();
      const bounded = await api.listPullRequestComments(pullRequestRef(), {
        count: 100,
        order: 'asc',
        minId: PULL_REQUEST_COMMENT_IDS[0],
        maxId: PULL_REQUEST_COMMENT_IDS[2],
      });
      expect(bounded.map((c) => c.id)).toEqual([PULL_REQUEST_COMMENT_IDS[1]]);
    });

    it('count cuts pull request comments from the head of the requested order', async () => {
      const api = await factory();
      const oldest = await api.listPullRequestComments(pullRequestRef(), {
        count: 2,
        order: 'asc',
      });
      expect(oldest.map((c) => c.id)).toEqual([
        PULL_REQUEST_COMMENT_IDS[0],
        PULL_REQUEST_COMMENT_IDS[1],
      ]);
      const newest = await api.listPullRequestComments(pullRequestRef(), {
        count: 2,
        order: 'desc',
      });
      expect(newest.map((c) => c.id)).toEqual([
        PULL_REQUEST_COMMENT_IDS[3],
        PULL_REQUEST_COMMENT_IDS[2],
      ]);
    });

    it('a single pull request comment is fetched through a one-element window', async () => {
      const api = await factory();
      const target = PULL_REQUEST_COMMENT_IDS[2];
      const window = await api.listPullRequestComments(pullRequestRef(), {
        count: 1,
        order: 'asc',
        minId: target - 1,
        maxId: target + 1,
      });
      expect(window.map((c) => c.id)).toEqual([target]);
    });

    it('adding and editing a pull request comment is reflected in the list', async () => {
      const api = await factory();
      const added = await api.addPullRequestComment(pullRequestRef(), {
        content: 'New pull request comment',
      });
      const afterAdd = await api.listPullRequestComments(pullRequestRef(), {
        count: 100,
        order: 'asc',
      });
      expect(afterAdd.map((c) => c.id)).toContain(added.id);

      const edited = await api.updatePullRequestComment(
        pullRequestRef(),
        added.id,
        'Edited pull request comment'
      );
      expect(edited.content).toBe('Edited pull request comment');
      const afterEdit = await api.listPullRequestComments(pullRequestRef(), {
        count: 100,
        order: 'asc',
      });
      expect(afterEdit.find((c) => c.id === added.id)?.content).toBe(
        'Edited pull request comment'
      );
    });

    it('addPullRequestComment accepts notifiedUserId and attachmentId', async () => {
      const api = await factory();
      await expect(
        api.addPullRequestComment(pullRequestRef(), {
          content: 'Notify',
          notifiedUserId: [ALICE.id],
          attachmentId: [PULL_REQUEST_ATTACHMENT_ID],
        })
      ).resolves.toMatchObject({ content: 'Notify' });
    });

    it('starring a pull request comment sends pullRequestCommentId, and starring an issue comment still sends commentId', async () => {
      const api = await factory();
      await api.addStar({ pullRequestCommentId: PULL_REQUEST_COMMENT_IDS[0] });
      await api.addStar({ commentId: 1 });

      const starredPullRequestComment = (
        await api.listPullRequestComments(pullRequestRef(), {
          count: 100,
          order: 'asc',
        })
      ).find((c) => c.id === PULL_REQUEST_COMMENT_IDS[0]);
      const starredIssueComment = await api.getComment(ISSUE_ID, 1);
      expect(starredPullRequestComment?.stars).toHaveLength(1);
      expect(starredIssueComment.stars).toHaveLength(1);

      const pullRequestStar = starredPullRequestComment?.stars[0];
      const issueStar = starredIssueComment.stars[0];
      if (pullRequestStar === undefined || issueStar === undefined) {
        throw new Error('both stars must have been recorded');
      }
      expect(pullRequestStar.id).not.toBe(issueStar.id);

      await api.deleteStar(pullRequestStar.id);
      await api.deleteStar(issueStar.id);
      const afterDelete = (
        await api.listPullRequestComments(pullRequestRef(), {
          count: 100,
          order: 'asc',
        })
      ).find((c) => c.id === PULL_REQUEST_COMMENT_IDS[0]);
      expect(afterDelete?.stars).toHaveLength(0);
      await expect(api.getComment(ISSUE_ID, 1)).resolves.toMatchObject({
        stars: [],
      });
    });

    it('a pull request attachment downloads', async () => {
      const api = await factory();
      await expect(
        api.listPullRequestAttachments(pullRequestRef())
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: PULL_REQUEST_ATTACHMENT_ID,
            name: 'diagram.png',
          }),
        ])
      );
      const downloaded = await api.downloadPullRequestAttachment(
        pullRequestRef(),
        PULL_REQUEST_ATTACHMENT_ID
      );
      expect(downloaded.filename).toBe('diagram.png');
      expect(Buffer.isBuffer(downloaded.data)).toBe(true);
      // The listed `size` is how many bytes the download must hand back; a
      // client that read the response's headers and dropped its body would
      // otherwise satisfy every assertion above.
      const listedSize = basePullRequestAttachment().size;
      expect(downloaded.data.byteLength).toBe(listedSize);
    });
  });
}

/**
 * The changelog Backlog attaches to a field update. Seeded on one comment in
 * both implementations so the `originalValue` -> `oldValue` rename has
 * something to rename; a fixture with an empty `changeLog` everywhere would
 * let a client read the wrong field forever.
 */
const STATUS_CHANGE_LOG: BacklogComment['changeLog'] = [
  { field: 'status', newValue: '4', oldValue: '3', attachmentInfo: null },
];

/** Seed shared by both implementations' conformance test files, kept here so the fixture only needs to be written once. */
export const conformanceFixture = {
  host: HOST,
  projectId: PROJECT_ID,
  issueId: ISSUE_ID,
  otherIssueId: OTHER_ISSUE_ID,
  bot: BOT,
  alice: ALICE,
  bob: BOB,
  repositoryId: REPOSITORY_ID,
  otherRepositoryId: OTHER_REPOSITORY_ID,
  pullRequestNumber: PULL_REQUEST_NUMBER,
  pullRequestId: PULL_REQUEST_ID,
  otherPullRequestNumber: OTHER_PULL_REQUEST_NUMBER,
  otherPullRequestId: OTHER_PULL_REQUEST_ID,
  pullRequestCommentIds: PULL_REQUEST_COMMENT_IDS,
  pullRequestAttachmentId: PULL_REQUEST_ATTACHMENT_ID,
  baseProject,
  baseIssue,
  baseComment,
  statusChangeLog: STATUS_CHANGE_LOG,
  baseGitRepository,
  basePullRequest,
  basePullRequestComment,
  basePullRequestAttachment,
  pullRequestRef,
};
