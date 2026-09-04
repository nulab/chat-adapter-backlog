import { describe, expect, it } from 'vitest';

import {
  assigneeChanged,
  attachmentAdded,
  commentNotificationAdded,
  commentWithStatusChange,
  descriptionEdited,
  FIXTURE,
  issueCommented,
  issueCreated,
  issueCreatedFromActivityApi,
  issueDeleted,
  issueMultiUpdated,
  issueUpdated,
  issueUpdatedWithoutComment,
  statusChanged,
  unrelatedActivity,
  webhookRequest,
} from './webhooks';

/**
 * These fixtures stand in for measured Backlog deliveries, so a drift between
 * them and `.claude/rules/backlog-webhook-facts.md` would silently weaken every
 * suite built on them. The assertions below pin the facts the adapter's own
 * behaviour depends on.
 */
describe('webhook fixtures', () => {
  it('names no real space, person or project', () => {
    const serialised = JSON.stringify([
      issueCreated(),
      issueCommented(),
      issueUpdated(),
      issueDeleted(),
    ]);
    expect(serialised).toContain('example.com');
    expect(serialised).toContain('Alice');
    expect(FIXTURE.host).toBe('example.backlog.com');
    expect(FIXTURE.bot).toEqual({
      id: 999,
      name: 'Chatbot',
      userId: 'chatbot',
    });
  });

  it('carries an empty notifications array on every activity type', () => {
    for (const payload of [
      issueCreated(),
      issueCommented(),
      issueUpdated(),
      statusChanged(),
      commentNotificationAdded(),
      issueMultiUpdated(),
      issueDeleted(),
    ]) {
      expect(payload['notifications']).toEqual([]);
    }
  });

  it('identifies the issue by numeric id and never by issue key', () => {
    const content = issueCreated()['content'] as Record<string, unknown>;
    expect(content['id']).toBe(FIXTURE.issueId);
    expect(content['key_id']).toBe(FIXTURE.issueKeyId);
    expect(content).not.toHaveProperty('issueKey');
  });

  it('omits the assignee from the activity-API form of a created issue', () => {
    expect(issueCreated({ assignee: FIXTURE.bot })['content']).toHaveProperty(
      'assignee'
    );
    expect(issueCreatedFromActivityApi()['content']).not.toHaveProperty(
      'assignee'
    );
  });

  it('reports a status change as an id string and an assignee change as a display name', () => {
    const status = (statusChanged()['content'] as Record<string, unknown>)[
      'changes'
    ];
    expect(status).toEqual([
      expect.objectContaining({
        field: 'status',
        new_value: '4',
        old_value: '3',
      }),
    ]);

    const assigner = (assigneeChanged()['content'] as Record<string, unknown>)[
      'changes'
    ];
    expect(assigner).toEqual([
      expect.objectContaining({
        field: 'assigner',
        new_value: FIXTURE.bot.name,
      }),
    ]);
  });

  it('attaches a changelog comment to every field update', () => {
    for (const payload of [
      statusChanged(),
      assigneeChanged(),
      descriptionEdited(),
      attachmentAdded(),
    ]) {
      const comment = (payload['content'] as Record<string, unknown>)[
        'comment'
      ] as Record<string, unknown>;
      expect(comment['id']).toEqual(expect.any(Number));
    }
  });

  it('carries both complete bodies when the description is edited', () => {
    const changes = (
      descriptionEdited({ before: 'old body', after: 'new body' })[
        'content'
      ] as Record<string, unknown>
    )['changes'] as Record<string, unknown>[];
    expect(changes[0]).toMatchObject({
      field: 'description',
      old_value: 'old body',
      new_value: 'new body',
    });
  });

  it('delivers a comment and a status change as one event', () => {
    const content = commentWithStatusChange()['content'] as Record<
      string,
      unknown
    >;
    const comment = content['comment'] as Record<string, unknown>;
    expect(comment['content']).toBe('Fixed in the latest build.');
    expect(content['changes']).toHaveLength(1);
  });

  it('tolerates the extra keys real payloads carry', () => {
    const changes = (statusChanged()['content'] as Record<string, unknown>)[
      'changes'
    ] as Record<string, unknown>[];
    expect(changes[0]).toHaveProperty('field_text');
    expect(changes[0]).toHaveProperty('type', 'standard');
  });

  it('omits the comment id on the update-without-comment shape', () => {
    expect(issueUpdatedWithoutComment()['content']).not.toHaveProperty(
      'comment'
    );
  });

  it('reports a bulk update as one type-14 activity with no per-issue comment', () => {
    const payload = issueMultiUpdated();
    expect(payload['type']).toBe(14);
    const content = payload['content'] as Record<string, unknown>;
    expect(content).toHaveProperty('tx_id');
    expect(content).not.toHaveProperty('id');
  });

  it('gives a Nulab-account user a null userId', () => {
    const payload = issueCommented({
      createdUser: { id: 102, name: 'Carol', userId: null },
    });
    const user = payload['createdUser'] as Record<string, unknown>;
    expect(user['userId']).toBeNull();
    expect(user['name']).toBe('Carol');
  });

  it('uses an activity type the adapter ignores for the unrelated case', () => {
    expect(unrelatedActivity()['type']).toBe(5);
  });
});

describe('webhook request builder', () => {
  it('puts the host and the secret in the query string', async () => {
    const request = webhookRequest(issueCommented());
    const url = new URL(request.url);
    expect(request.method).toBe('POST');
    expect(url.searchParams.get('host')).toBe(FIXTURE.host);
    expect(url.searchParams.get('token')).toBe(FIXTURE.webhookSecret);
    expect(JSON.parse(await request.text())['type']).toBe(3);
  });

  it('omits a parameter that is explicitly null', () => {
    const noHost = new URL(
      webhookRequest(issueCommented(), { host: null }).url
    );
    expect(noHost.searchParams.has('host')).toBe(false);

    const noToken = new URL(
      webhookRequest(issueCommented(), { token: null }).url
    );
    expect(noToken.searchParams.has('token')).toBe(false);
  });

  it('sends a body that is not valid JSON when one is supplied verbatim', async () => {
    const request = webhookRequest(null, { body: 'not json' });
    expect(await request.text()).toBe('not json');
  });

  it('builds a bodyless request for a non-POST method', () => {
    expect(webhookRequest(issueCommented(), { method: 'GET' }).method).toBe(
      'GET'
    );
  });
});
