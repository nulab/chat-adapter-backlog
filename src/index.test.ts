import { describe, expect, it } from 'vitest';

import * as entry from './index';

describe('package entry point', () => {
  it('exports nothing at run time beyond the adapter, its factory and the two decoders', () => {
    expect(Object.keys(entry).sort()).toEqual([
      'BacklogAdapter',
      'createBacklogAdapter',
      'decodeMessageId',
      'decodeUserId',
    ]);
  });

  it('builds an adapter named "backlog", the config key and thread-id prefix the core routes by', () => {
    const adapter = entry.createBacklogAdapter({
      host: 'example.backlog.com',
      apiKey: 'key',
      botUserId: 999,
      botUserName: 'Chatbot',
      webhookSecret: 'test-webhook-secret',
    });

    expect(adapter.name).toBe('backlog');
  });
});
