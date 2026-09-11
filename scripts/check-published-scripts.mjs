/**
 * Fails the build when package.json declares a lifecycle script that a
 * consumer's package manager would run while installing this package.
 *
 * npm and Yarn run a dependency's `preinstall`, `install` and `postinstall`
 * on the consumer's machine, where only this package's `dependencies` exist.
 * A `preinstall` of `only-allow pnpm` — a devDependency — therefore made
 * every npm install of the published tarball exit 127 with
 * `sh: only-allow: command not found` (#99, measured 2026-09-09 with npm
 * 10.8.2 and 11.19.0). A published manifest cannot be replaced, so the
 * check runs before anything is built rather than after.
 *
 * It reads package.json, not a packed manifest, because `npm publish` — what
 * release.yml runs — ships `scripts` verbatim (`npm pack` strips nothing;
 * measured 2026-09-09). `pnpm pack` is the wrong reference: it drops
 * `prepare`, `prepack`, `postpack` and `prepublishOnly`, so a guard reading
 * its output would describe a manifest the release never publishes.
 *
 * `prepare` is allowed on purpose. No package manager runs a dependency's
 * `prepare` when the dependency comes from the registry (npm 10.8.2, npm
 * 11.19.0, Yarn 1.22.22 and 4.18.0, measured 2026-09-09; npm documents it as
 * an install script "for non-registry sources" only). A git or directory
 * install would run it, but `files: ["dist"]` ships no `dist/` from a clone
 * either, so that route is not one a consumer can take. It stays because
 * lefthook's own `postinstall` cannot be relied on to install the hooks: pnpm's
 * side-effects cache replays a cached build instead of re-running the script,
 * which left a fresh clone with no `pre-commit` hook, and lefthook skips itself
 * under `CI=true` (measured 2026-09-09 with lefthook 2.1.12, pnpm 12.2.1).
 *
 * Plain `.mjs` and no flags so `pnpm build` needs nothing from the Node it
 * happens to run on, like check-published-types.mjs beside it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CONSUMER_INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];

const manifest = JSON.parse(
  readFileSync(path.join(ROOT, 'package.json'), 'utf8')
);

const shipped = CONSUMER_INSTALL_SCRIPTS.filter(
  (name) => manifest.scripts?.[name] !== undefined
);

if (shipped.length > 0) {
  throw new Error(
    `package.json declares ${shipped.map((s) => `"${s}"`).join(', ')}, ` +
      'which npm and Yarn run on a consumer\'s machine when this package is ' +
      'installed as a dependency, with only its `dependencies` present.\n' +
      '`npm publish` ships `scripts` verbatim, so this would break every npm ' +
      'and Yarn install of the published package (#99). Automation for ' +
      'contributors belongs in `prepare`, which a registry install never ' +
      'runs, or outside lifecycle scripts altogether.'
  );
}
