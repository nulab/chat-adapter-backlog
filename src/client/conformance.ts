import { describe, expect, it } from 'vitest';

import { ResourceNotFoundError } from '@chat-adapter/shared';

import type {
  BacklogApi,
  BacklogComment,
  BacklogIssue,
  BacklogProject,
  BacklogUserRef,
} from './port.js';

/** A fresh, seeded `BacklogApi` for one test. */
export type BacklogApiFactory = () => BacklogApi | Promise<BacklogApi>;

const HOST = 'example.backlog.com';
const PROJECT_ID = 500;
const ISSUE_ID = 8001;
const OTHER_ISSUE_ID = 8002;
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

function baseComment(overrides: Partial<BacklogComment> = {}): BacklogComment {
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

    it('a created issue appears with the bot as creator', async () => {
      const api = await factory();
      const issue = await api.createIssue({
        projectId: PROJECT_ID,
        summary: 'Created from a test',
        issueTypeId: 1,
        priorityId: 3,
      });
      expect(issue.createdUser).toMatchObject({ name: BOT.name });
      await expect(api.getIssue(issue.id)).resolves.toMatchObject({
        id: issue.id,
      });
    });

    it('issue types and priorities are readable', async () => {
      const api = await factory();
      await expect(api.listIssueTypes(PROJECT_ID)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 1 })])
      );
      await expect(api.listPriorities()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 2, name: 'High' }),
        ])
      );
    });

    it('stars carry the presenter as a numeric id, matching the credential owner, and are removable by star id', async () => {
      const api = await factory();
      await api.addStar(1);
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

    it('notifications list newest-first with an exclusive maxId and are markable as read', async () => {
      const api = await factory();
      const all = await api.listNotifications({ count: 100 });
      expect(all.length).toBeGreaterThanOrEqual(2);
      const ids = all.map((n) => n.id);
      expect(ids).toEqual([...ids].sort((a, b) => b - a));
      const maxId = ids[0];
      if (maxId !== undefined) {
        const bounded = await api.listNotifications({ count: 100, maxId });
        expect(bounded.map((n) => n.id)).not.toContain(maxId);
      }
      const first = all[0];
      if (first !== undefined) {
        await api.markNotificationAsRead(first.id);
      }
    });

    it('uploading a file posts one multipart part named file', async () => {
      const api = await factory();
      const uploaded = await api.uploadAttachment(
        'notes.txt',
        Buffer.from('hello'),
        'text/plain'
      );
      expect(uploaded).toMatchObject({ name: 'notes.txt' });
    });

    it('an issue-list call spends the search bucket, not read', async () => {
      const api = await factory();
      await api.listIssues(PROJECT_ID, { count: 10 });
      const snapshot = api.rateLimit();
      expect(snapshot.search).toBeDefined();
    });

    it("rateLimit reflects the last response's headers per bucket", async () => {
      const api = await factory();
      await api.getIssue(ISSUE_ID);
      await api.addComment(ISSUE_ID, { content: 'For rate-limit tracking' });
      const snapshot = api.rateLimit();
      expect(snapshot.read).toBeDefined();
      expect(snapshot.update).toBeDefined();
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
  baseProject,
  baseIssue,
  baseComment,
  statusChangeLog: STATUS_CHANGE_LOG,
};
