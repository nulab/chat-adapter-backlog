# Development

Contributor guide for `@nulab/chat-adapter-backlog`. For what the package is
and its current status, see [README.md](./README.md).

Two other files carry the rest, and this one does not repeat them:
[CLAUDE.md](./CLAUDE.md) (`AGENTS.md` is a symlink to it) holds the rules of
the toolchain, the quality gates and the pull-request conventions, for human
contributors and agents alike; the comments in `.github/workflows/*.yml` hold
why each CI and release step is written the way it is, next to the step.

## Setup

The global [`vp`](https://viteplus.dev/guide/global-cli) is the only thing to
install by hand (the guide has the install script and the Homebrew tap). It
provisions the rest, so nothing else need be on the machine:

```sh
vp install     # Node from devEngines.runtime, pnpm from packageManager, then `prepare` -> `vp config`
```

`vp` runs pnpm underneath, so `packageManager` in `package.json` stays the
source of truth for its version, and `pnpm-workspace.yaml` still carries the
pnpm settings. `runtimeOnFail: ignore` and `pmOnFail: ignore` there stop pnpm
provisioning a Node and a pnpm of its own beside the ones `vp` selected
(CLAUDE.md, Quality gates). The first run is slower than later ones because it
downloads both.

- **Bumping pnpm.** `packageManager` carries a hex integrity hash, which `vp`
  checks and refuses to install past a mismatch. It is the hex encoding of the
  base64-decoded `dist.integrity` from `npm view pnpm@<version> dist.integrity`
  (drop the `sha512-` prefix, decode, then hex-encode), written after
  `sha512.` as `packageManager` spells it.
- **Bumping Node.** Edit `devEngines.runtime.version`, an exact version, and
  `@types/node` with it (CLAUDE.md, Quality gates). Dependabot cannot see it.
- **Running another Node once**: `vp env use <version>` for the shell, or
  `vp env exec --node <version> <command>`; it overrides `devEngines.runtime`
  without editing it.
- `npm install` in this repository is unsupported: it ignores
  `pnpm-lock.yaml` and leaves a `package-lock.json` that must not be
  committed.

## Commands

The gates are [Vite+](https://viteplus.dev/guide/) built-ins, configured in
`vite.config.ts`. There are no wrapper scripts; `package.json` keeps only
`prepare`, which installs the git hooks.

| Command    | When to use it                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `vp check` | Format check, lint and type check in one run. This is what CI runs. `vp check --fix` writes the formatting and fixes. |
| `vp test`  | Run the suite once. Needs no credentials. `vp test watch` is watch mode while writing tests.                          |
| `vp pack`  | Produce `dist/`. Fails on a `publint`, `attw` or published-types problem.                                             |

The three gates CI enforces, and what each one catches, are in CLAUDE.md
"Quality gates". Formatting covers the whole repository except the generated
`sample-messages.md`, `pnpm-lock.yaml`, build output and `examples/**`, which
the root toolchain does not touch at all (CLAUDE.md, `examples/`); linting and
type checking also skip `scripts/consumer-smoke`.

## Pre-commit hook

`vp config` (run by `prepare` on every install) installs the Vite+ git hook
dispatcher, and `.vite-hooks/pre-commit` runs `vp staged`, which runs
`vp check --fix` on the staged files (the `staged` block in `vite.config.ts`;
see [Commit Hooks](https://viteplus.dev/guide/commit-hooks)). Unlike the hook
it replaces, **this one blocks the commit** when a check fails after the fixes
are applied. `VP_GIT_HOOKS=0 git commit …` skips it for one commit.

`prepare` writes `core.hooksPath` into the clone's shared `.git/config`, so
every worktree of the clone switches to the Vite+ hooks at once, and a worktree
that is on a branch from before this change, or has not run an install yet
(`.vite-hooks/_` is generated and git-ignored), runs no hook at all.

The hook needs `node` on PATH, because `node_modules/.bin/vp` is pnpm's shim and
it `exec`s `node`. A terminal with `vp` installed has it; a GUI git client or
an IDE that does not get `~/.vite-plus/bin` on PATH fails the commit with
`VITE+ - pre-commit script failed (code 127)`. Either put that directory on
PATH from `~/.config/vite-plus/hooks-init.sh`, which the hook sources before it
runs, or commit with `VP_GIT_HOOKS=0`.

## Tests

Vitest, bundled with Vite+ and imported from `vite-plus/test`, `environment:
'node'`, files colocated as `src/**/*.test.ts`. How tests are written here is
CLAUDE.md "Test strategy".

### Opt-in live suite

`src/test/live.test.ts` talks to a real Backlog space and skips itself unless
its variables are set; what it calls and the write budget it keeps are in that
file's header. Two things to know before setting them:

- `BACKLOG_BOT_USER_ID` must be the id of the API key's owner:
  `removeReaction` compares the presenter's id with it.
- `BACKLOG_LIVE_ISSUE_ID` names an issue the suite comments on. Use a scratch
  issue: each run leaves a comment with a file on it, which Backlog does not
  let anyone delete.
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
  process.env.BACKLOG_BOT_USER_ID &&
  process.env.BACKLOG_LIVE_ISSUE_ID
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

- The three-day release quarantine and `allowBuilds` are CLAUDE.md "Quality
  gates". `.npmrc`'s `min-release-age=3` applies the same quarantine to npm.
  If a fresh version is genuinely needed, say so in the PR rather than
  lowering the threshold.
- `vp` downloads Node from nodejs.org and verifies the PGP signature of the
  release's `SHASUMS256.txt` against Node's release keys, then the archive's
  SHA-256 ([Node.js signature verification](https://viteplus.dev/guide/env#node-js-signature-verification)).
  No checksum is committed here: `minimumReleaseAge` and the lockfile do not
  reach the runtime, and `devEngines.runtime.version` being exact is what keeps
  a CI run from taking a Node released that day.
- The global `vp` is the one thing here that no lockfile pins, and its trust
  root is different from an npm dependency's. CI's `voidzero-dev/setup-vp` is
  pinned to a commit, and it installs `vp` by running `install.sh` fetched
  from the `voidzero-dev/vite-plus` git tag of the version `vite-plus` has in
  `package.json`, which is why that version is exact. The script checks the
  platform package's npm `dist.integrity` (sha512) and its provenance
  attestation before installing it. If the tagged script cannot be fetched,
  `setup-vp` falls back to the latest script on viteplus.dev. Neither
  `minimumReleaseAge` nor `.npmrc`'s `min-release-age` applies to this
  download, so a `vp` release is as new as its `vite-plus` bump in
  `package.json`, which only Dependabot's cooldown holds back; that guarantee
  is weaker than the one the dependencies get.
- Dependabot (`.github/dependabot.yml`) opens weekly grouped npm and GitHub
  Actions updates with a 3-day cooldown (7 for majors), matching
  `minimumReleaseAge` so an update is proposed the moment it is installable.

## CI

`.github/workflows/ci.yml` runs on pushes to `main`, on every pull request
whatever its base, and as a reusable workflow called by the release. Why each
step is shaped as it is lives in the comments beside it.

| Job        | What it does                                                                                                                                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`    | `vp check`: format check, lint and type check.                                                                                                                                                                                                     |
| `consumer` | `vp pack` and `vp pm pack`; installs the tarball with npm outside the repository; runs `scripts/consumer-smoke/smoke.mjs` on Node 22; type checks `documented-usage.ts` against the tarball (CLAUDE.md, State of the repo). |
| `test`     | The suite on Node 22, 24 and 26, each asserted to be the Node that actually ran.                                                                                                                                                                   |

Installs are `--frozen-lockfile`, so commit `pnpm-lock.yaml` with any
`package.json` change.

## Releasing

`.github/workflows/release.yml`, dispatched by hand. Why each step is written
as it is lives in the comments beside it; this section is how to operate it.

| Input                   | Default | Meaning                                                                                                  |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `newversion`            | `patch` | `patch` / `minor` / `major`, applied to the latest `v*` tag.                                             |
| `dry-run`               | `true`  | Build and pack, upload the tarball as the `package` artifact, and stop. Nothing reaches npm or the repo. |
| `allow-released-commit` | `false` | Let a new run converge on a version tag on `main`'s tip that another run created. Recovery only.         |

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
   ([requiring 2FA](https://docs.npmjs.com/requiring-2fa-for-package-publishing-and-settings-modification));
   on `EOTP`, rotate the secret to a token that has it and re-run. If the
   `nulab` organization enforces 2FA so that option is unavailable, the
   fallbacks are a placeholder `0.0.1` published by hand to bootstrap trusted
   publishing — it is `latest` until `0.1.0` lands, and a published version
   number can never be reused — or `0.1.0` published by hand without
   provenance. npm plans to remove publishing with such tokens in January 2027.
5. **Dispatch from `main` with `minor`, `dry-run` on.** The summary must say
   `@nulab/chat-adapter-backlog@0.1.0`, and the packed file list must hold only
   `dist/`, `package.json`, `README.md` and `LICENSE`. A dry run needs neither
   the environment nor the token, so it can also go first.
6. **Dispatch from `main` with `minor`, `dry-run` off.** `publish` refuses any
   other ref.
7. **Configure trusted publishing on npmjs.com** — repository
   `nulab/chat-adapter-backlog`, workflow `release.yml`, environment
   `production`, spelled exactly; a mismatch surfaces as a misleading 404 at
   the next publish. Use the UI: a Bypass-2FA token cannot run `npm trust`.
8. **Delete the `NPM_TOKEN` secret, then revoke the token.** Later releases
   authenticate through OIDC alone.
