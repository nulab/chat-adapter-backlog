import { AdapterError } from '@chat-adapter/shared';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  createBacklogAdapter,
  encodeMessageId,
  encodeThreadId,
} from '../index';

import type { BacklogApi, PullRequestRef } from '../client/port';
import type { BacklogSubjectRef } from '../types';

/**
 * Opt-in suite against a real Backlog space (docs/specs/adapter.md §12.3).
 *
 * `pnpm test` must pass with no credentials and no network, so each section
 * skips itself unless its variables are set. It is not part of CI.
 *
 *   BACKLOG_HOST=example.backlog.com \
 *   BACKLOG_API_KEY=... \
 *   BACKLOG_LIVE_ISSUE_ID=8001 \
 *   BACKLOG_LIVE_PULL_REQUEST=700:12 \
 *   pnpm test
 *
 * The budget is deliberate. Backlog's update bucket allows on the order of
 * 150 requests per user per minute and the four buckets are independent
 * (https://developer.nulab.com/docs/backlog/rate-limit/), so a chatty live
 * suite earns an HTTP 429 that looks like a product bug. The issue section
 * spends at most ten update-bucket calls, the pull-request section at most
 * eight, both run strictly sequentially, and neither creates an issue or
 * touches notifications.
 *
 * The two sections differ in what they leave behind. The issue section deletes
 * everything it creates. The pull-request section deletes nothing, because
 * Backlog offers nothing to delete with: there is no delete endpoint for a
 * pull request or for one of its comments
 * (`.claude/rules/backlog-pull-request-facts.md`). `BACKLOG_LIVE_PULL_REQUEST`
 * must therefore name a scratch pull request — its comments are permanent.
 *
 * That measurement — `DELETE …/pullRequests/:number/comments/:commentId`
 * answering 400 with error code 6 `Undefined resource` — is asserted nowhere
 * below. Reaching the route means issuing a request the port deliberately has
 * no method for, and adding one to prove an endpoint's absence would put a
 * dead method in the adapter's own API forever. What the suite pins instead is
 * the behaviour a caller can observe: `deleteMessage` on a pull-request thread
 * refuses before any request leaves the process.
 *
 * `BACKLOG_LIVE_PULL_REQUEST` carries `<repositoryId>:<number>`, the two
 * coordinates the thread-id grammar writes as `pr:<repositoryId>:<number>`.
 * Every pull-request endpoint is keyed by a third one, the project, which the
 * variable does not carry and no endpoint derives — so it comes from
 * `BACKLOG_LIVE_ISSUE_ID`'s issue, and the scratch pull request has to live in
 * that issue's project.
 */

const host = process.env['BACKLOG_HOST'];
const apiKey = process.env['BACKLOG_API_KEY'];
const liveIssueId = process.env['BACKLOG_LIVE_ISSUE_ID'];
const livePullRequest = process.env['BACKLOG_LIVE_PULL_REQUEST'];

const configured = Boolean(host && apiKey && liveIssueId);

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
    // The live suite exercises the port rather than dispatch, so the bot
    // identity only has to be well-formed: nothing here reads it back.
    botUserId: 1,
    botUserName: 'Chatbot',
    webhookSecret: 'unused-by-this-suite',
  });
}

function connect(): BacklogApi {
  return createLiveAdapter().api(spaceHost);
}

describe.skipIf(!configured).sequential('a real Backlog space', () => {
  it('reads the issue named by BACKLOG_LIVE_ISSUE_ID', async () => {
    const issue = await connect().getIssue(issueId);

    expect(issue.id).toBe(issueId);
    expect(issue.issueKey).toMatch(/^[A-Z0-9_]+-\d+$/);
    expect(typeof issue.summary).toBe('string');
  });

  it('reads the project and reports its text formatting rule', async () => {
    const api = connect();
    const issue = await api.getIssue(issueId);
    const project = await api.getProject(issue.projectId);

    expect(project.id).toBe(issue.projectId);
    // The rule decides which converter every egress path uses, so a value
    // outside this pair would silently fall back to Markdown.
    expect(['markdown', 'backlog']).toContain(project.textFormattingRule);
  });

  it('adds, edits, stars, unstars and deletes one comment', async () => {
    const api = connect();

    const added = await api.addComment(issueId, {
      content:
        'chat-adapter-backlog live suite: this comment is deleted below.',
    });
    expect(added.id).toBeGreaterThan(0);

    const edited = await api.updateComment(
      issueId,
      added.id,
      'chat-adapter-backlog live suite: edited, and deleted below.'
    );
    expect(edited.content).toContain('edited');
    // Backlog moves `updated` past `created` on an edit, which is what a
    // REST-derived message reports as `edited` (docs/specs/adapter.md §7.1).
    expect(edited.updated.getTime()).toBeGreaterThan(edited.created.getTime());

    await api.addStar({ commentId: added.id });
    const starred = await api.getComment(issueId, added.id);
    expect(starred.stars.length).toBeGreaterThan(0);

    const star = starred.stars.at(-1);
    expect(star).toBeDefined();
    await api.deleteStar((star as NonNullable<typeof star>).id);

    await api.deleteComment(issueId, added.id);
  });

  it('uploads an attachment and attaches it to a comment', async () => {
    const api = connect();

    const uploaded = await api.uploadAttachment(
      'live-suite.txt',
      Buffer.from('chat-adapter-backlog live suite\n'),
      'text/plain'
    );
    expect(uploaded.id).toBeGreaterThan(0);
    expect(uploaded.name).toBe('live-suite.txt');

    const comment = await api.addComment(issueId, {
      content: 'chat-adapter-backlog live suite: attachment, deleted below.',
      attachmentId: [uploaded.id],
    });

    await api.deleteComment(issueId, comment.id);
  });

  it('records the rate-limit headers Backlog returns for each bucket used', async () => {
    const adapter = createLiveAdapter();

    expect(adapter.rateLimit(spaceHost)).toEqual({});

    const api = adapter.api(spaceHost);
    await api.getIssue(issueId);
    const afterRead = adapter.rateLimit(spaceHost);
    expect(afterRead.read).toBeDefined();
    expect(afterRead.read?.limit).toBeGreaterThan(0);
    expect(afterRead.read?.reset).toBeInstanceOf(Date);

    const comment = await api.addComment(issueId, {
      content:
        'chat-adapter-backlog live suite: rate-limit probe, deleted below.',
    });
    await api.deleteComment(issueId, comment.id);

    const afterUpdate = adapter.rateLimit(spaceHost);
    expect(afterUpdate.update).toBeDefined();
    // The buckets are independent, so an update must not have overwritten the
    // read snapshot (docs/specs/adapter.md §8.4).
    expect(afterUpdate.read).toBeDefined();
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

    let ref: PullRequestRef;

    beforeAll(async () => {
      const issue = await connect().getIssue(issueId);
      ref = { projectId: issue.projectId, ...coordinates };
    });

    it('reads the repository and the pull request named by BACKLOG_LIVE_PULL_REQUEST', async () => {
      const api = connect();

      const repository = await api.getGitRepository(
        ref.projectId,
        ref.repositoryId
      );
      expect(repository.id).toBe(ref.repositoryId);
      expect(repository.projectId).toBe(ref.projectId);
      expect(typeof repository.name).toBe('string');

      const pullRequest = await api.getPullRequest(ref);
      expect(pullRequest.number).toBe(ref.number);
      expect(pullRequest.repositoryId).toBe(ref.repositoryId);
      expect(pullRequest.projectId).toBe(ref.projectId);
      expect([1, 2, 3]).toContain(pullRequest.status.id);
    });

    it('adds, edits, stars and unstars one comment, which then stays on the pull request', async () => {
      const api = connect();

      const added = await api.addPullRequestComment(ref, {
        content:
          'chat-adapter-backlog live suite: this comment cannot be deleted.',
      });
      expect(added.id).toBeGreaterThan(0);

      const edited = await api.updatePullRequestComment(
        ref,
        added.id,
        'chat-adapter-backlog live suite: edited, and left behind.'
      );
      expect(edited.content).toContain('edited');
      expect(edited.updated.getTime()).toBeGreaterThan(
        edited.created.getTime()
      );

      await api.addStar({ pullRequestCommentId: added.id });
      // A one-element exclusive window, rather than a get: there is no Get
      // Pull Request Comment endpoint, and `minId`/`maxId` exclude their own
      // ids (`.claude/rules/backlog-pull-request-facts.md`).
      const [read] = await api.listPullRequestComments(ref, {
        count: 1,
        order: 'desc',
        minId: added.id - 1,
        maxId: added.id + 1,
      });
      expect(read).toBeDefined();
      const starred = read as NonNullable<typeof read>;
      expect(starred.id).toBe(added.id);
      expect(starred.stars.length).toBeGreaterThan(0);

      const star = starred.stars.at(-1);
      expect(star).toBeDefined();
      await api.deleteStar((star as NonNullable<typeof star>).id);
    });

    it('uploads an attachment, attaches it to a comment and lists it on the pull request', async () => {
      const api = connect();

      const uploaded = await api.uploadAttachment(
        'live-suite-pull-request.txt',
        Buffer.from('chat-adapter-backlog live suite\n'),
        'text/plain'
      );
      expect(uploaded.id).toBeGreaterThan(0);
      expect(uploaded.name).toBe('live-suite-pull-request.txt');

      const comment = await api.addPullRequestComment(ref, {
        content:
          'chat-adapter-backlog live suite: attachment, left behind below.',
        attachmentId: [uploaded.id],
      });
      expect(comment.id).toBeGreaterThan(0);

      const attachments = await api.listPullRequestAttachments(ref);
      expect(attachments.map((attachment) => attachment.name)).toContain(
        'live-suite-pull-request.txt'
      );
    });

    it('refuses to delete a pull request comment without reaching Backlog', async () => {
      const adapter = createLiveAdapter();
      const threadId = encodeThreadId({
        host: spaceHost,
        projectId: ref.projectId,
        subject,
      });
      // The comment id is arbitrary because no request carries it: the refusal
      // is a fact about Backlog's endpoint set, not about this comment.
      const messageId = encodeMessageId({
        host: spaceHost,
        subject,
        part: 'comment',
        commentId: 1,
      });

      const failure: unknown = await adapter
        .deleteMessage(threadId, messageId)
        .then(() => undefined)
        .catch((cause: unknown) => cause);

      expect(failure).toBeInstanceOf(AdapterError);
      expect((failure as AdapterError).code).toBe('UNSUPPORTED_OPERATION');
      // An untouched adapter records a bucket per response it has seen, so an
      // empty snapshot is proof that nothing was sent.
      expect(adapter.rateLimit(spaceHost)).toEqual({});
    });

    it('spends the read bucket on a pull request list and leaves the search bucket alone', async () => {
      const adapter = createLiveAdapter();
      const api = adapter.api(spaceHost);

      await api.getPullRequest(ref);
      const afterPullRequest = adapter.rateLimit(spaceHost);
      expect(afterPullRequest.read).toBeDefined();
      expect(afterPullRequest.read?.limit).toBeGreaterThan(0);
      expect(afterPullRequest.read?.reset).toBeInstanceOf(Date);
      expect(afterPullRequest.search).toBeUndefined();

      await api.listIssues(ref.projectId, { count: 1 });
      const afterIssues = adapter.rateLimit(spaceHost);
      expect(afterIssues.search).toBeDefined();

      await api.listPullRequests(ref.projectId, ref.repositoryId, {
        count: 1,
      });
      const afterPullRequests = adapter.rateLimit(spaceHost);
      // Not `remaining` arithmetic: the per-minute window can reset between
      // two calls, which would raise `remaining` rather than lower it.
      expect(afterPullRequests.read).not.toEqual(afterIssues.read);
      expect(afterPullRequests.search).toEqual(afterIssues.search);

      const comment = await api.addPullRequestComment(ref, {
        content:
          'chat-adapter-backlog live suite: rate-limit probe, left behind.',
      });
      expect(comment.id).toBeGreaterThan(0);

      const afterUpdate = adapter.rateLimit(spaceHost);
      expect(afterUpdate.update).toBeDefined();
      // The buckets are independent, so an update must not have overwritten
      // the read or search snapshot (docs/specs/adapter.md §8.4).
      expect(afterUpdate.read).toBeDefined();
      expect(afterUpdate.search).toEqual(afterIssues.search);
    });
  });
