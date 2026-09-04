import { describe, expect, it } from 'vitest';

import { createBacklogAdapter } from '../index';
import type { BacklogApi } from '../client/port';

/**
 * Opt-in suite against a real Backlog space (docs/specs/adapter.md §12.3).
 *
 * `pnpm test` must pass with no credentials and no network, so this skips
 * itself unless all three variables are set. It is not part of CI.
 *
 *   BACKLOG_HOST=example.backlog.com \
 *   BACKLOG_API_KEY=... \
 *   BACKLOG_LIVE_ISSUE_ID=8001 \
 *   pnpm test
 *
 * The budget is deliberate. Backlog's update bucket allows on the order of
 * 150 requests per user per minute and the four buckets are independent
 * (https://developer.nulab.com/docs/backlog/rate-limit/), so a chatty live
 * suite earns an HTTP 429 that looks like a product bug. This suite spends at
 * most ten update-bucket calls, runs strictly sequentially, creates no issues
 * and touches no notifications — everything it creates, it deletes.
 */

const host = process.env['BACKLOG_HOST'];
const apiKey = process.env['BACKLOG_API_KEY'];
const liveIssueId = process.env['BACKLOG_LIVE_ISSUE_ID'];
const configured = Boolean(host && apiKey && liveIssueId);

describe.skipIf(!configured).sequential('a real Backlog space', () => {
  // `configured` gates every test, so these are set by the time one runs.
  const spaceHost = host as string;
  const issueId = Number(liveIssueId);

  function connect(): BacklogApi {
    const adapter = createBacklogAdapter({
      host: spaceHost,
      apiKey: apiKey as string,
      // The live suite exercises the port rather than dispatch, so the bot
      // identity only has to be well-formed: nothing here reads it back.
      botUserId: 1,
      botUserName: 'Chatbot',
      webhookSecret: 'unused-by-this-suite',
    });
    return adapter.api(spaceHost);
  }

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

    await api.addStar(added.id);
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
    const adapter = createBacklogAdapter({
      host: spaceHost,
      apiKey: apiKey as string,
      botUserId: 1,
      botUserName: 'Chatbot',
      webhookSecret: 'unused-by-this-suite',
    });

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
