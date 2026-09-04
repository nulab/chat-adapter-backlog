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
setting, is how the CI test matrix reaches four majors from one lockfile. Use
it the same way locally:

```sh
pnpm install --frozen-lockfile --no-runtime   # then PATH's node runs the gates
pnpm install                                  # restores the pinned runtime
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
- `preinstall` runs `only-allow pnpm`, which aborts the install if it was
  started by npm or Yarn. This produces a hard error, not a warning. It is
  resolved from `node_modules/.bin` rather than through `npx`, because the Node
  pnpm provisions is a single `node` binary — there is no npm or npx beside it.

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
| `pnpm build`         | `tsdown`                                         | Produce `dist/` (ESM + `.d.ts` + source maps). Also runs `publint` and `attw` and fails on either.    |
| `pnpm dev`           | `tsdown --watch`                                 | Rebuild on change while working against a local consumer.                                             |
| `pnpm test`          | `vitest run`                                     | Run the suite once. Required before opening a PR. Needs no credentials.                               |
| `pnpm test:watch`    | `vitest`                                         | Watch mode while writing tests.                                                                       |
| `pnpm test:coverage` | `vitest run --coverage`                          | V8 coverage into `coverage/` (text, json, html, lcov).                                                |
| `pnpm lint`          | `oxlint --max-warnings 0`                        | Lint. Warnings are failures, so `no-console` warnings block CI too.                                   |
| `pnpm lint:fix`      | `oxlint --fix`                                   | Apply the auto-fixable lint results.                                                                  |
| `pnpm format`        | `oxfmt src tsdown.config.ts vitest.config.ts`    | Format the files the formatter owns.                                                                  |
| `pnpm format:check`  | `oxfmt --check src tsdown.config.ts vitest.config.ts` | Verify formatting without writing. This is what CI runs.                                         |
| `pnpm typecheck`     | `tsc --noEmit`                                   | Type check. `tsconfig.json` never emits; tsdown builds.                                               |

Before declaring a change done, run all five gates CI enforces:

```sh
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

Note the scope of `format`/`format:check`: they cover `src`, `tsdown.config.ts`
and `vitest.config.ts` only. Root-level JSON and YAML are formatted by the
pre-commit hook but are not checked in CI, so reformatting them by hand is not
required.

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
  process.env.BACKLOG_API_KEY && process.env.BACKLOG_HOST,
);

describe.skipIf(!liveCredentialsPresent)('live Backlog space', () => {
  it('...', async () => {
    // ...
  });
});
```

Keep such suites small and sequential. Backlog's Update bucket allows on the
order of 150 requests per user per minute, and a chatty live suite will hit
HTTP 429 — see [Rate limit](https://developer.nulab.com/docs/backlog/rate-limit/).

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

   | Variable           | Meaning                                                        |
   | ------------------ | -------------------------------------------------------------- |
   | `BACKLOG_HOST`     | Space host without a scheme, e.g. `example.backlog.com`.       |
   | `BACKLOG_API_KEY`  | The personal API key issued above.                             |

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

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, on pull requests
targeting `main`, and as a reusable workflow called by the release. Four jobs:

| Job          | What it does                                                                       |
| ------------ | ---------------------------------------------------------------------------------- |
| `lint`       | `pnpm lint` then `pnpm format:check`.                                              |
| `typecheck`  | `pnpm typecheck`.                                                                  |
| `build`      | `pnpm build`, then imports `dist/index.js` in a real Node process and asserts the entry loads and `dist/index.d.ts` exists. |
| `test`       | Matrix over Node 20, 22, 24 and 26. Asserts the running Node is the major the job asked for, then `pnpm test`. |

Every job provisions pnpm with `pnpm/action-setup` and `standalone: true`,
which installs the pnpm build with Node.js linked in and reads the version from
`packageManager`. That ordering is not optional: Node is a lockfile dependency
that `pnpm install` provisions, so nothing in CI may assume a Node on PATH
before pnpm has run.

`lint`, `typecheck` and `build` then run `pnpm install --frozen-lockfile` and
get the runtime the lockfile pins, exactly like a contributor — no job carries
a Node version of its own.

`test` is the exception, and the only job that names Node versions.
`actions/setup-node` puts the major under test on PATH and the install adds
`--no-runtime`, so no linked runtime shadows it. That flag is what makes a
matrix possible at all: with the runtime linked, `node_modules/.bin/node` wins
over PATH for every `pnpm run` and `pnpm exec`, and no flag or setting
overrides it — the matrix would run the pinned Node four times and report four
green checks.

Which is why `test` asserts, and asserts two things: that the running Node's
major is the one the job asked for, and that its `execPath` is not inside
`node_modules`. The second half is the one that catches a silently linked
runtime. An earlier matrix went green while testing a single version, and this
assertion is the only guard against that recurring.

Nothing in CI calls a bare `node`. The runner images ship their own, and it
would quietly service any step that asked for it, so the build job's smoke test
goes through `pnpm exec node`.

Installs use `pnpm install --frozen-lockfile`, so `pnpm-lock.yaml` must be
committed alongside any `package.json` change.

The build job's smoke test asserts on the value the entry point exports today.
If you change the public entry, the smoke test in `ci.yml` has to change with
it.

## Releasing

`.github/workflows/release.yml`, triggered manually
(`workflow_dispatch`) with a `patch` / `minor` / `major` choice.

What it does:

1. Runs the whole CI workflow and stops if anything fails.
2. Reads the latest git tag (`v0.0.0` if there is none), writes it into
   `package.json`, then applies the requested bump — **git tags are the version
   of record**. `package.json` stays at `0.0.0` on `main` and the bump is never
   committed back.
3. Builds.
4. Upgrades to the latest npm (Trusted Publishing needs the OIDC support added
   in npm 11.5.1, which is newer than the npm bundled with Node 26). The
   publish job is the only one that needs an npm at all, and gets it from
   `actions/setup-node`; the build in that job still runs on the Node pnpm
   provisions.
5. `npm publish --provenance --access public`, authenticated by
   [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers) via
   GitHub OIDC (`id-token: write`) — there is no npm token anywhere in the
   repository.
6. Pushes the new `vX.Y.Z` tag and creates a GitHub release with generated
   notes, categorized by `.github/release.yml`.

A `concurrency` group serializes releases.

### One-time prerequisites, not set up by anything in this repository

Both of these must exist before the first release can succeed, and neither is
created by the code here:

- **Trusted Publishing must be configured on npmjs.com** for
  `@nulab/chat-adapter-backlog`, pointing at this repository and the
  `release.yml` workflow. Without it, `npm publish` falls back to asking for a
  token and the job fails.
- **The `production` GitHub environment must exist** in the repository
  settings. The publish job declares `environment: production`; add any
  required reviewers or branch restrictions there. See
  [managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
