# Contributing

Contributor guide for `@nulab/chat-adapter-backlog`. For what the package is
and its current status, see [README.md](./README.md).

This file is how to work here: setting up, the commands, CI, the pull-request
conventions and the release. Three other places carry the rest, and this file
does not repeat them: [CLAUDE.md](./CLAUDE.md) (`AGENTS.md` is a symlink to
it) holds the rules for writing code, tests and comments, where each fact
lives, and the files CI couples together, for human contributors and agents
alike; [docs/spec.md](./docs/spec.md) holds the behaviour and
its design decisions; the comments in `.github/workflows/*.yml` and
`pnpm-workspace.yaml` hold why each CI, release and pnpm setting is what it is,
next to the setting.

## Setup

The global [`vp`](https://viteplus.dev/guide/global-cli) is the only thing to
install by hand (the guide has the install script and the Homebrew tap). It
provisions the rest, so nothing else need be on the machine:

```sh
vp install     # Node from devEngines.runtime, pnpm from packageManager, then `prepare` -> `vp config`
```

`vp` runs pnpm underneath, so `packageManager` in `package.json` stays the
source of truth for its version, and `pnpm-workspace.yaml` still carries the
pnpm settings, with the reason for each beside it (`runtimeOnFail: ignore` and
`pmOnFail: ignore` stop pnpm provisioning a Node and a pnpm of its own beside
the ones `vp` selected). `devEngines.runtime` is the only place the development
Node is written down, and it is an exact version; `vp` and the `node` and `npm`
shims it installs resolve it, so `prepare` gets it too. The first run is slower
than later ones because it downloads both.

- **Bumping pnpm.** `packageManager` carries a hex integrity hash, which `vp`
  checks and refuses to install past a mismatch. It is the hex encoding of the
  base64-decoded `dist.integrity` from `npm view pnpm@<version> dist.integrity`
  (drop the `sha512-` prefix, decode, then hex-encode), written after
  `sha512.` as `packageManager` spells it.
- **Bumping Node.** Edit `devEngines.runtime.version`, an exact version, and
  `@types/node` with it. The types track the runtime's major on purpose: ahead
  of it, `vp check` accepts APIs that do not exist at run time; behind it, it
  hides APIs that do. Dependabot cannot see the runtime.
- **Running another Node once**: `vp env use <version>` for the shell, or
  `vp env exec --node <version> <command>`; it overrides `devEngines.runtime`
  without editing it, so do not edit it to test another major. CI does the same
  through `voidzero-dev/setup-vp`'s `node-version`.
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
`docs/sample-messages.md`, `pnpm-lock.yaml`, build output and `examples/**`, which
the root toolchain does not touch at all (CLAUDE.md, `examples/`). Linting and
type checking cover `src/`, `scripts/` and the config only.

## Pre-commit hook

`vp config` (run by `prepare` on every install) installs the Vite+ git hook
dispatcher, and `.vite-hooks/pre-commit` runs `vp staged`, which runs
`vp check --fix` on the staged files (the `staged` block in `vite.config.ts`;
see [Commit Hooks](https://viteplus.dev/guide/commit-hooks)). **It blocks the
commit** when a check fails after the fixes are applied. `VP_GIT_HOOKS=0 git
commit …` skips it for one commit.

`prepare` writes `core.hooksPath` into the clone's shared `.git/config`, so
every worktree of the clone uses the Vite+ hooks, and a worktree that has not
run an install yet (`.vite-hooks/_` is generated and git-ignored) runs no hook
at all.

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

## Supply-chain settings

- `minimumReleaseAge` (three days) and `allowBuilds` are set, with their
  reasons, in `pnpm-workspace.yaml`; `.npmrc`'s `min-release-age=3` applies the
  same quarantine to npm. A brand-new version does not resolve, and that is
  intended: wait, or say in the PR that a fresh version is genuinely needed,
  rather than lowering the threshold.
- `vp` downloads Node from nodejs.org and verifies the PGP signature of the
  release's `SHASUMS256.txt` against Node's release keys, then the archive's
  SHA-256 ([Node.js signature verification](https://viteplus.dev/guide/env#node-js-signature-verification)).
  No checksum is committed here: with `runtimeOnFail: ignore` the lockfile
  holds no runtime entry, `minimumReleaseAge` does not reach the runtime, and
  `devEngines.runtime.version` being exact is what keeps a CI run from taking a
  Node released that day (a range would resolve to the newest release).
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

| Job     | What it does                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `check` | `vp check` then `vp pack`: format check, lint, type check, then the build with publint, attw and the published-types check. |
| `test`  | The suite on Node 22, 24 and 26, each asserted to be the Node that actually ran.                                            |

Installs are `--frozen-lockfile`, so commit `pnpm-lock.yaml` with any
`package.json` change.

## Pull requests

Three rules shape every PR here, and they interact: work reaches `main` only as
a squash commit, stacked PRs are actively used, and the release notes are
generated from labels.

### Titles

Conventional Commits, **with a scope**, because the title becomes a commit
subject on `main`: `feat(webhook): 401 a request with no path secret`.

Types used here: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `ci`,
`chore`, `revert`. Two are deliberately absent: `style`, because Vite+'s
formatter owns formatting and a formatting-only change is a `chore` on the scope it touched;
and `build`, because `build` is a _scope_ here — the toolchain change that
would be `build:` elsewhere is `chore(build)` or `fix(build)`.

| Scope       | Covers                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `adapter`   | the `Adapter` surface: the class, `createBacklogAdapter`, thread-ID codec, egress, reads, reactions, presence, `stream()` |
| `client`    | the `backlog-js` client: the injected `fetch`, auth, the 429 retry, typed errors, the response schemas                    |
| `webhook`   | webhook ingress: verification, body parsing, the `processMessage` dispatch                                                |
| `format`    | markup conversion — the `BaseFormatConverter` subclass and its AST both ways                                              |
| `build`     | `exports`/`files`, `tsconfig.json`, the `pack` block of `vite.config.ts`, publint/attw                                    |
| `toolchain` | pnpm, the pinned Node runtime, Vite+ and the rest of `vite.config.ts` (`lint`, `fmt`, `test`, `staged`), the git hooks    |
| `ci`        | `.github/workflows/ci.yml` and the Node matrix                                                                            |
| `release`   | `.github/workflows/release.yml`, `.github/release.yml`, publishing, versioning                                            |
| `deps`      | dependency and lockfile bumps — what Dependabot opens                                                                     |
| `docs`      | README, CONTRIBUTING.md, CLAUDE.md/AGENTS.md, the PR template, `docs/`, `.claude/rules/`                                  |
| `examples`  | `examples/*` — the deployable sample bots and their index README                                                          |

Tests take the scope of the code they cover, not a scope of their own:
`test(client)`, never `test(test)`.

If no scope fits, the PR is usually too broad — split it. If it really is a
new area, add the scope to this table in the same PR; do not invent a one-off
that appears in the history exactly once.

A breaking change carries `!` before the colon (`feat(adapter)!: …`) and
repeats itself as a `BREAKING CHANGE:` footer in the squash body.

### Labels

Label the PR when you open it. `.github/release.yml` builds the release notes
from labels alone, and because of its `'*'` catch-all an unlabeled PR does not
fail anything — it is filed under "Other Changes", silently, and the published
notes stay wrong until someone edits them by hand.

Read the label off the title's type:

| Title                                                      | Label                                     | Section          |
| ---------------------------------------------------------- | ----------------------------------------- | ---------------- |
| `feat`                                                     | `enhancement`                             | New Features     |
| `fix`                                                      | `bug`                                     | Bug Fixes        |
| `perf`                                                     | `performance`                             | Performance      |
| `docs`                                                     | `documentation`                           | Documentation    |
| `chore(deps)` / `fix(deps)`, and anything Dependabot opens | `dependencies`                            | Dependencies     |
| any `!` title or `BREAKING CHANGE:` footer                 | `breaking`, **plus** the type's own label | Breaking Changes |
| `chore`, `ci`, `refactor`, `test`, `revert`                | none — leave it unlabeled                 | Other Changes    |

- The last row is the only case where unlabeled is right, and it is a decision
  rather than a forgotten step: no category covers those types, and stretching
  `enhancement` over a refactor advertises a change users cannot observe as a
  new feature.
- `breaking` is the first category in `release.yml` and a PR lands in exactly
  one category, so a breaking feature carrying both labels appears under
  Breaking Changes, which is the intent.
- Dependabot applies `dependencies` and an ecosystem label itself, so its PRs
  need nothing from you.
- **Nothing in this repository creates the six labels**; the maintainer created
  them. If `gh pr edit --add-label enhancement` fails because the label does
  not exist, say so in the PR and stop — do not create one, and never settle for
  a near-miss like `feature` or `bugfix`, which the generated notes cannot tell
  apart from unlabeled.

### Squash merge

Squash merge is the only merge enabled, so the branch's commits never reach
`main` and their Why bodies are lost unless they are carried into the squash
commit message. GitHub's default message is not a substitute for a body
somebody wrote. Before merging, write the squash message on purpose: subject =
the PR title, body = the Why consolidated from the branch's commits and the PR
description, with the `BREAKING CHANGE:` footer if there is one. A PR body that
says "see the commits" leaves nothing behind on `main`. A non-squash merge is
the maintainer's call, not a contributor's.

### Stacked PRs

Use them. A dependent change split into a stack gives each part a reviewable
diff and gets the bottom of it merged while the top is still being written.

- **Base each PR on the previous branch, not `main`:**
  `gh pr create --base <parent-branch>`. GitHub fixes the base when the PR is
  opened, so a stack member opened with the default base shows its parent's
  commits as its own; repair that by editing the base, not by rebasing.
- **Declare the dependency** as the first line of the PR body's Why:
  `Stacked on #12 — merge that first.`
- **Review and merge bottom-up.** A child never merges ahead of its parent.
- **After the parent is squash-merged**, the child's branch still carries the
  parent's commits while `main` has that content only inside the squash commit,
  so the child's diff presents the parent's work a second time. Record
  `<parent-tip>` (`git rev-parse origin/<parent-branch>`) before the parent
  branch is deleted — or recover it from the PR's merge event or `git reflog` —
  then:

  ```sh
  git fetch origin && git rebase --onto origin/main <parent-tip> <child-branch> && git push --force-with-lease
  ```

  Plain `git rebase origin/main` conflicts instead: a squash is patch-identical
  to none of the branch's commits, so git replays the parent's commits and
  hands you the conflicts ([git-rebase](https://git-scm.com/docs/git-rebase)).
  `--onto` names the graft point and the cut point separately, so only the
  child's own commits are replayed.

- **`--force-with-lease` only on a stack branch**, after that rebase — never on
  `main`.

A stack is the wrong tool when:

- The parts are not genuinely dependent. Open them as separate PRs off `main`:
  they merge in any order and none of them pays the rebase above.
- The bottom PR would leave `main` broken. That is one indivisible change, not a
  stack — every PR merges on its own and must pass all the gates on its own.
- The stack is getting deep. Each merge costs a rebase and a force-push on every
  branch above it, so keep a stack to two or three and merge the bottom promptly.

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
