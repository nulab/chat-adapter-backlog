import { describe, expect, it } from 'vitest';

import {
  assigneeChanged,
  attachmentAdded,
  bulkFieldsChanged,
  bulkStatusChangedOnOneIssue,
  commentNotificationAdded,
  commentWithStatusChange,
  descriptionEdited,
  FIXTURE,
  gitPushed,
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
  pullRequestDescriptionEdited,
  pullRequestStatusChanged,
  pullRequestUpdated,
  RAW_MENTION,
  RESOLVED_MENTION,
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

  it('addresses a pull request by repository id and number, never by its global id', () => {
    expect(FIXTURE.repositoryId).toBe(700);
    expect(FIXTURE.pullRequestNumber).toBe(12);
    // The global id is vocabulary for stars and metadata only: no
    // pull-request endpoint accepts it
    // (`.claude/rules/backlog-pull-request-facts.md`).
    expect(FIXTURE.pullRequestId).toBe(90001);
    expect(FIXTURE.repositoryName).toBe('example-repo');
  });

  it('carries an empty notifications array on every activity type until one is asked for', () => {
    for (const payload of [
      issueCreated(),
      issueCommented(),
      issueUpdated(),
      statusChanged(),
      commentNotificationAdded(),
      issueMultiUpdated(),
      bulkStatusChangedOnOneIssue(),
      issueDeleted(),
    ]) {
      expect(payload['notifications']).toEqual([]);
    }
  });

  it('names the notified user and the reason when a builder is given notifications', () => {
    const payload = issueCommented({
      notifications: [{ user: FIXTURE.bot, reason: 2 }],
    });

    expect(payload['notifications']).toEqual([
      {
        id: 4100,
        alreadyRead: false,
        reason: 2,
        user: expect.objectContaining({
          id: FIXTURE.bot.id,
          name: FIXTURE.bot.name,
        }),
        resourceAlreadyRead: false,
      },
    ]);
  });

  it('notifies once per issue on a bulk update that changed the assignee, naming no issue', () => {
    const payload = bulkFieldsChanged();
    const content = payload['content'] as Record<string, unknown>;
    const notifications = payload['notifications'] as Record<string, unknown>[];

    expect(notifications).toHaveLength((content['link'] as unknown[]).length);
    for (const notification of notifications) {
      expect(notification['reason']).toBe(1);
      expect(notification['user']).toMatchObject({ id: FIXTURE.bob.id });
      // The entries differ from one another in nothing but their own id, so
      // pairing them with `link[]` would be an assumption about ordering.
      expect(Object.keys(notification).sort()).toEqual([
        'alreadyRead',
        'id',
        'reason',
        'resourceAlreadyRead',
        'user',
      ]);
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

  it('reports a bulk update as one type-14 activity naming its issues in content.link[]', () => {
    const payload = issueMultiUpdated();
    expect(payload['type']).toBe(14);
    const content = payload['content'] as Record<string, unknown>;
    expect(content).toHaveProperty('tx_id');
    expect(content).not.toHaveProperty('id');
    expect(content['individual_update']).toBe(false);
    expect(content['link']).toHaveLength(2);
  });

  it("writes a bulk update's issue ids as strings, as the webhook form does", () => {
    const content = issueMultiUpdated()['content'] as Record<string, unknown>;
    const [first] = content['link'] as Record<string, unknown>[];
    expect(first?.['id']).toBe(String(FIXTURE.issueId));
    expect(first?.['key_id']).toBe(String(FIXTURE.issueKeyId));
  });

  it('gives a bulk update a comment per issue even when the comment box was empty', () => {
    const content = issueMultiUpdated()['content'] as Record<string, unknown>;
    const links = content['link'] as Record<string, unknown>[];
    const commentIds = links.map(
      (link) => (link['comment'] as Record<string, unknown>)['id']
    );
    expect(new Set(commentIds).size).toBe(links.length);
    for (const link of links) {
      expect((link['comment'] as Record<string, unknown>)['content']).toBe('');
    }
    expect(content['comment']).toEqual({ content: '' });
  });

  it('reports a bulk update of a single issue as a type 14 all the same', () => {
    const payload = bulkStatusChangedOnOneIssue();

    expect(payload['type']).toBe(14);
    const content = payload['content'] as Record<string, unknown>;
    expect(content['link']).toHaveLength(1);
    expect(content['individual_update']).toBe(false);
  });

  it("writes a bulk update's priority as an id and its other fields as display names", () => {
    const content = bulkFieldsChanged()['content'] as Record<string, unknown>;

    // Type 2's notation, unchanged: `priority`, `status` and `resolution` are
    // the only fields Backlog reports by id.
    expect(content['changes']).toEqual([
      { field: 'component', new_value: 'Deployment', type: 'standard' },
      { field: 'milestone', new_value: '0.5.0', type: 'standard' },
      { field: 'assigner', new_value: FIXTURE.bob.name, type: 'standard' },
      { field: 'priority', new_value: '2', type: 'standard' },
    ]);
  });

  it("omits old_value from a bulk update's changes[], which reports only the new state", () => {
    const content = issueMultiUpdated()['content'] as Record<string, unknown>;
    const [change] = content['changes'] as Record<string, unknown>[];
    expect(change).toEqual({
      field: 'status',
      new_value: '4',
      type: 'standard',
    });
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

/**
 * The pull-request builders stand in for the **webhook** form measured on a
 * development space, 2026-09-06 (`.claude/rules/backlog-pull-request-facts.md`
 * "What each pull-request operation emits"), which is the activity API form
 * plus `assignee`, `base`, `branch` and `diff` on all three types alike.
 */
describe('pull-request webhook fixtures', () => {
  it('carries the activity key set plus the four webhook-only keys on all three types, with the repository name on every one', () => {
    const activityFormKeys = [
      'changes',
      'comment',
      'description',
      'id',
      'issue',
      'number',
      'repository',
      'summary',
    ];
    const webhookOnlyKeys = ['assignee', 'base', 'branch', 'diff'];

    for (const payload of [
      pullRequestAdded(),
      pullRequestUpdated(),
      pullRequestCommented(),
    ]) {
      const content = payload['content'] as Record<string, unknown>;
      expect(Object.keys(content).sort()).toEqual(
        [...activityFormKeys, ...webhookOnlyKeys].sort()
      );
      expect(content['repository']).toMatchObject({
        id: FIXTURE.repositoryId,
        name: FIXTURE.repositoryName,
      });
    }
  });

  it('names a target branch and a source branch that are not the same branch', () => {
    for (const payload of [
      pullRequestAdded(),
      pullRequestUpdated(),
      pullRequestCommented(),
    ]) {
      const content = payload['content'] as Record<string, unknown>;
      expect(content['base']).toEqual(expect.any(String));
      expect(content['branch']).toEqual(expect.any(String));
      expect(content['base']).not.toBe(content['branch']);
    }
  });

  it('leaves the diff null on every delivery but a description edit', () => {
    for (const payload of [
      pullRequestAdded(),
      pullRequestUpdated(),
      pullRequestCommented(),
      pullRequestStatusChanged(),
      pullRequestAssigneeChanged(),
    ]) {
      expect(
        (payload['content'] as Record<string, unknown>)['diff']
      ).toBeNull();
    }

    const edited = pullRequestDescriptionEdited()['content'] as Record<
      string,
      unknown
    >;
    expect(edited['diff']).toContain('1c1');
    expect((edited['changes'] as Record<string, unknown>[])[0]?.['field']).toBe(
      'description'
    );
  });

  it('leaves a created pull request unassigned and without attachments by default', () => {
    const content = pullRequestAdded()['content'] as Record<string, unknown>;
    expect(content['assignee']).toBeNull();
    expect(content).not.toHaveProperty('attachments');
    expect(content['comment']).toBeNull();
    expect(content['changes']).toEqual([]);
    expect(pullRequestAdded()['type']).toBe(18);
  });

  it('names the assignee whenever one is given, on a creation and on an update alike', () => {
    for (const payload of [
      pullRequestAdded({ assignee: FIXTURE.bot }),
      pullRequestUpdated({ assignee: FIXTURE.bot }),
      pullRequestCommented({ assignee: FIXTURE.bot }),
    ]) {
      expect(
        (payload['content'] as Record<string, unknown>)['assignee']
      ).toMatchObject({ id: FIXTURE.bot.id, name: FIXTURE.bot.name });
    }
  });

  it('addresses the pull request by number and repository, and carries the star-only global id apart from them', () => {
    const content = pullRequestAdded()['content'] as Record<string, unknown>;
    expect(content['number']).toBe(FIXTURE.pullRequestNumber);
    expect(content['id']).toBe(FIXTURE.pullRequestId);
    expect(content).not.toHaveProperty('issueKey');
  });

  it('gives a pull-request comment a 7-digit id from its own sequence', () => {
    const comment = (
      pullRequestCommented()['content'] as Record<string, unknown>
    )['comment'] as Record<string, unknown>;
    expect(String(comment['id'])).toHaveLength(7);
    expect(pullRequestCommented()['type']).toBe(20);
  });

  it('reports a merge as a type-19 status change by id string, not a type of its own', () => {
    const payload = pullRequestStatusChanged();
    expect(payload['type']).toBe(19);
    const content = payload['content'] as Record<string, unknown>;
    expect(content['changes']).toEqual([
      expect.objectContaining({
        field: 'status',
        new_value: '3',
        old_value: '1',
      }),
    ]);
    expect((content['comment'] as Record<string, unknown>)['content']).toBe('');
  });

  it('names the pull-request assignee field `assignee`, where the issue side says `assigner`', () => {
    const changes = (
      pullRequestAssigneeChanged()['content'] as Record<string, unknown>
    )['changes'] as Record<string, unknown>[];
    expect(changes[0]).toMatchObject({
      field: 'assignee',
      new_value: FIXTURE.bot.name,
      old_value: '',
    });

    const issueSide = (assigneeChanged()['content'] as Record<string, unknown>)[
      'changes'
    ] as Record<string, unknown>[];
    expect(issueSide[0]).toMatchObject({ field: 'assigner' });
  });

  it('names a comment attachment by file name and carries no id for it', () => {
    const content = pullRequestCommentWithAttachment({
      fileName: 'stack.txt',
    })['content'] as Record<string, unknown>;
    const changes = content['changes'] as Record<string, unknown>[];
    expect(changes[0]).toMatchObject({
      field: 'attachment',
      new_value: 'stack.txt',
      old_value: '',
    });
    expect(changes[0]).not.toHaveProperty('id');
    expect(content).not.toHaveProperty('attachments');
  });

  it('populates the linked issue only when one is asked for', () => {
    expect(
      (pullRequestAdded()['content'] as Record<string, unknown>)['issue']
    ).toBeNull();

    const linked = (
      pullRequestAdded({ linkedIssue: true })['content'] as Record<
        string,
        unknown
      >
    )['issue'] as Record<string, unknown>;
    expect(linked['id']).toBe(FIXTURE.issueId);
    expect(linked['issue_key']).toBe(
      `${FIXTURE.projectKey}-${FIXTURE.issueKeyId}`
    );
  });

  it('keeps mention notation raw in a summary and rewritten in a description', () => {
    const content = pullRequestAdded({
      summary: `Retry the deploy step ${RAW_MENTION}`,
      description: `${RESOLVED_MENTION} please review.`,
    })['content'] as Record<string, unknown>;
    expect(content['summary']).toContain('<@U999>');
    expect(content['description']).toContain('@Chatbot');
    expect(content['description']).not.toContain('<@U');
  });

  it('tolerates the extra keys real payloads carry inside changes[]', () => {
    const changes = (
      pullRequestStatusChanged()['content'] as Record<string, unknown>
    )['changes'] as Record<string, unknown>[];
    expect(changes[0]).toHaveProperty('field_text');
    expect(changes[0]).toHaveProperty('type', 'standard');
  });

  it('varies the repository and the number so two threads can be told apart', () => {
    const content = pullRequestCommented({
      repositoryId: 701,
      number: 13,
    })['content'] as Record<string, unknown>;
    expect(content['number']).toBe(13);
    expect(content['repository']).toMatchObject({ id: 701 });
  });

  it('gives a git push no pull-request reference at all', () => {
    const payload = gitPushed();
    expect(payload['type']).toBe(12);
    const content = payload['content'] as Record<string, unknown>;
    expect(Object.keys(content).sort()).toEqual([
      'change_type',
      'ref',
      'repository',
      'revision_count',
      'revision_type',
      'revisions',
    ]);
    expect(content).not.toHaveProperty('number');
  });

  it('offers a type-21 body for the ignored case only', () => {
    // Never observed on a real space (measured 2026-09-06): the body is a
    // guess, so only its type may be asserted on.
    expect(pullRequestDeleted()['type']).toBe(21);
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
