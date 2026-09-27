import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  assigneeChanged,
  attachmentAdded,
  bulkStatusChangedOnOneIssue,
  commentNotificationAdded,
  commentWithStatusChange,
  descriptionEdited,
  FIXTURE,
  gitPushed,
  issueCommented,
  issueCreated,
  issueDeleted,
  issueMultiUpdated,
  issueUpdatedWithoutComment,
  pullRequestAdded,
  pullRequestAssigneeChanged,
  pullRequestCommented,
  pullRequestCommentWithAttachment,
  pullRequestDeleted,
  pullRequestStatusChanged,
  pullRequestUpdated,
  RAW_MENTION,
  statusChanged,
} from './fixtures/webhooks';

const samples = readFileSync(
  fileURLToPath(new URL('../../sample-messages.md', import.meta.url)),
  'utf8'
);

/**
 * `sample-messages.md` is generated from the fixtures by
 * `scripts/generate-sample-messages.mts`. Regenerating it is a manual step, so
 * without this suite a fixture change would leave the published samples
 * describing payloads the adapter no longer parses.
 */
describe('published sample payloads', () => {
  it('matches the fixtures it was generated from', () => {
    for (const payload of [
      issueCreated({ assignee: FIXTURE.bot }),
      issueCommented(),
      statusChanged(),
      assigneeChanged(),
      descriptionEdited(),
      attachmentAdded(),
      commentWithStatusChange(),
      issueUpdatedWithoutComment(),
      issueDeleted(),
      issueMultiUpdated({ text: 'Moving these to done.' }),
      bulkStatusChangedOnOneIssue(),
      commentNotificationAdded(),
      issueCommented({
        text: 'Please take a look when you get a chance.',
        notifications: [{ user: FIXTURE.bot, reason: 2 }],
      }),
      pullRequestAdded({
        summary: `Retry the deploy step ${RAW_MENTION}`,
        assignee: FIXTURE.bot,
      }),
      pullRequestCommented(),
      pullRequestCommentWithAttachment(),
      pullRequestStatusChanged(),
      pullRequestAssigneeChanged(),
      pullRequestUpdated(),
      pullRequestDeleted(),
      gitPushed(),
    ]) {
      expect(samples).toContain(JSON.stringify(payload, null, 2));
    }
  });

  it('names no real space, person or project', () => {
    expect(samples).not.toMatch(/backlog\.(com|jp)\/api/);
    for (const forbidden of ['nulab', 'Nulab']) {
      expect(samples.includes(`${forbidden}.com/backlog`)).toBe(false);
    }
    expect(samples).toContain('example.backlog.com');
  });
});
