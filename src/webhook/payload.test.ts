import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  attachmentAdded,
  commentNotificationAdded,
  descriptionEdited,
  FIXTURE,
  issueCommented,
  issueCreated,
  issueCreatedFromActivityApi,
  issueDeleted,
  issueMultiUpdated,
  issueUpdated,
  issueUpdatedWithoutComment,
  pullRequestAdded,
  pullRequestAssigneeChanged,
  pullRequestCommented,
  pullRequestCommentWithAttachment,
  pullRequestDeleted,
  pullRequestStatusChanged,
  pullRequestUpdated,
  statusChanged,
  unrelatedActivity,
} from '../test/fixtures/webhooks';
import {
  DISPATCHED_ACTIVITY_TYPES,
  parseActivity,
  parseEnvelope,
  repositoryNameOf,
  subjectOfActivity,
} from './payload';

import type {
  BacklogBulkUpdatePayload,
  BacklogIssueCreatedActivity,
  BacklogIssueDeletedActivity,
  BacklogIssueUpdatedOrCommentedActivity,
  BacklogPullRequestAddedActivity,
  BacklogPullRequestUpdatedOrCommentedActivity,
  BacklogWebhookPayload,
} from '../types';
import type {
  IssueCreatedActivity,
  IssueDeletedActivity,
  IssueMultiUpdatedActivity,
  IssueMultiUpdatedBody,
  IssueUpdatedOrCommentedActivity,
  ParsedActivity,
  PullRequestAddedActivity,
  PullRequestUpdatedOrCommentedActivity,
  RecognisedActivity,
} from './payload';

function parsed(type: number, payload: object): ParsedActivity {
  const result = parseActivity(type, payload);
  if (!('activity' in result)) {
    throw new Error(`fixture failed to validate as type ${type}`);
  }
  return result.activity;
}

function activity(type: number, payload: object) {
  const value = parsed(type, payload);
  if (value.type === 14) {
    throw new Error('type 14 names no single subject; use bulkActivity');
  }
  return value;
}

function commentedActivity(payload: object): IssueUpdatedOrCommentedActivity {
  const value = parsed(3, payload);
  if (value.type !== 3) {
    throw new Error('fixture failed to validate as type 3');
  }
  return value;
}

function bulkActivity(payload: object): IssueMultiUpdatedActivity {
  const value = parsed(14, payload);
  if (value.type !== 14) {
    throw new Error('fixture failed to validate as type 14');
  }
  return value;
}

describe('parseEnvelope', () => {
  it('extracts the type discriminator from every recognised activity', () => {
    expect(parseEnvelope(issueCreated())).toEqual({ type: 1 });
    expect(parseEnvelope(issueCommented())).toEqual({ type: 3 });
    expect(parseEnvelope(issueDeleted())).toEqual({ type: 4 });
    expect(parseEnvelope(unrelatedActivity())).toEqual({ type: 5 });
  });

  it('rejects a body with no numeric type', () => {
    expect(parseEnvelope({})).toBeNull();
    expect(parseEnvelope({ type: 'not-a-number' })).toBeNull();
  });
});

describe('DISPATCHED_ACTIVITY_TYPES', () => {
  it('names exactly the issue and pull-request types the ladder dispatches (§5.1 step 8)', () => {
    expect(DISPATCHED_ACTIVITY_TYPES).toEqual([1, 2, 3, 4, 14, 18, 19, 20]);
  });

  it('a bulk update is dispatched, because its per-issue comments are real', () => {
    expect(DISPATCHED_ACTIVITY_TYPES).toContain(14);
  });

  it('a comment-notification type is not among them', () => {
    expect(DISPATCHED_ACTIVITY_TYPES).not.toContain(17);
  });

  it('a git push and a type-21 activity are not among them', () => {
    // 21 stays out because it was never observed: merge and close both
    // arrive as type 19 status changes, no delete operation exists, and the
    // measured project's whole history holds none (2026-09-06, D-PR5).
    expect(DISPATCHED_ACTIVITY_TYPES).not.toContain(12);
    expect(DISPATCHED_ACTIVITY_TYPES).not.toContain(21);
  });
});

describe('parseActivity', () => {
  it('validates a plain comment (type 3)', () => {
    const result = parseActivity(3, issueCommented());
    expect('activity' in result).toBe(true);
  });

  it('validates issue creation with and without a webhook-only assignee', () => {
    expect('activity' in parseActivity(1, issueCreated())).toBe(true);
    expect('activity' in parseActivity(1, issueCreatedFromActivityApi())).toBe(
      true
    );
  });

  it('validates a status change, an assignee change, a description edit and an attachment add', () => {
    expect('activity' in parseActivity(2, statusChanged())).toBe(true);
    expect(
      'activity' in
        parseActivity(
          2,
          issueUpdated({
            changes: [{ field: 'assigner', new_value: 'Chatbot' }],
          })
        )
    ).toBe(true);
    expect('activity' in parseActivity(2, descriptionEdited())).toBe(true);
    expect('activity' in parseActivity(2, attachmentAdded())).toBe(true);
  });

  it('validates a type-2 update with no comment id at all', () => {
    expect('activity' in parseActivity(2, issueUpdatedWithoutComment())).toBe(
      true
    );
  });

  it('validates issue deletion (type 4)', () => {
    expect('activity' in parseActivity(4, issueDeleted())).toBe(true);
  });

  it('required fields missing (§5.2) fail validation with issue paths, not values', () => {
    const result = parseActivity(3, {
      ...issueCommented(),
      createdUser: undefined,
    });
    expect('issuePaths' in result).toBe(true);
    if ('issuePaths' in result) {
      expect(result.issuePaths).toContain('createdUser');
    }
  });

  it('tolerates unknown keys everywhere, including inside changes[] and comment notifications', () => {
    const payload = issueMultiUpdated();
    // A type-14 body carries the top-level key like every other type, and
    // the fixture leaves it naming nobody; commentNotificationAdded (17)
    // reuses the type-3-shaped fixture surface and carries it too.
    expect(payload['notifications']).toEqual([]);

    const activity = commentNotificationAdded();
    expect('notifications' in activity).toBe(true);
  });

  it('reads who an activity notified, and why, off the top-level notifications[]', () => {
    const parsed = activity(
      3,
      issueCommented({
        notifications: [
          { user: FIXTURE.bot, reason: 2 },
          { user: FIXTURE.alice, reason: 1 },
        ],
      })
    );

    expect(parsed.notifications).toEqual([
      { user: { id: FIXTURE.bot.id }, reason: 2 },
      { user: { id: FIXTURE.alice.id }, reason: 1 },
    ]);
  });

  it('a notifications array in an unexpected shape leaves the activity valid', () => {
    const payload = issueCommented();
    payload['notifications'] = [{ user: 'someone' }, 7];

    const parsed = activity(3, payload);

    expect(parsed.notifications).toEqual([]);
    expect(parsed.type).toBe(3);
  });

  it('an activity carrying no notifications key reads as notifying nobody', () => {
    const payload = issueCommented();
    delete payload['notifications'];

    expect(activity(3, payload).notifications).toEqual([]);
  });

  it('reads a bulk update as its issues, its batch changes and its per-issue comments', () => {
    const activity = bulkActivity(
      issueMultiUpdated({ text: 'Moving these to done.' })
    );

    expect(activity.content.link).toEqual([
      {
        id: FIXTURE.issueId,
        key_id: FIXTURE.issueKeyId,
        title: 'Deploy fails on the staging space',
        comment: { id: 3101, content: 'Moving these to done.' },
      },
      {
        id: FIXTURE.otherIssueId,
        key_id: FIXTURE.otherIssueKeyId,
        title: 'Retry the failed deploy',
        comment: { id: 3102, content: 'Moving these to done.' },
      },
    ]);
    expect(activity.content.changes).toEqual([
      { field: 'status', new_value: '4' },
    ]);
    expect(activity.content.individual_update).toBe(false);
  });

  it('reads a bulk update issue id whether it arrives as a string or a number', () => {
    const asStrings = bulkActivity(issueMultiUpdated());
    const payload = issueMultiUpdated();
    const content = payload['content'] as Record<string, unknown>;
    for (const link of content['link'] as Record<string, unknown>[]) {
      link['id'] = Number(link['id']);
      link['key_id'] = Number(link['key_id']);
    }

    expect(bulkActivity(payload).content.link).toEqual(asStrings.content.link);
  });

  it('rejects a bulk update whose link entry names no usable issue', () => {
    const payload = issueMultiUpdated();
    const content = payload['content'] as Record<string, unknown>;
    const links = content['link'] as Record<string, unknown>[];
    links[0]!['id'] = '0';

    const result = parseActivity(14, payload);

    expect('issuePaths' in result).toBe(true);
    if ('issuePaths' in result) {
      expect(result.issuePaths).toContain('content.link.0.id');
    }
  });

  it('accepts a bulk update whose link entry carries no comment', () => {
    const payload = issueMultiUpdated();
    const content = payload['content'] as Record<string, unknown>;
    const links = content['link'] as Record<string, unknown>[];
    delete links[0]!['comment'];

    const activity = bulkActivity(payload);

    expect(activity.content.link[0]?.comment).toBeUndefined();
  });

  it('project.projectKey and content.key_id are optional, not required identity', () => {
    const payload = issueCommented();
    const project = payload['project'] as Record<string, unknown>;
    delete project['projectKey'];
    const content = payload['content'] as Record<string, unknown>;
    delete content['key_id'];

    expect('activity' in parseActivity(3, payload)).toBe(true);
  });
});

describe('subjectOfActivity', () => {
  it('reports every issue activity as being about the issue in content.id', () => {
    for (const [type, payload] of [
      [1, issueCreated()],
      [2, statusChanged()],
      [3, issueCommented()],
      [4, issueDeleted()],
    ] as const) {
      expect(subjectOfActivity(activity(type, payload))).toEqual({
        kind: 'issue',
        issueId: 8001,
      });
    }
  });

  it('reads the id from the activity, not from a fixture default', () => {
    expect(
      subjectOfActivity(activity(3, issueCommented({ issueId: 8002 })))
    ).toEqual({ kind: 'issue', issueId: 8002 });
  });
});

describe('parseActivity on pull-request activities', () => {
  it('validates creation, comment and update forms (types 18, 19, 20)', () => {
    expect('activity' in parseActivity(18, pullRequestAdded())).toBe(true);
    expect('activity' in parseActivity(20, pullRequestCommented())).toBe(true);
    expect('activity' in parseActivity(19, pullRequestUpdated())).toBe(true);
    expect('activity' in parseActivity(19, pullRequestStatusChanged())).toBe(
      true
    );
    expect('activity' in parseActivity(19, pullRequestAssigneeChanged())).toBe(
      true
    );
    expect(
      'activity' in parseActivity(20, pullRequestCommentWithAttachment())
    ).toBe(true);
  });

  it('a body missing the repository id is rejected with its issue path', () => {
    const payload = pullRequestAdded();
    const content = payload['content'] as Record<string, unknown>;
    delete (content['repository'] as Record<string, unknown>)['id'];

    const result = parseActivity(18, payload);
    expect('issuePaths' in result).toBe(true);
    if ('issuePaths' in result) {
      expect(result.issuePaths).toContain('content.repository.id');
    }
  });

  it('a body missing the pull-request number or its id is rejected', () => {
    const withoutNumber = pullRequestCommented();
    delete (withoutNumber['content'] as Record<string, unknown>)['number'];
    expect('issuePaths' in parseActivity(20, withoutNumber)).toBe(true);

    const withoutId = pullRequestCommented();
    delete (withoutId['content'] as Record<string, unknown>)['id'];
    expect('issuePaths' in parseActivity(20, withoutId)).toBe(true);
  });

  it('everything but the three identity fields is optional', () => {
    // The measured shape is the activity API's; the webhook form is
    // unmeasured, so a schema that required a display field would reject a
    // real delivery that happened to omit it.
    const minimal = {
      ...pullRequestAdded(),
      content: { id: 90001, number: 12, repository: { id: 700 } },
    };
    expect('activity' in parseActivity(18, minimal)).toBe(true);
  });

  it('a body carrying more than the activity form still parses', () => {
    const payload = pullRequestAdded();
    Object.assign(payload['content'] as Record<string, unknown>, {
      assignee: { id: 999, name: 'Chatbot' },
      attachments: [{ id: 9002, name: 'trace.log', size: 2048 }],
      base: 'main',
      branch: 'topic/retry',
      status: { id: 1, name: 'Open' },
    });
    expect('activity' in parseActivity(18, payload)).toBe(true);
  });
});

describe('subjectOfActivity on pull-request activities', () => {
  it('addresses a pull request by repository id and number', () => {
    for (const [type, payload] of [
      [18, pullRequestAdded()],
      [19, pullRequestStatusChanged()],
      [20, pullRequestCommented()],
    ] as const) {
      expect(subjectOfActivity(activity(type, payload))).toEqual({
        kind: 'pullRequest',
        repositoryId: 700,
        number: 12,
      });
    }
  });

  it('never reports the pull request by its space-wide content.id', () => {
    const subject = subjectOfActivity(
      activity(18, pullRequestAdded({ pullRequestId: 90009 }))
    );
    expect(subject).not.toHaveProperty('issueId');
    expect(JSON.stringify(subject)).not.toContain('90009');
  });

  it('a pull request linked to an issue is still its own subject', () => {
    expect(
      subjectOfActivity(activity(18, pullRequestAdded({ linkedIssue: true })))
    ).toEqual({ kind: 'pullRequest', repositoryId: 700, number: 12 });
  });

  it('reads the coordinates from the activity, not from a fixture default', () => {
    expect(
      subjectOfActivity(
        activity(20, pullRequestCommented({ repositoryId: 701, number: 13 }))
      )
    ).toEqual({ kind: 'pullRequest', repositoryId: 701, number: 13 });
  });
});

describe('repositoryNameOf', () => {
  it('reports the repository name every pull-request activity carries', () => {
    for (const [type, payload] of [
      [18, pullRequestAdded()],
      [19, pullRequestUpdated()],
      [20, pullRequestCommented()],
    ] as const) {
      expect(repositoryNameOf(activity(type, payload))).toEqual({
        repositoryId: 700,
        name: 'example-repo',
      });
    }
  });

  it('reports nothing for an issue activity, which names no repository', () => {
    expect(repositoryNameOf(activity(3, issueCommented()))).toBeUndefined();
    expect(repositoryNameOf(activity(1, issueCreated()))).toBeUndefined();
  });

  it('reports nothing when a pull-request body omits the name', () => {
    const payload = pullRequestAdded();
    delete (
      (payload['content'] as Record<string, unknown>)['repository'] as Record<
        string,
        unknown
      >
    )['name'];
    expect(repositoryNameOf(activity(18, payload))).toBeUndefined();
  });
});

describe('type 21', () => {
  it('is not validated at all: it never reaches a schema', () => {
    // Nothing asserts on the body — no type-21 activity was ever observed,
    // so the fixture is a guess and only the type gate may read it
    // (measured 2026-09-06, D-PR5).
    expect(parseEnvelope(pullRequestDeleted())).toEqual({ type: 21 });
    expect((DISPATCHED_ACTIVITY_TYPES as readonly number[]).includes(21)).toBe(
      false
    );
  });
});

describe('parseActivity — created (§5.2)', () => {
  it('an activity whose created is empty is invalid', () => {
    // `created: ""` used to pass: the message id of an update with no comment
    // ended in `:u:` and could not be decoded back, and `dateSent` was an
    // Invalid Date — both behind a 200.
    const result = parseActivity(
      2,
      issueUpdatedWithoutComment({ created: '' })
    );

    expect('issuePaths' in result).toBe(true);
    if ('issuePaths' in result) {
      expect(result.issuePaths).toContain('created');
    }
  });

  it('an activity whose created names no instant is invalid', () => {
    const result = parseActivity(3, issueCommented({ created: 'yesterday' }));

    expect('issuePaths' in result).toBe(true);
    if ('issuePaths' in result) {
      expect(result.issuePaths).toContain('created');
    }
  });

  it('a created carrying milliseconds or a numeric offset is accepted', () => {
    // The measured form is `2026-09-03T04:05:06Z`, and Backlog documents no
    // format at all — so a widened one is read rather than rejected.
    const withMillis = issueCommented({ created: '2026-09-03T04:05:06.123Z' });
    const withOffset = issueCommented({ created: '2026-09-03T13:05:06+09:00' });

    expect('activity' in parseActivity(3, withMillis)).toBe(true);
    expect('activity' in parseActivity(3, withOffset)).toBe(true);
  });
});

describe('parseActivity — fields that must not cost the message (§5.2)', () => {
  it('a changes value in a shape the adapter has not measured keeps the entry and the comment', () => {
    const payload = issueCommented();
    const content = payload['content'] as Record<string, unknown>;
    content['changes'] = [
      { field: 'custom_field_42', new_value: true, old_value: ['a', 'b'] },
    ];

    const parsed = commentedActivity(payload);

    expect(parsed.content.changes).toEqual([
      { field: 'custom_field_42', new_value: null, old_value: null },
    ]);
  });

  it('an attachment carrying no size is valid', () => {
    const payload = issueCommented();
    const content = payload['content'] as Record<string, unknown>;
    content['attachments'] = [{ id: 4001, name: 'trace.log' }];

    const parsed = commentedActivity(payload);

    expect(parsed.content.attachments).toEqual([
      { id: 4001, name: 'trace.log' },
    ]);
  });

  it('an attachment whose size is null, or in any other shape, keeps the file', () => {
    const payload = issueCommented();
    const content = payload['content'] as Record<string, unknown>;
    content['attachments'] = [
      { id: 4001, name: 'trace.log', size: null },
      { id: 4002, name: 'dump.bin', size: '2048' },
    ];

    const parsed = commentedActivity(payload);

    expect(parsed.content.attachments).toEqual([
      { id: 4001, name: 'trace.log' },
      { id: 4002, name: 'dump.bin' },
    ]);
  });
});

/**
 * The two payload types a consumer sees are declared by hand in
 * `src/types.ts` so the published declarations do not import zod (#37,
 * docs/specs/adapter.md §3.1). That leaves two descriptions of the same
 * bodies in this repository, and these assertions are what keeps them one
 * description: each pair is checked in both directions, so a schema edit the
 * hand-written type does not follow — or a hand-written field no schema
 * validates — fails `pnpm typecheck`.
 *
 * `vitest run` executes them as no-ops. Turning on vitest's own `typecheck`
 * mode would run a second `tsc` over the same files for no extra coverage:
 * `pnpm typecheck` already reads `src/**` and is one of the five gates.
 */
describe('the hand-written payload types and the schemas they mirror', () => {
  it('describe every issue activity identically', () => {
    expectTypeOf<BacklogIssueCreatedActivity>().toEqualTypeOf<IssueCreatedActivity>();
    expectTypeOf<BacklogIssueUpdatedOrCommentedActivity>().toEqualTypeOf<IssueUpdatedOrCommentedActivity>();
    expectTypeOf<BacklogIssueDeletedActivity>().toEqualTypeOf<IssueDeletedActivity>();
  });

  it('describe every pull-request activity identically', () => {
    expectTypeOf<BacklogPullRequestAddedActivity>().toEqualTypeOf<PullRequestAddedActivity>();
    expectTypeOf<BacklogPullRequestUpdatedOrCommentedActivity>().toEqualTypeOf<PullRequestUpdatedOrCommentedActivity>();
  });

  it('agree on which activities name a single subject', () => {
    expectTypeOf<BacklogWebhookPayload>().toEqualTypeOf<RecognisedActivity>();
  });

  it('describe a bulk update as delivered, before the schema coerces its link ids', () => {
    expectTypeOf<BacklogBulkUpdatePayload>().toEqualTypeOf<IssueMultiUpdatedBody>();
  });
});
