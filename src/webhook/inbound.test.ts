import { describe, expect, it, vi } from 'vitest';

import {
  assigneeChanged,
  attachmentAdded,
  commentWithStatusChange,
  descriptionEdited,
  FIXTURE,
  issueCommented,
  issueCreated,
  issueMultiUpdated,
  issueUpdatedWithoutComment,
  pullRequestAdded,
  pullRequestAssigneeChanged,
  pullRequestCommented,
  pullRequestCommentWithAttachment,
  pullRequestDescriptionEdited,
  pullRequestMultiFieldUpdated,
  pullRequestStatusChanged,
  pullRequestUpdated,
  RESOLVED_MENTION,
  statusChanged,
} from '../test/fixtures/webhooks';
import { comment, fileData, stubClient } from '../test/fixtures/rest';
import { createPullRequestSubjectClient } from '../subject/pull-request';
import { buildBulkUpdateMessage, buildInboundMessage } from './inbound';
import { parseDelivery } from './payload';

import type {
  BulkUpdateActivity,
  InboundContext,
  MessageActivity,
} from './inbound';
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

interface Input {
  subject: SubjectClient;
}

function input(overrides: Partial<Input> = {}): Input {
  return { subject: issueSubject(), ...overrides };
}

function pullRequestInput(overrides: Partial<Input> = {}): Input {
  return input({ subject: pullRequestSubject(), ...overrides });
}

const CONTEXT: InboundContext = {
  host: FIXTURE.host,
  botUserId: FIXTURE.bot.id,
  format: (text) => ({
    type: 'root',
    children: [
      { type: 'paragraph', children: [{ type: 'text', value: text }] },
    ],
  }),
};

function mapped(activity: MessageActivity, { subject }: Input) {
  const message = buildInboundMessage(activity, CONTEXT, subject);
  return {
    message,
    messageId: message.id,
    text: message.text,
    attachments: message.attachments,
    isMention: message.isMention === true,
    messageIsMention: message.isMention,
    changes: message.raw.changes,
  };
}

function parsed(payload: object) {
  const delivery = parseDelivery(payload);
  if (!delivery.ok || !('activity' in delivery)) {
    throw new Error(`fixture failed to parse: ${JSON.stringify(delivery)}`);
  }
  return delivery.activity;
}

function activityOfType(type: number, payload: object): MessageActivity {
  const activity = parsed(payload);
  if (activity.type !== type || activity.type === 4 || activity.type === 14) {
    throw new Error(`fixture is not a type ${type} message activity`);
  }
  return activity;
}

function bulkActivity(payload: object): BulkUpdateActivity {
  const activity = parsed(payload);
  if (activity.type !== 14) {
    throw new Error('fixture is not a bulk update');
  }
  return activity;
}

const created = (payload: object): MessageActivity =>
  activityOfType(1, payload);
const updated = (payload: object): MessageActivity =>
  activityOfType(2, payload);
const commented = (payload: object): MessageActivity =>
  activityOfType(3, payload);

describe('buildInboundMessage — type 1 Issue Created', () => {
  it('the message id is the issue root and text is summary + description', () => {
    const activity = created(
      issueCreated({ summary: 'Deploy fails', description: 'Repro steps' })
    );

    const fields = mapped(activity, input());

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

    const fields = mapped(activity, input());

    expect(fields.text).toBe('Deploy fails');
  });

  it('assigning the bot is a mention', () => {
    const activity = created(
      issueCreated({ assignee: { id: FIXTURE.bot.id, name: FIXTURE.bot.name } })
    );

    const fields = mapped(activity, input());

    expect(fields.isMention).toBe(true);
  });

  it('creating an issue assigned to someone else is not a mention', () => {
    const activity = created(
      issueCreated({
        assignee: { id: FIXTURE.alice.id, name: FIXTURE.alice.name },
      })
    );

    const fields = mapped(activity, input());

    expect(fields.isMention).toBe(false);
  });

  it.each([null, undefined])(
    'creating an issue with assignee %s is not a mention',
    (assignee) => {
      const payload = issueCreated(assignee === undefined ? {} : { assignee });

      expect(mapped(created(payload), input()).isMention).toBe(false);
    }
  );

  it('attachments carry an authenticated download URL, not a public link', () => {
    const activity = created(
      issueCreated({
        attachments: [{ id: 9001, name: 'trace.log', size: 2048 }],
      })
    );

    const fields = mapped(activity, input());

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

    const fields = mapped(
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

describe('buildInboundMessage — types 2 and 3, comment id present', () => {
  it('a plain comment (type 3) arrives with the comment message id and its text', () => {
    const activity = commented(
      issueCommented({ commentId: 3001, text: 'Any progress on this?' })
    );

    const fields = mapped(activity, input());

    expect(fields.messageId).toBe(
      `${FIXTURE.host}:issue:${FIXTURE.issueId}:c3001`
    );
    expect(fields.text).toBe('Any progress on this?');
    expect(fields.changes).toEqual([]);
  });

  it('a status-only change arrives as a comment message with empty text and a status change', () => {
    const activity = updated(statusChanged());

    const fields = mapped(activity, input());

    expect(fields.text).toBe('');
    expect(fields.changes).toEqual([
      { field: 'status', newValue: '4', oldValue: '3' },
    ]);
  });

  it('a comment posted together with a status change is one event carrying both', () => {
    const activity = updated(
      commentWithStatusChange({ text: 'Fixed in the latest build.' })
    );

    const fields = mapped(activity, input());

    expect(fields.text).toBe('Fixed in the latest build.');
    expect(fields.changes).toEqual([
      { field: 'status', newValue: '4', oldValue: '3' },
    ]);
  });

  it('a description edit carries both complete bodies in changes[] with empty text', () => {
    const activity = updated(
      descriptionEdited({ before: 'old body', after: 'new body' })
    );

    const fields = mapped(activity, input());

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

    const fields = mapped(activity, input());

    expect(fields.text).toBe('');
    expect(fields.changes).toEqual([]);
    expect(fields.attachments).toHaveLength(1);
    expect(fields.attachments[0]).toMatchObject({
      name: 'trace.log',
      size: 2048,
    });
  });
});

describe('buildInboundMessage — type 2 without a comment id', () => {
  it('uses the :u: message id and empty text', () => {
    const activity = updated(issueUpdatedWithoutComment());

    const fields = mapped(activity, input());

    expect(fields.messageId).toBe(
      `${FIXTURE.host}:issue:${FIXTURE.issueId}:u:2026-09-03T04:05:06Z`
    );
    expect(fields.text).toBe('');
  });
});

describe('buildInboundMessage — type 18 Pull Request Added', () => {
  it('the message id is the pull request root and text is summary + description', () => {
    const activity = activityOfType(
      18,
      pullRequestAdded({
        summary: 'Retry the deploy step on a 5xx',
        description: 'Fixes the flaky staging deploy.',
      })
    );

    const fields = mapped(activity, pullRequestInput());

    expect(fields.messageId).toBe(
      `${FIXTURE.host}:pr:${FIXTURE.repositoryId}:${FIXTURE.pullRequestNumber}:r`
    );
    expect(fields.text).toBe(
      'Retry the deploy step on a 5xx\n\nFixes the flaky staging deploy.'
    );
    expect(fields.changes).toEqual([]);
  });

  it('a linked issue is display data: it changes neither the ids nor the text', () => {
    const withLink = mapped(
      activityOfType(18, pullRequestAdded({ linkedIssue: true })),
      pullRequestInput()
    );
    const withoutLink = mapped(
      activityOfType(18, pullRequestAdded()),
      pullRequestInput()
    );

    expect(withLink.messageId).toBe(withoutLink.messageId);
    expect(withLink.text).toBe(withoutLink.text);
  });

  it('opening a pull request assigned to the bot is a mention', () => {
    const fields = mapped(
      activityOfType(18, pullRequestAdded({ assignee: FIXTURE.bot })),
      pullRequestInput()
    );

    expect(fields.isMention).toBe(true);
  });

  it('opening a pull request assigned to someone else is not a mention', () => {
    const fields = mapped(
      activityOfType(18, pullRequestAdded({ assignee: FIXTURE.alice })),
      pullRequestInput()
    );

    expect(fields.isMention).toBe(false);
  });

  it('opening a pull request assigned to nobody is not a mention', () => {
    const fields = mapped(
      activityOfType(18, pullRequestAdded({ assignee: null })),
      pullRequestInput()
    );

    expect(fields.isMention).toBe(false);
  });

  it('opening a pull request whose body carries no assignee key at all is not a mention', () => {
    const payload = pullRequestAdded();
    delete (payload['content'] as Record<string, unknown>)['assignee'];

    const fields = mapped(activityOfType(18, payload), pullRequestInput());

    expect(fields.isMention).toBe(false);
  });

  it('attachments a webhook body turns out to carry map through the subject', () => {
    const payload = pullRequestAdded();
    (payload['content'] as Record<string, unknown>)['attachments'] = [
      { id: 9002, name: 'trace.log', size: 2048 },
    ];

    const fields = mapped(activityOfType(18, payload), pullRequestInput());

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

describe('buildInboundMessage — types 19 and 20, comment id present', () => {
  it('a plain comment (type 20) arrives with the comment message id and its text', () => {
    const activity = activityOfType(
      20,
      pullRequestCommented({
        commentId: 7000001,
        text: 'Looks good, one question about the timeout.',
      })
    );

    const fields = mapped(activity, pullRequestInput());

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

    const fields = mapped(activity, pullRequestInput());

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

    const fields = mapped(activity, pullRequestInput());

    expect(fields.text).toBe('');
    expect(fields.changes).toEqual([
      { field: 'status', newValue: '3', oldValue: '1' },
    ]);
    expect(fields.isMention).toBe(false);
  });

  it('editing a field of a pull request the bot is assigned to is not a mention', () => {
    const fields = mapped(
      activityOfType(19, pullRequestUpdated({ assignee: FIXTURE.bot })),
      pullRequestInput()
    );

    expect(fields.changes.map((change) => change.field)).toEqual(['summary']);
    expect(fields.isMention).toBe(false);
  });

  it('a description edit carries its diff and mentions nobody', () => {
    const fields = mapped(
      activityOfType(
        19,
        pullRequestDescriptionEdited({ assignee: FIXTURE.bot })
      ),
      pullRequestInput()
    );

    expect(fields.changes.map((change) => change.field)).toEqual([
      'description',
    ]);
    expect(fields.isMention).toBe(false);
  });

  it('a multi-field update that changed no assignee and notified nobody is not a mention', () => {
    const fields = mapped(
      activityOfType(
        19,
        pullRequestMultiFieldUpdated({ assignee: FIXTURE.bot })
      ),
      pullRequestInput()
    );

    expect(fields.changes.map((change) => change.field)).toEqual([
      'summary',
      'description',
      'issue',
    ]);
    expect(fields.isMention).toBe(false);
  });

  it('a multi-field update naming no assignee change is a mention when the delivery notified the bot', () => {
    const fields = mapped(
      activityOfType(
        19,
        pullRequestMultiFieldUpdated({
          assignee: FIXTURE.bot,
          notifications: [{ user: FIXTURE.bot, reason: 10 }],
        })
      ),
      pullRequestInput()
    );

    expect(fields.changes.some((change) => change.field === 'assignee')).toBe(
      false
    );
    expect(fields.isMention).toBe(true);
  });

  it('a comment on a pull request the bot is assigned to is not a mention', () => {
    const fields = mapped(
      activityOfType(20, pullRequestCommented({ assignee: FIXTURE.bot })),
      pullRequestInput()
    );

    expect(fields.isMention).toBe(false);
  });

  it('merging a pull request the bot is assigned to is not a mention', () => {
    const fields = mapped(
      activityOfType(19, pullRequestStatusChanged({ assignee: FIXTURE.bot })),
      pullRequestInput()
    );

    expect(fields.changes.map((change) => change.field)).toEqual(['status']);
    expect(fields.isMention).toBe(false);
  });

  it('unassigning the bot from a pull request is not a mention', () => {
    const fields = mapped(
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

  it('an issue update carrying the standing bot assignee and no notification is not a mention', () => {
    // An issue webhook does carry the standing `content.assignee` on type 2
    // (measured 2026-09-06), but the issue fixtures model the key set the
    // adapter's issue tests were written against, so it is added by hand: an
    // issue and a pull request must answer the same operation the same way.
    const payload = descriptionEdited();
    (payload['content'] as Record<string, unknown>)['assignee'] = {
      id: FIXTURE.bot.id,
      name: FIXTURE.bot.name,
    };

    const fields = mapped(updated(payload), input());

    expect(fields.isMention).toBe(false);
  });

  it('a file posted with a pull request comment reaches the webhook message as an attachment', () => {
    const activity = activityOfType(
      20,
      pullRequestCommentWithAttachment({ fileName: 'trace.log' })
    );

    const fields = mapped(activity, pullRequestInput());

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

    const fields = mapped(activity, pullRequestInput());

    expect(fields.attachments).toEqual([]);
  });
});

describe('buildInboundMessage — type 19 without a comment id', () => {
  it('uses the :u: message id and empty text', () => {
    // Every measured pull-request update carried a changelog comment, so the
    // fixture builder always attaches one; the `:u:` path exists for a body
    // that does not.
    const payload = pullRequestUpdated();
    (payload['content'] as Record<string, unknown>)['comment'] = null;

    const fields = mapped(activityOfType(19, payload), pullRequestInput());

    expect(fields.messageId).toBe(
      `${FIXTURE.host}:pr:${FIXTURE.repositoryId}:${FIXTURE.pullRequestNumber}:u:2026-09-03T04:05:06Z`
    );
    expect(fields.text).toBe('');
  });
});

describe('buildInboundMessage — the subject the caller resolved', () => {
  it('builds every id from that subject, whatever kind it is', () => {
    const fields = mapped(
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

    const fields = mapped(
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

describe('mention detection from notifications[]', () => {
  it('a comment that named the bot only in the notification field is a mention', () => {
    const activity = commented(
      issueCommented({
        text: 'notify via the picker only',
        notifications: [{ user: FIXTURE.bot, reason: 2 }],
      })
    );

    const fields = mapped(activity, input());

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

    const fields = mapped(activity, input());

    expect(fields.isMention).toBe(false);
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

      const fields = mapped(activity, input());

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

    const fields = mapped(activity, input());

    expect(fields.isMention).toBe(true);
    expect(fields.changes[0]).toMatchObject({ field: 'assigner' });
  });

  it('a delivery that notified nobody is not a mention, comment or field-only update alike', () => {
    const comment = commented(
      issueCommented({ text: 'no @ here', notifications: [] })
    );
    const fieldOnlyUpdate = updated(descriptionEdited({ notifications: [] }));

    expect(mapped(comment, input()).isMention).toBe(false);
    expect(mapped(fieldOnlyUpdate, input()).isMention).toBe(false);
  });

  it('a message with no evidence leaves isMention unset so the core can match the typed name', () => {
    const comment = commented(
      issueCommented({ text: `@${FIXTURE.bot.name} hi`, notifications: [] })
    );

    expect(mapped(comment, input()).messageIsMention).toBeUndefined();
  });
});

describe('buildInboundMessage — author', () => {
  const author = (createdUser: {
    id: number;
    name: string;
    userId: string | null;
  }) =>
    mapped(commented(issueCommented({ createdUser })), input()).message.author;

  it('names a Nulab-account user, who has no login id, by display name', () => {
    expect(
      author({ id: FIXTURE.alice.id, name: FIXTURE.alice.name, userId: null })
    ).toEqual({
      userId: `${FIXTURE.host}:${FIXTURE.alice.id}`,
      userName: FIXTURE.alice.name,
      fullName: FIXTURE.alice.name,
      isMe: false,
      isBot: false,
    });
  });

  it('names a user with a login id by that id', () => {
    expect(author(FIXTURE.alice).userName).toBe(FIXTURE.alice.userId);
  });

  it('marks the bot as both me and a bot', () => {
    expect(author(FIXTURE.bot)).toMatchObject({ isMe: true, isBot: true });
  });
});

describe('buildBulkUpdateMessage', () => {
  function messages(payload: object) {
    const activity = bulkActivity(payload);
    return activity.content.link.map((link) =>
      buildBulkUpdateMessage(activity, link, CONTEXT)
    );
  }

  it('puts each issue in its own thread under the comment the batch wrote on it', () => {
    expect(
      messages(issueMultiUpdated()).map(({ threadId, id }) => ({
        threadId,
        id,
      }))
    ).toEqual([
      {
        threadId: `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.issueId}`,
        id: `${FIXTURE.host}:issue:${FIXTURE.issueId}:c3101`,
      },
      {
        threadId: `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.otherIssueId}`,
        id: `${FIXTURE.host}:issue:${FIXTURE.otherIssueId}:c3102`,
      },
    ]);
  });

  it('falls back to the update message id for an issue the batch wrote no comment on', () => {
    const payload = issueMultiUpdated();
    for (const link of (payload['content'] as { link: object[] }).link) {
      delete (link as Record<string, unknown>)['comment'];
    }

    expect(messages(payload)[0]?.id).toBe(
      `${FIXTURE.host}:issue:${FIXTURE.issueId}:u:2026-09-03T04:05:06Z`
    );
  });

  it('repeats the typed text and the batch changes on every message', () => {
    const built = messages(
      issueMultiUpdated({
        text: 'Moving these to done.',
        changes: [{ field: 'status', new_value: '4' }],
      })
    );

    for (const message of built) {
      expect(message.text).toBe('Moving these to done.');
      expect(message.raw.changes).toEqual([
        { field: 'status', newValue: '4', oldValue: null },
      ]);
    }
  });

  it('names the issue each message is about, beside the whole delivery', () => {
    const [first] = messages(issueMultiUpdated());

    expect(first?.raw).toMatchObject({
      kind: 'bulkUpdate',
      issueId: FIXTURE.issueId,
      payload: { type: 14, content: { tx_id: '9876' } },
    });
  });

  it('mentions the bot on every message when the delivery notified it, the notifications naming no issue', () => {
    const built = messages(
      issueMultiUpdated({ notifications: [{ user: FIXTURE.bot, reason: 1 }] })
    );

    expect(built.map((message) => message.isMention)).toEqual([true, true]);
  });

  it('does not mention the bot for a batch that neither names nor notifies it', () => {
    expect(
      messages(issueMultiUpdated()).map((message) => message.isMention)
    ).toEqual([undefined, undefined]);
  });
});

describe('one pull request comment seen twice', () => {
  const ATTACHMENT_ID = 4242;
  const ENDPOINT_REF = [
    FIXTURE.projectId,
    String(FIXTURE.repositoryId),
    FIXTURE.pullRequestNumber,
  ];

  /** The comment `fetchMessages` reads back for the file the webhook announced. */
  function restComment(fileName: string) {
    return comment({
      id: 7000001,
      content: 'Trace attached.',
      changeLog: [
        {
          field: 'attachment',
          newValue: fileName,
          originalValue: '',
          attachmentInfo: null,
        },
      ],
      created: '2026-09-03T04:05:06Z',
      updated: '2026-09-03T04:05:06Z',
    });
  }

  it('the same pull request comment carries the same attachment through the webhook and through a read', async () => {
    const getPullRequestAttachments = vi.fn().mockResolvedValue([
      {
        id: ATTACHMENT_ID,
        name: 'trace.log',
        size: 12,
        created: '2026-09-03T04:05:06Z',
      },
    ]);
    const getPullRequestAttachment = vi
      .fn()
      .mockImplementation(async () => fileData('trace'));
    const subject = createPullRequestSubjectClient(
      stubClient({ getPullRequestAttachments, getPullRequestAttachment }),
      {
        kind: 'pullRequest',
        repositoryId: FIXTURE.repositoryId,
        number: FIXTURE.pullRequestNumber,
      },
      { host: FIXTURE.host, projectId: FIXTURE.projectId }
    );

    const fromWebhook = mapped(
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

    expect(getPullRequestAttachment.mock.calls).toEqual([
      [...ENDPOINT_REF, ATTACHMENT_ID],
      [...ENDPOINT_REF, ATTACHMENT_ID],
    ]);
  });
});

/**
 * The shape a type 3 delivery had when a consumer reported the mention
 * `RangeError`: the stored text carries the resolved mention and
 * `notifications[]` names the bot as well (measured on a development space,
 * 2026-09-06).
 */
describe('a comment naming the bot in its text and its notifications[]', () => {
  it('is mapped whole — mention, text and message id — without throwing', () => {
    const activity = commented(
      issueCommented({
        commentId: 3001,
        text: `${RESOLVED_MENTION} mention in text`,
        notifications: [{ user: FIXTURE.bot, reason: 2 }],
      })
    );

    const fields = mapped(activity, input());

    expect(fields.isMention).toBe(true);
    expect(fields.text).toBe(`${RESOLVED_MENTION} mention in text`);
    expect(fields.changes).toEqual([]);
    expect(fields.messageId).toBe(
      `${FIXTURE.host}:issue:${FIXTURE.issueId}:c3001`
    );
  });
});
