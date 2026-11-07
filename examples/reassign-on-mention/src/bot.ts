import { createMemoryState } from '@chat-adapter/state-memory';
import { createBacklogAdapter } from '@nulab/chat-adapter-backlog';
import { Chat } from 'chat';
import { z } from 'zod';

import {
  chooseAssignee,
  PULL_REQUEST_COMMENT,
  readDelivery,
  reassignmentComment,
} from './reassign.js';

/**
 * Read and validated at module load, so a missing variable or a non-numeric id
 * fails the first cold start instead of sending `NaN` to Backlog on the first
 * mention. `createBacklogAdapter()` reads the same environment itself; the bot
 * id is the one this file also needs by name.
 */
const env = z
  .object({
    BACKLOG_BOT_USER_ID: z.coerce.number().int().positive(),
  })
  .parse(process.env);

const backlog = createBacklogAdapter();

export const chat = new Chat({
  adapters: { backlog },
  state: createMemoryState(),
  userName: 'reassign-on-mention',
});

chat.onNewMention(async (thread, message) => {
  if (message.author.isMe) {
    return;
  }

  // The thread id already says which kind of subject this is, so the pull
  // request is declined without the fetch `message.subject` would cost.
  const { subject } = backlog.decodeThreadId(message.threadId);
  if (subject.kind === 'pullRequest') {
    await thread.post(PULL_REQUEST_COMMENT);
    return;
  }

  const decision = chooseAssignee(
    readDelivery(message.raw),
    env.BACKLOG_BOT_USER_ID
  );

  if (decision.kind === 'reassign') {
    // Not a client of our own: the adapter's keeps the 429 retry and error
    // classes.
    await backlog
      .client()
      .patchIssue(subject.issueId, { assigneeId: decision.to.id });
  }

  await thread.post(reassignmentComment(decision));
});
