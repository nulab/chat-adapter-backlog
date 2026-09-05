import { describe, expect, it } from 'vitest';

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
  bot,
  alice,
  bob,
  baseProject,
  baseIssue,
  baseComment,
  statusChangeLog,
} = conformanceFixture;

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
    issueTypes: { [projectId]: [{ id: 1, name: 'Task' }] },
    notifications: [
      {
        id: 1,
        alreadyRead: false,
        project: { id: projectId, projectKey: 'PROJECT', name: 'Project' },
        issue: null,
        comment: { id: 1 },
        sender: alice,
        created: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 2,
        alreadyRead: false,
        project: { id: projectId, projectKey: 'PROJECT', name: 'Project' },
        issue: null,
        comment: { id: 2 },
        sender: bob,
        created: new Date('2026-01-01T00:01:00Z'),
      },
    ],
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

  it('seeding does not alias the caller-supplied seed objects', async () => {
    const mySeed = seed();
    const api = createInMemoryBacklogApi(mySeed);
    await api.createIssue({
      projectId,
      summary: 'New',
      issueTypeId: 1,
      priorityId: 3,
    });
    expect(mySeed.issues).toHaveLength(2);
  });
});
