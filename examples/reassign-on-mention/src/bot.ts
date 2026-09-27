import { createMemoryState } from '@chat-adapter/state-memory';
import {
  createBacklogAdapter,
  decodeThreadId,
} from '@nulab/chat-adapter-backlog';
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
 * mention. `createBacklogAdapter()` reads the same environment itself; these
 * three are the ones this file also needs by name.
 */
const env = z
  .object({
    // Lower-cased because the adapter keys its installations by the lower-cased
    // host, and `client()` below looks one up by this string.
    BACKLOG_HOST: z
      .string()
      .min(1)
      .transform((host) => host.toLowerCase()),
    BACKLOG_BOT_USER_ID: z.coerce.number().int().positive(),
    BACKLOG_BOT_USER_NAME: z.string().min(1),
  })
  .parse(process.env);

const backlog = createBacklogAdapter();

export const chat = new Chat({
  adapters: { backlog },
  state: createMemoryState(),
  userName: env.BACKLOG_BOT_USER_NAME,
});

chat.onNewMention(async (thread, message) => {
  if (message.author.isMe) {
    return;
  }

  // The thread id already says which kind of subject this is, so the pull
  // request is declined without the fetch `message.subject` would cost.
  const { subject } = decodeThreadId(message.threadId);
  if (subject.kind === 'pullRequest') {
    await thread.post(PULL_REQUEST_COMMENT);
    return;
  }

  const decision = chooseAssignee(
    readDelivery(message.raw),
    env.BACKLOG_BOT_USER_ID
  );

  if (decision.kind === 'reassign') {
    // The adapter's port has no issue-update member, so this goes through the
    // `backlog-js` client it hands out — the same one it makes its own calls
    // with, so this request is counted in the same rate-limit budget and its
    // failures arrive as the same error classes.
    await backlog
      .client(env.BACKLOG_HOST)
      .patchIssue(subject.issueId, { assigneeId: decision.to.id });
  }

  await thread.post(reassignmentComment(decision));
});
