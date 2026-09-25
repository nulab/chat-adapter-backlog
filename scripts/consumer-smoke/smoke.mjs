/**
 * The published package as a consumer receives it: resolved through
 * `node_modules`, on the floor of `engines.node`, configured by nothing but
 * the environment.
 *
 * The `build` job's smoke test imports `./dist/index.js` by path on the Node
 * `devEngines.runtime` pins, which proves the bundle tsdown just emitted
 * loads. A path import consults neither `exports` nor `files`, and the pinned
 * runtime is not the one the package promises support for, so the two jobs
 * cover different halves of the same claim
 * (docs/plans/adapter-implementation.md §1 criterion 6 and §3 P7 acceptance,
 * docs/specs/adapter.md §13).
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE = '@nulab/chat-adapter-backlog';

/**
 * The tarball ships `dist/` (`files`), plus the three files every packer adds
 * on its own. Asserting the whole listing rather than the presence of `dist/`
 * is what makes a file added to `files` a decision somebody makes here too:
 * anything else in a consumer's `node_modules` is weight they did not ask for
 * and a path they can import around `exports`.
 */
const PUBLISHED_ENTRIES = ['LICENSE', 'README.md', 'dist', 'package.json'];

const expectedNodeMajor = process.env.EXPECTED_NODE_MAJOR;

assert.equal(
  process.versions.node.split('.')[0],
  expectedNodeMajor,
  `ran Node ${process.versions.node}, not the Node ${expectedNodeMajor} this job asked for`
);

// The same pair of assertions the test matrix makes, for the same reason: a
// runtime `pnpm` linked into `node_modules/.bin` shadows PATH, and a job that
// only checks the major would report a pass for the wrong Node.
assert.ok(
  !process.execPath.includes('node_modules'),
  `ran a pnpm-linked runtime at ${process.execPath}, not the Node ${expectedNodeMajor} this job asked for`
);

const manifestUrl = import.meta.resolve(`${PACKAGE}/package.json`);
const installedRootUrl = new URL('.', manifestUrl).href;

assert.match(
  manifestUrl,
  new RegExp(`/node_modules/${PACKAGE}/package\\.json$`),
  `${PACKAGE} resolved to ${manifestUrl}, which is not an installed package`
);

const installedRoot = path.dirname(fileURLToPath(manifestUrl));

assert.deepEqual(
  readdirSync(installedRoot).sort(),
  PUBLISHED_ENTRIES,
  'the installed package does not hold exactly the files the tarball is meant to ship'
);

const manifest = JSON.parse(
  readFileSync(path.join(installedRoot, 'package.json'), 'utf8')
);
const declarations = manifest.exports['.'].types;

assert.ok(
  existsSync(path.resolve(installedRoot, declarations)),
  `exports["."].types points at ${declarations}, which the tarball does not contain`
);

assert.ok(
  import.meta.resolve(PACKAGE).startsWith(installedRootUrl),
  `importing ${PACKAGE} resolves outside the installed package, so exports["."] is not what answered`
);

/**
 * Constructing the adapter must not reach Backlog: the transport is built on
 * first use, and this job holds no credentials to build one with. Replacing
 * `fetch` states that as a guarantee instead of a belief — if construction
 * ever grows an eager request, this fails here rather than by hanging against
 * a host that does not exist.
 */
globalThis.fetch = () => {
  throw new Error('constructing the adapter must not reach the network');
};

const adapterModule = await import(PACKAGE);

assert.equal(
  typeof adapterModule.createBacklogAdapter,
  'function',
  `${PACKAGE} does not export createBacklogAdapter`
);

// No argument: every field comes from a BACKLOG_* variable, which is the
// zero-config construction CLAUDE.md's conventions promise and the explicit
// config the `build` job's smoke test passes cannot exercise.
const adapter = adapterModule.createBacklogAdapter();

assert.equal(adapter.name, 'backlog');
assert.equal(adapter.userName, process.env.BACKLOG_BOT_USER_NAME);

// `console.error`, not `console.log`: oxlint's `no-console` allows `warn` and
// `error` only, and `--max-warnings 0` makes the difference a failing lint.
console.error(
  `${PACKAGE} resolved from ${installedRootUrl} and constructed as ${adapter.userName} on Node ${process.versions.node}`
);
