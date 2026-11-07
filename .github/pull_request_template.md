## Why

<!--
The motivation, not the diff: the problem this solves, the decision behind it,
the alternatives rejected and why. Link the issue if there is one.

`git log -p` already shows what changed. Write down what a future reader could
not recover from it.
-->

## Verification

<!--
Beyond the three gates CI runs
(`vp check && vp test && vp pack`),
say what you actually exercised: a real Backlog space (which endpoints, which
plan), a local consumer of `vp pm pack`'s tarball, or nothing but the default suite.

`vp test` runs with no credentials and no network, so a green suite says
nothing about live behavior.
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
- [ ] The public entry's exports changed: `scripts/consumer-smoke/smoke.mjs`
      changed in this PR too.
- [ ] `exports`, `files`, the env fallbacks or `engines.node` changed:
      `scripts/consumer-smoke/smoke.mjs` changed in this PR too (CLAUDE.md,
      State of the repo).

<!-- Adapter design constraints: rate limits in .claude/rules/backlog-api-facts.md; webhook authenticity
(D2) and `stream()` (D4) in docs/specs/adapter.md's decision table; how to comment and
where each fact lives in CLAUDE.md. -->
