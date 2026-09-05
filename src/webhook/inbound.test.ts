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
  statusChanged,
} from '../test/fixtures/webhooks';
import { buildAuthor, buildInboundMessageFields } from './inbound';
import { parseActivity } from './payload';

import type { BuildInboundMessageInput } from './inbound';
import type {
  IssueCreatedActivity,
  IssueUpdatedOrCommentedActivity,
} from './payload';
import type { SubjectClient } from '../subject/client';
import type { Attachment } from 'chat';

/**
 * Only `ref` and `webhookAttachment` are reachable from the webhook path, so
 * the stub implements those two and leaves the rest of `SubjectClient` to
 * `src/subject/*.test.ts`. `webhookAttachment` mirrors the issue client's
 * mapping so the assertions below stay about what the webhook path produces.
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

function created(payload: object): IssueCreatedActivity {
  const result = parseActivity(1, payload);
  if (!('activity' in result)) {
    throw new Error('fixture failed to validate as type 1');
  }
  return result.activity as IssueCreatedActivity;
}

function updated(payload: object): IssueUpdatedOrCommentedActivity {
  const result = parseActivity(2, payload);
  if (!('activity' in result)) {
    throw new Error('fixture failed to validate as type 2');
  }
  return result.activity as IssueUpdatedOrCommentedActivity;
}

function commented(payload: object): IssueUpdatedOrCommentedActivity {
  const result = parseActivity(3, payload);
  if (!('activity' in result)) {
    throw new Error('fixture failed to validate as type 3');
  }
  return result.activity as IssueUpdatedOrCommentedActivity;
}

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

describe('buildInboundMessageFields — the subject the caller resolved', () => {
  it('builds every id from that subject, whatever kind it is', () => {
    const pullRequestSubject = {
      ref: {
        kind: 'pullRequest',
        repositoryId: FIXTURE.repositoryId,
        number: FIXTURE.pullRequestNumber,
      },
      webhookAttachment: () => {
        throw new Error('no attachments in this fixture');
      },
    } as unknown as SubjectClient;

    const fields = buildInboundMessageFields(
      commented(issueCommented({ commentId: 7000001 })),
      input({ subject: pullRequestSubject })
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
