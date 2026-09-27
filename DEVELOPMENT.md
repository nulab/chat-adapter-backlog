# Development

Contributor guide for `@nulab/chat-adapter-backlog`. For what the package is
and its current status, see [README.md](./README.md).

## Prerequisites

### Node.js

One Node runs everything, and pnpm provisions it. `package.json` declares it as
a range:

```json
"devEngines": {
  "runtime": { "name": "node", "version": "^26.0.0", "onFail": "download" }
}
```

`pnpm install` resolves that range to the newest matching release, installs it
like any other dependency and links it as `node_modules/.bin/node`. The
resolved version **and a checksum for every platform tarball** land in
`pnpm-lock.yaml`, so a bump is a reviewable diff and every machine and CI job
gets bytes that were pinned rather than whatever nodejs.org serves that day.

**Reach it through pnpm.** `pnpm exec node`, `pnpm exec vitest`,
`pnpm run <script>` and a bare `node` inside a script all resolve
`node_modules/.bin` first and get the pinned runtime. A bare `node` in your own
shell is *not* this Node, and on a machine set up only for this repository it
does not exist at all — that is expected, not a broken setup.

You do not need a Node to get a Node. `pnpm install` bootstraps from nothing
but pnpm itself, because the standalone pnpm build has Node.js linked into the
binary. This did not work on pnpm 10, which ran dependency install scripts
before linking the runtime's bin — lefthook's `postinstall` died on
`node: command not found`
([pnpm/pnpm#14358](https://github.com/pnpm/pnpm/issues/14358)) — and which
checked dependency `engines` against the old Node linked into pnpm itself,
silently dropping the platform packages oxlint, oxfmt and rolldown load their
native bindings from. Both are fixed as of the pnpm this repository pins, which
is why there is no longer a `mise.toml` provisioning a second Node to bootstrap
with.

The range follows 26.x on its own: a new patch or minor arrives on the next
unfrozen `pnpm install` and shows up as a lockfile change. Moving to another
major means editing `devEngines.runtime.version` — one place now.

`@types/node` tracks the same major (`^26`), so `pnpm typecheck` checks against
the API surface that exists at run time. Holding it behind the runtime hides
APIs you can use; running it ahead quietly lets the type checker approve APIs
the runtime does not have. Move the two together.

There is still no per-invocation override of the runtime. Because pnpm installs
Node as a real dependency, `node_modules/.bin/node` shadows everything else:
`--config.useNodeVersion` and `PNPM_SHIM_BYPASS` are both accepted and then
ignored. What does work is **`pnpm install --no-runtime`**, which skips
fetching and linking the runtime and leaves the rest of the install alone — so
whatever Node is on PATH is the one that runs. That flag, not an override
setting, is how the CI test matrix reaches four majors from one lockfile.

There is a catch, and it is the reason the matrix does not use `pnpm run`.
`pnpm run` and `pnpm exec` verify installed dependencies against the lockfile
before running anything, and a runtime left out by `--no-runtime` looks exactly
like a dependency that is missing — so pnpm downloads and links the pinned Node
and services the command with it, undoing the override. So run the tool
directly:

```sh
pnpm install --frozen-lockfile --no-runtime
node node_modules/vitest/vitest.mjs run   # bare `node`, not `pnpm test`
pnpm install                              # restores the pinned runtime
```

`package.json` also declares `"engines": { "node": ">=20" }`. That is the range
the published package supports — it matches the `engines.node` of the `chat`
core package, so the adapter does not narrow what its own peer accepts — and
unlike before, **it is backed by jobs**: the test matrix runs the suite on Node
20, 22, 24 and 26. Note that the *toolchain* is stricter than the package:
oxlint, oxfmt, rolldown and vite need Node 20.19 or newer, and tsdown needs
22.18 or newer, so the build never runs on 20. Consumers on Node 20 are
unaffected — they install neither.

### pnpm

pnpm is the only supported package manager, and it is now the only thing you
have to install by hand.

Get it any way that yields the version in `packageManager` — the
[standalone install script](https://pnpm.io/installation) is the one that needs
nothing else present:

```sh
curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=12.2.1 sh -
```

- `package.json`'s `packageManager` field is the single place the version is
  written down, carrying a hex integrity hash over the pnpm tarball. pnpm reads
  the field itself and re-downloads if the running version disagrees, so a
  mismatch costs a download rather than silently using the wrong pnpm. CI reads
  the same field.
- Regenerate the hash with `corepack use pnpm@<version>` rather than writing
  one by hand; the base64 digest npm publishes as `dist.integrity` is the same
  bytes in an encoding corepack rejects. Cross-check by base64-decoding
  `npm view pnpm@<version> dist.integrity` to hex — it must equal what corepack
  wrote.
- The pinned version is deliberately **not** the newest pnpm on npm. `latest`
  means the newest release that is at least three days old, the same quarantine
  `minimumReleaseAge` applies to every other dependency, and pnpm ships several
  patches a week. Bumping it is a normal dependency bump, not a special case.
- Nothing in the manifest refuses an npm install any more. `preinstall` used to
  run `only-allow pnpm`, but npm and Yarn run a dependency's `preinstall` on
  the consumer's machine, and `only-allow` is a devDependency no consumer has,
  so every npm install of the published package failed with exit 127 (#99;
  `scripts/check-published-scripts.mjs` now fails the build on any such
  script). The `packageManager` field still turns Yarn 1 away outright — it
  insists on Corepack — and makes pnpm switch itself to the pinned version.
  `devEngines.packageManager` was measured and not adopted: npm enforces it on
  `npm version` and `npm publish` as well as `npm install`, and those two are
  how release.yml publishes. Running `npm install` here is unsupported rather
  than impossible: it ignores `pnpm-lock.yaml`, provisions no runtime, and
  leaves a `package-lock.json` behind that must not be committed.

[Corepack](https://nodejs.org/api/corepack.html) is deliberately not part of
the setup. Node stopped bundling it after 24, so `corepack enable` cannot be
relied on to put `pnpm` anywhere in particular, and it is not reachable from
the toolchain's runtime either: the Node pnpm installs is a single binary, with
neither corepack nor npm beside it. Regenerating the `packageManager` hash is
the one job it still has, and that needs a Node from **outside** this
repository — any Node that still ships corepack, or `npm install -g corepack`.

## Setup

```sh
pnpm install     # provisions the runtime, and runs `prepare` -> `lefthook install`
```

That is the whole bootstrap, on a machine with nothing but pnpm on PATH.

`pnpm install` installs the git hooks through the `prepare` lifecycle script,
so no separate hook-installation step is needed. It also downloads the Node
from `devEngines.runtime` on first run, so the first install is slower than
later ones.

## Scripts

| Script               | Command                                          | When to use it                                                                                        |
| -------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `pnpm build`         | `tsdown`                                         | Produce `dist/` (ESM + `.d.ts` + source maps). Also runs `publint`, `attw` and the two `scripts/check-published-*.mjs` guards, and fails on any. |
| `pnpm dev`           | `tsdown --watch`                                 | Rebuild on change while working against a local consumer.                                             |
| `pnpm test`          | `vitest run`                                     | Run the suite once. Required before opening a PR. Needs no credentials.                               |
| `pnpm test:watch`    | `vitest`                                         | Watch mode while writing tests.                                                                       |
| `pnpm test:coverage` | `vitest run --coverage`                          | V8 coverage into `coverage/` (text, json, html, lcov).                                                |
| `pnpm lint`          | `oxlint --max-warnings 0`                        | Lint. Warnings are failures, so `no-console` warnings block CI too.                                   |
| `pnpm lint:fix`      | `oxlint --fix`                                   | Apply the auto-fixable lint results.                                                                  |
| `pnpm format`        | `oxfmt src examples tsdown.config.ts vitest.config.ts` | Format the files the formatter owns.                                                            |
| `pnpm format:check`  | `oxfmt --check src examples tsdown.config.ts vitest.config.ts` | Verify formatting without writing. This is what CI runs.                                  |
| `pnpm typecheck`     | `tsc --noEmit`                                   | Type check. `tsconfig.json` never emits; tsdown builds.                                               |

Before declaring a change done, run all five gates CI enforces:

```sh
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

Note the scope of `format`/`format:check`: they cover `src`, `examples`,
`tsdown.config.ts` and `vitest.config.ts` only. Root-level JSON and YAML are
formatted by the pre-commit hook but are not checked in CI, so reformatting
them by hand is not required.

`examples` is in that list because the example READMEs written by three
people should not drift in style, and oxfmt formats Markdown as well as
TypeScript — it aligns tables and normalises bullets to `-`, though it never
reflows prose. Two consequences: write a README and let `pnpm format` settle
it rather than hand-aligning a table, and do not remove `examples/` without
removing it from these two scripts, because oxfmt exits 2 on a path that does
not exist.

`pnpm lint` needs no equivalent change and never did: it passes no path, so
oxlint covers the whole working tree minus `ignorePatterns`, `examples/`
included.

## Pre-commit hook

[lefthook](https://lefthook.dev/) runs two commands in parallel on staged files
(`lefthook.yml`):

- **oxlint** — `oxlint --fix` on staged `*.{js,ts,jsx,tsx}`, then re-stages what
  it fixed. It ends with `|| true`, so a lint error that cannot be auto-fixed
  does **not** block the commit — it will block CI instead. Run `pnpm lint`
  yourself.
- **oxfmt** — formats staged `*.{js,ts,jsx,tsx,json,css,html,yaml,yml}`
  (excluding `pnpm-lock.yaml`) and re-stages the result.

Local-only hook tweaks go in `lefthook-local.yml`, which is gitignored.

## Tests

- Runner: [Vitest](https://vitest.dev/), `environment: 'node'`.
- Test files are colocated with the source and matched by
  `src/**/*.test.ts` — nothing outside `src/` is collected.
- Coverage is measured over `src/**/*.ts`, excluding `*.test.ts` and `*.d.ts`.
- Name tests after the behavior they specify, not the function they call.

`pnpm test` must stay runnable with no credentials, no network and no Backlog
space. Platform clients are replaced with `vi.mock`; do not reach for msw or
nock.

### Opt-in live suite

Anything that talks to a real Backlog space must skip itself when the
credentials are absent, so that the default suite and CI stay green:

```ts
import { describe, it } from 'vitest';

const liveCredentialsPresent = Boolean(
  process.env.BACKLOG_HOST &&
    process.env.BACKLOG_API_KEY &&
    process.env.BACKLOG_LIVE_ISSUE_ID,
);

describe.skipIf(!liveCredentialsPresent)('live Backlog space', () => {
  it('...', async () => {
    // ...
  });
});
```

Keep such suites small and sequential. Backlog allows writes on the order of
150 requests per user per minute, and a chatty live suite will hit
HTTP 429 — see [Rate limit](https://developer.nulab.com/docs/backlog/rate-limit/).

The adapter's own live suite has two sections, and each one skips itself.

The **issue section** runs when `BACKLOG_HOST`, `BACKLOG_API_KEY` and
`BACKLOG_LIVE_ISSUE_ID` are all set, and stays within eight write calls: Get
Project, Get Issue, then add, edit, star, unstar and delete one comment, and
upload one small attachment and attach it before deleting that comment too. It
creates no issues and touches no notifications. Point `BACKLOG_LIVE_ISSUE_ID` at a scratch issue: the suite
comments on it.

The **pull-request section** runs when `BACKLOG_LIVE_PULL_REQUEST` is set on
top of those three, and stays within six write calls: Get Git Repository, Get
Pull Request, then add, edit, star and unstar one comment, then upload one
small attachment and attach it to a second comment. It also asserts what the
adapter refuses — `deleteMessage` on a pull-request thread throws
`AdapterError` with code `UNSUPPORTED_OPERATION` without calling `fetch` at
all.

**Nothing that section creates is cleaned up**, because there is nothing to
clean it up with: Backlog has no endpoint that deletes a pull request or one of
its comments, and `DELETE …/pullRequests/:number/comments/:commentId` answers
400 with error code 6 `Undefined resource`
(`.claude/rules/backlog-pull-request-facts.md`, measured 2026-09-06). Every
comment the section adds stays on the pull request for good, so point
`BACKLOG_LIVE_PULL_REQUEST` at a scratch pull request, never a real one.

The variable is `<repositoryId>:<number>` — the two coordinates the thread-id
grammar writes as `pr:<repositoryId>:<number>`. Backlog keys every
pull-request endpoint by a third one, the project, and no endpoint derives it
from a repository id, so the section reads it from `BACKLOG_LIVE_ISSUE_ID`'s
issue. **The scratch pull request must therefore live in the same project as
the scratch issue.**

## Backlog credentials

You need a Backlog space and a personal API key.

1. Sign up for a space at [backlog.com](https://backlog.com/). Whether the
   Free plan exposes the API and webhooks is not stated on the pricing page --
   if you hit a wall there, the 30-day trial of a paid plan needs no card.
2. In Backlog, open **Personal Settings → API** and issue a new API key. If the
   API section is missing, a space administrator has to enable API access for
   the space.
3. Copy `.env.example` to `.env` and fill it in:

   ```sh
   cp .env.example .env
   ```

   Each variable is the fallback for the matching field of
   `createBacklogAdapter({ ... })`, and only for the single-space
   configuration shape. An explicit empty value is a validation error, not a
   request to fall back.

   | Variable                | Required                | Meaning                                                                                                                            |
   | ----------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
   | `BACKLOG_HOST`          | yes                     | Space host without a scheme, port or path, e.g. `example.backlog.com`. Also `backlog.jp` and legacy `backlogtool.com` domains.      |
   | `BACKLOG_API_KEY`       | one of these two        | The personal API key issued above. Sent in the `Backlog-API-Key` header.                                                            |
   | `BACKLOG_ACCESS_TOKEN`  | one of these two        | OAuth 2.0 bearer token instead of a key. Expires after an hour; the adapter runs no OAuth flow, so use the resolver form long-term.  |
   | `BACKLOG_BOT_USER_ID`   | no                      | Numeric id of the bot user; read from `GET /api/v2/users/myself` for the key above when unset. Recognises the bot's own messages.    |
   | `BACKLOG_BOT_USER_NAME` | no                      | The bot's display name as Backlog renders it; read from `GET /api/v2/users/myself` when unset. What the mention pattern matches.    |
   | `BACKLOG_WEBHOOK_SECRET`| unless a verifier is set| Secret carried in the webhook URL's `token` parameter, at least 16 bytes. Backlog signs nothing, so this is the only sender-side check available. |
   | `BACKLOG_LIVE_ISSUE_ID` | live suite only         | Numeric id of a scratch issue the opt-in live suite comments on.                                                                     |
   | `BACKLOG_LIVE_PULL_REQUEST` | live suite only     | `<repositoryId>:<number>` of a scratch pull request in the same project as `BACKLOG_LIVE_ISSUE_ID`. The suite comments on it and cannot clean up: Backlog has no delete. |

   Generate the webhook secret with `openssl rand -hex 32` and treat it as a
   credential: it is the entire authenticity check on the ingress path, because
   [Add Webhook](https://developer.nulab.com/docs/backlog/api/2/add-webhook/)
   accepts no secret parameter and Backlog sends no signature header.

`.env` is gitignored (`.env` and `.env.*` are ignored, `.env.example` is the
one exception). Never commit a real key, and never put it in a URL query
string — see [Authentication &
Authorization](https://developer.nulab.com/docs/backlog/auth/).

## Supply-chain settings

New releases of a dependency are quarantined before they can be installed, so
that a compromised publish has a window to be caught and unpublished.

- `pnpm-workspace.yaml` sets `minimumReleaseAge: 4320` (4320 minutes = 3 days).
  pnpm reads only auth and registry settings from `.npmrc`, so this has to live
  here. See [pnpm settings](https://pnpm.io/settings#minimumreleaseage).
- `.npmrc` sets `min-release-age=3` (days), which covers npm. The release
  workflow is the one place npm runs; the toolchain here provides no npm or
  npx, so the setting only applies if you bring your own. See the
  [npm config reference](https://docs.npmjs.com/cli/v11/using-npm/config#min-release-age).

**Consequence:** a dependency version published less than 3 days ago will not
resolve. `pnpm add some-package` can fail, or silently resolve to an older
version, purely because the newest release is too fresh. That is working as
intended — wait it out rather than lowering the threshold. If a fresh version
is genuinely required, raise it in the PR instead of changing the setting
quietly.

`pnpm-workspace.yaml` also sets `allowBuilds: { lefthook: true }`: lefthook is
the only dependency allowed to run install scripts. Nothing builds by default,
and an install script from a package that is not listed there fails the install
rather than being skipped quietly. (This replaced `onlyBuiltDependencies`,
which pnpm 11 removed.)

The Node runtime is covered by the same lockfile guarantee as any dependency,
because `devEngines.runtime` makes pnpm install it as one — see
[Node.js](#nodejs) above.

Dependabot (`.github/dependabot.yml`) opens weekly grouped npm and
GitHub Actions updates with its own cooldown — 3 days for any update, 7 for
majors. The default matches `minimumReleaseAge`, so a release becomes
installable and eligible for a PR at the same moment; a longer cooldown would
only hold the update back after it was already safe to take.

## Pull requests

How a change lands is written down once, in [CLAUDE.md](./CLAUDE.md) (`AGENTS.md`
is a symlink to it), and applies to human contributors and agents alike: squash
merge as the standard, Conventional Commit titles with a scope from a fixed
vocabulary, the label each PR needs before `.github/release.yml` can file it
under the right heading, and how to build a stack of dependent PRs and unwind it
after the bottom one merges. `.github/pull_request_template.md` is the short
form you get in the PR form.

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, on **every** pull request
whatever branch it is based on — so a stacked PR is checked before its parent
merges — and as a reusable workflow called by the release. Five jobs:

| Job          | What it does                                                                       |
| ------------ | ---------------------------------------------------------------------------------- |
| `lint`       | `pnpm lint` then `pnpm format:check`.                                              |
| `typecheck`  | `pnpm typecheck`.                                                                  |
| `build`      | `pnpm build`, then imports `dist/index.js` in a real Node process and asserts the entry loads and `dist/index.d.ts` exists. |
| `consumer`   | `pnpm pack`, then installs the tarball with npm into a directory outside the repository, runs `scripts/consumer-smoke/smoke.mjs` on Node 20, and type checks the documented usage and every `examples/*` against the same tarball. |
| `test`       | Matrix over Node 20, 22, 24 and 26. Asserts the running Node is the major the job asked for, then runs the suite (`vitest run`) with a bare `node`. |

Every job provisions pnpm with `pnpm/action-setup` and `standalone: true`,
which installs the pnpm build with Node.js linked in and reads the version from
`packageManager`. That ordering is not optional: Node is a lockfile dependency
that `pnpm install` provisions, so nothing in CI may assume a Node on PATH
before pnpm has run.

`lint`, `typecheck` and `build` then run
`pnpm install --frozen-lockfile` and get the runtime the lockfile pins, exactly
like a contributor — no job carries a Node version of its own.

`test` and `consumer` are the two that name a Node version, and they get it on
PATH in opposite ways. `consumer` installs with the runtime, because building
and packing are development commands and belong on the pinned Node; Node 20
reaches the consumer half because nothing after the pack goes through pnpm
but a read of the lockfile. `test` cannot do that — every step it has left is a pnpm command — so it
installs with `--no-runtime` instead.

`test` is the exception among the gates, and the only job that names several
Node versions.
`actions/setup-node` puts the major under test on PATH and the install adds
`--no-runtime`, so no linked runtime shadows it. That flag is what makes a
matrix possible at all: with the runtime linked, `node_modules/.bin/node` wins
over PATH for every `pnpm run` and `pnpm exec`, and no flag or setting
overrides it — the matrix would run the pinned Node four times and report four
green checks.

After that install the job stops using pnpm, and that is deliberate: `pnpm run`
and `pnpm exec` re-materialize the skipped runtime and would hand the step the
pinned Node anyway. The assertion and the suite both run through a bare `node`,
so exactly one Node is in play.

Which is why `test` asserts, and asserts two things: that the running Node's
major is the one the job asked for, and that its `execPath` is not inside
`node_modules`. The second half is the one that catches a linked runtime. An
earlier matrix went green while testing a single version, and this assertion is
the only guard against that recurring — it is also what caught the
re-materializing install rather than letting it pass as three green checks.

A bare `node` appears only where a job has deliberately put one on PATH with
`actions/setup-node`: the assertion and the suite in `test`, and the npm
installs, the consumer script and the type checks in `consumer`. Everywhere
else it goes through `pnpm exec node`, the build job's smoke test included —
the runner images ship a Node of their own, and it would quietly service any
step that asked for it.

Installs use `pnpm install --frozen-lockfile`, so `pnpm-lock.yaml` must be
committed alongside any `package.json` change.

The build job's smoke test asserts on the value the entry point exports today.
If you change the public entry, the smoke test in `ci.yml` has to change with
it.

`consumer` covers what a path import cannot. It packs the tarball with
`pnpm pack --out` — a name of its own, because the default is derived from
`version`, which stays `0.0.0` on `main` — installs it with npm under
`$RUNNER_TEMP`, and runs `scripts/consumer-smoke/smoke.mjs` from there:
outside the repository, so nothing can be answered by the repo's own
`node_modules`. What it asserts is the published surface rather than the
bundle — that the entry resolves through `exports`, that the installed tree is
exactly `dist/`, `package.json`, `README.md` and `LICENSE`, that
`exports["."].types` names a file that shipped, and that
`createBacklogAdapter()` with no argument builds an adapter out of the five
`BACKLOG_*` variables on Node 20, the floor of `engines.node`, whose
`initialize` then makes no request — the two `BACKLOG_BOT_*` variables are
what spares it `GET /users/myself` — and builds one more out of the three
required variables alone.

The install runs lifecycle scripts, as a consumer's does, so a `preinstall`
the tarball should not carry (#99) fails it rather than being stepped around.
`scripts/check-published-scripts.mjs` is the guard that names the cause; this
install is where a consumer would have met it.

Two type checks follow, against the declarations that shipped rather than
`src/`. `attw` and `check-published-types.mjs` prove the declarations resolve
and import nothing a consumer lacks, but not that the calls the README
documents compile. `scripts/consumer-smoke/documented-usage.ts` writes those
calls out — the `Chat` construction, `chat.webhooks.backlog`, the
`BacklogPostableExtras` and `BacklogChannelPostableExtras` postables, the
mention helpers, `installations` with a resolver-function `apiKey`,
`adapter.api`/`client`/`botUserName` and
`createInMemoryBacklogApi` — and the job compiles it strict, under `NodeNext`,
with `tsc --noEmit`. It reads `message.subject` too, but proves nothing about
the `'pull_request'` it compares against: `chat` types `subject.type` as
`string`, so that literal is pinned by the suite, not the compiler. Nothing
extracts the README's code blocks into it, so a README sample that changes
shape changes that file in the same commit.

Its `chat`, `@chat-adapter/state-memory` and TypeScript are exact versions,
because no lockfile exists out there and a range would turn the job red for an
upstream release rather than a change here. They are not committed in
`scripts/consumer-smoke/package.json`: the job reads each from
`pnpm-lock.yaml` (`pnpm list --lockfile-only`) and writes it in with
`npm pkg set` before `npm install`, so the lockfile is the one place they are
written down. A committed pin would have no owner — Dependabot watches `/`
only — and the first peer bump it missed would make npm refuse the install
with ERESOLVE. `@types/node` is the exception and stays committed, on the
major the consumer runs: the lockfile only holds the types for the pinned
runtime.

Then every `examples/*` is copied under `$RUNNER_TEMP`, its
`@nulab/chat-adapter-backlog` dependency rewritten to the tarball, installed
with npm and checked with its own `npm run typecheck`. An example is a
standalone project that depends on the published adapter, and the tarball is
that release before it exists — the only way to check an example without
pointing it at `src/`, which would let it compile against a declaration the
package does not ship. The step checks every example before it fails, so one
red run names all of the broken ones. The root `lint` and `format:check` cover
`examples/` as well.

That step is skipped when `release.yml` calls the workflow (`skip-examples`),
and that is a trade-off, not an oversight. An example declares ranges and
ships no lockfile, so an upstream release can turn it red with nothing changed
here, and a release gated on it would be blocked by an example rather than by
the package. The cost is that a release can go out while an example is broken
against it; pull requests and pushes to `main` still run the step, so the
break is reported there. The skip is an input because nothing else can tell a
called run apart: inside a reusable workflow the `github` context, and so
`github.event_name`, belongs to the caller.

By hand, an example is checked the way its README tells a reader to: `npm
install` and `npm run typecheck` inside its own directory — npm, not pnpm, for
the reason `examples/README.md` gives.

## Releasing

`.github/workflows/release.yml`, triggered manually (`workflow_dispatch`).
The design and the evidence behind it are in
[docs/plans/release-mechanism.md](./docs/plans/release-mechanism.md).

| Input                   | Default | Meaning                                                                                                        |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------------------- |
| `newversion`            | `patch` | `patch` / `minor` / `major`, applied to the latest tag.                                                        |
| `dry-run`               | `true`  | Build and pack, upload the tarball as the `package` artifact, and stop: nothing reaches npm or the repository. |
| `allow-released-commit` | `false` | Let a new run converge on a version tag on the commit that another run created. For recovery only — see below. |

A dispatch nobody thought about is therefore a dry run. To release, set
`dry-run` to `false`.

What it does:

1. Runs the whole CI workflow and stops if anything fails.
2. **`pack`** — fixes the target version, then builds and packs. If a `v*` tag
   already points at the commit, that tag is the version; otherwise it is the
   latest tag (`v0.0.0` if there is none) plus the requested bump. **Git tags
   are the version of record**: `package.json` stays at `0.0.0` on `main` and
   the bump is never committed back. Before building, it checks that the
   latest tag's version is on the registry — a tag that was never published
   would otherwise be bumped past and its version skipped — and that no tag
   for the target version sits on another commit. This job runs the install
   and the build, and holds neither `id-token: write` nor `contents: write`.
   The run summary shows the package, the tag, the notes range and the Node
   and npm that packed; the packed file list is in the log.
3. **`publish`** — skipped on a dry run. It runs in the `production`
   environment, refuses any ref but `main`, and never checks out or runs the
   repository's code: it downloads the tarball `pack` made, checks it holds
   the version being released, and converges on three effects, each skipped
   if it already exists.
   - **npm.** If the version is not on the registry,
     `npm publish <tarball> --provenance --access public`. If it is, the
     provenance attestation must name this commit, this repository and
     `release.yml`, or the step fails; a version published without provenance
     fails too, and is a human's call.
   - **The tag**, created through the API on the released commit as an
     annotated tag whose message names the run (`release.yml run <id>`). An
     existing tag that points anywhere else fails the step.
   - **The GitHub release**, with notes generated from the previous tag and
     categorized by `.github/release.yml`.

A `concurrency` group serializes releases.

**Node and npm.** Packing and publishing use the npm bundled with the Node
the lockfile pins (`devEngines.runtime`; 26.9.0 with npm 11.19.1 as of
2026-09-26). `pack` installs, reads that version back with
`pnpm exec node --version`, and hands the exact version to
`actions/setup-node` in both jobs; `publish` asserts that its npm is the one
that packed, and that it is at least the 11.5.1 trusted publishing needs.
`node-version: 26` would resolve the newest 26.x on the day — a two-day-old
26.10.0 on 2026-09-23, which `minimumReleaseAge` keeps out of every other
install here — and could give the two jobs different npms. The build still
runs on the Node pnpm provisions. An upgrade to `npm@latest` was removed on
purpose — it would have installed npm 12.1.0 the day it shipped, and
`.npmrc`'s `min-release-age` does not reach it: a project `.npmrc` "is not
read in global mode"
([npmrc](https://docs.npmjs.com/cli/v11/configuring-npm/npmrc)).

**Authentication.** `npm publish` tries OIDC first: once a trusted publisher is
configured on npmjs.com, every release is authenticated by it and there is no
npm token in the repository. If the `production` environment holds an
`NPM_TOKEN` secret, it is used whenever the OIDC exchange fails — which is the
case for the first publish only (see the checklist below). Leaving the secret
unset is how every later release runs.

### When a release fails part-way

**Re-run the failed run**, at the same commit, within 30 days — GitHub allows
a re-run "up to 30 days after its initial run"
([re-running workflows](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs)).
The job re-derives the same version (the tag on the commit, or the same latest
tag plus the same bump), skips whatever already took effect and finishes the
rest. "Re-run failed jobs" re-runs `publish` alone, which downloads the
`package` artifact the first `pack` uploaded, so it works only while that
artifact is within the repository's artifact retention; otherwise use "Re-run
all jobs", which packs again. Do not dispatch a new run instead: a run that
finds a version tag on the commit that it did not create fails on purpose,
naming the tag and the run that did, so that "release again" can never succeed
at doing nothing. Re-running the run the guard refused fails the same way; it
is the run that *created* the tag that has to be re-run.

`allow-released-commit` is for the case a re-run cannot reach: the failed run
is more than 30 days old. A dispatch always runs the tip of `main`, so this
works only while `main` still points at the tagged commit; with the input set,
the run converges exactly like a re-run. Once `main` has moved on, finish the
half-done release by hand — create the missing tag (annotated) or GitHub
release on the commit the registry's attestation names. A `v*` tag whose
version was never published stops every later run at `pack`; nothing can
depend on a version that does not exist, so delete that tag.

Two endings are loud and correct, not bugs. The registry's read path can lag
its write path, so a re-run seconds after a publish can see 404, publish again
and get 403 — wait and re-run. And a version already on the registry from
another commit, or without provenance, stops the run for a human to decide.

### Versioning

Plain [semver](https://semver.org), starting at `0.1.0`: the first release is
`release.yml` with `minor`. `newversion` defaults to `patch` because that is
the common case afterwards; while no `v*` tag exists, `pack` refuses anything
but `minor`.

| Change                                                   | Bump                                  |
| -------------------------------------------------------- | ------------------------------------- |
| Bug fix, internal refactor, docs, dependency bump        | `patch`                               |
| New feature, new export, new config option               | `minor`                               |
| Breaking change to the public surface (`!` in the title) | `major`; `minor` while still on `0.x` |

`chat` stays a peer dependency at a caret range. When a new `chat` major
ships, test against it, widen or move the peer range, and release a new major
of this package.

### The first release, step by step

Nothing in this repository creates any of the settings below, and the order is
not negotiable in two places: trusted publishing **cannot** be configured
before the package exists on npm — `npm trust` and npmjs.com require the
package to be on the registry already
([npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)) — so the
first publish authenticates with a token; and the repository has to be public
before anything publishes, because provenance is refused for a non-public
source repository
([trusted publishing](https://docs.npmjs.com/trusted-publishers/)).

1. **Make the repository public.** It has to have happened before the run, not
   be planned: a run against a non-public repository fails at the publish.
2. **Confirm the publishing account may publish into the `@nulab` scope** on
   npm. The scope and the organization already exist.
3. **Create the `production` environment** with a deployment-branch policy of
   `main`, and no required reviewers — a reviewer would make a failed release
   impossible to re-run unattended. It must exist, with its `main` policy,
   before the first dispatch with `dry-run` off: a dispatch naming a missing
   environment does not fail, it creates the environment unprotected and with
   no secrets
   ([managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
4. **Store a temporary token as the environment's `NPM_TOKEN` secret**: a
   granular access token with read-write permission on the `@nulab` scope and
   the shortest expiry that covers the day. The secret must exist before the
   real dispatch. npm requires 2FA or a granular token with **Bypass 2FA**
   enabled for creating and publishing packages
   ([requiring 2FA](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification)),
   so without that option a non-interactive publish stops with `EOTP`; rotate
   the secret to a token that has it and re-run. npm says not to enable it
   where an organization requires fully enforced 2FA; if `nulab` does, the
   first publish needs another route (release-mechanism.md §5 step 2). npm
   also plans to remove direct publishing with such tokens in January 2027,
   which a token used once before then does not meet.
5. **Dispatch `release.yml` with `minor`, `dry-run` left on.** Check the
   summary says `@nulab/chat-adapter-backlog@0.1.0`, and the packed file list
   holds only `dist/`, `package.json`, `README.md` and `LICENSE`. The dry run
   needs neither the environment nor the token, so it can also go first.
6. **Dispatch `release.yml` with `minor` and `dry-run` off.** `0.1.0` is
   published with provenance, tagged and released.
7. **Configure trusted publishing on npmjs.com** for the package: repository
   `nulab/chat-adapter-backlog`, workflow `release.yml`, environment
   `production`. Every field must match exactly — a mismatch surfaces as a
   misleading 404 at the next publish.
8. **Delete the `NPM_TOKEN` secret, then revoke the token on npmjs.com.** From
   here on releases authenticate through OIDC alone, and nothing in the
   workflow changes.
