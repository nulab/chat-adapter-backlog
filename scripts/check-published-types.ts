/**
 * Fails `vp pack` when the published declarations reference a module a
 * consumer does not install.
 *
 * `dist/index.d.ts` is the only file a consumer's `tsc` reads, and a type
 * alias to a `z.infer` is enough to pull `import { z } from "zod"` and three
 * hundred lines of `z.ZodObject<…, z.core.$strip>` into it (#37). That makes
 * zod's internal types part of this package's public contract: a consumer
 * type-checking `message.raw.payload` has to resolve them, a hoisted zod
 * minor can break that resolution, and a zod major becomes a semver-major
 * here.
 *
 * An allowlist rather than a denylist of `zod`: the leak is
 * "the declarations reached for something only the implementation has", and
 * the next module to do that is not necessarily one of those two.
 *
 * Run from the `build:done` hook of the `pack` block in `vite.config.ts`, not
 * as a vitest suite: `vp test` has to pass on a checkout with no `dist/`, and
 * a suite that skips itself when `dist/` is absent would skip in CI's test
 * matrix, which never builds.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * `chat` is the peer dependency the `Adapter` interface and `Logger` come
 * from, so a consumer already has it.
 *
 * `backlog-js` is here on purpose and is the one exception the spec records
 * (D-API1): `BacklogAdapter.client()` returns its `Backlog` client, so that a
 * consumer needing an endpoint the adapter does not cover gets its own
 * 429 retry and error mapping instead of standing up a second client beside
 * it. The price is exactly what this script otherwise
 * prevents — a `backlog-js` major becomes a semver-major here — and it is
 * accepted because it is the library this adapter is built on and the same
 * vendor ships both.
 *
 * Nothing else is installed on a consumer's behalf: `zod` and
 * `@chat-adapter/shared` are this package's own dependencies, hoisted
 * wherever the consumer's package manager decided, and the spec promises
 * neither appears in an exported type.
 */
const ALLOWED_SPECIFIERS = new Set(['chat', 'backlog-js']);

const SPECIFIER_PATTERN =
  /(?:\bfrom|\bimport\s*\(|\bdeclare\s+module|\brequire\s*\()\s*['"]([^'"]+)['"]/g;

function publishedTypesPath(root: string): string {
  const manifest: { exports?: { '.'?: { types?: unknown } } } = JSON.parse(
    readFileSync(path.join(root, 'package.json'), 'utf8')
  );
  const types = manifest.exports?.['.']?.types;
  if (typeof types !== 'string') {
    throw new Error(
      'package.json exports["."].types is not a path, so there is no published declaration file to check'
    );
  }
  return types;
}

function specifiersIn(declarations: string): Set<string> {
  return new Set(
    [...declarations.matchAll(SPECIFIER_PATTERN)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]]
    )
  );
}

/**
 * Fails when the declarations hand a consumer a type it cannot name. tsdown
 * bundles every type an export reaches, but exports only what `src/index.ts`
 * names, so a type that `BacklogRawMessage` references and the barrel forgets
 * still ships, as a declaration nobody can import (#113).
 */
const DECLARED_TYPE_PATTERN = /^(?:declare )?(?:interface|type) (\w+)/gm;
const EXPORT_LIST_PATTERN = /^export (type )?\{([^}]*)\}/gm;

function exportedNames(
  source: string,
  { typesOnly = false }: { typesOnly?: boolean } = {}
): Set<string> {
  return new Set(
    [...source.matchAll(EXPORT_LIST_PATTERN)]
      .filter((match) => !typesOnly || match[1] !== undefined)
      .flatMap((match) => (match[2] ?? '').split(','))
      .map((name) =>
        (
          name
            .trim()
            .replace(/^type\s+/, '')
            .split(/\s+as\s+/)
            .pop() ?? ''
        ).trim()
      )
      .filter((name) => name !== '')
  );
}

function namesIn(matches: Iterable<RegExpMatchArray>): string[] {
  return [...matches].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]]
  );
}

export function checkPublishedTypes(root: string): void {
  const entry = publishedTypesPath(root);
  let declarations: string;
  try {
    declarations = readFileSync(path.join(root, entry), 'utf8');
  } catch {
    throw new Error(
      `${entry} does not exist, so tsdown emitted no declarations for the published entry.`
    );
  }

  const leaked = [...specifiersIn(declarations)]
    .filter((specifier) => !ALLOWED_SPECIFIERS.has(specifier))
    .sort();

  if (leaked.length > 0) {
    throw new Error(
      `${entry} imports from ${leaked.map((s) => `"${s}"`).join(', ')}, ` +
        `but a consumer only installs ${[...ALLOWED_SPECIFIERS].map((s) => `"${s}"`).join(', ')}.\n` +
        'An exported type is reaching an implementation type. Declare the ' +
        'public shape by hand in src/types.ts and keep the schema aligned with ' +
        'it (docs/specs/adapter.md D-API1). If the module really belongs in the ' +
        'published contract, add it to ALLOWED_SPECIFIERS here and to the ' +
        "spec's exports in the same commit."
    );
  }

  const exportedTypes = exportedNames(declarations, { typesOnly: true });
  const unnameable = namesIn(declarations.matchAll(DECLARED_TYPE_PATTERN))
    .filter((name) => !exportedTypes.has(name))
    .sort();

  if (unnameable.length > 0) {
    throw new Error(
      `${entry} declares ${unnameable.join(', ')} without exporting them, so ` +
        'a consumer receives values of those types but cannot name them. ' +
        'Export them from src/index.ts, or stop an exported type from ' +
        'referencing them (docs/specs/adapter.md D-API1).'
    );
  }

  // The bundle must export the same set of names as the barrel, runtime and
  // type alike: an edit of `src/index.ts` that drops a name must not ship as a
  // quietly smaller package.
  const barrelNames = exportedNames(
    readFileSync(path.join(root, 'src/index.ts'), 'utf8')
  );
  const publishedNames = new Set([
    ...exportedNames(declarations),
    ...namesIn(
      declarations.matchAll(
        /^export declare (?:async )?(?:class|function|const) (\w+)/gm
      )
    ),
  ]);
  const dropped = [...barrelNames].filter((name) => !publishedNames.has(name));
  const unexpected = [...publishedNames].filter(
    (name) => !barrelNames.has(name)
  );

  if (dropped.length > 0 || unexpected.length > 0) {
    throw new Error(
      `${entry} exports a different set of names from src/index.ts` +
        (dropped.length > 0 ? `; missing: ${dropped.sort().join(', ')}` : '') +
        (unexpected.length > 0
          ? `; not in the barrel: ${unexpected.sort().join(', ')}`
          : '') +
        '.'
    );
  }
}
