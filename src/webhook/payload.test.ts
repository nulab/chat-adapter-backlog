import { describe, expect, it } from 'vitest';

import {
  FIXTURE,
  gitPushed,
  issueCommented,
  issueCreated,
  issueDeleted,
  issueMultiUpdated,
  issueUpdated,
  pullRequestAdded,
  pullRequestCommented,
  pullRequestDeleted,
  unrelatedActivity,
} from '../test/fixtures/webhooks';
import { parseDelivery, payloadOf, subjectOfActivity } from './payload';

import type { SubjectActivity, WebhookActivity } from './payload';

function activity(body: unknown): WebhookActivity {
  const delivery = parseDelivery(body);
  if (!delivery.ok || !('activity' in delivery)) {
    throw new Error(`not a dispatched activity: ${JSON.stringify(delivery)}`);
  }
  return delivery.activity;
}

function subjectActivity(body: unknown): SubjectActivity {
  const parsed = activity(body);
  if (parsed.type === 14) {
    throw new Error('a bulk update names no single subject');
  }
  return parsed;
}

function content(body: Record<string, unknown>): Record<string, unknown> {
  return body['content'] as Record<string, unknown>;
}

describe('parseDelivery', () => {
  it.each([
    ['a git push', gitPushed()],
    ['a pull request deletion (type 21)', pullRequestDeleted()],
    ['a comment notification (type 17)', { ...unrelatedActivity(), type: 17 }],
    ['an unknown type whose body is nothing like an activity', { type: 99 }],
  ])('ignores %s without reading its body', (_case, body) => {
    expect(parseDelivery(body)).toEqual({
      ok: true,
      ignoredType: (body as { type: number }).type,
    });
  });

  it.each([
    ['a JSON string', 'just a string'],
    ['a body with no numeric type', { notAType: true }],
  ])('rejects %s', (_case, body) => {
    expect(parseDelivery(body)).toMatchObject({ ok: false });
  });

  it('rejects a dispatched type missing an identity field, naming its path and not its value', () => {
    const body = issueCommented();
    delete content(body)['id'];

    expect(parseDelivery(body)).toEqual({
      ok: false,
      issuePaths: ['content.id'],
    });
  });

  it('keeps every key the schema does not name', () => {
    const parsed = activity(issueCommented());

    expect(parsed).toMatchObject({
      id: 71828,
      project: { projectKey: FIXTURE.projectKey, name: 'Example project' },
      content: { key_id: FIXTURE.issueKeyId, summary: expect.any(String) },
    });
  });

  it('reads the issue id of a bulk update link as a number, though a delivery writes it as a string', () => {
    const parsed = activity(issueMultiUpdated());

    expect(
      parsed.type === 14 && parsed.content.link.map((link) => link.id)
    ).toEqual([FIXTURE.issueId, FIXTURE.otherIssueId]);
  });

  it('reads an absent notifications[], or one in an unmeasured shape, as notifying nobody', () => {
    const absent = issueCommented();
    delete absent['notifications'];
    const unreadable = { ...issueCommented(), notifications: [{ reason: 2 }] };

    expect(activity(absent).notifications).toEqual([]);
    expect(activity(unreadable).notifications).toEqual([]);
  });

  it('reads a change value as a string, and one in an unmeasured shape or left out as null', () => {
    const body = issueUpdated();
    content(body)['changes'] = [
      { field: 'priority', new_value: 2, old_value: '3' },
      { field: 'Checked', new_value: ['a', 'b'], old_value: { id: 1 } },
      { field: 'status', new_value: '4' },
    ];

    const parsed = subjectActivity(body);

    expect(parsed.type === 2 && parsed.content.changes).toEqual([
      { field: 'priority', new_value: '2', old_value: '3' },
      { field: 'Checked', new_value: null, old_value: null },
      { field: 'status', new_value: '4', old_value: null },
    ]);
  });

  it("reads a changelog comment's null text as the empty string REST reports", () => {
    expect(subjectActivity(issueUpdated({ text: null })).content).toMatchObject(
      { comment: { content: '' } }
    );
  });

  it('hands a consumer a payload whose type narrows its content', () => {
    const payload = payloadOf(activity(issueCommented({ text: 'hello' })));

    expect(payload.type === 3 && payload.content.comment?.content).toBe(
      'hello'
    );
  });

  it('reads an absent comment, assignee, changes[] and attachments[] as null and empty', () => {
    const created = issueCreated();
    delete content(created)['assignee'];
    delete content(created)['attachments'];
    const updated = issueUpdated();
    delete content(updated)['comment'];
    delete content(updated)['changes'];

    const parsed = subjectActivity(created);
    expect(parsed.type === 1 && parsed.content).toMatchObject({
      assignee: null,
      attachments: [],
    });
    expect(subjectActivity(updated).content).toMatchObject({
      comment: null,
      changes: [],
      attachments: [],
    });
  });
});

describe('subjectOfActivity', () => {
  it.each([
    ['an issue creation', issueCreated()],
    ['an issue comment', issueCommented()],
    ['an issue deletion', issueDeleted()],
  ])('addresses %s by the issue id in content.id', (_case, body) => {
    expect(subjectOfActivity(subjectActivity(body))).toEqual({
      kind: 'issue',
      issueId: FIXTURE.issueId,
    });
  });

  it.each([
    ['creation', pullRequestAdded({ linkedIssue: true })],
    ['comment', pullRequestCommented()],
  ])(
    'addresses a pull-request %s by repository and number, never by its space-wide id or its linked issue',
    (_case, body) => {
      expect(subjectOfActivity(subjectActivity(body))).toEqual({
        kind: 'pullRequest',
        repositoryId: FIXTURE.repositoryId,
        number: FIXTURE.pullRequestNumber,
      });
    }
  );
});
