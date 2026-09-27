# Development

Contributor guide for `@nulab/chat-adapter-backlog`. For what the package is
and its current status, see [README.md](./README.md).

Two other files carry the rest, and this one does not repeat them:
[CLAUDE.md](./CLAUDE.md) (`AGENTS.md` is a symlink to it) holds the rules of
the toolchain, the quality gates and the pull-request conventions, for human
contributors and agents alike; the comments in `.github/workflows/*.yml` hold
why each CI and release step is written the way it is, next to the step.

## Setup

pnpm is the only thing to install by hand, at the version `packageManager` in
`package.json` names. The [standalone install script](https://pnpm.io/installation)
needs nothing else present:

```sh
curl -fsSL https://get.pnpm.io/install.sh | env PNPM_VERSION=<packageManager version> sh -
pnpm install     # provisions Node from devEngines.runtime, then `prepare` -> `lefthook install`
```

That is the whole bootstrap. The first install is slower than later ones
because it downloads the pinned Node. From then on reach Node through pnpm
(`pnpm exec node`, `pnpm run …`); a bare `node` in your shell is a different
Node or none at all (CLAUDE.md, Quality gates).

- **Bumping pnpm.** `packageManager` carries a hex integrity hash. Regenerate
  it with `corepack use pnpm@<version>` rather than by hand — npm's
  `dist.integrity` is the same digest in base64, which corepack rejects, so
  base64-decode `npm view pnpm@<version> dist.integrity` to cross-check. The
  Node pnpm provisions ships without corepack or npm, so this needs a Node from
  outside the repository.
- **Bumping Node.** Edit `devEngines.runtime.version` for a new major, and
  move `@types/node` with it. Patches and minors arrive on the next unfrozen
  `pnpm install` as a lockfile change.
- **Another Node for one run.** `pnpm install --no-runtime` leaves the pinned
  runtime out; then run the tool with a bare `node`, not `pnpm run`, which
  would link the runtime back (`.github/workflows/ci.yml`, job `test`). A
  plain `pnpm install` restores it.
- `npm install` in this repository is unsupported: it ignores
  `pnpm-lock.yaml`, provisions no runtime and leaves a `package-lock.json`
  that must not be committed.

## Scripts

| Script              | Command                   | When to use it                                                                                          |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pnpm build`        | `tsdown`                  | Produce `dist/`. Also runs `publint`, `attw` and `scripts/check-published-types.mjs`, and fails on any. |
| `pnpm test`         | `vitest run`              | Run the suite once. Needs no credentials.                                                               |
| `pnpm test:watch`   | `vitest`                  | Watch mode while writing tests.                                                                         |
| `pnpm lint`         | `oxlint --max-warnings 0` | Lint the whole tree, `examples/` included. Warnings fail.                                               |
| `pnpm lint:fix`     | `oxlint --fix`            | Apply the auto-fixable lint results.                                                                    |
| `pnpm format`       | `oxfmt <paths>`           | Format `src`, `examples` and the two config files.                                                      |
| `pnpm format:check` | `oxfmt --check <paths>`   | The same paths, without writing. This is what CI runs.                                                  |
| `pnpm typecheck`    | `tsc --noEmit`            | Type check. `tsconfig.json` never emits; tsdown builds.                                                 |

The five gates CI enforces, and what each one catches, are in CLAUDE.md
"Quality gates". Root-level JSON, YAML and Markdown are formatted by the
pre-commit hook but not checked in CI. oxfmt exits 2 on a path that does not
exist, so removing `examples/` means removing it from the two `format`
scripts.

## Pre-commit hook

[lefthook](https://lefthook.dev/) runs two commands in parallel on staged files
(`lefthook.yml`):

- **oxlint** — `oxlint --fix` on staged `*.{js,ts,jsx,tsx}`, then re-stages
  what it fixed. It ends with `|| true`, so an error it cannot fix does **not**
  block the commit; it blocks CI instead. Run `pnpm lint` yourself.
- **oxfmt** — formats staged `*.{js,ts,jsx,tsx,json,css,html,yaml,yml}`
  (excluding `pnpm-lock.yaml`) and re-stages the result.

Local-only hook tweaks go in `lefthook-local.yml`, which is gitignored.

## Tests

Vitest, `environment: 'node'`, files colocated as `src/**/*.test.ts`; coverage
is measured over `src/**/*.ts` minus tests and declarations. How tests are
written here is CLAUDE.md "Test strategy".

### Opt-in live suite

`src/test/live.test.ts` talks to a real Backlog space and skips itself unless
its variables are set; what it calls and the write budget it keeps are
docs/specs/adapter.md §12.3. Two things to know before setting them:

- `BACKLOG_LIVE_ISSUE_ID` names an issue the suite comments on. Use a scratch
  issue.
- `BACKLOG_LIVE_PULL_REQUEST` (`<repositoryId>:<number>`) adds the
  pull-request section. **Nothing it creates can be cleaned up** — Backlog has
  no endpoint that deletes a pull request or one of its comments — so point it
  at a scratch pull request, in the same project as the scratch issue.

A new live test follows the same shape and stays small and sequential: the
update bucket is on the order of 150 requests per user per minute on a paid
plan and far smaller on a free one (`.claude/rules/backlog-api-facts.md`).

```ts
const liveCredentialsPresent = Boolean(
  process.env.BACKLOG_HOST &&
    process.env.BACKLOG_API_KEY &&
    process.env.BACKLOG_LIVE_ISSUE_ID,
);

describe.skipIf(!liveCredentialsPresent)('live Backlog space', () => {
  // ...
});
```

## Backlog credentials

1. Sign up for a space at [backlog.com](https://backlog.com/). Whether the Free
   plan exposes the API and webhooks is not stated on the pricing page; the
   30-day trial of a paid plan needs no card.
2. In **Personal Settings → API**, issue an API key. If the section is missing,
   a space administrator has to enable API access.
3. `cp .env.example .env` and fill it in. `.env.example` explains every
   variable, the two live-suite ones included; README.md "Environment
   variables" is the consumer-facing table.

`.env` and `.env.*` are gitignored, `.env.example` excepted. Never commit a
real key, and never put it in a URL query string
([Authentication & Authorization](https://developer.nulab.com/docs/backlog/auth/)).

## Supply-chain settings

- `pnpm-workspace.yaml` sets `minimumReleaseAge: 4320` (three days) and
  `.npmrc` sets `min-release-age=3` for npm, so a release younger than that
  does not resolve. Wait it out; if a fresh version is genuinely needed, say
  so in the PR rather than lowering the threshold.
- `allowBuilds: { lefthook: true }` is the only dependency allowed to run
  install scripts; an unlisted one fails the install.
- The Node runtime is a lockfile dependency with a checksum per platform, like
  any other.
- Dependabot (`.github/dependabot.yml`) opens weekly grouped npm and GitHub
  Actions updates with a 3-day cooldown (7 for majors), matching
  `minimumReleaseAge` so an update is proposed the moment it is installable.

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, on every pull request
whatever its base, and as a reusable workflow called by the release. Why each
step is shaped as it is lives in the comments beside it.

| Job         | What it does                                                                                                                                                                                                                        |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lint`      | `pnpm lint`, then `pnpm format:check`.                                                                                                                                                                                              |
| `typecheck` | `pnpm typecheck`.                                                                                                                                                                                                                   |
| `consumer`  | `pnpm build` and `pnpm pack`; installs the tarball with npm outside the repository; runs `scripts/consumer-smoke/smoke.mjs` on Node 20; type checks `documented-usage.ts` and every `examples/*` against the tarball (CLAUDE.md, State of the repo). |
| `test`      | The suite on Node 20, 22, 24 and 26, each asserted to be the Node that actually ran.                                                                                                                                                |

Installs are `--frozen-lockfile`, so commit `pnpm-lock.yaml` with any
`package.json` change. An example is checked by hand the way its README says:
`npm install` and `npm run typecheck` inside its own directory.

## Releasing

`.github/workflows/release.yml`, dispatched by hand. Why each step is written
as it is lives in the comments beside it; this section is how to operate it.

| Input                   | Default | Meaning                                                                                                 |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `newversion`            | `patch` | `patch` / `minor` / `major`, applied to the latest `v*` tag.                                            |
| `dry-run`               | `true`  | Build and pack, upload the tarball as the `package` artifact, and stop. Nothing reaches npm or the repo. |
| `allow-released-commit` | `false` | Let a new run converge on a version tag on `main`'s tip that another run created. Recovery only.        |

The run is CI, then `pack` (fix the version, build, pack; read-only), then
`publish` (skipped on a dry run; the `production` environment): npm publish
with provenance, an annotated tag naming the run, and a GitHub release with
notes categorized by `.github/release.yml`. Each `publish` step skips an
effect that already exists, so a run can be re-run. **Git tags are the version
of record**; `package.json` stays `0.0.0` on `main`. Once trusted publishing is
configured on npmjs.com, no npm token is involved.

### When a release fails part-way

- **Re-run the failed run**, within GitHub's 30-day re-run window. It
  re-derives the same version and finishes what is missing. "Re-run failed
  jobs" reuses the uploaded `package` artifact while it is retained; otherwise
  "Re-run all jobs". Do not dispatch a new run instead: a run that finds a
  version tag it did not create on the commit fails on purpose, naming the run
  that did — that is the run to re-run.
- **Older than 30 days**: dispatch with `allow-released-commit`, which works
  only while `main` still points at the tagged commit.
- **Otherwise, by hand.** Only the GitHub side can be missing, since publish
  comes first. No tag: create an annotated tag on the commit the registry's
  provenance attestation names. No release:
  `gh release create <tag> --verify-tag --generate-notes --notes-start-tag <previous tag>`.
- A `v*` tag whose version was never published stops every later run at
  `pack`. Nothing can depend on it, so delete the tag.
- Two loud endings are correct, not bugs: a re-run seconds after a publish can
  read a lagging 404, publish again and get 403 — wait and re-run; and a
  version already on the registry from another commit, or without provenance,
  stops the run for a human.

### Versioning

Plain [semver](https://semver.org), starting at `0.1.0`; while no `v*` tag
exists, `pack` refuses anything but `minor`.

| Change                                                   | Bump                                  |
| -------------------------------------------------------- | ------------------------------------- |
| Bug fix, internal refactor, docs, dependency bump        | `patch`                               |
| New feature, new export, new config option               | `minor`                               |
| Breaking change to the public surface (`!` in the title) | `major`; `minor` while still on `0.x` |

`chat` stays a peer dependency at a caret range. When a new `chat` major ships,
test against it, move the peer range, and release a new major of this package.

### The first release, step by step

Two constraints fix the order. Provenance is refused for a non-public source
repository ([trusted publishing](https://docs.npmjs.com/trusted-publishers/)),
and trusted publishing cannot be configured before the package exists on npm
([npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/)), so the
first publish authenticates with a token. Nothing in this repository creates
any of the settings below.

1. **Make the repository public** — before the run, not planned for it.
2. **Confirm the publishing account may publish into the `@nulab` scope.**
3. **Create the `production` environment** with a deployment-branch policy of
   `main` and no required reviewers (a reviewer would stop a failed release
   from being re-run unattended). It must exist first: a dispatch naming a
   missing environment creates it unprotected and without secrets
   ([managing environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)).
4. **Store a temporary token as its `NPM_TOKEN` secret**: a granular token,
   read-write on `@nulab`, shortest expiry, with **Bypass 2FA** — without it a
   non-interactive publish stops with `EOTP`
   ([requiring 2FA](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification)).
   If the `nulab` organization enforces 2FA so that option is unavailable, the
   fallbacks are a throwaway `0.0.1` published by hand to bootstrap trusted
   publishing, or `0.1.0` published by hand without provenance. npm plans to
   remove publishing with such tokens in January 2027.
5. **Dispatch with `minor`, `dry-run` on.** The summary must say
   `@nulab/chat-adapter-backlog@0.1.0`, and the packed file list must hold only
   `dist/`, `package.json`, `README.md` and `LICENSE`.
6. **Dispatch with `minor`, `dry-run` off.**
7. **Configure trusted publishing on npmjs.com** — repository
   `nulab/chat-adapter-backlog`, workflow `release.yml`, environment
   `production`, spelled exactly; a mismatch surfaces as a misleading 404 at
   the next publish. Use the UI: a Bypass-2FA token cannot run `npm trust`.
8. **Delete the `NPM_TOKEN` secret, then revoke the token.** Later releases
   authenticate through OIDC alone.
