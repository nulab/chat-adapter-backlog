/**
 * Regenerates `sample-messages.md` from the webhook fixtures.
 *
 * The samples are published documentation and the fixtures are what the suite
 * asserts against, so writing the samples by hand would let the two drift with
 * nothing to catch it. Run with:
 *
 *     pnpm exec node --experimental-strip-types scripts/generate-sample-messages.mts > sample-messages.md
 *
 * `sample-messages.test.ts` fails when the committed file no longer matches.
 */
import {
  assigneeChanged, attachmentAdded, commentNotificationAdded, commentWithStatusChange,
  descriptionEdited, FIXTURE, gitPushed, issueCommented, issueCreated, issueDeleted,
  issueMultiUpdated, issueUpdatedWithoutComment, pullRequestAdded,
  pullRequestAssigneeChanged, pullRequestCommented, pullRequestCommentWithAttachment,
  pullRequestDeleted, pullRequestStatusChanged, pullRequestUpdated, RAW_MENTION,
  statusChanged,
} from '../src/test/fixtures/webhooks.ts';

const rows: [string, string, string, unknown][] = [
  ['1', 'Issue Created', '`<host>:issue:<issueId>:r` — text is `summary` + blank line + `description`', issueCreated({ assignee: FIXTURE.bot })],
  ['3', 'Issue Commented', '`<host>:issue:<issueId>:c<commentId>` — a plain comment carries no changes', issueCommented()],
  ['2', 'Issue Updated — status only', '`…:c<commentId>` with empty text; the change is in `changes[]`', statusChanged()],
  ['2', 'Issue Updated — assignee', '`changes[].field` is `assigner` and `new_value` is a display name', assigneeChanged()],
  ['2', 'Issue Updated — description', '`changes[]` carries both complete bodies', descriptionEdited()],
  ['2', 'Issue Updated — attachment added', 'a changelog comment; the change is visible only in the comment’s REST `changeLog`', attachmentAdded()],
  ['2', 'Issue Updated — comment and status together', 'one event, not two', commentWithStatusChange()],
  ['2', 'Issue Updated — no comment id', '`<host>:issue:<issueId>:u:<created>`, the rare update-without-comment path', issueUpdatedWithoutComment()],
  ['4', 'Issue Deleted', 'dispatched as `processMessageDeleted` on the root message', issueDeleted()],
  ['14', 'Issue Multi Updated', '200 Ignored — no per-issue comment exists', issueMultiUpdated()],
  ['17', 'Comment Notification Added', '200 Ignored — repeats an existing comment', commentNotificationAdded()],
  ['18', 'Pull Request Added', '`<host>:pr:<repositoryId>:<number>:r` — the thread id comes from `content.repository.id` and `content.number`, never from `content.id`, which addresses no endpoint. The `summary` keeps mention notation raw while a description or comment carries it rewritten.', pullRequestAdded({ summary: `Retry the deploy step ${RAW_MENTION}` })],
  ['20', 'Comment Added on Pull Request', '`…:c<commentId>` — pull-request comment ids come from a different sequence than issue comment ids', pullRequestCommented()],
  ['20', 'Comment Added on Pull Request — with an attachment', '`changes[].field` is `attachment` and names the file with **no id**; the id is resolved lazily from `GET …/pullRequests/:number/attachments`', pullRequestCommentWithAttachment()],
  ['19', 'Pull Request Updated — merged or closed', 'merge (from the UI or by pushing the merge to the base branch) and close both arrive here, as a `status` change by id string (`1` Open, `2` Closed, `3` Merged). There is no separate merge or delete activity.', pullRequestStatusChanged()],
  ['19', 'Pull Request Updated — assignee', '`changes[].field` is `assignee` — not the issue side’s `assigner`', pullRequestAssigneeChanged()],
  ['19', 'Pull Request Updated — summary', 'the `PATCH`’s own `comment` text arrives as `content.comment.content`', pullRequestUpdated()],
  ['21', 'Pull Request Deleted (documented) / Merged (`backlog-js`)', '200 Ignored — never observed on a real space, and the two sources disagree on what it even means, so it is not registered and not dispatched', pullRequestDeleted()],
  ['12', 'Git Pushed', '200 Ignored — a push is not a conversation, and the payload carries no pull-request reference', gitPushed()],
];

const out: string[] = [
  '# Sample Backlog webhook payloads',
  '',
  'One anonymised payload per activity type the adapter recognises, in the shape',
  'a real delivery carries. Generated from the fixtures in',
  '`src/test/fixtures/webhooks.ts`, so this file and the test suite cannot',
  'disagree; regenerate it rather than editing it by hand.',
  '',
  'The body is one Activity object as returned by',
  '[Get Recent Updates](https://developer.nulab.com/docs/backlog/api/2/get-recent-updates/).',
  'Backlog publishes no dedicated webhook-payload page, and measured payloads match',
  'the activity shape field for field. Vocabulary throughout: host',
  '`example.backlog.com`, bot `Chatbot` (id 999), users `Alice` (100) and `Bob`',
  '(101), project 500, issue 8001, repository 700 (`example-repo`), pull request',
  '12.',
  '',
  'Three properties of these payloads decide how a handler must read them:',
  '',
  '- **Nothing in the body identifies the space.** `project.projectKey` and the',
  '  numeric ids are not unique across Backlog spaces, so the host comes from the',
  '  request URL the webhook was registered with, never from the payload.',
  '- **Backlog attaches a changelog comment to every field update.** A set',
  '  `content.comment.id` therefore does not mean "no field change" — handlers key',
  '  on `content.changes[]`.',
  '- **`notifications` is always empty** (emptied by Backlog in 2022), so who was',
  '  notified cannot be read from a delivery.',
  '',
  'The pull-request payloads below are the **activity API** form, measured on a',
  'real space on 2026-09-06. The webhook form of types 18–20 is unmeasured; the',
  'adapter therefore requires only `content.id`, `content.number` and',
  '`content.repository.id`, and tolerates any key it does not name.',
  '',
];

for (const [type, name, note, payload] of rows) {
  out.push(`## Type ${type} — ${name}`, '', note, '', '```json', JSON.stringify(payload, null, 2), '```', '');
}
process.stdout.write(`${out.join('\n')}\n`);
