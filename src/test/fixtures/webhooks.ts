/**
 * Webhook payload builders for the activity types the adapter processes.
 *
 * Shapes follow `.claude/rules/backlog-webhook-facts.md`: the body is one
 * Activity object as returned by Get Recent Updates, and every measured payload
 * carries extra keys (`field_text`, `type` inside `changes[]`, `shared_files`).
 * Builders therefore emit those keys rather than a minimal shape, so a schema
 * that only tolerates the documented fields fails here rather than in
 * production. `notifications` defaults to `[]` — the shape a body replayed from
 * `GET /space/activities` has — and every builder takes `notifications` so a
 * real delivery's populated array can be built too.
 *
 * @see https://developer.nulab.com/docs/backlog/api/2/get-recent-updates/
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
  // A second issue, so a bulk update has more than one to fan out to.
  otherIssueId: 8002,
  otherIssueKeyId: 43,
  // A third, so a batch can be larger than a pair — the measured
  // notification-per-issue payload updated three at once.
  thirdIssueId: 8003,
  thirdIssueKeyId: 44,
  // The pull-request vocabulary P3's builders address a thread with: a pull
  // request is keyed by repository id + number, never by `pullRequestId` —
  // that space-wide id addresses no endpoint and exists here only because
  // `POST /stars` wants it (`.claude/rules/backlog-pull-request-facts.md`).
  repositoryId: 700,
  repositoryName: 'example-repo',
  pullRequestNumber: 12,
  pullRequestId: 90001,
  bot: { id: 999, name: 'Chatbot', userId: 'chatbot' },
  alice: { id: 100, name: 'Alice', userId: 'alice' },
  bob: { id: 101, name: 'Bob', userId: 'bob' },
} as const;

/**
 * A `createdUser` as Backlog serialises it. `userId` is `null` for users who
 * sign in with a Nulab account, which is why the adapter falls back to `name`.
 */
export interface FixtureUser {
  id: number;
  name: string;
  userId?: string | null;
}

export interface FixtureChange {
  field: string;
  new_value?: string | number | null;
  old_value?: string | number | null;
}

export interface FixtureAttachment {
  id: number;
  name: string;
  size: number;
}

/**
 * One top-level `notifications[]` entry. `reason` follows Get Notification's
 * codes: 1 Assigned to Issue, 2 Issue Commented
 * (`.claude/rules/backlog-api-facts.md`).
 */
export interface FixtureNotification {
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

/**
 * One `notifications[]` entry as Backlog serialises it: the read flags and the
 * full user object surround the two fields the adapter reads
 * (measured 2026-09-06).
 */
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

/**
 * `changes[]` as Backlog serialises it: the three documented keys plus
 * `field_text` and `type`, which every measured payload carries.
 */
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
    // The activity id, not the issue or comment id.
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
    // Empty by default because that is what a body replayed from `GET
    // /space/activities` carries; a real delivery names the users it notified
    // (measured 2026-09-06), which is what `notifications` builds.
    notifications: notificationEntries(options.notifications ?? []),
    createdUser: createdUserOf(user),
    created: options.created ?? DEFAULT_CREATED,
  };
}

/** Type 1 — Issue Created. `assignee` is present only on the webhook form. */
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
 * Type 1 as the activity API returns it — without `assignee`.
 *
 * Kept separate from {@link issueCreated} because assignment-based mention
 * detection can only work on the webhook form; replaying an activity body must
 * still parse.
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

/** Type 3 — Issue Commented. A plain comment carries no changes. */
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
 * Type 2 — Issue Updated, with the changelog comment Backlog attaches to every
 * field update. `comment.id` being set does **not** mean "no field change".
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

/**
 * Type 2 without a comment id — the `:u:<created>` message path.
 *
 * Every measured field change carried a comment id, so this shape is rare; it
 * exists so an update without one is a well-formed message rather than a 400.
 */
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

/** A status change reports ids as strings, not display names. */
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
 * An assignee change reports the new assignee by **display name** under the
 * field name `assigner` — not `assignee`, and not an id.
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

/** A description edit carries both complete bodies in `changes[]`. */
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

/**
 * An attachment add arrives as a changelog comment whose `content` is
 * effectively empty; the change itself is visible only in that comment's REST
 * `changeLog`, so the webhook body carries no `changes[]` entry for it.
 */
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

/** A comment posted together with a status change is one event, not two. */
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

/** One issue of a bulk update, as `content.link[]` names it. */
export interface FixtureBulkIssue {
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

/** The default pair plus one, for a batch whose size is the point. */
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
 * Type 14 — Issue Multi Updated: one delivery for a bulk update made from the
 * issue list, however many issues it covered — **one included**.
 *
 * Four details are measured (on a development space, 2026-09-06) and are the
 * reason this builder does not go through
 * {@link changeEntries} or reuse the numeric ids the other builders emit:
 *
 * - `content.link[].id` and `key_id` are decimal **strings** here, while every
 *   other activity writes the same fields as numbers.
 * - `changes[]` entries carry `field`, `new_value` and `type` and **no**
 *   `old_value` — a bulk update reports where the issues ended up, not where
 *   each of them started.
 * - `link[].comment` exists even when the comment box was left empty, with
 *   `content: ""`, and its `id` is a comment that really was written on that
 *   issue.
 * - `notifications[]` carries one reason-1 entry **per issue** when the batch
 *   changed the assignee, and none of them says which issue it belongs to.
 *   One delivery holding several indistinguishable entries is peculiar to 14.
 *
 * `content.comment` repeats the typed text with no `id` of its own, and
 * `individual_update` was `false` on all six measured deliveries — the bulk
 * update screen has no way to give two issues different values, so no known
 * operation produces a `true`.
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
 * A bulk update of several fields at once, as the issue list makes one: four
 * `changes[]` entries in two value systems and one assignee notification per
 * issue (measured on a development space, 2026-09-06).
 *
 * The notation is type 2's, not a bulk-specific one — `priority` is a
 * **id** written as a string while `component` (the category), `milestone`
 * and `assigner` are display names — and the only thing that makes it a
 * bulk update's `changes[]` is the absent `old_value`.
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
    // One reason-1 entry per issue, the same user repeated: Backlog emits the
    // notification per issue, and the entries name no issue, so they are
    // indistinguishable from one another.
    notifications: issues.map(() => ({ user: assignee, reason: 1 })),
  });
}

/**
 * A bulk update of a **single** issue — still a type 14, and still with an
 * empty `notifications[]` when no assignee changed (measured on a development
 * space, 2026-09-06).
 *
 * What separates a type 2 from a type 14 is the screen the update was made
 * from, not how many issues it covered: one issue ticked on the issue list
 * arrives here, while the same field changed on the issue's own page arrives
 * as a type 2.
 */
export function bulkStatusChangedOnOneIssue(
  options: ActivityOptions & { statusId?: string } = {}
): Record<string, unknown> {
  return issueMultiUpdated({
    ...options,
    issues: [DEFAULT_BULK_ISSUES[0]!],
    changes: [{ field: 'status', new_value: options.statusId ?? '3' }],
  });
}

/** Type 17 — Comment Notification Added. Repeats an existing comment. */
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

/**
 * The mention notation a pull-request **summary** keeps: the server rewrites
 * `<@U…>` to `@<display name>` in a description or a comment, but not in a
 * summary, where the literal survives (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md` "Mentions"). Detection must
 * therefore match both forms, so both have a fixture.
 */
export const RAW_MENTION = `<@U${FIXTURE.bot.id}>`;

/** The rewritten form a description or a comment carries instead. */
export const RESOLVED_MENTION = `@${FIXTURE.bot.name}`;

/**
 * A pull request is addressed by repository id and number; `pullRequestId` is
 * the space-wide id that only `POST /stars` accepts.
 */
interface PullRequestOptions extends ActivityOptions {
  repositoryId?: number;
  repositoryName?: string;
  number?: number;
  pullRequestId?: number;
  /**
   * The subject's **current** assignee, which the webhook form carries on 18,
   * 19 and 20 alike while the activity form carries it on none of them
   * (measured 2026-09-07). `null` — an unassigned pull request — is the
   * default because these builders model the webhook form, which is the only
   * form the adapter ever receives.
   */
  assignee?: FixtureUser | null;
  /**
   * The diff(1)-style body a description edit puts on its type 19, and `null`
   * on every other delivery (measured 2026-09-07). Only
   * `pullRequestDescriptionEdited` sets it, so the pairing of the key with the
   * `description` change is a property of the fixtures rather than of each
   * caller.
   */
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
 * The `content` key set types 18, 19 and 20 share in the form the adapter
 * receives (`.claude/rules/backlog-pull-request-facts.md`): the activity
 * form's keys — no `attachments`, no `status`, `repository.name` on every one
 * — plus the four the **webhook** adds, `assignee`, `base`, `branch` and
 * `diff` (measured 2026-09-07 by diffing five deliveries against the same
 * activities). `base` and `branch` are constants here because nothing reads
 * them and no measured delivery omitted them.
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
            // Not the `roleType` the same user carries under
            // `notifications[].user`, which was 2 for the same account
            // (measured 2026-09-07). Nothing reads either; the fixture keeps
            // them different so nothing starts to.
            roleType: 94,
            lang: 'ja',
          },
    comment: options.comment ?? null,
    changes: changeEntries(options.changes ?? []),
    issue: options.issue ?? null,
    repository: repositoryOf(options),
  };
}

/**
 * Type 18 — Pull Request Added.
 *
 * The attachments a create call takes are **not in the activity at all**, so
 * no option adds them; the `assignee` it takes is, on the webhook form
 * (measured 2026-09-07), which is what makes opening a pull request for the
 * bot a mention. `linkedIssue` populates `content.issue`, which is display
 * data and never routing (D-PR6).
 */
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
      issue: options.linkedIssue
        ? {
            id: options.issueId ?? FIXTURE.issueId,
            key_id: FIXTURE.issueKeyId,
            issue_key: `${FIXTURE.projectKey}-${FIXTURE.issueKeyId}`,
            summary: 'Deploy fails on the staging space',
            description: 'Reproduces on every push to main.',
          }
        : null,
    }),
    options
  );
}

/** Type 20 — Comment Added on Pull Request. A plain comment carries no changes. */
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
 * Type 19 — Pull Request Updated, with the changelog comment Backlog attaches
 * to every field update. A `PATCH` carrying a `comment` puts its text here.
 */
export function pullRequestUpdated(
  options: PullRequestOptions & {
    commentId?: number;
    text?: string | null;
    summary?: string;
    description?: string | null;
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
    }),
    options
  );
}

/**
 * A description edit, the one delivery measured to carry a non-null
 * `content.diff` (2026-09-07): a diff(1)-style body of the edit, alongside the
 * `description` change that carries both full bodies. Every other pull-request
 * delivery has `diff: null`, which is what the other builders emit.
 */
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

/**
 * A merge or a close: both arrive as type 19 with a status change, never as a
 * type of their own, and the status is an **id string** — `1` Open, `2`
 * Closed, `3` Merged (measured 2026-09-06).
 */
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
 * An assignee change reports both assignees by **display name** under the
 * field name `assignee` — the issue side calls the same thing `assigner`
 * (measured 2026-09-06). `previousName` defaults to `""`, the value measured
 * when nobody was assigned before; a reassignment carries the old name there,
 * and an unassignment is `assigneeName: ""` with the old name kept (measured
 * 2026-09-07).
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

/**
 * A comment posted with `attachmentId[]`: the change names the file and
 * carries **no id**, so the attachment can only be resolved by name against
 * the pull request's attachment list (D-PR10).
 */
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
 * Type 21, for the "200 Ignored" case only.
 *
 * No type-21 activity was ever observed, so this body is a **guess** wearing
 * the type-18 content shape (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md`). It is only ever fed to the
 * ladder's type gate, which ignores it before any schema runs; nothing may
 * assert on its content.
 */
export function pullRequestDeleted(
  options: PullRequestOptions = {}
): Record<string, unknown> {
  return envelope(21, pullRequestContent(options), options);
}

/**
 * Type 12 — Git Pushed. A push carries no pull-request reference at all, so
 * it can never be routed to a thread even when it is the push that merges a
 * pull request (measured 2026-09-06).
 */
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

/**
 * Build the inbound `Request` the Chat SDK route would hand `handleWebhook`.
 *
 * `host` and `token` are the query parameters the adapter authenticates on:
 * pass `null` to omit either one. Backlog signs nothing, so there is no header
 * to forge here — the path secret is the whole check.
 */
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
    // Backlog documents neither the Content-Type nor the User-Agent it sends,
    // so nothing in the adapter may key on them; the fixture sends the
    // conventional pair to prove that.
    headers: { 'content-type': 'application/json' },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  });
}
