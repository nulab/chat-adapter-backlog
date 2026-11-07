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

- [ ] Labeled per CONTRIBUTING.md "Labels" (release notes are generated from
      labels).
- [ ] `package.json` changed: `pnpm-lock.yaml` is committed with it, because CI
      installs with `--frozen-lockfile`.

<!-- Adapter design constraints: rate limits in .claude/rules/backlog-api-facts.md; webhook authenticity
(D2) and `stream()` (D4) in docs/spec.md's decision table; how to comment and
where each fact lives in CLAUDE.md; title, label, squash body and stacks in CONTRIBUTING.md. -->
