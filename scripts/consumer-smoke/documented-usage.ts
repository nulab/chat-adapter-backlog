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
  createInMemoryBacklogApi,
  MENTION_PROJECT_MEMBERS,
  mentionTeam,
  mentionUser,
  type Backlog,
  type BacklogAdapter,
  type BacklogChannelPostableExtras,
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

  await thread.post({ markdown: `${mentionUser(100)} please take a look` });
  await thread.post({
    markdown: `${mentionTeam(7)} ${MENTION_PROJECT_MEMBERS} release is out`,
  });
});

export function POST(
  request: Request,
  waitUntil: (task: Promise<unknown>) => void
): Promise<Response> {
  return chat.webhooks.backlog(request, { waitUntil });
}

export async function fileIssue(): Promise<void> {
  const issue: PostableMarkdown & BacklogChannelPostableExtras = {
    markdown: '# Deploy fails on staging\n\nReproduces on every push to main.',
    issueTypeId: 12,
    priorityId: 3,
    assigneeId: 100,
  };
  await chat.channel(`backlog:${HOST}:500`).post(issue);
}

export async function reachBacklogDirectly(): Promise<{
  botUserName: string;
}> {
  const api = backlog.api(HOST);
  await api.getIssue(8001);
  await api.listPullRequests(500, 700, { count: 20 });

  const client: Backlog = backlog.client(HOST);
  await client.getCustomFields(500);

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
    rateLimit: { maxWaitMs: 5_000 },
  });
}

export function createTestAdapter(): BacklogAdapter {
  const api = createInMemoryBacklogApi({
    projects: [
      {
        id: 500,
        projectKey: 'EXAMPLE',
        name: 'Example',
        textFormattingRule: 'markdown',
      },
    ],
    issueTypes: { 500: [{ id: 1, name: 'Task' }] },
    repositories: [
      { id: 700, projectId: 500, name: 'example-repo', description: '' },
    ],
  });

  return createBacklogAdapter({
    host: HOST,
    apiKey: 'test',
    botUserId: 999,
    botUserName: 'Chatbot',
    webhookSecret: 'test-webhook-secret',
    createApi: () => api,
  });
}
