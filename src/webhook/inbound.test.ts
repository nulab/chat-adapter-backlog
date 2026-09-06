import { describe, expect, it, vi } from 'vitest';

import {
  assigneeChanged,
  attachmentAdded,
  commentWithStatusChange,
  descriptionEdited,
  FIXTURE,
  issueCommented,
  issueCreated,
  issueUpdatedWithoutComment,
  pullRequestAdded,
  pullRequestAssigneeChanged,
  pullRequestCommented,
  pullRequestCommentWithAttachment,
  pullRequestStatusChanged,
  pullRequestUpdated,
  RESOLVED_MENTION,
  statusChanged,
} from '../test/fixtures/webhooks';
import { createPullRequestSubjectClient } from '../subject/pull-request';
import { buildAuthor, buildInboundMessageFields } from './inbound';
import { parseActivity } from './payload';

import type { BuildInboundMessageInput, InboundActivity } from './inbound';
import type { BacklogApi, BacklogComment } from '../client/port';
import type { SubjectClient } from '../subject/client';
import type { BacklogChange } from '../types';
import type { Attachment } from 'chat';

/**
 * Only `ref`, `webhookAttachment` and `webhookChangeAttachment` are reachable
 * from the webhook path, so the stub implements those three and leaves the
 * rest of `SubjectClient` to `src/subject/*.test.ts`. Both attachment members
 * mirror the issue client's mapping — including its empty answer for a
 * `changes[]` entry, which an issue webhook never carries — so the assertions
 * below stay about what the webhook path produces.
 */
function issueSubject(
  fetchAttachment: (
    issueId: number,
    attachmentId: number
  ) => Promise<Buffer> = async () => Buffer.alloc(0)
): SubjectClient {
  const ref = { kind: 'issue', issueId: FIXTURE.issueId } as const;
  return {
    ref,
    webhookAttachment: (attachment: {
      id: number;
      name: string;
      size: number;
    }): Attachment => ({
      type: 'file',
      name: attachment.name,
      size: attachment.size,
      url: `https://${FIXTURE.host}/api/v2/issues/${ref.issueId}/attachments/${attachment.id}`,
      fetchData: () => fetchAttachment(ref.issueId, attachment.id),
    }),
    webhookChangeAttachment: (): Attachment | undefined => undefined,
  } as unknown as SubjectClient;
}

/**
 * The same three members for a pull-request thread. `webhookAttachment`
 * mirrors the pull-request client's URL, which is keyed by project,
 * repository and number rather than by an issue id, and
 * `webhookChangeAttachment` mirrors its name-only file, which carries no URL
 * at all.
 */
function pullRequestSubject(): SubjectClient {
  const ref = {
    kind: 'pullRequest',
    repositoryId: FIXTURE.repositoryId,
    number: FIXTURE.pullRequestNumber,
  } as const;
  return {
    ref,
    webhookAttachment: (attachment: {
      id: number;
      name: string;
      size: number;
    }): Attachment => ({
      type: 'file',
      name: attachment.name,
      size: attachment.size,
      url:
        `https://${FIXTURE.host}/api/v2/projects/${FIXTURE.projectId}` +
        `/git/repositories/${ref.repositoryId}/pullRequests/${ref.number}` +
        `/attachments/${attachment.id}`,
    }),
    webhookChangeAttachment: (
      change: BacklogChange
    ): Attachment | undefined => {
      const name = change.newValue;
      return name === null ? undefined : { type: 'file', name };
    },
  } as unknown as SubjectClient;
}

function input(
  overrides: Partial<BuildInboundMessageInput> = {}
): BuildInboundMessageInput {
  return {
    host: FIXTURE.host,
    botUserId: FIXTURE.bot.id,
    botUserName: FIXTURE.bot.name,
    subject: issueSubject(),
    ...overrides,
  };
}

function pullRequestInput(
  overrides: Partial<BuildInboundMessageInput> = {}
): BuildInboundMessageInput {
  return input({ subject: pullRequestSubject(), ...overrides });
}

/**
 * A fixture body as the response ladder hands it on: validated by the schema
 * for its type, so a test can never assert on a field the schema would have
 * stripped before the mapping saw it.
 */
function activityOfType(type: number, payload: object): InboundActivity {
  const result = parseActivity(type, payload);
  if (!('activity' in result)) {
    throw new Error(
      `fixture failed to validate as type ${type}: ${result.issuePaths.join(', ')}`
    );
  }
  const activity = result.activity;
  if (activity.type === 4) {
    throw new Error('type 4 is a deletion, not a message');
  }
  if (activity.type === 14) {
    throw new Error('type 14 fans out; see bulk.test.ts');
  }
  return activity;
}

const created = (payload: object): InboundActivity =>
  activityOfType(1, payload);
const updated = (payload: object): InboundActivity =>
  activityOfType(2, payload);
const commented = (payload: object): InboundActivity =>
  activityOfType(3, payload);

describe('buildInboundMessageFields — type 1 Issue Created', () => {
  it('the message id is the issue root and text is summary + description', () => {
    const activity = created(
      issueCreated({ summary: 'Deploy fails', description: 'Repro steps' })
    );

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.messageId).toBe(`${FIXTURE.host}:issue:${FIXTURE.issueId}:r`);
    expect(fields.text).toBe('Deploy fails\n\nRepro steps');
    expect(fields.changes).toEqual([]);
  });

  it('a null description does not add a leading blank line', () => {
    // `issueCreated({ description: null })` falls back to its own default via
    // `??`, so a genuinely null description is built by hand here instead of
    // through the fixture builder.
    const payload = issueCreated({ summary: 'Deploy fails' });
    (payload['content'] as Record<string, unknown>)['description'] = null;
    const activity = created(payload);

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.text).toBe('Deploy fails');
  });

  it('assigning the bot is a mention', () => {
    const activity = created(
      issueCreated({ assignee: { id: FIXTURE.bot.id, name: FIXTURE.bot.name } })
    );

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.isMention).toBe(true);
  });

  it('assigning someone else with no mention text is not a mention', () => {
    const activity = created(
      issueCreated({
        assignee: { id: FIXTURE.alice.id, name: FIXTURE.alice.name },
      })
    );

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.isMention).toBe(false);
  });

  it('a mention placed in the summary counts', () => {
    const activity = created(
      issueCreated({ summary: 'cc @Chatbot please review' })
    );

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.isMention).toBe(true);
  });

  it('attachments carry an authenticated download URL, not a public link', () => {
    const activity = created(
      issueCreated({
        attachments: [{ id: 9001, name: 'trace.log', size: 2048 }],
      })
    );

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.attachments).toHaveLength(1);
    expect(fields.attachments[0]).toMatchObject({
      type: 'file',
      name: 'trace.log',
      size: 2048,
      url: `https://${FIXTURE.host}/api/v2/issues/${FIXTURE.issueId}/attachments/9001`,
    });
  });

  it('webhook attachments download through the configured host', async () => {
    const fetchAttachmentSpy = vi.fn(async () => Buffer.from('file-bytes'));
    const activity = created(
      issueCreated({
        attachments: [{ id: 9001, name: 'trace.log', size: 2048 }],
      })
    );

    const fields = buildInboundMessageFields(
      activity,
      input({ subject: issueSubject(fetchAttachmentSpy) })
    );
    const attachment = fields.attachments[0];
    expect(attachment?.fetchData).toBeDefined();
    const data = await attachment?.fetchData?.();

    expect(fetchAttachmentSpy).toHaveBeenCalledWith(FIXTURE.issueId, 9001);
    expect(data).toEqual(Buffer.from('file-bytes'));
  });
});

describe('buildInboundMessageFields — types 2 and 3, comment id present', () => {
  it('a plain comment (type 3) arrives with the comment message id and its text', () => {
    const activity = commented(
      issueCommented({ commentId: 3001, text: 'Any progress on this?' })
    );

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.messageId).toBe(
      `${FIXTURE.host}:issue:${FIXTURE.issueId}:c3001`
    );
    expect(fields.text).toBe('Any progress on this?');
    expect(fields.changes).toEqual([]);
  });

  it('a status-only change arrives as a comment message with empty text and a status change', () => {
    const activity = updated(statusChanged());

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.text).toBe('');
    expect(fields.changes).toEqual([
      { field: 'status', newValue: '4', oldValue: '3' },
    ]);
  });

  it('a comment posted together with a status change is one event carrying both', () => {
    const activity = updated(
      commentWithStatusChange({ text: 'Fixed in the latest build.' })
    );

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.text).toBe('Fixed in the latest build.');
    expect(fields.changes).toEqual([
      { field: 'status', newValue: '4', oldValue: '3' },
    ]);
  });

  it('assigning the bot is a mention, a status change alone is not', () => {
    const mentionFields = buildInboundMessageFields(
      updated(assigneeChanged({ assigneeName: FIXTURE.bot.name })),
      input()
    );
    const statusOnlyFields = buildInboundMessageFields(
      updated(statusChanged()),
      input()
    );

    expect(mentionFields.isMention).toBe(true);
    expect(mentionFields.text).toBe('');
    expect(mentionFields.changes[0]).toMatchObject({
      field: 'assigner',
      newValue: FIXTURE.bot.name,
    });
    expect(statusOnlyFields.isMention).toBe(false);
  });

  it('assigning someone other than the bot is not a mention', () => {
    const fields = buildInboundMessageFields(
      updated(assigneeChanged({ assigneeName: FIXTURE.alice.name })),
      input()
    );

    expect(fields.isMention).toBe(false);
  });

  it('a description edit carries both complete bodies in changes[] with empty text', () => {
    const activity = updated(
      descriptionEdited({ before: 'old body', after: 'new body' })
    );

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.text).toBe('');
    expect(fields.changes).toEqual([
      { field: 'description', oldValue: 'old body', newValue: 'new body' },
    ]);
  });

  it('an attachment added to the issue arrives as a changelog comment with one attachment', () => {
    const activity = updated(
      attachmentAdded({
        attachments: [{ id: 9001, name: 'trace.log', size: 2048 }],
      })
    );

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.text).toBe('');
    expect(fields.changes).toEqual([]);
    expect(fields.attachments).toHaveLength(1);
    expect(fields.attachments[0]).toMatchObject({
      name: 'trace.log',
      size: 2048,
    });
  });
});

describe('buildInboundMessageFields — type 2 without a comment id', () => {
  it('uses the :u: message id and empty text', () => {
    const activity = updated(issueUpdatedWithoutComment());

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.messageId).toBe(
      `${FIXTURE.host}:issue:${FIXTURE.issueId}:u:2026-09-03T04:05:06Z`
    );
    expect(fields.text).toBe('');
  });
});

describe('buildInboundMessageFields — type 18 Pull Request Added', () => {
  it('the message id is the pull request root and text is summary + description', () => {
    const activity = activityOfType(
      18,
      pullRequestAdded({
        summary: 'Retry the deploy step on a 5xx',
        description: 'Fixes the flaky staging deploy.',
      })
    );

    const fields = buildInboundMessageFields(activity, pullRequestInput());

    expect(fields.messageId).toBe(
      `${FIXTURE.host}:pr:${FIXTURE.repositoryId}:${FIXTURE.pullRequestNumber}:r`
    );
    expect(fields.text).toBe(
      'Retry the deploy step on a 5xx\n\nFixes the flaky staging deploy.'
    );
    expect(fields.changes).toEqual([]);
  });

  it('a linked issue is display data: it changes neither the ids nor the text', () => {
    const withLink = buildInboundMessageFields(
      activityOfType(18, pullRequestAdded({ linkedIssue: true })),
      pullRequestInput()
    );
    const withoutLink = buildInboundMessageFields(
      activityOfType(18, pullRequestAdded()),
      pullRequestInput()
    );

    expect(withLink.messageId).toBe(withoutLink.messageId);
    expect(withLink.text).toBe(withoutLink.text);
  });

  it('a mention typed into the description counts', () => {
    const activity = activityOfType(
      18,
      pullRequestAdded({ description: 'cc @Chatbot please review' })
    );

    const fields = buildInboundMessageFields(activity, pullRequestInput());

    expect(fields.isMention).toBe(true);
  });

  it('a summary mentioning the bot in raw notation is a mention', () => {
    const activity = activityOfType(
      18,
      pullRequestAdded({ summary: `cc <@U${FIXTURE.bot.id}> please review` })
    );

    const fields = buildInboundMessageFields(activity, pullRequestInput());

    expect(fields.isMention).toBe(true);
  });

  it('an issue summary carrying the same raw notation is not a mention', () => {
    const activity = created(
      issueCreated({ summary: `cc <@U${FIXTURE.bot.id}> please review` })
    );

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.isMention).toBe(false);
  });

  it('a summary mentioning another user in raw notation is not a mention', () => {
    const activity = activityOfType(
      18,
      pullRequestAdded({ summary: `cc <@U${FIXTURE.alice.id}> please review` })
    );

    const fields = buildInboundMessageFields(activity, pullRequestInput());

    expect(fields.isMention).toBe(false);
  });

  it('opening a pull request assigned to the bot is a mention', () => {
    const fields = buildInboundMessageFields(
      activityOfType(18, pullRequestAdded({ assignee: FIXTURE.bot })),
      pullRequestInput()
    );

    expect(fields.isMention).toBe(true);
  });

  it('opening a pull request assigned to someone else is not a mention', () => {
    const fields = buildInboundMessageFields(
      activityOfType(18, pullRequestAdded({ assignee: FIXTURE.alice })),
      pullRequestInput()
    );

    expect(fields.isMention).toBe(false);
  });

  it('opening a pull request that an activity replay strips the assignee from is not a mention', () => {
    const fields = buildInboundMessageFields(
      activityOfType(18, pullRequestAdded()),
      pullRequestInput()
    );

    expect(fields.isMention).toBe(false);
  });

  it('attachments a webhook body turns out to carry map through the subject', () => {
    const payload = pullRequestAdded();
    (payload['content'] as Record<string, unknown>)['attachments'] = [
      { id: 9002, name: 'trace.log', size: 2048 },
    ];

    const fields = buildInboundMessageFields(
      activityOfType(18, payload),
      pullRequestInput()
    );

    expect(fields.attachments).toHaveLength(1);
    expect(fields.attachments[0]).toMatchObject({
      type: 'file',
      name: 'trace.log',
      size: 2048,
      url:
        `https://${FIXTURE.host}/api/v2/projects/${FIXTURE.projectId}` +
        `/git/repositories/${FIXTURE.repositoryId}` +
        `/pullRequests/${FIXTURE.pullRequestNumber}/attachments/9002`,
    });
  });
});

describe('buildInboundMessageFields — types 19 and 20, comment id present', () => {
  it('a plain comment (type 20) arrives with the comment message id and its text', () => {
    const activity = activityOfType(
      20,
      pullRequestCommented({
        commentId: 7000001,
        text: 'Looks good, one question about the timeout.',
      })
    );

    const fields = buildInboundMessageFields(activity, pullRequestInput());

    expect(fields.messageId).toBe(
      `${FIXTURE.host}:pr:${FIXTURE.repositoryId}:${FIXTURE.pullRequestNumber}:c7000001`
    );
    expect(fields.text).toBe('Looks good, one question about the timeout.');
    expect(fields.changes).toEqual([]);
  });

  it('a summary change (type 19) carries the PATCH comment text and both bodies', () => {
    const activity = activityOfType(
      19,
      pullRequestUpdated({ commentId: 7000002 })
    );

    const fields = buildInboundMessageFields(activity, pullRequestInput());

    expect(fields.messageId).toBe(
      `${FIXTURE.host}:pr:${FIXTURE.repositoryId}:${FIXTURE.pullRequestNumber}:c7000002`
    );
    expect(fields.text).toBe('Rewording the summary.');
    expect(fields.changes).toEqual([
      {
        field: 'summary',
        oldValue: 'Retry the deploy step',
        newValue: 'Retry the deploy step on a 5xx',
      },
    ]);
  });

  it('a merge arrives as a status change with empty text, not as a type of its own', () => {
    const activity = activityOfType(19, pullRequestStatusChanged());

    const fields = buildInboundMessageFields(activity, pullRequestInput());

    expect(fields.text).toBe('');
    expect(fields.changes).toEqual([
      { field: 'status', newValue: '3', oldValue: '1' },
    ]);
    expect(fields.isMention).toBe(false);
  });

  it('assigning the bot to a pull request is a mention', () => {
    const fields = buildInboundMessageFields(
      activityOfType(
        19,
        pullRequestAssigneeChanged({ assigneeName: FIXTURE.bot.name })
      ),
      pullRequestInput()
    );

    expect(fields.isMention).toBe(true);
    expect(fields.text).toBe('');
    expect(fields.changes[0]).toMatchObject({
      field: 'assignee',
      newValue: FIXTURE.bot.name,
    });
  });

  it('assigning someone other than the bot to a pull request is not a mention', () => {
    const fields = buildInboundMessageFields(
      activityOfType(
        19,
        pullRequestAssigneeChanged({ assigneeName: FIXTURE.alice.name })
      ),
      pullRequestInput()
    );

    expect(fields.isMention).toBe(false);
  });

  it('a multi-field update naming no assignee mentions the bot when the bot is the assignee', () => {
    const fields = buildInboundMessageFields(
      activityOfType(19, pullRequestUpdated({ assignee: FIXTURE.bot })),
      pullRequestInput()
    );

    expect(fields.changes.map((change) => change.field)).toEqual(['summary']);
    expect(fields.isMention).toBe(true);
  });

  it('a multi-field update naming no assignee is not a mention when someone else is the assignee', () => {
    const fields = buildInboundMessageFields(
      activityOfType(19, pullRequestUpdated({ assignee: FIXTURE.alice })),
      pullRequestInput()
    );

    expect(fields.isMention).toBe(false);
  });

  it('a comment on a pull request the bot is assigned to is not a mention', () => {
    const fields = buildInboundMessageFields(
      activityOfType(20, pullRequestCommented({ assignee: FIXTURE.bot })),
      pullRequestInput()
    );

    expect(fields.isMention).toBe(false);
  });

  it('merging a pull request the bot is assigned to is not a mention', () => {
    const fields = buildInboundMessageFields(
      activityOfType(19, pullRequestStatusChanged({ assignee: FIXTURE.bot })),
      pullRequestInput()
    );

    expect(fields.changes.map((change) => change.field)).toEqual(['status']);
    expect(fields.isMention).toBe(false);
  });

  it('unassigning the bot from a pull request is not a mention', () => {
    const fields = buildInboundMessageFields(
      activityOfType(
        19,
        pullRequestAssigneeChanged({
          assigneeName: '',
          previousName: FIXTURE.bot.name,
          assignee: null,
        })
      ),
      pullRequestInput()
    );

    expect(fields.isMention).toBe(false);
  });

  it('an issue update is decided by its changes entry alone, whatever assignee a body carries', () => {
    // No measured issue webhook carries `content.assignee` on type 2 at all
    // (2026-08-28), so the field is added by hand: the point of the test is
    // that the pull-request rule above cannot start firing on issues if one
    // ever does.
    const payload = descriptionEdited();
    (payload['content'] as Record<string, unknown>)['assignee'] = {
      id: FIXTURE.bot.id,
      name: FIXTURE.bot.name,
    };

    const fields = buildInboundMessageFields(updated(payload), input());

    expect(fields.isMention).toBe(false);
  });

  it('raw mention notation in a comment is not a mention, only a summary keeps it literal', () => {
    const activity = activityOfType(
      20,
      pullRequestCommented({ text: `cc <@U${FIXTURE.bot.id}>` })
    );

    const fields = buildInboundMessageFields(activity, pullRequestInput());

    expect(fields.isMention).toBe(false);
  });

  it('a file posted with a pull request comment reaches the webhook message as an attachment', () => {
    const activity = activityOfType(
      20,
      pullRequestCommentWithAttachment({ fileName: 'trace.log' })
    );

    const fields = buildInboundMessageFields(activity, pullRequestInput());

    expect(fields.attachments).toEqual([{ type: 'file', name: 'trace.log' }]);
    expect(fields.changes).toEqual([
      { field: 'attachment', newValue: 'trace.log', oldValue: '' },
    ]);
  });

  it('an attachment the changes name as removed is not offered as a file', () => {
    const activity = activityOfType(
      20,
      pullRequestCommented({
        changes: [
          { field: 'attachment', new_value: '', old_value: 'gone.log' },
        ],
      })
    );

    const fields = buildInboundMessageFields(activity, pullRequestInput());

    expect(fields.attachments).toEqual([]);
  });
});

describe('buildInboundMessageFields — type 19 without a comment id', () => {
  it('uses the :u: message id and empty text', () => {
    // Every measured pull-request update carried a changelog comment, so the
    // fixture builder always attaches one; the `:u:` path exists for a body
    // that does not.
    const payload = pullRequestUpdated();
    (payload['content'] as Record<string, unknown>)['comment'] = null;

    const fields = buildInboundMessageFields(
      activityOfType(19, payload),
      pullRequestInput()
    );

    expect(fields.messageId).toBe(
      `${FIXTURE.host}:pr:${FIXTURE.repositoryId}:${FIXTURE.pullRequestNumber}:u:2026-09-03T04:05:06Z`
    );
    expect(fields.text).toBe('');
  });
});

describe('buildInboundMessageFields — the subject the caller resolved', () => {
  it('builds every id from that subject, whatever kind it is', () => {
    const fields = buildInboundMessageFields(
      commented(issueCommented({ commentId: 7000001 })),
      pullRequestInput()
    );

    expect(fields.messageId).toBe(
      `${FIXTURE.host}:pr:${FIXTURE.repositoryId}:${FIXTURE.pullRequestNumber}:c7000001`
    );
  });

  it('maps attachments through the subject rather than assembling a URL itself', () => {
    const webhookAttachment = vi.fn(
      (attachment: { id: number; name: string; size: number }): Attachment => ({
        type: 'file',
        name: attachment.name,
        size: attachment.size,
        url: 'https://example.invalid/mapped-by-the-subject',
      })
    );
    const activity = created(
      issueCreated({
        attachments: [{ id: 9001, name: 'trace.log', size: 2048 }],
      })
    );

    const fields = buildInboundMessageFields(
      activity,
      input({
        subject: {
          ref: { kind: 'issue', issueId: FIXTURE.issueId },
          webhookAttachment,
        } as unknown as SubjectClient,
      })
    );

    expect(webhookAttachment).toHaveBeenCalledWith({
      id: 9001,
      name: 'trace.log',
      size: 2048,
    });
    expect(fields.attachments[0]?.url).toBe(
      'https://example.invalid/mapped-by-the-subject'
    );
  });
});

describe('mention regex negative cases (§5.4)', () => {
  it.each([['@Chatbot2'], ['foo@Chatbot'], ['<@U999>']])(
    '%s does not match the bot mention pattern',
    (text) => {
      const activity = commented(issueCommented({ text }));

      const fields = buildInboundMessageFields(activity, input());

      expect(fields.isMention).toBe(false);
    }
  );

  it.each([['@Chatbot'], ['@Chatbotさん'], ['(@Chatbot)']])(
    '%s matches the bot mention pattern',
    (text) => {
      const activity = commented(issueCommented({ text }));

      const fields = buildInboundMessageFields(activity, input());

      expect(fields.isMention).toBe(true);
    }
  );
});

describe('mention detection from notifications[] (§5.4 rule 6)', () => {
  it('a comment that named the bot only in the notification field is a mention', () => {
    const activity = commented(
      issueCommented({
        text: 'notify via the picker only',
        notifications: [{ user: FIXTURE.bot, reason: 2 }],
      })
    );

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.text).not.toContain('@');
    expect(fields.isMention).toBe(true);
  });

  it('a comment that notified only other users is not a mention', () => {
    const activity = commented(
      issueCommented({
        text: 'notify via the picker only',
        notifications: [
          { user: FIXTURE.alice, reason: 2 },
          { user: FIXTURE.bob, reason: 2 },
        ],
      })
    );

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.isMention).toBe(false);
  });

  it('a typed mention arrives together with the notification it created', () => {
    const activity = commented(
      issueCommented({
        text: `${RESOLVED_MENTION} mention in text`,
        notifications: [{ user: FIXTURE.bot, reason: 2 }],
      })
    );

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.isMention).toBe(true);
  });

  it.each([[1], [2], [10]])(
    'a notification naming the bot counts whatever its reason code (%i)',
    (reason) => {
      const activity = commented(
        issueCommented({
          text: 'no @ in this text',
          notifications: [{ user: FIXTURE.bot, reason }],
        })
      );

      const fields = buildInboundMessageFields(activity, input());

      expect(fields.isMention).toBe(true);
    }
  );

  it('an issue assigned to the bot is notified as well as reported in changes[]', () => {
    const activity = updated(
      assigneeChanged({
        assigneeName: FIXTURE.bot.name,
        notifications: [{ user: FIXTURE.bot, reason: 1 }],
      })
    );

    const fields = buildInboundMessageFields(activity, input());

    expect(fields.isMention).toBe(true);
    expect(fields.changes[0]).toMatchObject({ field: 'assigner' });
  });

  it('a multi-field pull-request update whose assignee change Backlog omitted is a mention through its notification', () => {
    const activity = activityOfType(
      19,
      pullRequestUpdated({
        changes: [
          {
            field: 'summary',
            old_value: 'Retry the deploy step',
            new_value: 'Retry the deploy step on a 5xx',
          },
        ],
        notifications: [{ user: FIXTURE.bot, reason: 10 }],
      })
    );

    const fields = buildInboundMessageFields(activity, pullRequestInput());

    expect(fields.changes.map((change) => change.field)).toEqual(['summary']);
    expect(fields.isMention).toBe(true);
  });

  it('a delivery that notified nobody is not a mention, comment or field-only update alike', () => {
    const comment = commented(
      issueCommented({ text: 'no @ here', notifications: [] })
    );
    const fieldOnlyUpdate = updated(descriptionEdited({ notifications: [] }));

    expect(buildInboundMessageFields(comment, input()).isMention).toBe(false);
    expect(buildInboundMessageFields(fieldOnlyUpdate, input()).isMention).toBe(
      false
    );
  });

  it('an activity body replayed from the activity API carries no notifications and falls back to the text', () => {
    const withoutText = commented(issueCommented({ text: 'no @ here' }));
    const withText = commented(
      issueCommented({ text: `${RESOLVED_MENTION} please look` })
    );

    expect(buildInboundMessageFields(withoutText, input()).isMention).toBe(
      false
    );
    expect(buildInboundMessageFields(withText, input()).isMention).toBe(true);
  });
});

describe('buildAuthor', () => {
  it('maps a Nulab-account user (no userId) to userName = display name', () => {
    const author = buildAuthor(FIXTURE.host, FIXTURE.bot.id, {
      id: FIXTURE.alice.id,
      name: FIXTURE.alice.name,
      userId: null,
    });

    expect(author).toEqual({
      userId: `${FIXTURE.host}:${FIXTURE.alice.id}`,
      userName: FIXTURE.alice.name,
      fullName: FIXTURE.alice.name,
      isMe: false,
      isBot: false,
    });
  });

  it('maps a user with a login id to userName = that id', () => {
    const author = buildAuthor(FIXTURE.host, FIXTURE.bot.id, {
      id: FIXTURE.alice.id,
      name: FIXTURE.alice.name,
      userId: FIXTURE.alice.userId,
    });

    expect(author.userName).toBe(FIXTURE.alice.userId);
  });

  it('the bot authoring a message is isMe and isBot both true', () => {
    const author = buildAuthor(FIXTURE.host, FIXTURE.bot.id, {
      id: FIXTURE.bot.id,
      name: FIXTURE.bot.name,
      userId: FIXTURE.bot.userId,
    });

    expect(author.isMe).toBe(true);
    expect(author.isBot).toBe(true);
  });
});

describe('one pull request comment seen twice (§6.6)', () => {
  const ATTACHMENT_ID = 4242;
  const ENDPOINT_REF = {
    projectId: FIXTURE.projectId,
    repositoryId: FIXTURE.repositoryId,
    number: FIXTURE.pullRequestNumber,
  };

  /** The comment `fetchMessages` reads back for the file the webhook announced. */
  function restComment(fileName: string): BacklogComment {
    return {
      id: 7000001,
      content: 'Trace attached.',
      changeLog: [
        {
          field: 'attachment',
          newValue: fileName,
          oldValue: '',
          attachmentInfo: null,
        },
      ],
      createdUser: {
        id: FIXTURE.alice.id,
        userId: FIXTURE.alice.userId,
        name: FIXTURE.alice.name,
        mailAddress: null,
      },
      created: new Date('2026-09-03T04:05:06Z'),
      updated: new Date('2026-09-03T04:05:06Z'),
      stars: [],
    };
  }

  it('the same pull request comment carries the same attachment through the webhook and through a read', async () => {
    const listPullRequestAttachments = vi.fn().mockResolvedValue([
      {
        id: ATTACHMENT_ID,
        name: 'trace.log',
        size: 12,
        created: new Date('2026-09-03T04:05:06Z'),
      },
    ]);
    const downloadPullRequestAttachment = vi.fn().mockResolvedValue({
      filename: 'trace.log',
      contentType: 'text/plain',
      data: Buffer.from('trace'),
    });
    const subject = createPullRequestSubjectClient(
      {
        listPullRequestAttachments,
        downloadPullRequestAttachment,
      } as unknown as BacklogApi,
      {
        kind: 'pullRequest',
        repositoryId: FIXTURE.repositoryId,
        number: FIXTURE.pullRequestNumber,
      },
      { host: FIXTURE.host, projectId: FIXTURE.projectId }
    );

    const fromWebhook = buildInboundMessageFields(
      activityOfType(
        20,
        pullRequestCommentWithAttachment({ fileName: 'trace.log' })
      ),
      input({ subject })
    ).attachments;
    const fromRead = subject.commentAttachments(restComment('trace.log'));

    expect(fromWebhook).toHaveLength(1);
    expect(
      fromWebhook.map(({ type, name, size, url }) => ({
        type,
        name,
        size,
        url,
      }))
    ).toEqual(
      fromRead.map(({ type, name, size, url }) => ({ type, name, size, url }))
    );

    await fromWebhook[0]?.fetchData?.();
    await fromRead[0]?.fetchData?.();

    expect(downloadPullRequestAttachment.mock.calls).toEqual([
      [ENDPOINT_REF, ATTACHMENT_ID],
      [ENDPOINT_REF, ATTACHMENT_ID],
    ]);
  });
});
