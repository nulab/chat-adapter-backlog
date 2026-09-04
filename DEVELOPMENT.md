# Development

Contributor guide for `@nulab/chat-adapter-backlog`. For what the package is
and its current status, see [README.md](./README.md).

## Prerequisites

### Node.js

Provisioned by pnpm, not by mise. `pnpm-workspace.yaml` sets
`useNodeVersion: 24.20.0`; `pnpm install` downloads that Node and puts it on
PATH for every `pnpm run` and `pnpm exec`, which is every gate.

Nothing else in the repository provisions a Node, so **reach it through pnpm**.
A bare `node` runs whatever your shell already had — possibly nothing, and
possibly a different version than the one the gates use. `pnpm exec node`,
`pnpm exec vitest` and `pnpm run <script>` all get 24.20.0.

`useNodeVersion` takes an exact version and rejects ranges: `24` crashes pnpm
inside its own version check, and `24.x` and `lts` are rejected as invalid. So
the patch version is written out, and unlike the `node = "24"` it replaces it
does **not** follow 24.x on its own — bumping it is a deliberate edit to
`pnpm-workspace.yaml`, and no update tool watches it.

`package.json` declares `"engines": { "node": ">=22" }` and CI runs the test
suite on Node 22, 24 and 26, so a change that only works on 24 will fail there.
pnpm 10 exposes no environment variable for `useNodeVersion`, only a
per-invocation flag, so each matrix job resolves its major to an exact version
and passes it to every pnpm command it runs. Do the same to try another version
locally:

```sh
pnpm --config.use-node-version="$(pnpm env list --remote 22 | tail -1)" run test
```

If you do not use mise, install pnpm 10.34.5 yourself; nothing else in the
repository depends on mise, and Node follows from pnpm either way.

### pnpm

pnpm is the only supported package manager, and the only tool mise provisions.

- `mise.toml` pins the version under `[tools]`, so `pnpm` is on PATH for
  anyone — and any CI job — with a mise-managed toolchain. This is not circular
  with Node coming from pnpm: the pnpm mise installs is a standalone executable
  with Node.js linked into it, so it runs on a machine that has no `node`,
  `npm` or `npx` at all.
- The same version is declared in `package.json`'s `packageManager` field, with
  a hex integrity hash over the pnpm tarball. pnpm reads the field itself and
  re-downloads if the running version disagrees, so **the two have to be bumped
  together**. Regenerate the hash with `corepack use pnpm@<version>` rather
  than writing one by hand; the base64 digest npm publishes as `dist.integrity`
  is the same bytes in an encoding corepack rejects.
- `preinstall` runs `only-allow pnpm`, which aborts the install if it was
  started by npm or Yarn. This produces a hard error, not a warning. It is
  resolved from `node_modules/.bin` rather than through `npx`, because the Node
  pnpm provisions is a single `node` binary — there is no npm or npx beside it.

[Corepack](https://nodejs.org/api/corepack.html) is deliberately not part of
the setup. Node stopped bundling it after 24, so `corepack enable` means
something different on each Node version in the test matrix and cannot be
relied on to put `pnpm` anywhere in particular. It is also not reachable from
the toolchain any more: the Node pnpm installs ships neither corepack nor npm.
Running `corepack use` to regenerate the `packageManager` hash therefore needs
a Node of your own, outside this project.

## Setup

```sh
mise install     # provisions pnpm
pnpm install     # provisions Node, and runs `prepare` -> `lefthook install`
```

`pnpm install` installs the git hooks through the `prepare` lifecycle script,
so no separate hook-installation step is needed. It also downloads the Node
from `useNodeVersion` on first run, so the first install is slower than later
ones.

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

`pnpm-workspace.yaml` also sets `onlyBuiltDependencies: [lefthook]`: lefthook is
the only dependency allowed to run install scripts.

Dependabot (`.github/dependabot.yml`) opens weekly grouped npm and
GitHub Actions updates with its own cooldown — 7 days for any update, 30 for
majors.

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, on pull requests
targeting `main`, and as a reusable workflow called by the release. Four jobs:

| Job          | What it does                                                                       |
| ------------ | ---------------------------------------------------------------------------------- |
| `lint`       | `pnpm lint` then `pnpm format:check`.                                              |
| `typecheck`  | `pnpm typecheck`.                                                                  |
| `build`      | `pnpm build`, then imports `dist/index.js` in a real Node process and asserts the entry loads and `dist/index.d.ts` exists. |
| `test`       | `pnpm test` on a Node 22 / 24 / 26 matrix, `fail-fast: false`. Each job asserts that the Node major it actually got is the one it advertises. |

Node comes from `useNodeVersion` in every job, so `lint`, `typecheck` and
`build` run on the same 24.20.0 a contributor gets. The `test` matrix overrides
it per job: it resolves the major to an exact version with
`pnpm env list --remote <major>` and passes `--config.use-node-version` to each
pnpm command, because pnpm 10 has no environment variable that would set it
once for the whole job. A command that forgets the flag silently runs 24.20.0
instead, which is what the assertion catches — it fails both when a job did not
get the major it is named after and when the version that ran is not the one
that was resolved.

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
   in npm 11.5.1, which is newer than the npm bundled with Node 24). The
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
