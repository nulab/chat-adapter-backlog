import {
  PermissionError,
  ResourceNotFoundError,
  ValidationError,
} from '@chat-adapter/shared';

import type {
  AddCommentInput,
  AddPullRequestCommentInput,
  BacklogApi,
  BacklogComment,
  BacklogDownloadedFile,
  BacklogGitRepository,
  BacklogIssue,
  BacklogIssueComment,
  BacklogIssueType,
  BacklogNotification,
  BacklogPriority,
  BacklogProject,
  BacklogPullRequest,
  BacklogPullRequestAttachment,
  BacklogStar,
  BacklogUploadedFile,
  BacklogUserRef,
  CreateIssueInput,
  ListCommentsOptions,
  ListIssuesOptions,
  ListNotificationsOptions,
  ListPullRequestsOptions,
  PullRequestRef,
  RateLimitSnapshots,
  StarTarget,
} from './port.js';

/**
 * Seed data for `createInMemoryBacklogApi` (docs/specs/adapter.md §8.3).
 * Every array is copied, not aliased, so mutating a seed after calling the
 * factory has no effect on the returned API's state.
 */
export interface InMemoryBacklogSeed {
  projects?: BacklogProject[];
  issues?: BacklogIssue[];
  comments?: BacklogIssueComment[];
  users?: BacklogUserRef[];
  /** Issue types available per project, keyed by `projectId`. */
  issueTypes?: Record<number, BacklogIssueType[]>;
  /** Defaults to High(2)/Normal(3)/Low(4), the documented example. */
  priorities?: BacklogPriority[];
  notifications?: BacklogNotification[];
  repositories?: BacklogGitRepository[];
  pullRequests?: BacklogPullRequest[];
  /**
   * Keyed `` `${repositoryId}:${number}` `` — a pull-request comment carries no
   * parent reference of its own, so the parent has to be the key rather than a
   * field.
   */
  pullRequestComments?: Record<string, BacklogComment[]>;
  /** Keyed as `pullRequestComments` is. */
  pullRequestAttachments?: Record<string, BacklogPullRequestAttachment[]>;
  /** The credential-holding user; used as `createdUser` for anything the API creates. */
  me?: BacklogUserRef;
  /** Clock used for `created`/`updated` timestamps on records the API creates. Defaults to `() => new Date()`. */
  now?: () => Date;
}

/** State exposed for assertions in consumers' tests (docs/specs/adapter.md §8.3). */
export interface InMemoryBacklogState {
  projects: BacklogProject[];
  issues: BacklogIssue[];
  comments: BacklogIssueComment[];
  users: BacklogUserRef[];
  repositories: BacklogGitRepository[];
  pullRequests: BacklogPullRequest[];
  /**
   * The project's issue types, keyed as the seed is, and the space's
   * priorities. Both are live: a `createIssue` refuses an id they do not
   * hold, so removing an entry is how a test models a project whose settings
   * changed under a cached default (`src/egress.ts`).
   */
  issueTypes: Record<number, BacklogIssueType[]>;
  priorities: BacklogPriority[];
  /** Keyed as the seed is, and holding added comments alongside the seeded ones. */
  pullRequestComments: Record<string, BacklogComment[]>;
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
  | {
      method: 'addPullRequestComment';
      ref: PullRequestRef;
      input: AddPullRequestCommentInput;
    }
  | {
      method: 'updatePullRequestComment';
      ref: PullRequestRef;
      commentId: number;
      content: string;
    }
  | { method: 'addStar'; target: StarTarget }
  | { method: 'deleteStar'; starId: number }
  | { method: 'markNotificationAsRead'; id: number }
  | {
      method: 'uploadAttachment';
      filename: string;
      /**
       * A copy, so a caller that reuses one buffer across uploads cannot
       * rewrite what this records — a real space keeps the bytes it was sent.
       */
      data: Buffer;
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

function pullRequestKey(repositoryId: number, number: number): string {
  return `${repositoryId}:${number}`;
}

function copyKeyedLists<T>(
  source: Record<string, T[]> | undefined
): Record<string, T[]> {
  return Object.fromEntries(
    Object.entries(source ?? {}).map(([key, list]) => [key, [...list]])
  );
}

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
  const issueTypes: Record<number, BacklogIssueType[]> = copyKeyedLists(
    seed.issueTypes
  );
  const priorities = [...(seed.priorities ?? DEFAULT_PRIORITIES)];
  const notifications = [...(seed.notifications ?? [])];
  const repositories = [...(seed.repositories ?? [])];
  const pullRequests = [...(seed.pullRequests ?? [])];
  const pullRequestComments = copyKeyedLists(seed.pullRequestComments);
  const pullRequestAttachments = copyKeyedLists(seed.pullRequestAttachments);
  const seededPullRequestComments = Object.values(pullRequestComments).flat();
  const stars: BacklogStar[] = [
    ...comments.flatMap((c) => c.stars),
    ...seededPullRequestComments.flatMap((c) => c.stars),
  ];
  const uploads: BacklogUploadedFile[] = [];
  /**
   * The bytes and declared type of every upload, keyed by its id.
   * `BacklogUploadedFile` carries only `{ id, name, size }`, so neither has
   * anywhere to live on the state a consumer reads — but discarding them
   * would let a port that uploads an empty body pass every assertion this
   * fake can make.
   */
  const uploadedFiles = new Map<number, { data: Buffer; mimeType?: string }>();
  const recordedInputs: RecordedInput[] = [];

  const seededIds = [
    ...issues.map((i) => i.id),
    ...comments.map((c) => c.id),
    ...notifications.map((n) => n.id),
    ...uploads.map((u) => u.id),
    ...repositories.map((r) => r.id),
    ...pullRequests.map((p) => p.id),
    ...seededPullRequestComments.map((c) => c.id),
    ...Object.values(pullRequestAttachments)
      .flat()
      .map((a) => a.id),
    ...stars.map((s) => s.id),
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

  /**
   * Both rate-limit members answer with the same documented example figures.
   * The fake models no consumption, so the distinction the real port draws —
   * headers this instance observed versus what the server reports now — has
   * nothing to be drawn from here, and inventing a divergence would let a test
   * assert a difference no implementation guarantees.
   */
  function syntheticRateLimit(): RateLimitSnapshots {
    const reset = new Date(now().getTime() + 60_000);
    return {
      read: { limit: 600, remaining: 599, reset },
      update: { limit: 150, remaining: 149, reset },
      search: { limit: 150, remaining: 149, reset },
      icon: { limit: 60, remaining: 59, reset },
    };
  }

  function findIssue(issueId: number): BacklogIssue {
    const issue = issues.find((i) => i.id === issueId);
    if (issue === undefined) {
      throw new ResourceNotFoundError('backlog', 'issue', String(issueId));
    }
    return issue;
  }

  function findComment(
    issueId: number,
    commentId: number
  ): BacklogIssueComment {
    const comment = comments.find(
      (c) => c.id === commentId && c.issueId === issueId
    );
    if (comment === undefined) {
      throw new ResourceNotFoundError('backlog', 'comment', String(commentId));
    }
    return comment;
  }

  /**
   * Refuses a comment body Backlog refuses. `content` is a required parameter
   * on all four comment endpoints (`.claude/rules/backlog-api-facts.md`
   * "Writes"), so an empty one is a 400 code 7 — **inferred** from code 7
   * being `InvalidRequestError` (docs/specs/adapter.md §8.5), not measured:
   * nothing here has posted an empty comment to a real space.
   * Whitespace is deliberately *not* trimmed first: `stream()` posts a single
   * space for an empty stream (docs/specs/adapter.md §4.2 `stream`, §15
   * question 7), so a fake that trimmed would fail the adapter's own
   * documented path on a claim no measurement supports either.
   */
  function requireCommentContent(content: string): void {
    if (content === '') {
      throw new ValidationError('backlog', 'No comment content.');
    }
  }

  /**
   * Refuses to write another user's comment. Update and Delete are documented
   * as the caller's own comments only — "Authenticated user can update his own
   * comments" on both the issue and the pull-request endpoint
   * (`.claude/rules/backlog-api-facts.md` "Writes") — and a real space answers
   * 403 code 5, which the port maps to `PermissionError`
   * (docs/specs/adapter.md §8.5).
   */
  function requireOwnComment(comment: BacklogComment, action: string): void {
    if (comment.createdUser.id !== me.id) {
      throw new PermissionError('backlog', action);
    }
  }

  function findUser(userId: number): BacklogUserRef {
    const user = users.find((u) => u.id === userId);
    if (user === undefined) {
      throw new ResourceNotFoundError('backlog', 'user', String(userId));
    }
    return user;
  }

  function findGitRepository(
    projectId: number,
    repositoryId: number
  ): BacklogGitRepository {
    const repository = repositories.find(
      (r) => r.id === repositoryId && r.projectId === projectId
    );
    if (repository === undefined) {
      throw new ResourceNotFoundError(
        'backlog',
        'gitRepository',
        String(repositoryId)
      );
    }
    return repository;
  }

  function findPullRequest(ref: PullRequestRef): BacklogPullRequest {
    const pullRequest = pullRequests.find(
      (p) =>
        p.projectId === ref.projectId &&
        p.repositoryId === ref.repositoryId &&
        p.number === ref.number
    );
    if (pullRequest === undefined) {
      throw new ResourceNotFoundError(
        'backlog',
        'pullRequest',
        pullRequestKey(ref.repositoryId, ref.number)
      );
    }
    return pullRequest;
  }

  function commentsOfPullRequest(ref: PullRequestRef): BacklogComment[] {
    return (
      pullRequestComments[pullRequestKey(ref.repositoryId, ref.number)] ?? []
    );
  }

  function findPullRequestComment(commentId: number): BacklogComment {
    const comment = Object.values(pullRequestComments)
      .flat()
      .find((c) => c.id === commentId);
    if (comment === undefined) {
      throw new ResourceNotFoundError(
        'backlog',
        'pullRequestComment',
        String(commentId)
      );
    }
    return comment;
  }

  function findStarTarget(target: StarTarget): BacklogComment {
    if ('commentId' in target) {
      const comment = comments.find((c) => c.id === target.commentId);
      if (comment === undefined) {
        throw new ResourceNotFoundError(
          'backlog',
          'comment',
          String(target.commentId)
        );
      }
      return comment;
    }
    return findPullRequestComment(target.pullRequestCommentId);
  }

  function page<T extends BacklogComment>(
    from: T[],
    options: ListCommentsOptions
  ): T[] {
    const withinBounds = from.filter((c) => {
      if (options.minId !== undefined && c.id <= options.minId) return false;
      if (options.maxId !== undefined && c.id >= options.maxId) return false;
      return true;
    });
    const sorted = [...withinBounds].sort((a, b) =>
      options.order === 'asc' ? a.id - b.id : b.id - a.id
    );
    return sorted.slice(0, options.count);
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
      const issueType = (issueTypes[input.projectId] ?? []).find(
        (t) => t.id === input.issueTypeId
      );
      if (issueType === undefined) {
        throw new ValidationError(
          'backlog',
          `issueTypeId ${input.issueTypeId} is not an issue type of project ${input.projectId}`
        );
      }
      const priority = priorities.find((p) => p.id === input.priorityId);
      if (priority === undefined) {
        throw new ValidationError(
          'backlog',
          `priorityId ${input.priorityId} is not a priority of this space`
        );
      }
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
      return [...(issueTypes[projectId] ?? [])];
    },

    async listPriorities() {
      return [...priorities];
    },

    async listComments(issueId, options: ListCommentsOptions) {
      findIssue(issueId);
      return page(
        comments.filter((c) => c.issueId === issueId),
        options
      );
    },

    async getComment(issueId, commentId) {
      return findComment(issueId, commentId);
    },

    async addComment(issueId, input: AddCommentInput) {
      recordedInputs.push({ method: 'addComment', issueId, input });
      findIssue(issueId);
      requireCommentContent(input.content);
      const createdAt = now();
      const comment: BacklogIssueComment = {
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
      requireOwnComment(comment, 'update a comment');
      requireCommentContent(content);
      comment.content = content;
      comment.updated = now();
      return comment;
    },

    async deleteComment(issueId, commentId) {
      recordedInputs.push({ method: 'deleteComment', issueId, commentId });
      const comment = findComment(issueId, commentId);
      requireOwnComment(comment, 'delete a comment');
      comments.splice(comments.indexOf(comment), 1);
      return comment;
    },

    async listGitRepositories(projectId) {
      findProject(projectId);
      return repositories.filter((r) => r.projectId === projectId);
    },

    async getGitRepository(projectId, repositoryId) {
      return findGitRepository(projectId, repositoryId);
    },

    async listPullRequests(
      projectId,
      repositoryId,
      options: ListPullRequestsOptions
    ) {
      findGitRepository(projectId, repositoryId);
      const offset = options.offset ?? 0;
      return pullRequests
        .filter(
          (p) =>
            p.projectId === projectId &&
            p.repositoryId === repositoryId &&
            (options.statusId === undefined ||
              options.statusId.includes(p.status.id))
        )
        .slice(offset, offset + options.count);
    },

    async getPullRequest(ref) {
      return findPullRequest(ref);
    },

    async listPullRequestComments(ref, options: ListCommentsOptions) {
      findPullRequest(ref);
      return page(commentsOfPullRequest(ref), options);
    },

    async addPullRequestComment(ref, input: AddPullRequestCommentInput) {
      recordedInputs.push({ method: 'addPullRequestComment', ref, input });
      findPullRequest(ref);
      requireCommentContent(input.content);
      const createdAt = now();
      const comment: BacklogComment = {
        id: allocateId(),
        content: input.content,
        changeLog: [],
        createdUser: me,
        created: createdAt,
        updated: createdAt,
        stars: [],
      };
      const key = pullRequestKey(ref.repositoryId, ref.number);
      (pullRequestComments[key] ??= []).push(comment);
      return comment;
    },

    async updatePullRequestComment(ref, commentId, content) {
      recordedInputs.push({
        method: 'updatePullRequestComment',
        ref,
        commentId,
        content,
      });
      findPullRequest(ref);
      const comment = commentsOfPullRequest(ref).find(
        (c) => c.id === commentId
      );
      if (comment === undefined) {
        throw new ResourceNotFoundError(
          'backlog',
          'pullRequestComment',
          String(commentId)
        );
      }
      requireOwnComment(comment, 'update a pull request comment');
      requireCommentContent(content);
      comment.content = content;
      comment.updated = now();
      return comment;
    },

    async listPullRequestAttachments(ref) {
      findPullRequest(ref);
      return [
        ...(pullRequestAttachments[
          pullRequestKey(ref.repositoryId, ref.number)
        ] ?? []),
      ];
    },

    async downloadPullRequestAttachment(
      ref,
      attachmentId
    ): Promise<BacklogDownloadedFile> {
      findPullRequest(ref);
      const attachment =
        pullRequestAttachments[
          pullRequestKey(ref.repositoryId, ref.number)
        ]?.find((a) => a.id === attachmentId) ??
        uploads.find((u) => u.id === attachmentId);
      if (attachment === undefined) {
        throw new ResourceNotFoundError(
          'backlog',
          'attachment',
          String(attachmentId)
        );
      }
      const uploaded = uploadedFiles.get(attachment.id);
      return {
        filename: attachment.name,
        // A pull-request attachment download answers the file's **real**
        // content type, where the issue-side download answers
        // `application/octet-stream` (measured 2026-09-06,
        // `.claude/rules/backlog-pull-request-facts.md` "Attachments"). The
        // two are not the same call and the fake does not make them agree.
        contentType: uploaded?.mimeType ?? 'application/octet-stream',
        data: uploaded?.data ?? Buffer.alloc(attachment.size),
      };
    },

    async addStar(target: StarTarget) {
      recordedInputs.push({ method: 'addStar', target });
      const comment = findStarTarget(target);
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
      const starred: BacklogComment[] = [
        ...comments,
        ...Object.values(pullRequestComments).flat(),
      ];
      for (const comment of starred) {
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
      notification.resourceAlreadyRead = true;
    },

    async uploadAttachment(filename, data, mimeType) {
      const bytes = Buffer.from(data);
      recordedInputs.push({
        method: 'uploadAttachment',
        filename,
        data: bytes,
        mimeType,
      });
      const file: BacklogUploadedFile = {
        id: allocateId(),
        name: filename,
        size: bytes.byteLength,
      };
      uploads.push(file);
      uploadedFiles.set(file.id, {
        data: bytes,
        ...(mimeType !== undefined && { mimeType }),
      });
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
        data: uploadedFiles.get(upload.id)?.data ?? Buffer.alloc(upload.size),
      };
    },

    async getRateLimit(): Promise<RateLimitSnapshots> {
      return syntheticRateLimit();
    },

    rateLimit(): RateLimitSnapshots {
      return syntheticRateLimit();
    },

    state: {
      projects,
      issues,
      comments,
      users,
      repositories,
      pullRequests,
      issueTypes,
      priorities,
      pullRequestComments,
      stars,
      uploads,
      notifications,
      recordedInputs,
    },
  };

  return api;
}
