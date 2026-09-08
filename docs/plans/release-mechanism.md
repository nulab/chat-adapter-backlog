# Release mechanism

How `@nulab/chat-adapter-backlog` should cut a release, reconsidered before
the first one is ever cut. `.github/workflows/release.yml` exists, has never
run, and its shape (`workflow_dispatch` with a `patch` / `minor` / `major`
choice) was written before anybody asked whether a release-PR tool would suit
this repository better.

**This document changes no workflow.** It records what was verified, what the
choice actually turns on, one recommendation, and the decisions that are the
maintainer's. The implementation is a separate PR, after the recommendation is
accepted or replaced. Issue **#53** is the first run of whatever comes out of
this; two of the three weaknesses it lists are solved here by design rather
than patched (§6).

Everything below was checked on **2026-09-09**. Where a claim could not be
established from a primary source, it says so instead of guessing.

## 1. Verified premises

### 1.1 A push or a tag made with `GITHUB_TOKEN` still starts nothing

The rule is unchanged. GitHub's own concept page states it without
qualification:

> Events triggered by the `GITHUB_TOKEN` will not create a new workflow run

with two long-standing exceptions — `workflow_dispatch` and
`repository_dispatch` — and it spells out the case that matters here:

> if a workflow run pushes code using the repository's `GITHUB_TOKEN`, a new
> workflow will not run even when the repository contains a workflow
> configured to run when `push` events occur

([GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token),
[Trigger a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow),
both read 2026-09-09).

**What did change**, and is almost certainly what prompted the question:
on **2026-06-11** GitHub shipped
[Bot-created pull requests can run workflows if approved](https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/)
— a pull request opened by `github-actions[bot]` now creates workflow runs in
an *approval-required* state, and a user with write access starts them from the
merge box. Before that, such a pull request ran no CI at all. The concept page
reflects it: `pull_request` with activity type `opened`, `synchronize` or
`reopened` is now a third exception, gated on that approval; `labeled`,
`edited` and `closed` are not.

That is a change to **`pull_request` only**. Push, tag creation and the
`release` event are exactly as restricted as they were. A second June change,
[Control who and what triggers GitHub Actions workflows](https://github.blog/changelog/2026-06-18-control-who-and-what-triggers-github-actions-workflows/)
(public preview, 2026-06-18), adds an admin allow-list over actors and events;
it can only restrict triggering further, never relax it.

`release-please-action`'s own README still carries the warning, in the present
tense: resources it creates with the default token — tags, releases, pull
requests — do not trigger future workflows, and `release.created` does not run
([release-please-action](https://github.com/googleapis/release-please-action),
read 2026-09-09).

**Consequences for any design here.** Three, and the first is the load-bearing
one:

1. A two-workflow release — *A* computes and pushes the tag, *B* runs
   `on: push: tags` or `on: release` and publishes — **does not work** with
   `GITHUB_TOKEN`. It needs a GitHub App installation access token or a PAT,
   which the docs name as the escape hatch. The alternative is to keep the
   publish in the *same run* that created the tag, which is what
   release-please's documented pattern does (`if: steps.release.outputs.release_created`).
2. CI on a bot-authored release PR is possible now but is a **manual approval
   click per release PR**, not an automatic run — unless the PR is opened with
   an App token or a PAT.
3. Not separately verified, but it follows from the rule and is worth stating
   because a release-PR design leans on it: a release PR merged by a *person*
   produces a push whose actor is that person, so `on: push: [main]` workflows
   run normally. Only the bot's own writes are inert.

### 1.2 npm Trusted Publishing cannot be configured for a name that does not exist

Primary source, `npm trust` (the CLI equivalent of the website's trusted
publisher settings), under Prerequisites:

> The package you're configuring must already exist on the npm registry.

([npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/), read
2026-09-09; the command additionally needs `npm@11.15.0` or above, write
access to the package, and account-level 2FA.)

The gap is a known, still-open request:
[npm/cli#8544](https://github.com/npm/cli/issues/8544) ("Allow publishing
initial version with OIDC", filed 2025-09-01, open as of 2026-09-09) states
that "it's not possible to publish the initial version of a package using
OIDC, it needs to be published manually or using a token", and contrasts it
with PyPI, which does let you configure OIDC before the project exists.

[Multiple trusted publishing configurations for npm](https://github.blog/changelog/2026-09-03-multiple-trusted-publishing-configurations-for-npm/)
(2026-09-03) lets one package carry several OIDC configurations. It does not
change when the first one can be created.

`@nulab/chat-adapter-backlog` is unpublished: `GET
https://registry.npmjs.org/@nulab%2Fchat-adapter-backlog` returned **404** on
2026-09-09. Two other plausible `@nulab/*` names returned 404 as well, so
whether the **`@nulab` scope itself exists on npm, and who may publish into
it, could not be determined** from unauthenticated probes. That is a
prerequisite to check with an account that can see it, alongside the two
DEVELOPMENT.md already lists.

So the first publish authenticates some other way, by construction. §5 is the
route.

### 1.3 `--provenance` requires a public source repository, and this repository is `internal`

npm's trusted-publishing page is explicit:

> Provenance generation is not supported for private repositories, even when
> publishing public packages.

([Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/),
read 2026-09-09.) It also states that publishing through trusted publishing
from GitHub Actions generates provenance **by default**, without the flag.
The generating-provenance page requires that `package.json` name a *public*
`repository` matching, case-sensitively, where the publish runs from
([Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements/)).

This is not new: private source repositories were dropped on **2023-07-25**
([Publishing with npm provenance from private source repositories is no longer
supported](https://github.blog/changelog/2023-07-25-publishing-with-npm-provenance-from-private-source-repositories-is-no-longer-supported/)).

`internal` visibility specifically: secondary sources report the registry
rejecting it with `Unsupported GitHub Actions source repository visibility:
'internal'. Only public source repositories are supported when publishing with
provenance.` **That exact string was not confirmed against an npm-owned
document**, only against community reports; the direction, however, is not in
doubt — an `internal` repository is not public, and the rule names public as
the requirement rather than naming private as the exclusion.

`gh repo view nulab/chat-adapter-backlog --json visibility` returned
`INTERNAL` on 2026-09-09.

**Therefore spec §15 row 28 is not a preference between two workable
options.** As the repository stands, `npm publish --provenance` in
`release.yml` fails, and so does a trusted-publishing publish that generates
provenance by default. Publishing from an internal repository is possible only
by turning provenance *off* (`--provenance=false`, or `provenance=false` in
`.npmrc`) — which is the one thing the maintainer said they want.

One separation worth keeping straight, because it is what makes §5 work:
**provenance does not require trusted publishing.** The documented Actions
example generates provenance with `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`
plus `permissions: id-token: write`. Token auth and provenance are
independent; only the *public repository* requirement is shared.

### 1.4 The candidate tools against pnpm and this repository's Node

- **`release-please-action` and `changesets/action` are JavaScript actions.**
  They run on the runner's own Node, provisioned by the Actions runtime, not
  on the Node `pnpm install` links. Neither needs `npm` or `npx` to exist for
  the action itself, so the constraint recorded in `release.yml`'s comment
  ("the Node that `pnpm install` provisions is installed without npm, npx or
  corepack") does **not** rule either of them out.
- **`changesets/action` does need `@changesets/cli` checked out and
  installed** ("Needs repo checked out and `@changesets/cli` installed"),
  i.e. a new devDependency — which is subject to
  `minimumReleaseAge: 4320`, so adding it means waiting three days after the
  version you want is published, and every later bump of it does too.
- **`semantic-release`** is a Node CLI, so it is either a devDependency (same
  quarantine, and a much larger tree) or run through `pnpm dlx`. Whether
  `minimumReleaseAge` applies to a `pnpm dlx` resolution was **not verified**.
- **Do not switch to `pnpm publish` to avoid installing npm.**
  [pnpm/pnpm#11513](https://github.com/pnpm/pnpm/issues/11513) reports OIDC
  trusted publishing working under pnpm 10.x and failing with a 404 under
  11.0.8 (filed 2026-05-07, open, PR #11526 referenced). This repository pins
  pnpm 12.2.1 and the report was not re-tested there; the point is that
  `npm publish` is the path npm documents and tests, and the cost of reaching
  it is one `actions/setup-node` plus one `npm install -g`.
- npm CLI floor: **11.5.1** for trusted publishing, **11.15.0** for
  `npm trust`. The npm bundled with Node 26 predates the first, which is why
  the upgrade step exists at all.

### 1.5 How npm matches a workflow to a trusted-publishing configuration

Three facts that constrain how the workflow file may be reorganised
([Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/),
read 2026-09-09):

- The workflow field takes **the filename only**, with the extension —
  renaming `release.yml` breaks the configuration.
- The environment field is **optional**, "if using GitHub environments for
  deployment protection". The docs do not say what happens when the workflow
  declares an environment the configuration omits; community reports of the
  registry's misleading 404 consistently list the environment name among the
  fields that must match exactly
  ([npm/cli#9088](https://github.com/npm/cli/issues/9088)). Treat a mismatch
  as fatal and set both sides to the same string.
- For a **reusable workflow**, "validation checks the calling workflow's name
  instead of the workflow that actually contains the publish command". Today
  `release.yml` *calls* `ci.yml` but publishes from a job of its own, so the
  claim names `release.yml` and this is not a problem — but it means the
  publish step must never be moved into a called workflow.

## 2. What the choice actually turns on

Not "which tool". **Whether D15 stands.**

Spec §15 row 27 records it as **confirmed, 2026-09-07**: the package's own
semver from `0.1.0`; `package.json` stays at `0.0.0` on `main`; git tags are
the version of record; the bump is never committed back (#58, DEVELOPMENT.md
"Versioning", `release.yml:71-78`).

A release-please or changesets release PR **is** a diff, and that diff is
precisely the two writes D15 forbids: the version into `package.json`, and a
`CHANGELOG.md` entry. Under D15 there is nothing left to put in the pull
request. The release-PR model and D15 are not in tension over a detail; one of
them has to go.

Three smaller collisions come with the same package, and each is a decision of
its own rather than a consequence:

1. **Two changelogs.** `.github/release.yml` builds the GitHub release notes
   from six label categories, and CLAUDE.md makes labelling a per-PR
   obligation with a documented "unlabeled is correct" case. A tool that
   commits `CHANGELOG.md` produces a second, differently-ordered account of
   the same releases, derived from commit *types* rather than labels. Keeping
   both means they drift; dropping the labels means unwinding a rule that is
   already written down and followed.
2. **A bot commit on `main`.** "Work reaches `main` only as a squash commit"
   survives — a release PR can be squash-merged — but its subject is
   release-please's `chore(main): release 0.1.0`, and `main` is not in
   CLAUDE.md's scope vocabulary. The table would need a row, or the tool would
   need its title template overridden.
3. **CI on the release PR.** Per §1.1 it is now possible, as a manual
   "Approve workflows to run" click per release PR, or automatic at the cost
   of a GitHub App (an org-level app, its private key as a repository secret,
   `actions/create-github-app-token` in the workflow) or a PAT.

## 3. Candidates

Evaluated against this repository's decisions, not in general.

| | Keeps D15 | Notes come from | New dependency | Needs App token / PAT | Derives the bump | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| **A. Harden the `workflow_dispatch`** | yes | labels (unchanged) | none | no | no — human picks | **recommended** |
| **B. release-please** | **no** — writes `package.json` + `CHANGELOG.md` | tool, duplicating labels | none (a JS action) | only to auto-run CI on the release PR | yes, from conventional commits | rejected — §8 |
| **C. changesets** | **no** — same two writes | tool, duplicating labels | `@changesets/cli` (3-day quarantine) | same | no — a changeset file per PR, a *third* place the same fact is written | rejected — §8 |
| **D. semantic-release** (no `@semantic-release/git`) | **yes**, by default | `@semantic-release/github` writes its own, replacing the labels | large tree, quarantined | no | yes, from conventional commits | rejected — §8 |
| **E. Trigger on a human-pushed tag** | yes | labels (unchanged) | none | no | no — the tag *is* the input | rejected — §8 |
| **F. Derive the bump inside A** | yes | labels (unchanged) | none (a script) | no | yes, from squashed subjects | **recommended, separable** |

A word on each of the two recommended ones.

**A — keep `workflow_dispatch`, fix what is wrong with it.** It is the only
candidate that costs nothing in decisions already taken: D15 stands, the label
categories stay the single source of release notes, no dependency enters the
quarantine, and the OIDC claim keeps naming `release.yml`. What it does not do
is compute the version; §6 is what has to change inside it either way.

**F — compute the next version from the commits, keep the dispatch as the
gate.** This is the half of release-please that is genuinely attractive here,
extracted from the half that breaks D15. The repository already writes exactly
the input it needs: squash-merge means one commit subject per PR on `main`,
and CLAUDE.md mandates a scoped Conventional Commit subject with `!` for a
breaking change. So the bump is a pure function of
`git log --format=%s <last-tag>..HEAD`:

- any subject with `!` before the colon, or any `BREAKING CHANGE:` footer →
  `major`, degraded to `minor` while the version is `0.x` (DEVELOPMENT.md's
  own table says so);
- otherwise any `feat` → `minor`;
- otherwise → `patch`.

Roughly twenty lines in `scripts/`, in the same idiom as
`scripts/check-published-types.mjs`, run through the pinned Node. The
`workflow_dispatch` input becomes optional: absent, the script decides;
present, it overrides and the run-name records that a human overrode it. It is
separable from A on purpose — A is worth doing whether or not F is.

## 4. Recommendation

**Keep D15. Adopt A, and take F as a second, separable step.** Concretely:

1. Do **not** adopt release-please, changesets or semantic-release.
2. Keep `release.yml` triggered by `workflow_dispatch`, publishing from a job
   in that same file.
3. Restructure the publish job so that it **converges rather than sequences**
   (§6.1), add a `dry-run` input, and pin npm (§6.2).
4. Optionally add the bump-derivation script (F), making the version input an
   override rather than a requirement.
5. Keep `.github/release.yml`'s label categories as the only changelog. Do not
   add a `CHANGELOG.md`.

The reason is one sentence: the release-PR flow's whole product is a
reviewable diff, and under D15 that diff is empty, so adopting it means
overturning a decision confirmed two days ago in order to buy a review step
for a change nobody wrote.

**If the maintainer wants the release-PR flow anyway**, that is a coherent
position — the argument for it is that `package.json` on `main` reading
`0.0.0` is a small lie that every consumer reading the repository has to be
told about, and a `CHANGELOG.md` is readable without GitHub. Taking it means
deciding, in one go: overturn §15 row 27 (D15's version-of-record half; its
dependency-range half is untouched), drop or subordinate the label categories
in `.github/release.yml`, add `main` to CLAUDE.md's scope table, and choose
between a per-release approval click and a GitHub App. Of the three tools,
**release-please** is then the one to take: it adds no dependency to the
quarantined tree, it reads the conventional commits this repository already
writes rigorously, and it needs no third place (a changeset file) to record
what the PR title already says.

## 5. The route to the first release

Order matters, and the first two steps are decisions, not work.

**Step 0 — settle §15 row 28 (visibility).** Per §1.3 there is no middle
option: provenance requires a public source repository. Recommendation
(unchanged from §15.4): **make the repository public before the first
release**, which also fixes the README's absolute links, the licence badge and
`homepage` for anonymous readers. If it must stay `internal`, then
`--provenance` comes out of `release.yml`, trusted publishing must be
configured to *not* generate provenance, and "provenance + Trusted Publishing"
is off the table until the visibility changes — record that as the trade
rather than discovering it in a failed job.

**Step 1 — confirm the scope.** Per §1.2, check with an account that can see
npm's org settings that `@nulab` exists, that the publishing identity is a
member with publish rights, and that the org permits public packages
(`--access public` is already on the command and is required for a scoped
package's first publish).

**Step 2 — the first publish cannot use OIDC.** Three routes; the first is
recommended.

- **A temporary granular access token, used from `release.yml` itself.**
  Create a granular token scoped to the `@nulab` scope with read-write
  package permission and a short expiry, store it as the `production`
  environment's secret, and publish `0.1.0` from the normal workflow with
  `--provenance` and `NODE_AUTH_TOKEN`. Per §1.3 this **does** produce a
  provenance attestation, because provenance needs the public repository and
  `id-token: write`, not trusted publishing. Then configure trusted publishing
  on the now-existing package, delete the secret and the token, and remove the
  `NODE_AUTH_TOKEN` line. `0.1.0` ships with provenance, from the same
  workflow every later release uses; the only thing that differs is one
  release's authentication.
- **A placeholder version.** Publish `0.0.1` (from a laptop or from CI),
  configure trusted publishing, then release `0.1.0` normally. Costs a junk
  version that is `latest` until `0.1.0` lands, and npm's unpublish policy
  makes it only partly reversible: a version can be unpublished within 72
  hours if nothing depends on it, but "once `package@version` has been used,
  you can never use it again"
  ([Unpublish policy](https://docs.npmjs.com/policies/unpublish), read
  2026-09-09) — `0.0.1` is burned either way, though `0.1.0` is untouched.
- **Publish `0.1.0` by hand from a maintainer's machine.** Simplest, and the
  worst of the three: the first published artefact is the one release that
  never went through the workflow, and it carries no provenance.

**Step 3 — configure trusted publishing**, with the workflow filename
`release.yml` and, if the `production` environment is kept, the environment
name spelled identically on both sides (§1.5).

**Step 4 — create the `production` environment.** It does not exist yet, and
`release.yml` declares it; a job naming a missing environment does not run.
Decide at the same time whether it carries required reviewers — that is where
a human gate on publishing belongs, and it is a better place for one than a
release PR.

**Step 5 — dry run, then release.** With the `dry-run` input from §6.2, the
first exercise of the workflow can prove the version derivation, the build and
the packed tarball without touching the registry.

## 6. The weaknesses of the current workflow, solved by design

Issue #53 lists three. Two are real; the third is already handled.

### 6.1 Partial failure (real) — make the job converge, not sequence

Today the order is publish → tag push → release create. A failure between
steps leaves a state no later run recovers from: `npm publish` succeeded and
`git push origin "$NEW_TAG"` failed, so the next run's
`git describe --tags --abbrev=0` still reports the previous tag, derives the
same version, and `npm publish` answers 403.

Reordering does not fix it, it moves it. **Tag first** turns the stuck state
into a silently *wrong* one: if the tag lands and the publish fails, the next
run derives its bump from a tag no published version corresponds to, and a
`minor` from `v0.1.0` produces `0.2.0` — `0.1.0` is skipped, with nothing to
show that it was. Deleting the tag on failure adds a compensating action that
can itself fail, in the step where things are already failing. The
coordinator's reading is right on both counts, and the ordering question is
the wrong question.

**The fix is to stop treating the job as a transaction and treat it as a
convergence.** Each step asks whether its effect already exists and skips if
it does:

1. Compute the target version (from the last tag, plus the bump).
2. Build.
3. If `https://registry.npmjs.org/<name>/<version>` is **404**, publish;
   otherwise log that the version is already on the registry and skip.
4. If the tag does not exist on the remote, create and push it; otherwise
   verify it points at the commit being released and **fail loudly** if it
   does not.
5. If no GitHub release exists for the tag, create it.

Now every partial failure has the same recovery — re-run the workflow with the
same input — and the ordering stops mattering, so publish-before-tag can stay.
Step 4's mismatch check is the one place that must still fail rather than
skip: a tag pointing at a different commit than the one just published is a
state a re-run must not paper over.

Two smaller things fall out of the same restructuring. `gh release create`
failing after a successful publish and tag is no longer a manual cleanup, it
is a re-run. And `git describe --tags --abbrev=0` returns the most recent tag
*reachable from HEAD*, which is not necessarily the highest semver; on a
linear `main` with a serialising `concurrency` group that is the same tag, but
it is an assumption worth a Why-not comment rather than an accident.

### 6.2 `npm install -g npm@latest` is unpinned (real)

`release.yml:86` installs whatever npm is newest on the day, into the job that
signs the provenance attestation. `.npmrc`'s `min-release-age=3` narrows the
window but does not make the run reproducible.

Pin an exact version — the floor is **11.5.1** for trusted publishing (§1.4) —
and write the floor and the reason into the comment, because the next reader's
instinct will be to drop the step now that the bundled npm has caught up.
Nothing in this repository bumps a version pinned inside a `run:` string, so
the comment is also the only maintenance instruction that pin will ever get.

### 6.3 The first release's notes range (already handled — drop it from #53)

Verified in the file, not inferred: `release.yml:104-107` builds
`--generate-notes` first and appends `--notes-start-tag "$PREVIOUS_TAG"` only
if `git tag --list | grep -qx "$PREVIOUS_TAG"` matches. On the first run there
is no tag, `get_latest_tag` falls back to the literal `v0.0.0`, the grep fails,
and `gh release create` runs with `--generate-notes` alone. The checkout uses
`fetch-depth: 0`, so the tag list is complete. There is nothing to verify at
run time and nothing to fix; **#53's third item can be closed as already
handled.**

## 7. Migration

If the recommendation is accepted, the follow-up PR is `ci(release)` or
`fix(release)` scoped, and it:

**Adds**

- the guarded steps of §6.1 in `release.yml` (a registry existence check
  before publish, a remote tag check before the tag push, a release existence
  check before `gh release create`);
- a `dry-run` boolean `workflow_dispatch` input that stops after
  `npm publish --dry-run` and echoes the computed version and tag;
- an exact npm version in the upgrade step, with the 11.5.1 floor in the
  comment;
- optionally (F) `scripts/next-version.mjs` and a test for it, with the
  `newversion` input demoted to an optional override.

**Removes**

- nothing from `.github/release.yml`; the label categories stay as the only
  changelog.

**Changes in documentation, in the same PR**

- `DEVELOPMENT.md` "Releasing": the numbered list is currently a faithful
  description of a sequence that will no longer be a sequence. Rewrite steps
  2–6 as the convergence, say that a failed release is recovered by re-running
  the workflow with the same input, and add the `dry-run` input.
- `DEVELOPMENT.md` "One-time prerequisites": add the two this document found —
  that the `@nulab` scope must exist with publish rights (§5 step 1), and that
  trusted publishing **cannot** be configured before the package exists, so
  the first release authenticates differently (§5 step 2). Both belong next to
  the existing two, which is where a releaser will look.
- `docs/specs/adapter.md` §15.4 item 28: it recommends making the repository
  public and calls the alternative a cost. Per §1.3 the alternative is not
  "costs its provenance attestation", it is "provenance is impossible" —
  tighten the wording and cite the npm rule.
- `docs/plans/adapter-implementation.md` §7 and P7d: P7d says "run `release.yml`
  with `minor`". Under F there is no bump input to pick, and under §5 the
  first run is authenticated differently. Update both.
- This file: mark the recommendation accepted or replaced, and record which.

Nothing in `src/` changes, and `package.json` is untouched — under the
recommendation it keeps its `0.0.0`.

## 8. Rejected, and why

**release-please.** Rejected because its output is the two writes D15 forbids
(§2), and because the value it adds beyond those writes — deriving the bump
from conventional commits — is available without them (§3, F). Two further
costs specific to this repository: the release PR's title (`chore(main): …`)
uses a scope the vocabulary does not have, and CI on that PR is either a
per-release approval click or a GitHub App. Named as the tool to pick **if**
the maintainer overturns D15 (§4).

**changesets.** Rejected for everything release-please is rejected for, plus
two of its own. It adds `@changesets/cli` to a dependency tree governed by a
three-day quarantine, so the tool's own upgrades become scheduled work. And it
asks each PR to write a changeset file describing the change and its bump —
which this repository already states twice, in the Conventional Commit title
and in the release label. A third place is a third place to forget.

**semantic-release.** The interesting rejection, because it is the one tool
that **does** coexist with D15: without `@semantic-release/git` it writes the
version only into the publish, never into a commit, which is exactly this
repository's model. It fails on the other axis instead —
`@semantic-release/github` generates the release notes from commits, which
displaces the six label categories in `.github/release.yml` and the CLAUDE.md
rule that feeds them. Add to that the largest dependency tree of the three
under the quarantine, and a release on every push to `main` rather than on a
human's decision. Rejected, but it is the right thing to reconsider if the
label mechanism is ever dropped for another reason.

**Trigger the release on a tag the maintainer pushes** (`on: push: tags:
['v*']`). Genuinely attractive: it keeps D15 (the tag *is* the version of
record, and now also the input), the `GITHUB_TOKEN` restriction never applies
because a person pushed the tag, and §6.1's worst state is unreachable —
publish cannot succeed before a tag exists, because the tag is what started
the run. Rejected on the gate: the tag would exist before CI has run on that
commit, so a red release leaves a permanent tag on `main` pointing at a
version that was never published, and the recovery is deleting a pushed tag.
`workflow_dispatch` puts the same decision behind a UI that can carry a
`dry-run`, an environment approval and a re-run, and §6.1 removes the failure
mode this would have avoided.

**A GitHub App token to make bot-created pushes trigger workflows.** Rejected
as unnecessary rather than wrong: it is the correct fix for a design that
needs workflow *B* to react to workflow *A*'s tag, and none of the recommended
designs needs that. It costs an org-level app, a private key in repository
secrets, and a credential outliving every release — for a capability this
repository would use once per release, if at all. Revisit only alongside
release-please.

**Publishing a placeholder version to bootstrap trusted publishing.**
Rejected as the *recommended* route (§5 step 2) but kept as a documented
fallback: it burns a version number permanently and makes a junk release
`latest` for a while, where the temporary granular token costs one secret that
is deleted the same day and gets `0.1.0` published with provenance from the
real workflow.

**Tag first, delete the tag on failure.** Rejected in §6.1: it converts a
stuck state into a silently skipped version, and its safety depends on a
compensating action running in exactly the circumstances where things are
already failing.

## 9. Left to the maintainer

1. **Does D15 stand?** (§2, §4). Recommendation: yes — keep it, take A and F.
   If no, take release-please and accept the three collisions in §2 as a
   package.
2. **§15 row 28, visibility** (§1.3, §5 step 0). Recommendation: public before
   the first release. This is now a binary: internal means no provenance at
   all, not weaker provenance.
3. **Which first-publish route** (§5 step 2). Recommendation: the temporary
   granular access token.
4. **Does `production` carry required reviewers?** (§5 step 4). Not decided
   here; it is the natural home for a human gate on publishing.
5. **Take F, or keep picking the bump by hand?** (§3). Recommendation: take
   it, but separately from A.

## Sources

All read 2026-09-09.

- [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token) —
  the rule and its exceptions.
- [Trigger a workflow](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow) —
  the push wording.
- [Bot-created pull requests can run workflows if approved](https://github.blog/changelog/2026-06-11-bot-created-pull-requests-can-run-workflows-if-approved/) —
  2026-06-11, what actually changed.
- [Control who and what triggers GitHub Actions workflows](https://github.blog/changelog/2026-06-18-control-who-and-what-triggers-github-actions-workflows/) —
  2026-06-18, public preview; restricts only.
- [release-please-action](https://github.com/googleapis/release-please-action) —
  the token warning and the `release_created` pattern.
- [changesets/action](https://github.com/changesets/action) — needs
  `@changesets/cli` installed.
- [npm-trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/) — "must
  already exist on the npm registry"; `npm@11.15.0`.
- [npm/cli#8544](https://github.com/npm/cli/issues/8544) — initial version
  cannot use OIDC; open, filed 2025-09-01.
- [Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/) —
  npm 11.5.1 floor, automatic provenance, private-repository exclusion,
  workflow/environment matching, reusable-workflow caveat.
- [Generating provenance statements](https://docs.npmjs.com/generating-provenance-statements/) —
  public repository requirement; provenance with a token.
- [Publishing with npm provenance from private source repositories is no longer supported](https://github.blog/changelog/2023-07-25-publishing-with-npm-provenance-from-private-source-repositories-is-no-longer-supported/) —
  2023-07-25.
- [Multiple trusted publishing configurations for npm](https://github.blog/changelog/2026-09-03-multiple-trusted-publishing-configurations-for-npm/) —
  2026-09-03.
- [npm/cli#9088](https://github.com/npm/cli/issues/9088) — trusted-publishing
  failures surface as a misleading 404.
- [pnpm/pnpm#11513](https://github.com/pnpm/pnpm/issues/11513) —
  `pnpm publish` with OIDC, filed 2026-05-07, open.
- [Unpublish policy](https://docs.npmjs.com/policies/unpublish) — 72 hours,
  and a version number is never reusable.
