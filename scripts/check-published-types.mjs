/**
 * Fails the build when the published declarations reference a module a
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
 * Plain `.mjs` and no flags so `pnpm build` needs nothing from the Node it
 * happens to run on. Run as the tail of `pnpm build`, not as a vitest suite:
 * `pnpm test` has to pass on a checkout with no `dist/`, and a suite that
 * skips itself when `dist/` is absent would skip in CI's test matrix, which
 * never builds.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `chat` is the peer dependency the `Adapter` interface and `Logger` come
 * from, so a consumer already has it.
 *
 * `backlog-js` is here on purpose and is the one exception §3.1 records:
 * `BacklogAdapter.client(host)` returns its `Backlog` client, so that a
 * consumer needing an endpoint the port does not name spends the adapter's
 * own rate-limit accounting, retries and error mapping instead of standing up
 * a second client beside it. The price is exactly what this script otherwise
 * prevents — a `backlog-js` major becomes a semver-major here — and it is
 * accepted because it is the library this adapter is built on and the same
 * vendor ships both.
 *
 * Nothing else is installed on a consumer's behalf: `zod` and
 * `@chat-adapter/shared` are this package's own dependencies, hoisted
 * wherever the consumer's package manager decided, and §3.1 promises neither
 * appears in an exported type.
 */
const ALLOWED_SPECIFIERS = new Set(['chat', 'backlog-js']);

const SPECIFIER_PATTERN =
  /(?:\bfrom|\bimport\s*\(|\bdeclare\s+module|\brequire\s*\()\s*['"]([^'"]+)['"]/g;

function publishedTypesPath() {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, 'package.json'), 'utf8')
  );
  const types = manifest.exports?.['.']?.types;
  if (typeof types !== 'string') {
    throw new Error(
      'package.json exports["."].types is not a path, so there is no published declaration file to check'
    );
  }
  return types;
}

function specifiersIn(declarations) {
  return new Set(
    [...declarations.matchAll(SPECIFIER_PATTERN)].map((match) => match[1])
  );
}

const entry = publishedTypesPath();
let declarations;
try {
  declarations = readFileSync(path.join(ROOT, entry), 'utf8');
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
      'it (docs/specs/adapter.md §3.1). If the module really belongs in the ' +
      'published contract, add it to ALLOWED_SPECIFIERS here and to §3.1 in ' +
      'the same commit.'
  );
}

/**
 * Fails the build when a shipped `.js` or `.d.ts` points at a source map
 * that `dist/` does not contain.
 *
 * tsdown.config.ts splits the build into a JS pass and a declaration-only
 * pass to keep this from happening -- see the comment there for why a
 * single build can't. This check is the regression tripwire for that split:
 * if a future config change or tsdown version reintroduces one build doing
 * both, `pnpm build` fails loudly here instead of publishing a broken
 * pointer again.
 */
const SOURCE_MAPPING_URL_PATTERN = /\/\/# sourceMappingURL=(\S+)\s*$/;

const orphanedSourceMaps = readdirSync(path.join(ROOT, 'dist'))
  // `.js`/`.d.ts` because those are the only extensions `dist/` ever holds;
  // a future third artifact type would need its own comment syntax here too.
  .filter((name) => name.endsWith('.js') || name.endsWith('.d.ts'))
  .flatMap((name) => {
    const match = readFileSync(path.join(ROOT, 'dist', name), 'utf8').match(
      SOURCE_MAPPING_URL_PATTERN
    );
    if (!match) return [];
    if (existsSync(path.join(ROOT, 'dist', match[1]))) return [];
    return [`dist/${name} -> ${match[1]}`];
  });

if (orphanedSourceMaps.length > 0) {
  throw new Error(
    `dist/ ships a sourceMappingURL comment pointing at a file it does not ` +
      `contain: ${orphanedSourceMaps.join(', ')}.\n` +
      "A consumer's tooling that follows it (bundlers, source-map-loader, " +
      'editors) gets a 404/ENOENT. Check tsdown.config.ts -- the two build ' +
      'entries there exist to keep this from happening (#107).'
  );
}
