/**
 * The usage README.md documents, compiled by the ci.yml consumer job with
 * `tsc --noEmit` against the installed tarball. Never run: every value here
 * exists for the compiler, which is why nothing below is awaited at the top
 * level or needs a credential.
 *
 * What it writes out is the shapes README.md documents, and README.md's
 * samples mirror it once #104 is on main. They are not extracted from it
 * automatically, so a README sample that changes shape changes here in the
 * same commit — otherwise the README can document a call that no longer
 * compiles, which is what the 2026-09-23 release review found by hand.
 */
import { createMemoryState } from '@chat-adapter/state-memory';
import {
  createBacklogAdapter,
  decodeMessageId,
  decodeUserId,
  type Backlog,
  type BacklogAdapter,
  type BacklogPostableExtras,
} from '@nulab/chat-adapter-backlog';
import { Chat, type PostableMarkdown } from 'chat';

const HOST = 'example.backlog.com';

const backlog = createBacklogAdapter();

const chat = new Chat({
  userName: backlog.userName,
  adapters: { backlog },
  state: createMemoryState(),
});

chat.onNewMention(async (thread, message) => {
  const subject = await message.subject;
  // chat types `subject.type` as `string`, so this literal compiles whatever
  // it says; src/subject/pull-request.test.ts and src/reads.test.ts pin it.
  if (subject?.type === 'pull_request') {
    await thread.post({ markdown: `Reviewing ${subject.title}` });
    return;
  }

  // A named type rather than an object literal passed inline: `post` is typed
  // by Chat SDK, which knows nothing of `notifiedUserId`, so a literal would
  // fail its excess-property check.
  const reply: PostableMarkdown & BacklogPostableExtras = {
    markdown: `Saw: ${message.text}`,
    notifiedUserId: [100],
  };
  await thread.post(reply);

  await thread.post({ markdown: '<@U100> please take a look' });
  await thread.post({ markdown: '<@T7> <@project> release is out' });

  const { part } = decodeMessageId(message.id);
  if (part === 'root') {
    const { userId } = decodeUserId(message.author.userId);
    await thread.post({ markdown: `Thanks for the report, <@U${userId}>` });
  }
});

export function POST(
  request: Request,
  waitUntil: (task: Promise<unknown>) => void
): Promise<Response> {
  return chat.webhooks.backlog(request, { waitUntil });
}

export async function reachBacklogDirectly(): Promise<{
  botUserName: string;
}> {
  const client: Backlog = backlog.client(HOST);
  await client.getRateLimit();
  await client.getCustomFields(500);
  await client.getPullRequests(500, '700', { count: 20 });
  await client.patchIssue(8001, { assigneeId: 100 });

  return { botUserName: backlog.botUserName(HOST) };
}

declare function readKey(space: string): Promise<string>;

export function createMultiSpaceAdapter(): BacklogAdapter {
  return createBacklogAdapter({
    installations: [
      {
        host: 'one.backlog.com',
        apiKey: () => readKey('one'),
        botUserId: 999,
        botUserName: 'Chatbot',
        webhookSecret: 'one-webhook-secret-value',
      },
      {
        host: 'two.backlog.jp',
        apiKey: () => readKey('two'),
        botUserId: 42,
        botUserName: 'Helperbot',
        webhookSecret: 'two-webhook-secret-value',
      },
    ],
  });
}

export function botNameOnSecondSpace(): string {
  return createMultiSpaceAdapter().botUserName('two.backlog.jp');
}
