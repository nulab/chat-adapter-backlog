import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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
  issueDeleted,
  issueMultiUpdated,
  issueUpdatedWithoutComment,
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
  it('documents one payload per recognised activity type', () => {
    for (const heading of [
      '## Type 1 — Issue Created',
      '## Type 3 — Issue Commented',
      '## Type 2 — Issue Updated — status only',
      '## Type 2 — Issue Updated — assignee',
      '## Type 2 — Issue Updated — description',
      '## Type 2 — Issue Updated — attachment added',
      '## Type 2 — Issue Updated — comment and status together',
      '## Type 2 — Issue Updated — no comment id',
      '## Type 4 — Issue Deleted',
      '## Type 14 — Issue Multi Updated',
      '## Type 17 — Comment Notification Added',
    ]) {
      expect(samples).toContain(heading);
    }
  });

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
      commentNotificationAdded(),
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
