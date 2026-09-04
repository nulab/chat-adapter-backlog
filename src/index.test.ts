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
      webhookSecret: 'secret',
    });

    // The config key in `new Chat({ adapters: { backlog } })` must equal this,
    // because the core routes thread ids by their prefix.
    expect(adapter.name).toBe('backlog');
    expect(
      adapter.encodeThreadId({
        host: 'example.backlog.com',
        projectId: 500,
        issueId: 8001,
      })
    ).toBe('backlog:example.backlog.com:500:8001');
  });

  it('exports the id codec and the mention helpers', () => {
    for (const name of [
      'encodeThreadId',
      'decodeThreadId',
      'encodeChannelId',
      'decodeChannelId',
      'channelIdFromThreadId',
      'encodeMessageId',
      'decodeMessageId',
      'encodeUserId',
      'decodeUserId',
      'mentionUser',
      'mentionTeam',
      'mentionPattern',
    ] as const) {
      expect(typeof entry[name]).toBe('function');
    }
    expect(entry.MENTION_PROJECT_MEMBERS).toBe('<@project>');
  });

  it('exports the converters and the in-memory port for consumers to test against', () => {
    expect(typeof entry.BacklogMarkdownConverter).toBe('function');
    expect(typeof entry.BacklogNotationConverter).toBe('function');
    expect(typeof entry.createInMemoryBacklogApi).toBe('function');
  });

  it('keeps the internals off the public surface', () => {
    // §3.1: the backlog-js wrapper, the zod schemas, the plain-text fallback
    // converter and the fixtures are not part of the contract, so a consumer
    // cannot come to depend on them.
    for (const name of [
      'createBacklogJsApi',
      'FallbackFormatConverter',
      'converterFor',
      'userSchema',
    ]) {
      expect(entry).not.toHaveProperty(name);
    }
  });
});
