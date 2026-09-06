import { describe, expect, it } from 'vitest';

import {
  attachmentAdded,
  commentNotificationAdded,
  descriptionEdited,
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

import type { RecognisedActivity } from './payload';

function activity(type: number, payload: object): RecognisedActivity {
  const result = parseActivity(type, payload);
  if (!('activity' in result)) {
    throw new Error(`fixture failed to validate as type ${type}`);
  }
  return result.activity;
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
    expect(DISPATCHED_ACTIVITY_TYPES).toEqual([1, 2, 3, 4, 18, 19, 20]);
  });

  it('a bulk update and a comment-notification type are not among them', () => {
    expect(DISPATCHED_ACTIVITY_TYPES).not.toContain(14);
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
    // Type 14 has its own shape and is never schema-validated (it is
    // filtered out at the envelope-type gate before reaching a schema), but
    // commentNotificationAdded (17) reuses the type-3-shaped fixture surface
    // with a `notifications` key that no schema names.
    expect(payload['notifications']).toEqual([]);

    const activity = commentNotificationAdded();
    expect('notifications' in activity).toBe(true);
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
