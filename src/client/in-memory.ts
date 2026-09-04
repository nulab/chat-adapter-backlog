import { ResourceNotFoundError } from '@chat-adapter/shared';

import type {
  AddCommentInput,
  BacklogApi,
  BacklogComment,
  BacklogDownloadedFile,
  BacklogIssue,
  BacklogIssueType,
  BacklogNotification,
  BacklogPriority,
  BacklogProject,
  BacklogStar,
  BacklogUploadedFile,
  BacklogUserRef,
  CreateIssueInput,
  ListCommentsOptions,
  ListIssuesOptions,
  ListNotificationsOptions,
  RateLimitSnapshots,
} from './port.js';

/**
 * Seed data for `createInMemoryBacklogApi` (docs/specs/adapter.md §8.3).
 * Every array is copied, not aliased, so mutating a seed after calling the
 * factory has no effect on the returned API's state.
 */
export interface InMemoryBacklogSeed {
  projects?: BacklogProject[];
  issues?: BacklogIssue[];
  comments?: BacklogComment[];
  users?: BacklogUserRef[];
  /** Issue types available per project, keyed by `projectId`. */
  issueTypes?: Record<number, BacklogIssueType[]>;
  /** Defaults to High(2)/Normal(3)/Low(4), the documented example. */
  priorities?: BacklogPriority[];
  notifications?: BacklogNotification[];
  /** The credential-holding user; used as `createdUser` for anything the API creates. */
  me?: BacklogUserRef;
  /** Clock used for `created`/`updated` timestamps on records the API creates. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** State exposed for assertions in consumers' tests (docs/specs/adapter.md §8.3). */
export interface InMemoryBacklogState {
  projects: BacklogProject[];
  issues: BacklogIssue[];
  comments: BacklogComment[];
  users: BacklogUserRef[];
  stars: BacklogStar[];
  uploads: BacklogUploadedFile[];
  notifications: BacklogNotification[];
  /** Every call the API received, in order, for assertions on inputs. */
  recordedInputs: RecordedInput[];
}

export type RecordedInput =
  | { method: 'createIssue'; input: CreateIssueInput }
  | { method: 'addComment'; issueId: number; input: AddCommentInput }
  | {
      method: 'updateComment';
      issueId: number;
      commentId: number;
      content: string;
    }
  | { method: 'deleteComment'; issueId: number; commentId: number }
  | { method: 'addStar'; commentId: number }
  | { method: 'deleteStar'; starId: number }
  | { method: 'markNotificationAsRead'; id: number }
  | {
      method: 'uploadAttachment';
      filename: string;
      mimeType: string | undefined;
    };

export interface InMemoryBacklogApi extends BacklogApi {
  state: InMemoryBacklogState;
}

const DEFAULT_PRIORITIES: BacklogPriority[] = [
  { id: 2, name: 'High' },
  { id: 3, name: 'Normal' },
  { id: 4, name: 'Low' },
];

const DEFAULT_ME: BacklogUserRef = {
  id: 999,
  userId: 'chatbot',
  name: 'Chatbot',
  mailAddress: null,
};

/**
 * An in-memory `BacklogApi` for consumers' own tests
 * (docs/specs/adapter.md §8.3). It mirrors the `backlog-js` implementation's
 * observable behaviour — same error classes, same exclusive `minId`/`maxId`
 * semantics, same rate-limit-header shape — so a caller can swap
 * implementations without changing assertions; `describeBacklogApiConformance`
 * (`./conformance.ts`) runs the identical suite against both.
 */
export function createInMemoryBacklogApi(
  seed: InMemoryBacklogSeed = {}
): InMemoryBacklogApi {
  const now = seed.now ?? (() => new Date());
  const me = seed.me ?? DEFAULT_ME;

  const projects = [...(seed.projects ?? [])];
  const issues = [...(seed.issues ?? [])];
  const comments = [...(seed.comments ?? [])];
  const users = [...(seed.users ?? [])];
  const issueTypesByProject = new Map(
    Object.entries(seed.issueTypes ?? {}).map(([k, v]) => [Number(k), [...v]])
  );
  const priorities = [...(seed.priorities ?? DEFAULT_PRIORITIES)];
  const notifications = [...(seed.notifications ?? [])];
  const stars: BacklogStar[] = comments.flatMap((c) => c.stars);
  const uploads: BacklogUploadedFile[] = [];
  const recordedInputs: RecordedInput[] = [];

  const seededIds = [
    ...issues.map((i) => i.id),
    ...comments.map((c) => c.id),
    ...comments.flatMap((c) => c.stars.map((s) => s.id)),
    ...notifications.map((n) => n.id),
    ...uploads.map((u) => u.id),
  ];
  let nextId = Math.max(0, ...seededIds) + 1;
  const allocateId = (): number => nextId++;

  function findProject(projectId: number): BacklogProject {
    const project = projects.find((p) => p.id === projectId);
    if (project === undefined) {
      throw new ResourceNotFoundError('backlog', 'project', String(projectId));
    }
    return project;
  }

  function findIssue(issueId: number): BacklogIssue {
    const issue = issues.find((i) => i.id === issueId);
    if (issue === undefined) {
      throw new ResourceNotFoundError('backlog', 'issue', String(issueId));
    }
    return issue;
  }

  function findComment(issueId: number, commentId: number): BacklogComment {
    const comment = comments.find(
      (c) => c.id === commentId && c.issueId === issueId
    );
    if (comment === undefined) {
      throw new ResourceNotFoundError('backlog', 'comment', String(commentId));
    }
    return comment;
  }

  function findUser(userId: number): BacklogUserRef {
    const user = users.find((u) => u.id === userId);
    if (user === undefined) {
      throw new ResourceNotFoundError('backlog', 'user', String(userId));
    }
    return user;
  }

  const api: InMemoryBacklogApi = {
    async getIssue(issueId) {
      return findIssue(issueId);
    },

    async getProject(projectId) {
      return findProject(projectId);
    },

    async getUser(userId) {
      return findUser(userId);
    },

    async listIssues(projectId, options: ListIssuesOptions) {
      findProject(projectId);
      const offset = options.offset ?? 0;
      return issues
        .filter((issue) => issue.projectId === projectId)
        .slice(offset, offset + options.count);
    },

    async createIssue(input: CreateIssueInput) {
      recordedInputs.push({ method: 'createIssue', input });
      findProject(input.projectId);
      const issueType = (issueTypesByProject.get(input.projectId) ?? []).find(
        (t) => t.id === input.issueTypeId
      ) ?? {
        id: input.issueTypeId,
        name: 'Task',
      };
      const priority = priorities.find((p) => p.id === input.priorityId) ?? {
        id: input.priorityId,
        name: 'Normal',
      };
      const assignee =
        input.assigneeId === undefined ? null : findUser(input.assigneeId);
      const createdAt = now();
      const issue: BacklogIssue = {
        id: allocateId(),
        projectId: input.projectId,
        issueKey: `PROJECT-${issues.length + 1}`,
        summary: input.summary,
        description: input.description ?? '',
        issueType,
        priority,
        status: { id: 1, name: 'Open' },
        assignee,
        createdUser: me,
        created: createdAt,
        updated: createdAt,
      };
      issues.push(issue);
      return issue;
    },

    async listIssueTypes(projectId) {
      findProject(projectId);
      return [...(issueTypesByProject.get(projectId) ?? [])];
    },

    async listPriorities() {
      return [...priorities];
    },

    async listComments(issueId, options: ListCommentsOptions) {
      findIssue(issueId);
      const forIssue = comments.filter((c) => c.issueId === issueId);
      const withinBounds = forIssue.filter((c) => {
        if (options.minId !== undefined && c.id <= options.minId) return false;
        if (options.maxId !== undefined && c.id >= options.maxId) return false;
        return true;
      });
      const sorted = [...withinBounds].sort((a, b) =>
        options.order === 'asc' ? a.id - b.id : b.id - a.id
      );
      return sorted.slice(0, options.count);
    },

    async getComment(issueId, commentId) {
      return findComment(issueId, commentId);
    },

    async addComment(issueId, input: AddCommentInput) {
      recordedInputs.push({ method: 'addComment', issueId, input });
      findIssue(issueId);
      const createdAt = now();
      const comment: BacklogComment = {
        id: allocateId(),
        issueId,
        content: input.content,
        changeLog: [],
        createdUser: me,
        created: createdAt,
        updated: createdAt,
        stars: [],
      };
      comments.push(comment);
      return comment;
    },

    async updateComment(issueId, commentId, content) {
      recordedInputs.push({
        method: 'updateComment',
        issueId,
        commentId,
        content,
      });
      const comment = findComment(issueId, commentId);
      comment.content = content;
      comment.updated = now();
      return comment;
    },

    async deleteComment(issueId, commentId) {
      recordedInputs.push({ method: 'deleteComment', issueId, commentId });
      const comment = findComment(issueId, commentId);
      comments.splice(comments.indexOf(comment), 1);
      return comment;
    },

    async addStar(commentId) {
      recordedInputs.push({ method: 'addStar', commentId });
      const comment = comments.find((c) => c.id === commentId);
      if (comment === undefined) {
        throw new ResourceNotFoundError(
          'backlog',
          'comment',
          String(commentId)
        );
      }
      const star: BacklogStar = {
        id: allocateId(),
        comment: null,
        url: '',
        title: '',
        presenter: me,
        created: now(),
      };
      comment.stars.push(star);
      stars.push(star);
    },

    async deleteStar(starId) {
      recordedInputs.push({ method: 'deleteStar', starId });
      const star = stars.find((s) => s.id === starId);
      if (star === undefined) {
        throw new ResourceNotFoundError('backlog', 'star', String(starId));
      }
      stars.splice(stars.indexOf(star), 1);
      for (const comment of comments) {
        const index = comment.stars.findIndex((s) => s.id === starId);
        if (index !== -1) {
          comment.stars.splice(index, 1);
        }
      }
    },

    async listNotifications(options: ListNotificationsOptions) {
      const withinBounds = notifications.filter(
        (n) => options.maxId === undefined || n.id < options.maxId
      );
      return [...withinBounds]
        .sort((a, b) => b.id - a.id)
        .slice(0, options.count);
    },

    async markNotificationAsRead(id) {
      recordedInputs.push({ method: 'markNotificationAsRead', id });
      const notification = notifications.find((n) => n.id === id);
      if (notification === undefined) {
        throw new ResourceNotFoundError('backlog', 'notification', String(id));
      }
      notification.alreadyRead = true;
    },

    async uploadAttachment(filename, _data, mimeType) {
      recordedInputs.push({ method: 'uploadAttachment', filename, mimeType });
      const file: BacklogUploadedFile = {
        id: allocateId(),
        name: filename,
        size: _data.byteLength,
      };
      uploads.push(file);
      return file;
    },

    async downloadAttachment(
      issueId,
      attachmentId
    ): Promise<BacklogDownloadedFile> {
      findIssue(issueId);
      const upload = uploads.find((u) => u.id === attachmentId);
      if (upload === undefined) {
        throw new ResourceNotFoundError(
          'backlog',
          'attachment',
          String(attachmentId)
        );
      }
      return {
        filename: upload.name,
        contentType: 'application/octet-stream',
        data: Buffer.alloc(0),
      };
    },

    rateLimit(): RateLimitSnapshots {
      const reset = new Date(now().getTime() + 60_000);
      return {
        read: { limit: 600, remaining: 599, reset },
        update: { limit: 150, remaining: 149, reset },
        search: { limit: 150, remaining: 149, reset },
        icon: { limit: 60, remaining: 59, reset },
      };
    },

    state: {
      projects,
      issues,
      comments,
      users,
      stars,
      uploads,
      notifications,
      recordedInputs,
    },
  };

  return api;
}
