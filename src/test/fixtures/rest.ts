import { Types } from 'backlog-js';

import type {
  BacklogRawComment,
  BacklogRawIssue,
  BacklogRawPullRequest,
  BacklogUser,
} from '../../types';
import type { Backlog, Entity } from 'backlog-js';

export const REST = {
  host: 'example.backlog.com',
  projectId: 500,
  projectKey: 'PROJECT',
  issueId: 8001,
  issueKey: 'PROJECT-42',
  repositoryId: 700,
  repositoryName: 'example-repo',
  pullRequestNumber: 12,
  pullRequestId: 90001,
} as const;

export function user(overrides: Partial<BacklogUser> = {}): BacklogUser {
  return {
    id: 100,
    userId: 'alice',
    name: 'Alice',
    roleType: Types.NormalRoleType.MemberOrGuest,
    lang: 'en',
    mailAddress: 'alice@example.com',
    lastLoginTime: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

export const ALICE = user();
export const BOB = user({
  id: 101,
  userId: 'bob',
  name: 'Bob',
  mailAddress: 'bob@example.com',
});
export const BOT = user({
  id: 999,
  userId: 'chatbot',
  name: 'Chatbot',
  mailAddress: 'bot@example.com',
});

export function star(
  presenter: BacklogUser,
  id = 1
): BacklogRawComment['stars'][number] {
  return {
    id,
    comment: null,
    url: `https://${REST.host}/view/${REST.issueKey}`,
    title: 'Seeded issue',
    presenter,
    created: '2026-09-02T00:00:00Z',
  };
}

export function comment(
  overrides: Partial<BacklogRawComment> = {}
): BacklogRawComment {
  return {
    id: 1,
    content: 'Seeded comment',
    changeLog: [],
    createdUser: ALICE,
    created: '2026-09-02T11:30:00Z',
    updated: '2026-09-02T11:30:00Z',
    stars: [],
    notifications: [],
    ...overrides,
  };
}

export function issueComment(
  overrides: Partial<BacklogRawComment> = {}
): BacklogRawComment & { issueId: number } {
  return { ...comment(overrides), issueId: REST.issueId };
}

export function issue(
  overrides: Partial<BacklogRawIssue> = {}
): BacklogRawIssue {
  return {
    id: REST.issueId,
    projectId: REST.projectId,
    issueKey: REST.issueKey,
    keyId: 42,
    issueType: {
      id: 1,
      projectId: REST.projectId,
      name: 'Bug',
      color: '#e30000',
      displayOrder: 0,
    },
    summary: 'Login fails on retry',
    description: 'Steps to reproduce',
    priority: { id: 3, name: 'Normal' },
    status: {
      id: 1,
      projectId: REST.projectId,
      name: 'Open',
      color: '#ea2c00',
      displayOrder: 1000,
    },
    assignee: null,
    category: [],
    versions: [],
    milestone: [],
    createdUser: BOB,
    created: '2026-09-01T10:00:00Z',
    updatedUser: BOB,
    updated: '2026-09-02T11:30:00Z',
    customFields: [],
    attachments: [],
    sharedFiles: [],
    stars: [],
    ...overrides,
  };
}

export function pullRequest(
  overrides: Partial<BacklogRawPullRequest> = {}
): BacklogRawPullRequest {
  return {
    id: REST.pullRequestId,
    projectId: REST.projectId,
    repositoryId: REST.repositoryId,
    number: REST.pullRequestNumber,
    summary: 'Add the thing',
    description: 'Body of the PR.',
    base: 'main',
    branch: 'feature/thing',
    status: { id: 1, name: 'Open' },
    assignee: null,
    issue: null,
    baseCommit: null,
    branchCommit: null,
    mergeCommit: null,
    closeAt: null,
    mergeAt: null,
    createdUser: ALICE,
    created: '2026-09-01T10:00:00Z',
    updatedUser: ALICE,
    updated: '2026-09-02T11:30:00Z',
    attachments: [],
    stars: [],
    ...overrides,
  };
}

export function project(
  overrides: Partial<Entity.Project.Project> = {}
): Entity.Project.Project {
  return {
    id: REST.projectId,
    projectKey: REST.projectKey,
    name: 'Project',
    chartEnabled: false,
    useResolvedForChart: false,
    subtaskingEnabled: false,
    projectLeaderCanEditProjectLeader: false,
    useWiki: true,
    useFileSharing: true,
    useWikiTreeView: true,
    useOriginalImageSizeAtWiki: false,
    useSubversion: false,
    useGit: true,
    textFormattingRule: 'markdown',
    archived: false,
    displayOrder: 0,
    useDevAttributes: true,
    ...overrides,
  };
}

export function gitRepository(
  overrides: Partial<Entity.Git.GitRepository> = {}
): Entity.Git.GitRepository {
  return {
    id: REST.repositoryId,
    projectId: REST.projectId,
    name: REST.repositoryName,
    description: '',
    httpUrl: `https://${REST.host}/git/${REST.projectKey}/${REST.repositoryName}.git`,
    sshUrl: `${REST.host}:/${REST.projectKey}/${REST.repositoryName}.git`,
    displayOrder: 0,
    createdUser: { ...ALICE, userId: 'alice' },
    created: '2026-09-01T00:00:00Z',
    updatedUser: { ...ALICE, userId: 'alice' },
    updated: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

/** What a download method resolves: the body is the only part the adapter reads. */
export function fileData(bytes: string): Entity.File.FileData {
  return {
    body: new Response(bytes).body as ReadableStream,
    url: `https://${REST.host}/api/v2/download`,
    filename: 'file.txt',
    contentType: 'text/plain',
  };
}

type Stubs = { [K in keyof Backlog]?: (...args: never[]) => unknown };

/**
 * A `backlog-js` client made of the given `vi.fn`s, whose every other method
 * fails the test: "no request was made" has to be told apart from
 * "something was called and happened to resolve".
 */
export function stubClient(stubs: Stubs): Backlog {
  return new Proxy(stubs, {
    get(target, property): unknown {
      // Probed by `await` and by vitest's formatter; answering them with a
      // throwing function would make the stub itself look like a call.
      if (typeof property === 'symbol' || property === 'then') {
        return undefined;
      }
      const member = target[property as keyof Backlog];
      if (member === undefined) {
        return () => {
          throw new Error(`unstubbed backlog-js call: ${String(property)}`);
        };
      }
      return member;
    },
  }) as unknown as Backlog;
}
