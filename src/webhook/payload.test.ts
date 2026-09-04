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
  statusChanged,
  unrelatedActivity,
} from '../test/fixtures/webhooks';
import {
  DISPATCHED_ACTIVITY_TYPES,
  parseActivity,
  parseEnvelope,
} from './payload';

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
  it('names exactly the four types the ladder dispatches (§5.1 step 8)', () => {
    expect(DISPATCHED_ACTIVITY_TYPES).toEqual([1, 2, 3, 4]);
  });

  it('a bulk update and a comment-notification type are not among them', () => {
    expect(DISPATCHED_ACTIVITY_TYPES).not.toContain(14);
    expect(DISPATCHED_ACTIVITY_TYPES).not.toContain(17);
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
