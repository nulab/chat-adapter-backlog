import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import * as entry from './index';

const SRC = path.dirname(fileURLToPath(import.meta.url));

function declaredTypeNames(file: string): Set<string> {
  const source = readFileSync(path.join(SRC, file), 'utf8');
  return new Set(
    [...source.matchAll(/^export (?:interface|type) (\w+)/gm)].map(
      (match) => match[1] ?? ''
    )
  );
}

/**
 * The names the barrel's header claims are declared in both modules. Read out
 * of the prose rather than kept in a constant beside it, because the prose is
 * what a reader believes: the raw shapes were called `BacklogIssue` and
 * `BacklogComment` until they were renamed to `BacklogRaw*`, and the sentence
 * naming them as duplicates outlived the rename unchallenged.
 */
function namesClaimedTwiceByTheHeader(): string[] {
  const header = readFileSync(path.join(SRC, 'index.ts'), 'utf8').split(
    '*/'
  )[0];
  const claim = (header ?? '').split('declared in both modules:')[1] ?? '';
  const sentence = claim.split('.')[0] ?? '';
  return [...sentence.matchAll(/`(\w+)`/g)].map((match) => match[1] ?? '');
}

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

  it('names in its header exactly the types the port and the raw-message module both declare', () => {
    const port = declaredTypeNames('client/port.ts');
    const raw = declaredTypeNames('types.ts');
    const declaredTwice = [...port].filter((name) => raw.has(name)).sort();

    expect(namesClaimedTwiceByTheHeader()).toEqual(declaredTwice);
  });

  it('keeps the internals off the public surface', () => {
    // §3.1: the backlog-js wrapper, the zod schemas, the plain-text fallback
    // converter, the fixtures and the subject layer are not part of the
    // contract, so a consumer cannot come to depend on them.
    for (const name of [
      'createBacklogJsApi',
      'FallbackFormatConverter',
      'converterFor',
      'userSchema',
      'subjectClientFor',
    ]) {
      expect(entry).not.toHaveProperty(name);
    }
  });
});
