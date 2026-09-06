import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The two modules that are allowed to know what kind a subject is, and why no
 * third one is: `subjectClientFor` is the runtime dispatch every member goes
 * through (D-PR2), and `ids.ts` is the grammar codec, which turns a ref into
 * text and back with no API and no context to reach a `SubjectClient` with.
 * Anywhere else, kind-specific behaviour belongs on `SubjectClient`.
 */
const KIND_AWARE_MODULES = new Set(['subject/client.ts', 'ids.ts']);

/**
 * Discriminated unions in this repo whose `kind` is not a subject's:
 * `BacklogRawMessage` (`raw.kind`, four variants, two of which are named after
 * the subject kinds) and `SubjectRoot.source`, which the subject modules narrow
 * to reach the port object their root was built from.
 */
const OTHER_UNIONS: readonly { receiver: string; within: string }[] = [
  { receiver: 'raw', within: '' },
  { receiver: 'source', within: 'subject/' },
];

const DISPATCH_PATTERNS: readonly RegExp[] = [
  /switch\s*\(\s*([\w$.]+)\.kind\s*\)/g,
  /([\w$.]+)\.kind\s*[!=]==\s*['"](?:issue|pullRequest)['"]/g,
];

interface Violation {
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

function isOtherUnion(receiver: string, file: string): boolean {
  const last = receiver.split('.').pop();
  return OTHER_UNIONS.some(
    (union) => union.receiver === last && file.startsWith(union.within)
  );
}

function violationsIn(file: string, contents: string): Violation[] {
  const violations: Violation[] = [];
  contents.split('\n').forEach((source, index) => {
    for (const pattern of DISPATCH_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        const receiver = match[1] ?? '';
        if (isOtherUnion(receiver, file)) {
          continue;
        }
        violations.push({ file, line: index + 1, source: source.trim() });
      }
    }
  });
  return violations;
}

function scanRepository(): Violation[] {
  return sourceFiles(SRC).flatMap((full) => {
    const file = path.relative(SRC, full).split(path.sep).join('/');
    if (KIND_AWARE_MODULES.has(file)) {
      return [];
    }
    return violationsIn(file, readFileSync(full, 'utf8'));
  });
}

describe('subject kind dispatch', () => {
  it('happens in the subject client factory and the id codec, nowhere else', () => {
    const violations = scanRepository();

    expect(
      violations,
      violations
        .map(
          ({ file, line, source }) =>
            `src/${file}:${line}: ${source}\n` +
            '  -> a subject kind is dispatched outside src/subject/client.ts. ' +
            'Put the kind-specific behaviour on SubjectClient (src/subject/client.ts) ' +
            'and call it through subjectClientFor instead.'
        )
        .join('\n')
    ).toEqual([]);
  });

  it('recognises a kind check smuggled into another module', () => {
    const smuggled = [
      '  switch (ref.kind) {',
      "  if (threadId.subject.kind === 'pullRequest') {",
      "  const isIssue = someSubject.kind === 'issue';",
    ].join('\n');

    expect(violationsIn('reads.ts', smuggled)).toHaveLength(3);
  });

  it('leaves the raw message union and a root’s port object alone', () => {
    const allowed = [
      '  switch (raw.kind) {',
      "  if (message.raw.kind === 'issue') {",
      "  if (root.source.kind !== 'pullRequest') {",
    ].join('\n');

    expect(violationsIn('subject/issue.ts', allowed)).toEqual([]);
  });
});
