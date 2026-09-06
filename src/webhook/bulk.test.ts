import { Message as MessageCtor } from 'chat';
import { describe, expect, it } from 'vitest';

import { FIXTURE, issueMultiUpdated } from '../test/fixtures/webhooks';
import { buildBulkUpdateMessage, bulkUpdateTargets } from './bulk';
import { parseActivity } from './payload';

import type { IssueMultiUpdatedActivity } from './payload';
import type { BacklogBulkUpdatePayload } from '../types';

function bulkActivity(payload: object): IssueMultiUpdatedActivity {
  const result = parseActivity(14, payload);
  if (!('activity' in result) || result.activity.type !== 14) {
    throw new Error('fixture failed to validate as type 14');
  }
  return result.activity;
}

const input = {
  host: FIXTURE.host,
  botUserId: FIXTURE.bot.id,
  botUserName: FIXTURE.bot.name,
};

function messagesOf(payload: object) {
  const activity = bulkActivity(payload);
  return bulkUpdateTargets(activity).map((target) =>
    buildBulkUpdateMessage(
      activity,
      target,
      { ...input, payload: payload as BacklogBulkUpdatePayload },
      MessageCtor
    )
  );
}

describe('bulkUpdateTargets', () => {
  it('names one target per issue the bulk update touched', () => {
    expect(bulkUpdateTargets(bulkActivity(issueMultiUpdated()))).toEqual([
      { issueId: FIXTURE.issueId, commentId: 3101, text: '' },
      { issueId: FIXTURE.otherIssueId, commentId: 3102, text: '' },
    ]);
  });

  it('copies the bulk comment text to every issue that received it', () => {
    const targets = bulkUpdateTargets(
      bulkActivity(issueMultiUpdated({ text: 'Moving these to done.' }))
    );

    expect(targets.map((target) => target.text)).toEqual([
      'Moving these to done.',
      'Moving these to done.',
    ]);
  });

  it('names no target for a bulk update that touched no issue', () => {
    expect(
      bulkUpdateTargets(bulkActivity(issueMultiUpdated({ issues: [] })))
    ).toEqual([]);
  });

  it('takes the comment id from the issue, not from the batch', () => {
    const payload = issueMultiUpdated({ text: 'Moving these to done.' });
    const content = payload['content'] as Record<string, unknown>;

    // The batch-level `content.comment` has the same text and no id at all,
    // so a mapping that read it would give every issue the same message id.
    expect(content['comment']).not.toHaveProperty('id');
    const commentIds = bulkUpdateTargets(bulkActivity(payload)).map(
      (target) => target.commentId
    );
    expect(new Set(commentIds).size).toBe(commentIds.length);
  });
});

describe('buildBulkUpdateMessage', () => {
  it('gives each issue its own thread and its own comment message id', () => {
    const messages = messagesOf(issueMultiUpdated());

    expect(messages.map((message) => message.threadId)).toEqual([
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.issueId}`,
      `backlog:${FIXTURE.host}:${FIXTURE.projectId}:issue:${FIXTURE.otherIssueId}`,
    ]);
    expect(messages.map((message) => message.id)).toEqual([
      `${FIXTURE.host}:issue:${FIXTURE.issueId}:c3101`,
      `${FIXTURE.host}:issue:${FIXTURE.otherIssueId}:c3102`,
    ]);
  });

  it('falls back to the update message id when an issue got no comment', () => {
    const payload = issueMultiUpdated();
    const content = payload['content'] as Record<string, unknown>;
    const links = content['link'] as Record<string, unknown>[];
    delete links[0]!['comment'];

    const [message] = messagesOf(payload);

    expect(message?.id).toBe(
      `${FIXTURE.host}:issue:${FIXTURE.issueId}:u:2026-09-03T04:05:06Z`
    );
    expect(message?.text).toBe('');
  });

  it('repeats the batch changes on every message, values untranslated', () => {
    const messages = messagesOf(
      issueMultiUpdated({
        changes: [
          { field: 'status', new_value: '4' },
          { field: 'assigner', new_value: FIXTURE.alice.name },
        ],
      })
    );

    for (const message of messages) {
      // A status arrives as its **id** written as a string while an assignee
      // arrives as a display name; §3.5 leaves both as Backlog sent them.
      expect(message.raw?.changes).toEqual([
        { field: 'status', newValue: '4', oldValue: null },
        { field: 'assigner', newValue: FIXTURE.alice.name, oldValue: null },
      ]);
    }
  });

  it('carries the whole delivery as raw, not the one issue it is about', () => {
    const payload = issueMultiUpdated();

    const [message] = messagesOf(payload);

    expect(message?.raw?.kind).toBe('bulkUpdate');
    const raw = message?.raw as { issueId: number; payload: object };
    expect(raw.issueId).toBe(FIXTURE.issueId);
    expect(raw.payload).toEqual(payload);
  });

  it('mentions the bot when the bulk comment names it', () => {
    const messages = messagesOf(
      issueMultiUpdated({ text: `@${FIXTURE.bot.name} please review` })
    );

    expect(messages.every((message) => message.isMention)).toBe(true);
  });

  it('mentions the bot when the batch assigned every issue to it', () => {
    const messages = messagesOf(
      issueMultiUpdated({
        changes: [{ field: 'assigner', new_value: FIXTURE.bot.name }],
      })
    );

    expect(messages.every((message) => message.isMention)).toBe(true);
  });

  it('does not mention the bot for a status-only bulk update', () => {
    const messages = messagesOf(issueMultiUpdated());

    expect(messages.some((message) => message.isMention)).toBe(false);
  });

  it('attributes every message to the user who ran the bulk update', () => {
    const [message] = messagesOf(issueMultiUpdated());

    expect(message?.author).toMatchObject({
      userId: `${FIXTURE.host}:${FIXTURE.alice.id}`,
      userName: FIXTURE.alice.userId,
      fullName: FIXTURE.alice.name,
      isMe: false,
    });
  });

  it('carries no attachments, because a bulk update names no file', () => {
    const [message] = messagesOf(issueMultiUpdated());

    expect(message?.attachments).toEqual([]);
  });

  it('dates every message from the one delivery and marks none edited', () => {
    const messages = messagesOf(issueMultiUpdated());

    for (const message of messages) {
      expect(message.metadata?.dateSent).toEqual(
        new Date('2026-09-03T04:05:06Z')
      );
      expect(message.metadata?.edited).toBe(false);
    }
  });
});
