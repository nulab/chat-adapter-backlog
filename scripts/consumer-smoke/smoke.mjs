/**
 * The published package as a consumer receives it: resolved through
 * `node_modules`, on the floor of `engines.node`, configured by nothing but
 * the environment.
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
 *
 * The attempts are counted as well as refused, because `initialize` catches a
 * failed `GET /users/myself` and logs it rather than rejecting: a throw alone
 * would let an unwanted lookup pass as a warning.
 */
let networkAttempts = 0;
globalThis.fetch = () => {
  networkAttempts += 1;
  throw new Error('the adapter must not reach the network in this job');
};

const adapterModule = await import(PACKAGE);

assert.equal(
  typeof adapterModule.createBacklogAdapter,
  'function',
  `${PACKAGE} does not export createBacklogAdapter`
);

// No argument: every field comes from a BACKLOG_* variable, which is the
// zero-config construction CLAUDE.md's conventions promise.
const adapter = adapterModule.createBacklogAdapter();

assert.equal(adapter.name, 'backlog');
assert.equal(adapter.userName, process.env.BACKLOG_BOT_USER_NAME);

// BACKLOG_BOT_USER_ID is set, so `initialize` has nothing to ask
// `GET /users/myself` for — with the name set, and again without it.
const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLogger;
  },
};
await adapter.initialize({ getLogger: () => silentLogger });
assert.equal(
  networkAttempts,
  0,
  'initialize reached the network although botUserId was configured'
);

delete process.env.BACKLOG_BOT_USER_NAME;
await adapterModule
  .createBacklogAdapter()
  .initialize({ getLogger: () => silentLogger });
assert.equal(
  networkAttempts,
  0,
  'initialize reached the network to learn only the bot name'
);

// The three variables README.md calls required, and nothing else: the bot
// identity is left to `GET /users/myself`, which `initialize` would make —
// construction still must not.
delete process.env.BACKLOG_BOT_USER_ID;
assert.equal(adapterModule.createBacklogAdapter().name, 'backlog');
assert.equal(networkAttempts, 0, 'construction reached the network');

// `console.error`, not `console.log`: oxlint's `no-console` allows `warn` and
// `error` only, and `--max-warnings 0` makes the difference a failing lint.
console.error(
  `${PACKAGE} resolved from ${installedRootUrl} and constructed as ${adapter.userName} on Node ${process.versions.node}`
);
