import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The one module allowed to declare the credentials type, and why no second
 * one is: `port.ts` owns the API domain types, and this one carries a
 * constraint the compiler can only enforce where it is written — `apiKey?:
 * never` / `accessToken?: never` on its members (docs/specs/adapter.md §8.7).
 * A second declaration is how that was lost once already: `backlog-js.ts`
 * had its own `{ apiKey?; accessToken? }` interface, the transport took that
 * one, and passing both credentials silently meant the API key.
 */
const DECLARING_MODULE = 'client/port.ts';

const DECLARATION = /\b(?:type|interface)\s+BacklogCredentials\b/;

interface Declaration {
  file: string;
  line: number;
  source: string;
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      files.push(full);
    }
  }
  return files;
}

function declarationsIn(file: string, contents: string): Declaration[] {
  return contents
    .split('\n')
    .flatMap((source, index) =>
      DECLARATION.test(source)
        ? [{ file, line: index + 1, source: source.trim() }]
        : []
    );
}

function scanRepository(): Declaration[] {
  return sourceFiles(SRC).flatMap((full) => {
    const file = path.relative(SRC, full).split(path.sep).join('/');
    return declarationsIn(file, readFileSync(full, 'utf8'));
  });
}

describe('the credentials type', () => {
  it('is declared in the port and nowhere else', () => {
    const declarations = scanRepository();

    expect(
      declarations.map(({ file }) => file),
      declarations
        .filter(({ file }) => file !== DECLARING_MODULE)
        .map(
          ({ file, line, source }) =>
            `src/${file}:${line}: ${source}\n` +
            '  -> BacklogCredentials is declared outside src/client/port.ts. ' +
            'Import the type from there; a second declaration loses the ' +
            '`?: never` members that make "exactly one credential" a compile ' +
            'error rather than a comment.'
        )
        .join('\n')
    ).toEqual([DECLARING_MODULE]);
  });

  it('recognises a second declaration in another module', () => {
    const smuggled = [
      'export interface BacklogCredentials {',
      '  apiKey?: () => string;',
      '}',
      'type BacklogCredentialsResolver = () => string;',
    ].join('\n');

    expect(declarationsIn('client/backlog-js.ts', smuggled)).toHaveLength(1);
  });
});
