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
  descriptionEdited, FIXTURE, issueCommented, issueCreated, issueDeleted,
  issueMultiUpdated, issueUpdatedWithoutComment, statusChanged,
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
  '(101), project 500, issue 8001.',
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
];

for (const [type, name, note, payload] of rows) {
  out.push(`## Type ${type} — ${name}`, '', note, '', '```json', JSON.stringify(payload, null, 2), '```', '');
}
process.stdout.write(`${out.join('\n')}\n`);
