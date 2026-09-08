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
 *
 * The exemption is by **name**, so a subject ref that happens to be called
 * `raw` is waved through anywhere in `src/`. Narrowing it further would need
 * types, which a line-based scan does not have; the names are the ones the
 * repo actually uses for those two unions, and a subject ref is called `ref`
 * or `subject` everywhere it appears.
 */
const OTHER_UNIONS: readonly { receiver: string; within: string }[] = [
  { receiver: 'raw', within: '' },
  { receiver: 'source', within: 'subject/' },
];

/** A dotted or optional-chained path: `ref`, `threadId.subject`, `x?.y`. */
const RECEIVER = String.raw`([\w$]+(?:\s*\??\.\s*[\w$]+)*)`;

/** That path's `kind`, however it is spelled: `.kind`, `?.kind`, `['kind']`. */
const KIND = String.raw`\s*(?:\??\.\s*kind|\??\[\s*['"]kind['"]\s*\])`;

/** `===`, `!==`, `==`, `!=`, never a bare `=`: an assignment is no dispatch. */
const EQUALITY = String.raw`[!=]={1,2}`;

/** A subject kind, quoted or backticked; the closing quote must match. */
const SUBJECT_KIND = String.raw`(?<quote>['"\`])(?:issue|pullRequest)\k<quote>`;

/**
 * A kind dispatch is recognised only where the value it reads can be *named*
 * on the line it appears on, because the exemptions above are by name. Within
 * that limit the spelling does not matter: `?.`, `['kind']`, `==` and a
 * backticked kind are all caught, and so is destructuring `kind` out of a
 * ref — the form that would otherwise hide every later use behind a bare
 * identifier.
 *
 * Deliberately unmatched, because the receiver has no name to check against
 * those exemptions, and guessing would report the `raw` and `source`
 * narrowing this repo is full of:
 *
 * - a parenthesised receiver — `(await subject.fetch()).kind === 'issue'`,
 *   `(message.raw as BacklogRawIssue).kind`;
 * - a value bound by a parameter pattern — `({ kind }: BacklogSubjectRef)`;
 * - a `kind` read through a variable key — `ref[discriminant]`;
 * - a check split over two lines, which this scan reads one line at a time;
 * - a predicate — `isPullRequest(ref)` — or any other indirection.
 *
 * Field sniffing (`'issueId' in ref`) is left out for a different reason: one
 * line cannot tell it from *building* a ref out of a webhook payload
 * (`src/webhook/payload.ts`), which is what the adapter is supposed to do.
 *
 * Being by name, the exemptions also over-report: the destructuring pattern
 * flags `kind` pulled out of **any** receiver that is not `raw` or `source`,
 * so `const { kind, id } = customField`, `const { kind } = await this.load()`
 * and even a type parameter's default
 * (`<T extends { kind: string } = BacklogSubjectRef>`) would all be reported.
 * What keeps that theoretical is that no `kind` in `src/` belongs to anything
 * but the three unions named here. A fourth one means teaching `OTHER_UNIONS`
 * about it, not loosening the pattern — the pattern is only worth having
 * while `kind` means a discriminant and nothing else.
 *
 * So this suite is a tripwire and not a proof. It catches the shapes a kind
 * dispatch is actually written in; the rule itself still has to be understood
 * (CLAUDE.md, docs/specs/adapter.md §14 D-PR2).
 */
const DISPATCH_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`switch\s*\(\s*${RECEIVER}${KIND}\s*\)`, 'g'),
  new RegExp(
    String.raw`${RECEIVER}${KIND}\s*${EQUALITY}\s*${SUBJECT_KIND}`,
    'g'
  ),
  new RegExp(String.raw`\{[^{}]*\bkind\b[^{}]*\}\s*=\s*${RECEIVER}`, 'g'),
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
  const last = receiver.replace(/[\s?]/g, '').split('.').pop();
  return OTHER_UNIONS.some(
    (union) => union.receiver === last && file.startsWith(union.within)
  );
}

/**
 * The one thing this scan is not is a parser: it reads the **text** of a line,
 * so prose about this very rule matches the patterns as readily as code does.
 * That is not hypothetical — `src/webhook/bulk.ts` and `src/subject/url.ts`
 * each already carry a Why-not sentence about D-PR2 that would start failing
 * this suite the moment a subject kind were quoted in it, and the failure
 * message would tell its author to move a comment onto `SubjectClient`. A
 * grep test that fires on prose is a grep test somebody deletes, so a comment
 * comes off the line first: one that opens or continues a block comment is
 * dropped whole, and a `//` tail is cut away.
 *
 * Two consequences survive that, and are disclosed rather than fixed because
 * closing them needs the parser this deliberately is not:
 *
 * - **A subject kind inside a string literal is still reported**, because
 *   nothing tells `logger.warn("subject.kind === 'issue'")` from the dispatch
 *   it describes. Writing about this rule *outside* a comment therefore means
 *   keeping the `kind` read and the kind literal on separate lines.
 * - **A `//` inside a string cuts the line short** (`'https://…'`), so a
 *   dispatch written after one, on that same line, is missed.
 */
function codeOn(line: string): string {
  const text = line.trimStart();
  if (text.startsWith('*') || text.startsWith('/*')) {
    return '';
  }
  const commentTail = line.indexOf('//');
  return commentTail === -1 ? line : line.slice(0, commentTail);
}

function violationsIn(file: string, contents: string): Violation[] {
  const violations: Violation[] = [];
  contents.split('\n').forEach((source, index) => {
    const code = codeOn(source);
    for (const pattern of DISPATCH_PATTERNS) {
      for (const match of code.matchAll(pattern)) {
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

  it.each([
    { spelling: 'a switch', line: '  switch (ref.kind) {' },
    {
      spelling: 'a switch through an optional chain',
      line: '  switch (ref?.kind) {',
    },
    {
      spelling: 'a dotted path',
      line: "  if (threadId.subject.kind === 'pullRequest') {",
    },
    {
      spelling: 'a comparison assigned to a boolean',
      line: "  const isIssue = someSubject.kind === 'issue';",
    },
    { spelling: 'an optional chain', line: "  if (ref?.kind === 'issue') {" },
    { spelling: 'loose equality', line: "  if (ref.kind == 'issue') {" },
    {
      spelling: 'loose inequality',
      line: "  if (ref.kind != 'pullRequest') {",
    },
    { spelling: 'a bracket access', line: "  if (ref['kind'] === 'issue') {" },
    { spelling: 'a backticked kind', line: '  if (ref.kind === `issue`) {' },
    { spelling: 'a destructuring', line: '  const { kind } = ref;' },
    {
      spelling: 'a renamed destructuring',
      line: '  const { kind: subjectKind } = threadId.subject;',
    },
  ])(
    'recognises a kind check smuggled into another module as $spelling',
    ({ line }) => {
      expect(violationsIn('reads.ts', line)).toHaveLength(1);
    }
  );

  it('reads code, not the prose written about the rule', () => {
    const documented = [
      "  * a `ref.kind === 'issue'` branch belongs on SubjectClient",
      '  /** Never `switch (ref.kind)` here — call subjectClientFor. */',
      '  // const { kind } = ref; would violate D-PR2',
      "  } // no `ref.kind === 'pullRequest'` outside the subject layer",
    ].join('\n');

    expect(violationsIn('reads.ts', documented)).toEqual([]);
  });

  it('leaves the raw message union and a root’s port object alone', () => {
    const allowed = [
      '  switch (raw.kind) {',
      "  if (message.raw.kind === 'issue') {",
      "  if (message.raw?.kind === 'issue') {",
      '  const { kind } = message.raw;',
      "  if (root.source.kind !== 'pullRequest') {",
      '  const { kind: sourceKind } = root.source;',
    ].join('\n');

    expect(violationsIn('subject/issue.ts', allowed)).toEqual([]);
  });
});
