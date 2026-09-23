/**
 * Removes a `sourceMappingURL` comment from a shipped `.js` or `.d.ts` when
 * the map it points at was not itself shipped.
 *
 * `dts: { sourcemap: false }` in tsdown.config.ts (see the comment there) is
 * meant to drop both `index.d.ts.map` and the comment pointing at it, and it
 * does for the `tsc` and `oxc` declaration generators. With TypeScript 7
 * installed, though, `rolldown-plugin-dts` picks its `tsgo` generator
 * instead, which shells out to the `tsgo` binary with `-p tsconfig.json` and
 * is only ever told to *add* `--declarationMap`, never to negate the `true`
 * already in that file (#102, measured with tsdown 0.22.14 and 0.23.x).
 * `tsgo` then writes `//# sourceMappingURL=index.d.ts.map` into the
 * declaration text before rolldown-plugin-dts bundles it into `index.d.ts`,
 * pointing at a `.d.ts.map` the bundler never writes.
 *
 * This scans every shipped `.js`/`.d.ts` rather than only `index.d.ts`, so
 * it also survives a future tsdown version choosing a different generator
 * for the same reason, or a second entry point. `index.js.map` is
 * unaffected: `sourcemap: true` at the top level is honoured for the JS
 * build regardless of generator, so its comment's target exists and this
 * script leaves it alone.
 *
 * Runs between `tsdown` and check-published-types.mjs in `pnpm build`, so
 * the guard there never sees the orphaned comment this removes. Plain
 * `.mjs` and no flags, like its siblings.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const SOURCE_MAPPING_URL_PATTERN = /\n+\/\/# sourceMappingURL=(\S+)\s*$/;

for (const name of readdirSync(DIST)) {
  if (!name.endsWith('.js') && !name.endsWith('.d.ts')) continue;

  const filePath = path.join(DIST, name);
  const contents = readFileSync(filePath, 'utf8');
  const match = contents.match(SOURCE_MAPPING_URL_PATTERN);
  if (!match) continue;

  const mapTarget = path.join(DIST, match[1]);
  if (existsSync(mapTarget)) continue;

  writeFileSync(filePath, contents.slice(0, match.index));
}
