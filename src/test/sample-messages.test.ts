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
  statusChanged,
} from './fixtures/webhooks';

const SAMPLES_PATH = '../../sample-messages.md';

const rows: [string, string, string, unknown][] = [
  [
    '1',
    'Issue Created',
    '`<host>:issue:<issueId>:r` — text is `summary` + blank line + `description`',
    issueCreated({ assignee: FIXTURE.bot }),
  ],
  [
    '3',
    'Issue Commented',
    '`<host>:issue:<issueId>:c<commentId>` — a plain comment carries no changes',
    issueCommented(),
  ],
  [
    '3',
    'Issue Commented — recipients chosen in the notification field',
    'the text carries no `@` at all; `notifications[]` is the only record that the comment was addressed to the bot, and only a webhook carries it (`reason: 2`, Issue Commented)',
    issueCommented({
      text: 'Please take a look when you get a chance.',
      notifications: [{ user: FIXTURE.bot, reason: 2 }],
    }),
  ],
  [
    '2',
    'Issue Updated — status only',
    '`…:c<commentId>` with empty text; the change is in `changes[]`. `status` is one of the three issue fields — with `priority` and `resolution` — whose `new_value` is an id string; every other field arrives as a display name, a full text or a bare date (`.claude/rules/backlog-webhook-facts.md`)',
    statusChanged(),
  ],
  [
    '2',
    'Issue Updated — assignee',
    '`changes[].field` is `assigner` and `new_value` is a display name',
    assigneeChanged(),
  ],
  [
    '2',
    'Issue Updated — description',
    '`changes[]` carries both complete bodies',
    descriptionEdited(),
  ],
  [
    '2',
    'Issue Updated — attachment added',
    'a changelog comment; the change is visible only in the comment’s REST `changeLog`',
    attachmentAdded(),
  ],
  [
    '2',
    'Issue Updated — comment and status together',
    'one event, not two',
    commentWithStatusChange(),
  ],
  [
    '2',
    'Issue Updated — no comment id',
    '`<host>:issue:<issueId>:u:<created>`, the rare update-without-comment path',
    issueUpdatedWithoutComment(),
  ],
  [
    '4',
    'Issue Deleted',
    'dispatched as `processMessageDeleted` on the root message',
    issueDeleted(),
  ],
  [
    '14',
    'Issue Multi Updated',
    'one delivery, one message per `content.link[]` entry: the thread id comes from `link[].id` (a decimal **string** here) and the message id from `link[].comment.id`, the comment the batch really wrote on that issue. `content.comment` repeats the text with no id, `changes[]` describes the whole batch and carries no `old_value`, and a `status` change is a status **id**.',
    issueMultiUpdated({ text: 'Moving these to done.' }),
  ],
  [
    '14',
    'Issue Multi Updated — one issue',
    'a bulk update of a **single** issue is a type 14 too, with a one-entry `link[]`. The screen decides the activity type, not the number of issues: the same field changed on the issue’s own page arrives as a type 2. `notifications` is empty here because the batch changed no assignee; a batch that changed one carries a reason-1 entry per issue, none of which says which issue it belongs to.',
    bulkStatusChangedOnOneIssue(),
  ],
  [
    '17',
    'Comment Notification Added',
    '200 Ignored — `POST /issues/:id/comments/:commentId/notifications` added recipients to a comment that already exists, so `content.comment` is that **original** comment — no new comment exists and nothing changed — and the message id repeats one already dispatched. Choosing recipients while posting a comment emits a plain type 3 instead.',
    commentNotificationAdded(),
  ],
  [
    '18',
    'Pull Request Added',
    '`<host>:pr:<repositoryId>:<number>:r` — the thread id comes from `content.repository.id` and `content.number`, never from `content.id`, which addresses no endpoint. `content.assignee` is the account the pull request was opened for, and opening one for the bot is a mention; on a 19 or a 20 the same key is the standing assignee and means nothing.',
    pullRequestAdded({
      assignee: FIXTURE.bot,
    }),
  ],
  [
    '20',
    'Comment Added on Pull Request',
    '`…:c<commentId>` — pull-request comment ids come from a different sequence than issue comment ids',
    pullRequestCommented(),
  ],
  [
    '20',
    'Comment Added on Pull Request — with an attachment',
    '`changes[].field` is `attachment` and names the file with **no id**; the id is resolved lazily from `GET …/pullRequests/:number/attachments`',
    pullRequestCommentWithAttachment(),
  ],
  [
    '19',
    'Pull Request Updated — merged or closed',
    'merge (from the UI or by pushing the merge to the base branch) and close both arrive here, as a `status` change by id string (`1` Open, `2` Closed, `3` Merged). There is no separate merge or delete activity.',
    pullRequestStatusChanged(),
  ],
  [
    '19',
    'Pull Request Updated — assignee',
    '`changes[].field` is `assignee` — not the issue side’s `assigner`',
    pullRequestAssigneeChanged(),
  ],
  [
    '19',
    'Pull Request Updated — summary',
    'the `PATCH`’s own `comment` text arrives as `content.comment.content`',
    pullRequestUpdated(),
  ],
  [
    '21',
    'Pull Request Deleted (documented) / Merged (`backlog-js`)',
    '200 Ignored — never observed on a real space, and the two sources disagree on what it even means, so it is not registered and not dispatched',
    pullRequestDeleted(),
  ],
  [
    '12',
    'Git Pushed',
    '200 Ignored — a push is not a conversation, and the payload carries no pull-request reference',
    gitPushed(),
  ],
];

function renderSamples(): string {
  const out: string[] = [
    '# Sample Backlog webhook payloads',
    '',
    'One anonymised payload per activity type the adapter recognises, in the shape',
    'a real delivery carries. Generated from the fixtures in',
    '`src/test/fixtures/webhooks.ts` by `src/test/sample-messages.test.ts`;',
    'regenerate it with `pnpm exec vitest run src/test/sample-messages.test.ts -u`',
    'rather than editing it by hand. What Backlog delivers, and where a delivery',
    'differs from the activities API, is recorded with its measurements in',
    '`.claude/rules/backlog-webhook-facts.md` and',
    '`.claude/rules/backlog-pull-request-facts.md`.',
    '',
    'Vocabulary throughout: host `example.backlog.com`, bot `Chatbot` (id 999),',
    'users `Alice` (100) and `Bob` (101), project 500, issue 8001, repository 700',
    '(`example-repo`), pull request 12.',
    '',
  ];
  for (const [type, name, note, payload] of rows) {
    out.push(
      `## Type ${type} — ${name}`,
      '',
      note,
      '',
      '```json',
      JSON.stringify(payload, null, 2),
      '```',
      ''
    );
  }
  return `${out.join('\n')}\n`;
}

describe('published sample payloads', () => {
  it('are the fixtures, rendered', async () => {
    await expect(renderSamples()).toMatchFileSnapshot(SAMPLES_PATH);
  });

  it('name no real space, person or project', () => {
    const samples = readFileSync(
      fileURLToPath(new URL(SAMPLES_PATH, import.meta.url)),
      'utf8'
    );
    expect(samples).not.toMatch(/backlog\.(com|jp)\/api/);
    for (const forbidden of ['nulab', 'Nulab']) {
      expect(samples.includes(`${forbidden}.com/backlog`)).toBe(false);
    }
    expect(samples).toContain('example.backlog.com');
  });
});
