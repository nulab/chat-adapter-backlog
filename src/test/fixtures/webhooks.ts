/**
 * Webhook payload builders for the activity types the adapter processes.
 *
 * Shapes follow `.claude/rules/backlog-webhook-facts.md`: the body is one
 * Activity object as returned by Get Recent Updates, every measured payload
 * carries extra keys (`field_text`, `type` inside `changes[]`, `notifications`,
 * `shared_files`), and `notifications` is always empty. Builders therefore emit
 * those keys rather than a minimal shape, so a schema that only tolerates the
 * documented fields fails here rather than in production.
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

interface ActivityOptions {
  created?: string;
  createdUser?: FixtureUser;
  projectId?: number;
  issueId?: number;
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
    // Emptied by Backlog in 2022 and measured empty on every type since; a
    // fixture with entries here would exercise code that never runs.
    notifications: [],
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
    changes: (options.changes ?? []).map((change) => ({
      field: change.field,
      new_value: change.new_value ?? '',
      old_value: change.old_value ?? '',
      field_text: change.field,
      type: 'standard',
    })),
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
      changes: (
        options.changes ?? [{ field: 'status', new_value: '4', old_value: '3' }]
      ).map((change) => ({
        field: change.field,
        new_value: change.new_value ?? '',
        old_value: change.old_value ?? '',
        field_text: change.field,
        type: 'standard',
      })),
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

/**
 * Type 14 — Issue Multi Updated. A bulk status change never arrives as a
 * type 2 per issue, so there is no per-issue comment to build a message from.
 */
export function issueMultiUpdated(
  options: ActivityOptions = {}
): Record<string, unknown> {
  return envelope(
    14,
    {
      tx_id: '9876',
      comment: { content: '' },
      link: [
        {
          id: FIXTURE.issueId,
          key_id: FIXTURE.issueKeyId,
          title: 'Deploy fails on the staging space',
          comment: { id: 3003, content: '' },
        },
      ],
      changes: [{ field: 'status', new_value: '4', type: 'standard' }],
    },
    options
  );
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
