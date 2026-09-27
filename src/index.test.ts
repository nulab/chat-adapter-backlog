import { describe, expect, it } from 'vitest';

import * as entry from './index';

/**
 * The package entry is the only surface a consumer sees, and `.github/workflows/ci.yml`
 * asserts on it by importing the built bundle in a real Node process. These
 * tests are the source-level half of that check: they fail here, in a fast
 * suite, rather than in the build job.
 */
describe('package entry point', () => {
  it('exports the factory and the adapter class', () => {
    expect(typeof entry.createBacklogAdapter).toBe('function');
    expect(typeof entry.BacklogAdapter).toBe('function');
  });

  it('constructs an adapter that registers itself as "backlog"', () => {
    const adapter = entry.createBacklogAdapter({
      host: 'example.backlog.com',
      apiKey: 'key',
      botUserId: 999,
      botUserName: 'Chatbot',
      webhookSecret: 'test-webhook-secret',
    });

    // The config key in `new Chat({ adapters: { backlog } })` must equal this,
    // because the core routes thread ids by their prefix.
    expect(adapter.name).toBe('backlog');
    expect(
      adapter.encodeThreadId({
        host: 'example.backlog.com',
        projectId: 500,
        subject: { kind: 'issue', issueId: 8001 },
      })
    ).toBe('backlog:example.backlog.com:500:issue:8001');
    expect(
      adapter.encodeThreadId({
        host: 'example.backlog.com',
        projectId: 500,
        subject: { kind: 'pullRequest', repositoryId: 700, number: 12 },
      })
    ).toBe('backlog:example.backlog.com:500:pr:700:12');
  });

  it('exports the two decoders a handler has no adapter member for', () => {
    expect(typeof entry.decodeMessageId).toBe('function');
    expect(typeof entry.decodeUserId).toBe('function');
  });

  it('exports nothing at run time beyond the adapter, its factory and those decoders', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'BacklogAdapter',
      'createBacklogAdapter',
      'decodeMessageId',
      'decodeUserId',
    ]);
  });

  it('keeps the internals off the public surface', () => {
    // §3.1: the port and its in-memory double, the id encoders, the
    // converters, the mention helpers, the backlog-js wrapper, the zod schemas
    // and the subject layer are not part of the contract, so a consumer
    // cannot come to depend on them.
    for (const name of [
      'createInMemoryBacklogApi',
      'encodeThreadId',
      'decodeThreadId',
      'channelIdFromThreadId',
      'encodeMessageId',
      'BacklogMarkdownConverter',
      'BacklogNotationConverter',
      'mentionUser',
      'mentionPattern',
      'createBacklogJsApi',
      'createBacklogJsTransport',
      'userSchema',
      'subjectClientFor',
    ]) {
      expect(entry).not.toHaveProperty(name);
    }
  });
});
