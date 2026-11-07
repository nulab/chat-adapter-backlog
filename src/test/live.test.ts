import { AdapterError } from '@chat-adapter/shared';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { createBacklogAdapter } from '../index';
import { encodeChannelId, encodeMessageId, encodeThreadId } from '../ids';

import type {
  BacklogRawComment,
  BacklogRawMessage,
  BacklogSubjectRef,
} from '../types';

/**
 * Opt-in suite against a real Backlog space.
 *
 * `pnpm test` must pass with no credentials and no network, so each section
 * skips itself unless its variables are set. It is not part of CI.
 *
 *   BACKLOG_HOST=example.backlog.com \
 *   BACKLOG_API_KEY=... \
 *   BACKLOG_BOT_USER_ID=999 \
 *   BACKLOG_LIVE_ISSUE_ID=8001 \
 *   BACKLOG_LIVE_PULL_REQUEST=700:12 \
 *   pnpm test
 *
 * The budget is deliberate. Backlog allows writes on the order of 150
 * requests per user per minute
 * (https://developer.nulab.com/docs/backlog/rate-limit/), so a chatty live
 * suite earns an HTTP 429 that looks like a product bug. The issue section
 * spends at most seven write calls, the pull-request section at most six,
 * both run strictly sequentially, and neither creates an issue or touches
 * notifications.
 *
 * Both sections leave comments behind, so both variables must name scratch
 * subjects. The issue section deletes its plain comment, but a comment that
 * added an attachment cannot be deleted: Backlog keeps it, and the file with
 * it, so the adapter refuses (`.claude/rules/backlog-api-facts.md`). The
 * pull-request section deletes nothing, because there is no delete endpoint
 * for a pull request or for one of its comments
 * (`.claude/rules/backlog-pull-request-facts.md`). Each run names its files
 * uniquely, because Backlog renames a file whose name the issue already has.
 *
 * `BACKLOG_LIVE_PULL_REQUEST` carries `<repositoryId>:<number>`, the two
 * coordinates the thread-id grammar writes as `pr:<repositoryId>:<number>`.
 * A thread id also needs the project, which the variable does not carry and
 * no endpoint derives — so it comes from `BACKLOG_LIVE_ISSUE_ID`'s issue, and
 * the scratch pull request has to live in that issue's project.
 */

const host = process.env['BACKLOG_HOST'];
const apiKey = process.env['BACKLOG_API_KEY'];
const liveIssueId = process.env['BACKLOG_LIVE_ISSUE_ID'];
const livePullRequest = process.env['BACKLOG_LIVE_PULL_REQUEST'];

const configured = Boolean(
  host && apiKey && liveIssueId && process.env['BACKLOG_BOT_USER_ID']
);

function parsePullRequestCoordinates(
  value: string | undefined
): { repositoryId: number; number: number } | null {
  const [, repositoryId, number] =
    /^([1-9]\d*):([1-9]\d*)$/.exec(value ?? '') ?? [];
  if (repositoryId === undefined || number === undefined) {
    return null;
  }
  return { repositoryId: Number(repositoryId), number: Number(number) };
}

const pullRequestCoordinates = parsePullRequestCoordinates(livePullRequest);
const pullRequestConfigured = configured && pullRequestCoordinates !== null;

// `configured` gates every test, so these are set by the time one runs.
const spaceHost = host as string;
const issueId = Number(liveIssueId);

function createLiveAdapter() {
  return createBacklogAdapter({
    host: spaceHost,
    apiKey: apiKey as string,
    webhookSecret: 'unused-by-this-suite',
  });
}

async function projectIdOfLiveIssue(): Promise<number> {
  const issue = await createLiveAdapter().client().getIssue(issueId);
  return issue.projectId;
}

function commentOf(raw: BacklogRawMessage): BacklogRawComment {
  if (raw.kind !== 'comment') {
    throw new Error(`expected a comment raw message, got ${raw.kind}`);
  }
  return raw.comment;
}

describe.skipIf(!configured).sequential('a real Backlog space', () => {
  const subject: BacklogSubjectRef = { kind: 'issue', issueId };
  let adapter: ReturnType<typeof createLiveAdapter>;
  let threadId: string;
  let channelId: string;

  beforeAll(async () => {
    adapter = createLiveAdapter();
    const projectId = await projectIdOfLiveIssue();
    threadId = encodeThreadId({ host: spaceHost, projectId, subject });
    channelId = encodeChannelId({ host: spaceHost, projectId });
  });

  it('describes the issue named by BACKLOG_LIVE_ISSUE_ID as a thread', async () => {
    const thread = await adapter.fetchThread(threadId);

    expect(thread.metadata).toMatchObject({ kind: 'issue', issueId });
    expect(thread.metadata['issueKey']).toMatch(/^[A-Z0-9_]+-\d+$/);
  });

  it("describes the issue's project as a channel", async () => {
    const channel = await adapter.fetchChannelInfo(channelId);

    expect(channel.metadata['projectKey']).toMatch(/^[A-Z0-9_]+$/);
  });

  it('posts, reads, edits, stars, unstars and deletes one comment', async () => {
    const posted = await adapter.postMessage(threadId, {
      markdown:
        'chat-adapter-backlog live suite: this comment is deleted below.',
    });
    const commentId = commentOf(posted.raw).id;

    const page = await adapter.fetchMessages(threadId, { limit: 5 });
    expect(page.messages.map((message) => message.id)).toContain(posted.id);

    const edited = await adapter.editMessage(threadId, posted.id, {
      markdown: 'chat-adapter-backlog live suite: edited, and deleted below.',
    });
    const editedComment = commentOf(edited.raw);
    expect(editedComment.content).toContain('edited');
    expect(Date.parse(editedComment.updated)).toBeGreaterThanOrEqual(
      Date.parse(editedComment.created)
    );

    const client = adapter.client();
    await adapter.addReaction(threadId, posted.id, 'star');
    const starred = await client.getIssueComment(issueId, commentId);
    expect(starred.stars.length).toBeGreaterThan(0);

    await adapter.removeReaction(threadId, posted.id, 'star');
    const unstarred = await client.getIssueComment(issueId, commentId);
    expect(unstarred.stars).toHaveLength(0);

    await adapter.deleteMessage(threadId, posted.id);
  });

  it('posts a file with a comment, reads it back as that comment’s attachment, and refuses to delete the comment', async () => {
    const filename = `live-suite-${Date.now()}.txt`;
    const posted = await adapter.postMessage(threadId, {
      markdown: 'chat-adapter-backlog live suite: attachment, left behind.',
      files: [
        {
          filename,
          data: Buffer.from('chat-adapter-backlog live suite\n'),
          mimeType: 'text/plain',
        },
      ],
    });

    const message = await adapter.fetchMessage(threadId, posted.id);
    const attachment = message?.attachments.find(
      (candidate) => candidate.name === filename
    );
    expect(attachment).toBeDefined();
    expect(String(await attachment?.fetchData?.())).toBe(
      'chat-adapter-backlog live suite\n'
    );

    const failure: unknown = await adapter
      .deleteMessage(threadId, posted.id)
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(AdapterError);
    expect((failure as AdapterError).code).toBe('UNSUPPORTED_OPERATION');
  });
});

describe
  .skipIf(!pullRequestConfigured)
  .sequential('a real Backlog pull request', () => {
    // `pullRequestConfigured` gates every test, so this is set by the time one
    // runs.
    const coordinates = pullRequestCoordinates as NonNullable<
      typeof pullRequestCoordinates
    >;
    const subject: BacklogSubjectRef = {
      kind: 'pullRequest',
      ...coordinates,
    };
    let adapter: ReturnType<typeof createLiveAdapter>;
    let projectId: number;
    let threadId: string;

    beforeAll(async () => {
      adapter = createLiveAdapter();
      projectId = await projectIdOfLiveIssue();
      threadId = encodeThreadId({ host: spaceHost, projectId, subject });
    });

    it('describes the pull request named by BACKLOG_LIVE_PULL_REQUEST with its web url', async () => {
      const thread = await adapter.fetchThread(threadId);

      expect(thread.metadata).toMatchObject({
        kind: 'pullRequest',
        projectId,
        ...coordinates,
      });
      expect([1, 2, 3]).toContain(
        (thread.metadata['status'] as { id: number }).id
      );
      expect(thread.metadata['url']).toMatch(
        new RegExp(`/pullRequests/${coordinates.number}$`)
      );
    });

    it('posts, edits, stars and unstars one comment, which then stays on the pull request', async () => {
      const posted = await adapter.postMessage(threadId, {
        markdown:
          'chat-adapter-backlog live suite: this comment cannot be deleted.',
      });
      const commentId = commentOf(posted.raw).id;

      const edited = await adapter.editMessage(threadId, posted.id, {
        markdown: 'chat-adapter-backlog live suite: edited, and left behind.',
      });
      const editedComment = commentOf(edited.raw);
      expect(editedComment.content).toContain('edited');
      expect(Date.parse(editedComment.updated)).toBeGreaterThanOrEqual(
        Date.parse(editedComment.created)
      );

      const client = adapter.client();
      const window = {
        count: 1,
        order: 'desc',
        minId: commentId - 1,
        maxId: commentId + 1,
      } as const;
      const repositoryId = String(coordinates.repositoryId);

      await adapter.addReaction(threadId, posted.id, 'star');
      const [starred] = await client.getPullRequestComments(
        projectId,
        repositoryId,
        coordinates.number,
        window
      );
      expect(starred?.id).toBe(commentId);
      expect(starred?.stars.length).toBeGreaterThan(0);

      await adapter.removeReaction(threadId, posted.id, 'star');
      const [unstarred] = await client.getPullRequestComments(
        projectId,
        repositoryId,
        coordinates.number,
        window
      );
      expect(unstarred?.stars).toHaveLength(0);
    });

    it('posts a file with a comment and reads it back as that comment’s attachment', async () => {
      const filename = `live-suite-pull-request-${Date.now()}.txt`;
      const posted = await adapter.postMessage(threadId, {
        markdown:
          'chat-adapter-backlog live suite: attachment, left behind below.',
        files: [
          {
            filename,
            data: Buffer.from('chat-adapter-backlog live suite\n'),
            mimeType: 'text/plain',
          },
        ],
      });

      const message = await adapter.fetchMessage(threadId, posted.id);
      const attachment = message?.attachments.find(
        (candidate) => candidate.name === filename
      );
      expect(attachment).toBeDefined();
      expect(String(await attachment?.fetchData?.())).toBe(
        'chat-adapter-backlog live suite\n'
      );
    });

    it('refuses to delete a pull request comment without reaching Backlog', async () => {
      // The comment id is arbitrary because no request carries it: the refusal
      // is a fact about Backlog's endpoint set, not about this comment.
      const messageId = encodeMessageId({
        host: spaceHost,
        subject,
        part: 'comment',
        commentId: 1,
      });

      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      try {
        const failure: unknown = await adapter
          .deleteMessage(threadId, messageId)
          .then(() => undefined)
          .catch((cause: unknown) => cause);

        expect(failure).toBeInstanceOf(AdapterError);
        expect((failure as AdapterError).code).toBe('UNSUPPORTED_OPERATION');
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
