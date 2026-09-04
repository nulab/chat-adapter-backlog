## Why

<!--
The motivation, not the diff: the problem this solves, the decision behind it,
the alternatives rejected and why. Link the issue if there is one.

`git log -p` already shows what changed. Write down what a future reader could
not recover from it.
-->

## Verification

<!--
Beyond the five gates CI runs
(`pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`),
say what you actually exercised: a real Backlog space (which endpoints, which
plan), a local consumer via `pnpm dev`, or nothing but the default suite.

`pnpm test` runs with no credentials and no network, so a green suite says
nothing about live behavior. If the opt-in live suite ran, say so.
-->

## Before merging

<!-- Delete the lines that do not apply. -->

- [ ] Labeled to match the title's type — `feat`->`enhancement`, `fix`->`bug`,
      `perf`->`performance`, `docs`->`documentation`, deps->`dependencies`, any
      `!`->`breaking`. Release notes are generated from labels
      (`.github/release.yml`); `chore`, `ci`, `refactor`, `test` and `revert`
      have no category and belong in "Other Changes" unlabeled.
- [ ] `package.json` changed: `pnpm-lock.yaml` is committed with it, because CI
      installs with `--frozen-lockfile`.
- [ ] The public entry's exports changed: the smoke test in
      `.github/workflows/ci.yml` changed in this PR too.
- [ ] `exports`, `files`, `engines` or the build config changed: `pnpm build`
      ran locally, since publint and attw run only there.

<!-- Adapter design constraints (rate limits, webhooks, `stream()`): CLAUDE.md -->
