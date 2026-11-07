import { createMemoryState } from '@chat-adapter/state-memory';
import {
  createBacklogAdapter,
  decodeUserId,
} from '@nulab/chat-adapter-backlog';
import { Chat } from 'chat';
import type { Message, Thread } from 'chat';
import { z } from 'zod';

import {
  alreadyHandedBack,
  closedIssueId,
  handBackComment,
  requiredFieldState,
} from './done-gate.js';

/**
 * Read and validated at module load, so a typo fails the first cold start
 * instead of sending `NaN` to Backlog the first time somebody closes an issue.
 */
const env = z
  .object({
    DONE_STATUS_ID: z.coerce.number().int().positive().default(4),
    REQUIRED_CUSTOM_FIELD_ID: z.coerce.number().int().positive(),
  })
  .parse(process.env);

/**
 * How many of the issue's newest comments are read to see whether the bot has
 * already commented. A redelivery follows the original closely, so the bot's
 * own comment is within the last few; reading more would spend the issue's
 * read budget on a case that does not arise.
 */
const RECENT_COMMENTS = 5;

const backlog = createBacklogAdapter();

export const chat = new Chat({
  adapters: { backlog },
  state: createMemoryState(),
  userName: 'custom-field-done-gate',
});

const log = chat.getLogger('done-gate');

/**
 * A match-everything pattern rather than one that means something:
 * `onNewMessage` takes no handler-only form, and this bot decides from
 * `message.raw` — the delivery's `changes[]` — not from the text. A status
 * change carries no text worth matching, and an empty text has to reach the
 * handler too.
 */
chat.onNewMessage(/[\s\S]*/, gateOnClose);

/**
 * The same handler again, because the core dispatches a message to exactly one
 * of its handler lists: a delivery flagged as a mention goes to the mention
 * handlers and returns before any pattern is tested, even when no mention
 * handler is registered. Closing an issue with a comment that happens to
 * address the bot is a real way to reach that branch, and without this line
 * that close would be the one that slips through the gate.
 */
chat.onNewMention(gateOnClose);

async function gateOnClose(thread: Thread, message: Message): Promise<void> {
  const issueId = closedIssueId(message.raw, env.DONE_STATUS_ID);
  if (issueId === null) {
    return;
  }

  // The bot never closes an issue, but it does comment on one, and a
  // redelivery of its own activity must not start an argument with itself.
  if (message.author.isMe) {
    return;
  }

  // Not a client of our own: the adapter's keeps the 429 retry and error
  // classes.
  const issue = await backlog.client().getIssue(issueId);
  const field = requiredFieldState(
    issue.customFields,
    env.REQUIRED_CUSTOM_FIELD_ID
  );

  if (field.state === 'absent') {
    log.warn(
      `REQUIRED_CUSTOM_FIELD_ID=${env.REQUIRED_CUSTOM_FIELD_ID} matches no custom field on ${issue.issueKey}; nothing to check.`
    );
    return;
  }

  if (field.state === 'filled') {
    log.info(`${issue.issueKey} was closed with ${field.name} filled in.`);
    return;
  }

  const closedBy = decodeUserId(message.author.userId).userId;
  const comment = handBackComment(closedBy, field.name);

  if (alreadyHandedBack(await newestComments(thread), comment)) {
    return;
  }

  await thread.post(comment);
  await backlog.client().patchIssue(issueId, { assigneeId: closedBy });
}

/**
 * `thread.messages` iterates newest first and pages lazily, so breaking out
 * early costs one page instead of the whole issue's history.
 */
async function newestComments(thread: Thread): Promise<Message[]> {
  const newest: Message[] = [];
  for await (const message of thread.messages) {
    newest.push(message);
    if (newest.length >= RECENT_COMMENTS) {
      break;
    }
  }
  return newest;
}
