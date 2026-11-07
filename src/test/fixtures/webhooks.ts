/**
 * Deliveries as `.claude/rules/backlog-webhook-facts.md` and
 * `backlog-pull-request-facts.md` record them, extra keys included, so a
 * schema that tolerates only the documented fields fails here rather than in
 * production.
 */

/** Vocabulary shared by every fixture, so no real space or person is named. */
export const FIXTURE = {
  host: 'example.backlog.com',
  otherHost: 'other.backlog.jp',
  webhookSecret: 's3cret-path-token',
  projectId: 500,
  projectKey: 'EXAMPLE',
  issueId: 8001,
  issueKeyId: 42,
  otherIssueId: 8002,
  otherIssueKeyId: 43,
  thirdIssueId: 8003,
  thirdIssueKeyId: 44,
  repositoryId: 700,
  repositoryName: 'example-repo',
  pullRequestNumber: 12,
  pullRequestId: 90001,
  bot: { id: 999, name: 'Chatbot', userId: 'chatbot' },
  alice: { id: 100, name: 'Alice', userId: 'alice' },
  bob: { id: 101, name: 'Bob', userId: 'bob' },
} as const;

interface FixtureUser {
  id: number;
  name: string;
  userId?: string | null;
}

interface FixtureChange {
  field: string;
  new_value?: string | number | null;
  old_value?: string | number | null;
}

interface FixtureAttachment {
  id: number;
  name: string;
  size: number;
}

interface FixtureNotification {
  user: FixtureUser;
  reason: number;
}

interface ActivityOptions {
  created?: string;
  createdUser?: FixtureUser;
  projectId?: number;
  issueId?: number;
  notifications?: FixtureNotification[];
}

const DEFAULT_CREATED = '2026-09-03T04:05:06Z';

function createdUserOf(user: FixtureUser): Record<string, unknown> {
  return {
    id: user.id,
    userId: user.userId ?? null,
    name: user.name,
    roleType: 2,
    lang: 'ja',
    mailAddress: `${user.userId ?? user.name.toLowerCase()}@example.com`,
    nulabAccount: null,
  };
}

/** `backlog-webhook-facts.md` § Payload envelope. */
function notificationEntries(
  notifications: FixtureNotification[]
): Record<string, unknown>[] {
  return notifications.map((notification, index) => ({
    id: 4100 + index,
    alreadyRead: false,
    reason: notification.reason,
    user: createdUserOf(notification.user),
    resourceAlreadyRead: false,
  }));
}

function changeEntries(changes: FixtureChange[]): Record<string, unknown>[] {
  return changes.map((change) => ({
    field: change.field,
    new_value: change.new_value ?? '',
    old_value: change.old_value ?? '',
    field_text: change.field,
    type: 'standard',
  }));
}

function envelope(
  type: number,
  content: Record<string, unknown>,
  options: ActivityOptions = {}
): Record<string, unknown> {
  const user = options.createdUser ?? FIXTURE.alice;
  return {
    id: 71828,
    project: {
      id: options.projectId ?? FIXTURE.projectId,
      projectKey: FIXTURE.projectKey,
      name: 'Example project',
      archived: false,
      displayOrder: 2147483646,
    },
    type,
    content,
    notifications: notificationEntries(options.notifications ?? []),
    createdUser: createdUserOf(user),
    created: options.created ?? DEFAULT_CREATED,
  };
}

/** Type 1 — Issue Created. */
export function issueCreated(
  options: ActivityOptions & {
    summary?: string;
    description?: string | null;
    assignee?: FixtureUser | null;
    attachments?: FixtureAttachment[];
  } = {}
): Record<string, unknown> {
  const content: Record<string, unknown> = {
    id: options.issueId ?? FIXTURE.issueId,
    key_id: FIXTURE.issueKeyId,
    summary: options.summary ?? 'Deploy fails on the staging space',
    description: options.description ?? 'Reproduces on every push to main.',
  };
  if (options.assignee !== undefined) {
    content['assignee'] =
      options.assignee === null
        ? null
        : { id: options.assignee.id, name: options.assignee.name };
  }
  if (options.attachments) content['attachments'] = options.attachments;
  return envelope(1, content, options);
}

/**
 * Type 1 as the activity API returns it: `backlog-webhook-facts.md` § What each
 * issue operation emits.
 */
export function issueCreatedFromActivityApi(
  options: ActivityOptions & {
    summary?: string;
    description?: string | null;
  } = {}
): Record<string, unknown> {
  return envelope(
    1,
    {
      id: options.issueId ?? FIXTURE.issueId,
      key_id: FIXTURE.issueKeyId,
      summary: options.summary ?? 'Deploy fails on the staging space',
      description: options.description ?? 'Reproduces on every push to main.',
    },
    options
  );
}

/** Type 3 — Issue Commented. */
export function issueCommented(
  options: ActivityOptions & {
    commentId?: number;
    text?: string | null;
    attachments?: FixtureAttachment[];
  } = {}
): Record<string, unknown> {
  const content: Record<string, unknown> = {
    id: options.issueId ?? FIXTURE.issueId,
    key_id: FIXTURE.issueKeyId,
    summary: 'Deploy fails on the staging space',
    description: 'Reproduces on every push to main.',
    comment: {
      id: options.commentId ?? 3001,
      content: options.text ?? 'Any progress on this?',
    },
    changes: [],
  };
  if (options.attachments) content['attachments'] = options.attachments;
  return envelope(3, content, options);
}

/**
 * Type 2 — Issue Updated, with the changelog comment every field update
 * carries.
 */
export function issueUpdated(
  options: ActivityOptions & {
    commentId?: number;
    text?: string | null;
    changes?: FixtureChange[];
    attachments?: FixtureAttachment[];
  } = {}
): Record<string, unknown> {
  const content: Record<string, unknown> = {
    id: options.issueId ?? FIXTURE.issueId,
    key_id: FIXTURE.issueKeyId,
    summary: 'Deploy fails on the staging space',
    description: 'Reproduces on every push to main.',
    comment: {
      id: options.commentId ?? 3002,
      content: options.text ?? null,
    },
    changes: changeEntries(options.changes ?? []),
    shared_files: [],
    external_file_links: [],
  };
  if (options.attachments) content['attachments'] = options.attachments;
  return envelope(2, content, options);
}

/** Type 2 without a comment id, which no measured delivery lacked. */
export function issueUpdatedWithoutComment(
  options: ActivityOptions & { changes?: FixtureChange[] } = {}
): Record<string, unknown> {
  return envelope(
    2,
    {
      id: options.issueId ?? FIXTURE.issueId,
      key_id: FIXTURE.issueKeyId,
      summary: 'Deploy fails on the staging space',
      description: 'Reproduces on every push to main.',
      changes: changeEntries(
        options.changes ?? [{ field: 'status', new_value: '4', old_value: '3' }]
      ),
    },
    options
  );
}

export function statusChanged(
  options: ActivityOptions = {}
): Record<string, unknown> {
  return issueUpdated({
    ...options,
    text: null,
    changes: [{ field: 'status', new_value: '4', old_value: '3' }],
  });
}

/**
 * `backlog-webhook-facts.md` § Type 2 `changes[]` field names and value
 * formats.
 */
export function assigneeChanged(
  options: ActivityOptions & {
    assigneeName?: string;
    previousName?: string;
  } = {}
): Record<string, unknown> {
  return issueUpdated({
    ...options,
    text: null,
    changes: [
      {
        field: 'assigner',
        new_value: options.assigneeName ?? FIXTURE.bot.name,
        old_value: options.previousName ?? '',
      },
    ],
  });
}

export function descriptionEdited(
  options: ActivityOptions & { before?: string; after?: string } = {}
): Record<string, unknown> {
  return issueUpdated({
    ...options,
    text: '',
    changes: [
      {
        field: 'description',
        old_value: options.before ?? 'Reproduces on every push to main.',
        new_value:
          options.after ?? 'Reproduces on every push to main, since 0.4.0.',
      },
    ],
  });
}

/** `backlog-webhook-facts.md` § What each issue operation emits. */
export function attachmentAdded(
  options: ActivityOptions & { attachments?: FixtureAttachment[] } = {}
): Record<string, unknown> {
  return issueUpdated({
    ...options,
    text: null,
    changes: [],
    attachments: options.attachments ?? [
      { id: 9001, name: 'trace.log', size: 2048 },
    ],
  });
}

export function commentWithStatusChange(
  options: ActivityOptions & { text?: string } = {}
): Record<string, unknown> {
  return issueUpdated({
    ...options,
    text: options.text ?? 'Fixed in the latest build.',
    changes: [{ field: 'status', new_value: '4', old_value: '3' }],
  });
}

/** Type 4 — Issue Deleted. */
export function issueDeleted(
  options: ActivityOptions = {}
): Record<string, unknown> {
  return envelope(
    4,
    { id: options.issueId ?? FIXTURE.issueId, key_id: FIXTURE.issueKeyId },
    options
  );
}

interface FixtureBulkIssue {
  issueId: number;
  keyId: number;
  title: string;
  commentId: number;
}

const DEFAULT_BULK_ISSUES: FixtureBulkIssue[] = [
  {
    issueId: FIXTURE.issueId,
    keyId: FIXTURE.issueKeyId,
    title: 'Deploy fails on the staging space',
    commentId: 3101,
  },
  {
    issueId: FIXTURE.otherIssueId,
    keyId: FIXTURE.otherIssueKeyId,
    title: 'Retry the failed deploy',
    commentId: 3102,
  },
];

const THREE_BULK_ISSUES: FixtureBulkIssue[] = [
  ...DEFAULT_BULK_ISSUES,
  {
    issueId: FIXTURE.thirdIssueId,
    keyId: FIXTURE.thirdIssueKeyId,
    title: 'Roll the staging deploy back',
    commentId: 3103,
  },
];

/**
 * Type 14 — Issue Multi Updated, string ids and no `old_value` included:
 * `backlog-webhook-facts.md` § What each issue operation emits.
 */
export function issueMultiUpdated(
  options: ActivityOptions & {
    issues?: FixtureBulkIssue[];
    text?: string;
    changes?: FixtureChange[];
    individualUpdate?: boolean;
  } = {}
): Record<string, unknown> {
  const text = options.text ?? '';
  const issues = options.issues ?? DEFAULT_BULK_ISSUES;
  return envelope(
    14,
    {
      tx_id: '9876',
      comment: { content: text },
      link: issues.map((issue) => ({
        id: String(issue.issueId),
        key_id: String(issue.keyId),
        title: issue.title,
        comment: { id: issue.commentId, content: text },
      })),
      individual_update: options.individualUpdate ?? false,
      changes: (options.changes ?? [{ field: 'status', new_value: '4' }]).map(
        (change) => ({
          field: change.field,
          new_value: change.new_value ?? '',
          type: 'standard',
        })
      ),
    },
    options
  );
}

/**
 * Several fields and one assignee notification per issue:
 * `backlog-webhook-facts.md` § What each issue operation emits.
 */
export function bulkFieldsChanged(
  options: ActivityOptions & {
    issues?: FixtureBulkIssue[];
    assignee?: FixtureUser;
  } = {}
): Record<string, unknown> {
  const assignee = options.assignee ?? FIXTURE.bob;
  const issues = options.issues ?? THREE_BULK_ISSUES;
  return issueMultiUpdated({
    ...options,
    issues,
    changes: [
      { field: 'component', new_value: 'Deployment' },
      { field: 'milestone', new_value: '0.5.0' },
      { field: 'assigner', new_value: assignee.name },
      { field: 'priority', new_value: '2' },
    ],
    notifications: issues.map(() => ({ user: assignee, reason: 1 })),
  });
}

/** One issue ticked on the issue list is still a type 14. */
export function bulkStatusChangedOnOneIssue(
  options: ActivityOptions & { statusId?: string } = {}
): Record<string, unknown> {
  return issueMultiUpdated({
    ...options,
    issues: [DEFAULT_BULK_ISSUES[0]!],
    changes: [{ field: 'status', new_value: options.statusId ?? '3' }],
  });
}

/** Type 17 — Comment Notification Added, repeating an existing comment. */
export function commentNotificationAdded(
  options: ActivityOptions & { commentId?: number; text?: string } = {}
): Record<string, unknown> {
  return envelope(
    17,
    {
      id: options.issueId ?? FIXTURE.issueId,
      key_id: FIXTURE.issueKeyId,
      comment: {
        id: options.commentId ?? 3001,
        content: options.text ?? 'Any progress on this?',
      },
    },
    options
  );
}

/** The rewritten form a description or a comment carries instead. */
export const RESOLVED_MENTION = `@${FIXTURE.bot.name}`;

interface PullRequestOptions extends ActivityOptions {
  repositoryId?: number;
  repositoryName?: string;
  number?: number;
  pullRequestId?: number;
  assignee?: FixtureUser | null;
  diff?: string | null;
}

function repositoryOf(options: PullRequestOptions): Record<string, unknown> {
  return {
    id: options.repositoryId ?? FIXTURE.repositoryId,
    name: options.repositoryName ?? FIXTURE.repositoryName,
    description: null,
  };
}

/**
 * Types 18–20, webhook form: `backlog-pull-request-facts.md` § What each
 * pull-request operation emits.
 */
function pullRequestContent(
  options: PullRequestOptions & {
    summary?: string;
    description?: string | null;
    comment?: { id: number; content: string | null } | null;
    changes?: FixtureChange[];
    issue?: Record<string, unknown> | null;
  }
): Record<string, unknown> {
  const assignee = options.assignee ?? null;
  return {
    id: options.pullRequestId ?? FIXTURE.pullRequestId,
    number: options.number ?? FIXTURE.pullRequestNumber,
    summary: options.summary ?? 'Retry the deploy step on a 5xx',
    description: options.description ?? 'Fixes the flaky staging deploy.',
    base: 'main',
    branch: 'fix/deploy-retry',
    diff: options.diff ?? null,
    assignee:
      assignee === null
        ? null
        : {
            id: assignee.id,
            userId: assignee.userId ?? null,
            name: assignee.name,
            // Differs from `notifications[].user.roleType`, as measured, so
            // nothing starts to read one for the other.
            roleType: 94,
            lang: 'ja',
          },
    comment: options.comment ?? null,
    changes: changeEntries(options.changes ?? []),
    issue: options.issue ?? null,
    repository: repositoryOf(options),
  };
}

/** Type 18 — Pull Request Added, which carries no attachments. */
export function pullRequestAdded(
  options: PullRequestOptions & {
    summary?: string;
    description?: string | null;
    linkedIssue?: boolean;
  } = {}
): Record<string, unknown> {
  return envelope(
    18,
    pullRequestContent({
      ...options,
      comment: null,
      changes: [],
      issue: linkedIssueOf(options),
    }),
    options
  );
}

function linkedIssueOf(
  options: PullRequestOptions & { linkedIssue?: boolean }
): Record<string, unknown> | null {
  if (options.linkedIssue !== true) {
    return null;
  }
  return {
    id: options.issueId ?? FIXTURE.issueId,
    key_id: FIXTURE.issueKeyId,
    issue_key: `${FIXTURE.projectKey}-${FIXTURE.issueKeyId}`,
    summary: 'Deploy fails on the staging space',
    description: 'Reproduces on every push to main.',
  };
}

/** Type 20 — Comment Added on Pull Request. */
export function pullRequestCommented(
  options: PullRequestOptions & {
    commentId?: number;
    text?: string | null;
    changes?: FixtureChange[];
  } = {}
): Record<string, unknown> {
  return envelope(
    20,
    pullRequestContent({
      ...options,
      comment: {
        id: options.commentId ?? 7000001,
        content: options.text ?? 'Looks good, one question about the timeout.',
      },
      changes: options.changes ?? [],
    }),
    options
  );
}

/**
 * Type 19 — Pull Request Updated, with the changelog comment every field update
 * carries.
 */
export function pullRequestUpdated(
  options: PullRequestOptions & {
    commentId?: number;
    text?: string | null;
    summary?: string;
    description?: string | null;
    linkedIssue?: boolean;
    changes?: FixtureChange[];
  } = {}
): Record<string, unknown> {
  return envelope(
    19,
    pullRequestContent({
      ...options,
      comment: {
        id: options.commentId ?? 7000002,
        content: options.text ?? 'Rewording the summary.',
      },
      changes: options.changes ?? [
        {
          field: 'summary',
          old_value: 'Retry the deploy step',
          new_value: 'Retry the deploy step on a 5xx',
        },
      ],
      issue: linkedIssueOf(options),
    }),
    options
  );
}

/**
 * A multi-field `PATCH` that notified nobody: `backlog-pull-request-facts.md` §
 * What each pull-request operation emits.
 */
export function pullRequestMultiFieldUpdated(
  options: PullRequestOptions & { commentId?: number } = {}
): Record<string, unknown> {
  const newSummary = 'Retry the deploy step on a 5xx and link the issue';
  const newBody = 'Retries the deploy step on a 5xx.';
  const oldBody = 'Fixes the flaky staging deploy.';
  return pullRequestUpdated({
    ...options,
    summary: newSummary,
    description: newBody,
    diff: `1c1\n<${newBody}---\n>${oldBody}`,
    linkedIssue: true,
    changes: [
      {
        field: 'summary',
        new_value: newSummary,
        old_value: 'Retry the deploy step on a 5xx',
      },
      { field: 'description', new_value: newBody, old_value: oldBody },
      {
        field: 'issue',
        new_value: `${FIXTURE.projectKey}-${FIXTURE.issueKeyId}`,
        old_value: '',
      },
    ],
  });
}

/** The one delivery measured with a non-null `content.diff`. */
export function pullRequestDescriptionEdited(
  options: PullRequestOptions & {
    newBody?: string;
    oldBody?: string;
  } = {}
): Record<string, unknown> {
  const newBody = options.newBody ?? 'Retries the deploy step on a 5xx.';
  const oldBody = options.oldBody ?? 'Fixes the flaky staging deploy.';
  return pullRequestUpdated({
    ...options,
    description: newBody,
    diff: `1c1\n<${newBody}---\n>${oldBody}`,
    text: '',
    changes: [{ field: 'description', new_value: newBody, old_value: oldBody }],
  });
}

/** A merge or a close, both a type 19 status change. */
export function pullRequestStatusChanged(
  options: PullRequestOptions & {
    newStatusId?: string;
    oldStatusId?: string;
  } = {}
): Record<string, unknown> {
  return pullRequestUpdated({
    ...options,
    text: '',
    changes: [
      {
        field: 'status',
        new_value: options.newStatusId ?? '3',
        old_value: options.oldStatusId ?? '1',
      },
    ],
  });
}

/**
 * `backlog-pull-request-facts.md` § What each pull-request operation emits,
 * assignee rows.
 */
export function pullRequestAssigneeChanged(
  options: PullRequestOptions & {
    assigneeName?: string;
    previousName?: string;
  } = {}
): Record<string, unknown> {
  return pullRequestUpdated({
    ...options,
    text: '',
    changes: [
      {
        field: 'assignee',
        new_value: options.assigneeName ?? FIXTURE.bot.name,
        old_value: options.previousName ?? '',
      },
    ],
  });
}

/** The file is named in `changes[]`, with no id (D-PR10). */
export function pullRequestCommentWithAttachment(
  options: PullRequestOptions & {
    commentId?: number;
    text?: string | null;
    fileName?: string;
  } = {}
): Record<string, unknown> {
  return pullRequestCommented({
    ...options,
    text: options.text ?? 'Trace attached.',
    changes: [
      {
        field: 'attachment',
        new_value: options.fileName ?? 'trace.log',
        old_value: '',
      },
    ],
  });
}

/**
 * Type 21 was never observed, so this body is a guess: assert on nothing but
 * its type.
 */
export function pullRequestDeleted(
  options: PullRequestOptions = {}
): Record<string, unknown> {
  return envelope(21, pullRequestContent(options), options);
}

/** Type 12 — Git Pushed, which names no pull request. */
export function gitPushed(
  options: PullRequestOptions & { ref?: string } = {}
): Record<string, unknown> {
  return envelope(
    12,
    {
      repository: repositoryOf(options),
      change_type: 'update',
      revision_type: 'commit',
      ref: options.ref ?? 'refs/heads/main',
      revision_count: 1,
      revisions: [
        { rev: '0f1e2d3c4b5a69788796a5b4c3d2e1f009182736', comment: 'Merge' },
      ],
    },
    options
  );
}

/** An activity type the adapter has no meaning for (a wiki event). */
export function unrelatedActivity(
  options: ActivityOptions = {}
): Record<string, unknown> {
  return envelope(5, { id: 4242, name: 'Home' }, options);
}

interface RequestOptions {
  host?: string | null;
  token?: string | null;
  method?: string;
  body?: string;
  url?: string;
}

/** `null` omits the `host` or `token` query parameter. */
export function webhookRequest(
  payload: unknown,
  options: RequestOptions = {}
): Request {
  const url = new URL(
    options.url ?? 'https://app.example.com/api/webhooks/backlog'
  );
  const host = options.host === undefined ? FIXTURE.host : options.host;
  const token =
    options.token === undefined ? FIXTURE.webhookSecret : options.token;
  if (host !== null) url.searchParams.set('host', host);
  if (token !== null) url.searchParams.set('token', token);

  const method = options.method ?? 'POST';
  const body = options.body ?? JSON.stringify(payload);
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  });
}
