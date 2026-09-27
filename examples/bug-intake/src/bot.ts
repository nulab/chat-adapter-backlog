import { createMemoryState } from '@chat-adapter/state-memory';
import {
  createBacklogAdapter,
  decodeThreadId,
  mentionUser,
} from '@nulab/chat-adapter-backlog';
import { generateText } from 'ai';
import { Chat, type Thread } from 'chat';
import { z } from 'zod';

import {
  buildIntakePrompt,
  handOffComment,
  intakeComment,
  isIssueRoot,
  movedToDoneStatus,
  writeIntakeBody,
  type IntakePrompt,
} from './intake.js';

/**
 * Read and validated at module load. `INTAKE_CONTACT_USER_ID` especially: a
 * `NaN` reaching Backlog's `assigneeId` is a request that fails with the issue
 * already closed and nobody looking at it.
 */
const env = z
  .object({
    // Lower-cased because the adapter keys its installations by the lower-cased
    // host, and `client()` below looks one up by this string.
    BACKLOG_HOST: z
      .string()
      .min(1)
      .transform((host) => host.toLowerCase()),
    BUG_ISSUE_TYPE_NAME: z.string().min(1).default('Bug'),
    DONE_STATUS_ID: z.coerce.number().int().positive().default(4),
    INTAKE_CONTACT_USER_ID: z.coerce.number().int().positive(),
    AI_MODEL: z.string().min(1).default('openai/gpt-5.4-nano'),
  })
  .parse(process.env);

const backlog = createBacklogAdapter();

export const chat = new Chat({
  userName: backlog.userName,
  adapters: { backlog },
  state: createMemoryState(),
});

const logger = chat.getLogger('bug-intake');

chat.onNewMessage(/[\s\S]*/, async (thread, message) => {
  // Checked before the read below rather than relying on the core's own
  // self-message suppression: the bot comments on every issue it triages, and
  // each of those comments would otherwise cost a Get Issue to find out it is
  // not interesting.
  if (message.author.isMe) {
    return;
  }

  const { subject } = decodeThreadId(thread.id);
  if (subject.kind !== 'issue') {
    return;
  }

  // Both questions are answered from the message alone, and they are asked
  // before the read below so that an ordinary comment on a bug — the most
  // frequent event on a busy issue — costs no API call at all.
  const isNewReport = isIssueRoot(message.id);
  const wasClosed = movedToDoneStatus(message.raw, env.DONE_STATUS_ID);
  if (!isNewReport && !wasClosed) {
    return;
  }

  // One read serves both paths: the issue type they both gate on, the summary
  // and description the prompt needs, the reporter to address, and the
  // assignee the hand-off compares. A type-1 or type-2 webhook carries all of
  // it in `content`, but a type-14 fan-out carries no issue snapshot at all,
  // so reading the issue is the route that is uniform across the three
  // activity types. It goes through the client the adapter hands out, so it is
  // counted in the adapter's own rate-limit budget.
  const issue = await backlog
    .client(env.BACKLOG_HOST)
    .getIssue(subject.issueId);
  if (issue.issueType.name !== env.BUG_ISSUE_TYPE_NAME) {
    return;
  }

  if (isNewReport) {
    const body = await writeIntakeBody(
      buildIntakePrompt({
        summary: issue.summary,
        description: issue.description,
      }),
      generate,
      (reason) => {
        logger.error('the intake comment fell back to the fixed text', {
          reason,
        });
      }
    );
    await thread.post({
      markdown: intakeComment(mentionUser(issue.createdUser.id), body),
    });
    return;
  }

  await handOff(thread, issue.id, issue.assignee?.id, message.author.fullName);
});

async function generate(prompt: IntakePrompt): Promise<string> {
  const result = await generateText({
    model: env.AI_MODEL,
    system: prompt.system,
    prompt: prompt.prompt,
  });
  return result.text;
}

async function handOff(
  thread: Thread,
  issueId: number,
  currentAssigneeId: number | undefined,
  closedByName: string
): Promise<void> {
  if (currentAssigneeId !== env.INTAKE_CONTACT_USER_ID) {
    await backlog
      .client(env.BACKLOG_HOST)
      .patchIssue(issueId, { assigneeId: env.INTAKE_CONTACT_USER_ID });
  }

  await thread.post({
    markdown: handOffComment(
      mentionUser(env.INTAKE_CONTACT_USER_ID),
      closedByName
    ),
  });
}
