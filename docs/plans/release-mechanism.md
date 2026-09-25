# Release mechanism

How `@nulab/chat-adapter-backlog` should cut a release, reconsidered before
the first one is ever cut. `.github/workflows/release.yml` exists, has never
run, and its shape (`workflow_dispatch` with a `patch` / `minor` / `major`
choice) was written before anybody asked whether a release-PR tool would suit
this repository better.

**This document changes no workflow.** It records what was verified, what the
choice actually turns on, one recommendation, and the decisions that were the
maintainer's. The implementation is a separate PR, #106. Issue **#53** is the
first run of whatever comes out of this; two of the three weaknesses it lists
are solved here by design rather than patched (§6).

**Status: accepted 2026-09-23 — candidate A, with F deferred.** The maintainer
delegated the choice, and §4's recommendation was accepted as far as A goes:
`release.yml` keeps `workflow_dispatch`, converges instead of sequencing, and
gains a `dry-run` input. F — deriving the bump from the commits — is not taken
for now, so the bump stays a human's choice. The §9 items resolve as
recommended: the `package.json`-stays-at-`0.0.0` practice stands, the first
publish uses a temporary granular token, and `production` carries no required
reviewers.

Everything below was checked on **2026-09-09**, except where a passage names
**2026-09-23**: a review on that date corrected the Node and npm facts (§1.4,
§6.2), the environment and re-run facts (§5, §6.1), and the guard design
(§6.1). Line references (`release.yml:86`, `DEVELOPMENT.md:432-435` and the
like) are to the files on `main` before #106 changes them. Where a claim could
not be established from a primary source, it says so instead of guessing.

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
2026-09-09.

The scope around it, however, is not in doubt, and needs no credentials to
establish. `GET https://registry.npmjs.org/-/org/nulab/package` returns
fourteen packages (2026-09-09), four of them scoped — `@nulab/bee`,
`@nulab/datadog-ai-guard-middleware-core` and its `-ai-v2` and `-ai-v3`
siblings — alongside unscoped `backlog-js` and `backlog-mcp-server`. **The
`nulab` organisation exists on npm and already publishes public scoped
packages**, so neither creating the scope nor proving that public scoped
publishing is permitted is work. What that probe cannot answer is who may
publish *into* the scope, which is an account-level question. §5 step 1 is
narrowed to that.

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

**That settles spec §15 row 28, and it is settled as a premise rather than as
a choice.** The maintainer's decision, 2026-09-09: the conditions a publish
needs are theirs to supply, and a repository being `internal` while it is
developed says nothing about its state on the day it publishes. So **this
document assumes the repository is public at publish time**, and provenance
follows. The rule above is not deleted by that decision — it is the *reason*
for it, and it is also what would have to be given up if the premise ever
changed: from an internal repository, `npm publish --provenance` fails, a
trusted-publishing publish fails the same way because it generates provenance
by default, and publishing at all would mean turning provenance off
(`--provenance=false`, or `provenance=false` in `.npmrc`) — the one thing the
maintainer said they want.

Two things this premise is **not**. It is not a claim that the repository has
already been switched — `gh repo view` said `INTERNAL` on the day this was
written, and it stays that way until somebody changes it. And it is not a
licence to stop caring: everything §5 says about what becomes visible on
publication day still has to be true when the switch happens.

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
- **Keep publishing with `npm publish`, but not because `pnpm publish` is
  broken.** [pnpm/pnpm#11513](https://github.com/pnpm/pnpm/issues/11513) —
  OIDC trusted publishing working under pnpm 10.x and failing with a 404 under
  11.0.8 — was filed 2026-05-07 and **closed as completed the next day**
  (2026-05-08); the fix,
  [pnpm/pnpm#11526](https://github.com/pnpm/pnpm/pull/11526)
  (`fix(config): drop unresolved ${VAR} placeholders from .npmrc auth
  values`), **merged 2026-05-15**. It does not apply to the pnpm 12.2.1 this
  repository pins, and citing it as a live risk would be wrong. The reason to
  keep `npm publish` is the positive one: it is the path npm documents and
  tests for trusted publishing, and reaching it costs one
  `actions/setup-node`.
- **npm CLI floors: 11.5.1 for trusted publishing, 11.15.0 for `npm trust` —
  and Node 26 already clears both.** Measured against
  [`https://nodejs.org/dist/index.json`](https://nodejs.org/dist/index.json)
  on 2026-09-09: **v26.0.0 (2026-05-05) bundles npm 11.12.1**, and the newest
  26.x on that day, **v26.8.1 (2026-08-26), bundles npm 11.19.0**. Every 26.x
  release clears 11.5.1, and every release from v26.3.1 (npm 11.16.0) clears
  11.15.0 as well, so the job already has an npm new enough to publish through
  trusted publishing before `release.yml:86` runs.
- **But `node-version: 26` is not the Node this repository pins.** Re-measured
  2026-09-23: `actions/setup-node` with `node-version: 26` resolves the newest
  26.x, which is now **v26.10.0 (2026-09-21, npm 11.19.1)** — two days old, so
  younger than the three-day `minimumReleaseAge` every other tool here waits
  out — while `pnpm-lock.yaml` pins **Node 26.8.1 (npm 11.19.0)** through
  `devEngines.runtime`. The major-only spec makes the packer and the publisher
  a function of the day the job runs, and two jobs of one run can even get
  different ones. Meanwhile `npm@latest`, which `release.yml:86` installs, is
  **12.1.0** (published 2026-09-22): a new major the step would have put into
  the publishing job on its first run. §6.2 is what follows from both.

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
- Relatedly, if publishing ever ran inside a called workflow, the caller would
  have to grant `id-token: write`: a called workflow cannot elevate beyond what
  its caller passes — "The `GITHUB_TOKEN` permissions passed from the caller
  workflow can be only downgraded (not elevated) by the called workflow"
  ([Reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations),
  read 2026-09-23). Today `release.yml` grants it on the `publish` job, which
  is where the publish runs, and `ci.yml` needs none — but a reorganisation
  that moves publishing across that boundary has to move the permission with
  it.

## 2. What the choice actually turns on

Not "which tool". **Whether D15 stands.**

"D15" is used loosely below and the loose use is worth pinning down once,
because the register row and the practice are not the same statement. D15
itself (§14, `docs/specs/adapter.md:2259`) is the version-line-and-dependency-
ranges decision. Spec §15 **row 27** (`docs/specs/adapter.md:2337`) records
the half that was reopened and settled on **2026-09-07**: the package's own
semver, starting at `0.1.0`, superseding #17's proposal to track `chat`'s
line — and it says nothing about `package.json`. The rest of the practice —
**`package.json` stays at `0.0.0` on `main`, git tags are the version of
record, and the bump is never committed back** — is recorded in
`DEVELOPMENT.md:432-435` and in the comment at `release.yml:71-78`, not in the
register at all.

It is that last, workflow-level half that the release-PR model collides with,
and it is what "D15" means for the rest of this document. Overturning it
therefore does *not* require reopening row 27; it requires changing
DEVELOPMENT.md and the workflow, and adding a register row for a decision that
never had one.

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
   (§6.1), add a `dry-run` input, and resolve the npm step (§6.2).
4. Optionally add the bump-derivation script (F), making the version input an
   override rather than a requirement.
5. Keep `.github/release.yml`'s label categories as the only changelog. Do not
   add a `CHANGELOG.md`.

The reason is one sentence: the release-PR flow's whole product is a
reviewable diff, and under D15 that diff is empty, so adopting it means
overturning a settled practice in order to buy a review step for a change
nobody wrote.

**If the maintainer wants the release-PR flow anyway**, that is a coherent
position — the argument for it is that `package.json` on `main` reading
`0.0.0` is a small lie that every consumer reading the repository has to be
told about, and a `CHANGELOG.md` is readable without GitHub. Taking it means
deciding, in one go: overturn the `package.json`-stays-at-`0.0.0` practice
(per §2 that lives in `DEVELOPMENT.md:432-435` and `release.yml:71-78`, so it
is those two that change — row 27's "the package's own semver from `0.1.0`"
and D15's dependency ranges both survive untouched, and the newly-made
decision wants a register row of its own), drop or subordinate the label
categories in `.github/release.yml`, add `main` to CLAUDE.md's scope table,
and choose between a per-release approval click and a GitHub App. Of the three tools,
**release-please** is then the one to take: it adds no dependency to the
quarantined tree, it reads the conventional commits this repository already
writes rigorously, and it needs no third place (a changeset file) to record
what the PR title already says.

## 5. The route to the first release

Order matters. Step 0 is a premise the maintainer supplies, step 1 is a
question to answer, and only from step 2 is any of it work.

**Step 0 — the repository is public before the publish runs.** Settled
2026-09-09 (§1.3, spec §15 row 28): the maintainer supplies this rather than
the release deciding it. Provenance requires it, and the same switch is what
makes the README's absolute links, the licence badge and `homepage` resolve
for the anonymous readers who reach them on publication day — the README
published for a version is immutable, so this is the one of the five steps
that cannot be fixed afterwards. Two consequences to carry into the release
checklist rather than assume: **the switch has to have happened before the
job starts**, not merely be planned, and a `release.yml` run against a still-
internal repository fails at the publish rather than silently dropping the
attestation.

**Step 1 — confirm who may publish into the scope.** Per §1.2 the `nulab`
organisation and the `@nulab` scope already exist and already carry public
scoped packages, so only one question is left, and it needs an account that
can see npm's org settings: **is the publishing identity a member with publish
rights on the scope?** (`--access public` is already on the command and is
required for a scoped package's first publish.)

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
  release's authentication. One constraint on the token itself, from
  `npm trust`'s prerequisites: **a granular access token with the "bypass 2FA"
  option is not supported** for configuring trusted publishing, and neither is
  legacy basic auth. That does not affect the publish, but it does mean the
  same token cannot then be used to run `npm trust` — configure the trusted
  publisher from the npmjs.com UI, or from a session that satisfies the
  account-level 2FA requirement.
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

**Step 4 — create the `production` environment, before step 2's publish.** It
does not exist yet, and `release.yml` declares it. A missing environment does
**not** stop the job; GitHub creates it on the spot: "Running a workflow that
references an environment that does not exist will create an environment with
the referenced name", and "the newly created environment will not have any
protection rules or secrets configured"
([Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments),
read 2026-09-23). So the failure is not a refusal but an unprotected
`production` with no bootstrap secret in it. That is why the step matters, and
why it is numbered here but has to be done first: the environment, its
deployment-branch policy of `main`, and step 2's token secret must all exist
before the first run that is not a dry run.
Whether it should also carry **required reviewers** is a decision of its own,
and §9 item 4 recommends against it for `0.1.0`: the environment is the right
*place* for a human gate on publishing — better than a release PR — but the
`workflow_dispatch` is already one, and a required reviewer makes a failed
release impossible to re-run unattended, which is what §6.1's recovery
depends on.

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
can itself fail, in the step where things are already failing. So the ordering
question is the wrong question: neither order is safe on its own.

**The fix is to stop treating the job as a transaction and treat it as a
convergence.** Each step asks whether its effect already exists and skips if
it does. But a convergence only converges if its *target* is fixed, and that
is the part it is easy to get wrong: deriving the target version from
`git describe` reads a value the later steps write, so a re-run after a late
failure aims somewhere new. Walked concretely — publish succeeded, tag pushed,
`gh release create` failed — a re-run would find `v0.1.0` on HEAD, derive
`0.2.0` from it, see 404 on the registry for `0.2.0`, and **publish a second
unwanted version and tag the same commit twice**, with `--notes-start-tag`
degenerating to the release currently being made. So step 0 comes first:

0. **Fix the target.** If a tag already points at the commit being released,
   **that tag is the target version**. Only when there is none is the target
   computed from the last tag plus the bump. The version is then an invariant
   of the input rather than a reading of the state the job is about to
   change. Computing it from the last tag rests on one more assumption, so
   **assert it rather than trust it** (added 2026-09-23): the last tag's
   version must exist on the registry. A tag with no published version behind
   it — pushed by hand, or left over from anything that tags before it
   publishes — would otherwise become the base of the bump, and the version it
   names would be skipped as silently as in the tag-first ordering above.
   Fail and name the tag. For the same reason, a tag for the *computed*
   version that already exists on another commit is a failure, not a target.
1. Derive `PREVIOUS_TAG` for the notes range from the last tag **excluding any
   tag on HEAD**, for the same reason.
2. Build.
3. If `https://registry.npmjs.org/<name>/<version>` is **404**, publish. If it
   is 200, the version already exists — but see below: that is not on its own
   proof that it is *this* build, so the check has to compare before it skips.
4. If the tag does not exist on the remote, create and push it; otherwise
   verify it points at the commit being released and **fail loudly** if it
   does not.
5. If no GitHub release exists for the tag, create it.

Step 3 needs the same "fail loudly" treatment step 4 gets, and for the same
reason. A 200 proves only that *something* was published under that name and
version — a hand publish, or a build from a different commit, answers 200
too. Skipping silently on 200 would tag a commit whose contents are not what
the registry serves. **What it should compare, though, is not the bytes.**

The obvious comparison — re-pack locally and check the tarball's digest
against the packument's `dist.integrity` — quietly assumes that packing is
reproducible run to run. If it is not, the digests differ every time and
step 3 fails loudly on exactly the runs it was supposed to let through,
turning the recovery path into a hard stop. So that assumption was measured
rather than assumed, and it holds only in part.

**Measured 2026-09-09, npm 11.19.0, against a throwaway probe package.**
Packing the same bytes twice at different wall-clock times gives the same
`shasum` and `integrity`; so does packing after touching a file's mtime to
`now` and again to 2001, so **npm normalises modification times**; so does
packing the same tree from a different parent directory path, and under a
different `umask`. One input does change the digest: **the executable bit**
(`0644` → `0755` produced a different `shasum`), so file modes are carried
into the tarball rather than normalised. In CI the modes come from the git
checkout, which records only that bit and reproduces it, so this is stable in
practice — but it is preserved state, not normalised state.

Two things that measurement does **not** establish, and neither should be
assumed:

- **npm promises none of this.** The `npm pack` documentation says nothing
  about determinism, timestamps or modes
  ([npm-pack](https://docs.npmjs.com/cli/v11/commands/npm-pack), read
  2026-09-09), and the request to normalise timestamps
  ([npm/npm#17412](https://github.com/npm/npm/issues/17412)) sits in the
  archived repository with no resolution recorded there. The behaviour above
  is observed on one npm version, not guaranteed across them — which couples
  this step to §6.2: if the npm-upgrade step is dropped and `setup-node`
  resolves a newer 26.x between the original publish and the re-run, the two
  packs are not necessarily done by the same packer.
- **The build was not measured at all.** The tarball can only be reproducible
  if `dist/` is, and whether tsdown emits byte-identical output across runs is
  unknown here. That is the larger half of the assumption and the one most
  likely to break it.

**So compare the provenance attestation, not the tarball.** It answers the
question step 3 is actually asking — *was this version published from this
commit?* — directly, and it does not depend on re-packing anything.
`GET https://registry.npmjs.org/-/npm/v1/attestations/<name>@<version>`
returns the SLSA statement, whose `resolvedDependencies[].digest.gitCommit`
is the source commit and whose `externalParameters.workflow` names the
repository, the workflow path and the ref (verified 2026-09-09 by decoding a
published package's bundle). Equal to the release commit: skip. Different, or
from another repository or workflow: fail and say so.

That check is available from `0.1.0` onward, because §5's first-publish route
keeps `--provenance` even while authenticating with a token. Where it is not
available — a version published by hand, without provenance — there is no
cheap authoritative answer, and the honest fallback is to **fail loudly on 200
and let a human decide**, rather than to compare digests whose stability has
not been established. If byte comparison is wanted later, the thing to measure
first is the build, not the packer.

The opposite direction is worth stating too, because it will be met before it
is understood: the registry's read path can lag its write path, so a 404 for a
version published moments earlier is possible, and the re-publish that follows
is rejected with a 403. That is an acceptable ending — loud, and correct — but
it should be *described* rather than discovered at three in the morning.

**"Re-run" means re-running the same run, at the same commit.** This is a
constraint on the recovery, not a detail of it: a fresh `workflow_dispatch`
after `main` has moved is a different input, so step 0 sees a different HEAD,
derives a different bump, and can publish a version that is not the one left
untagged. Recovery from a partial failure is the re-run button on the failed
run, within the window below; anything else is a new release.

**And a convergence that has nothing to do must say so.** Step 0 has a
back side: dispatch `patch` against a commit that is already released and
every guard fires — tag on HEAD, so that tag is the target; registry 200, so
skip; tag present, so skip; release present, so skip. The job ends green
having done nothing. That is correct convergence and a bad report: somebody
asked for a release, got a green check, and no version exists that did not
exist before. Six weeks later, reading the run list during an incident,
nobody can tell that run from one that worked.

The distinction the workflow needs is one the section above already draws in
prose: *this* run's tag versus somebody else's. GitHub exposes the identity it
needs — `github.run_id` "does not change if you re-run the workflow run"
([Contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts),
read 2026-09-09) — so **the guard keys on who owns the tag**. The run that
creates a tag creates it *annotated*, with a message that names its own run
id, and every later reading of that tag can ask whether it was made by the
run now looking at it. A re-run keeps its run id, so it recognises its own
tag; a new dispatch has a new one, so it does not. So:

- **Step 0 found a tag on the release commit that this run did not create →
  fail, loudly, naming the tag, and say to re-run the run that created it.**
  A new run against an already-tagged commit is an operator error — a release
  asked for with nothing new to release, or a recovery attempted by dispatch
  instead of by re-run — and the useful thing to do is say which version
  already covers this commit rather than to succeed at nothing. Note that this
  guard is *broader* than the fully-released case, and deliberately: a fresh
  dispatch onto a commit left half-released by an earlier failed run is
  precisely the mistake the paragraph above warns about, and the same
  condition catches it.
- **The tag names this run → converge and succeed.** This is the recovery
  path, and skipping the steps that already took effect is the whole point.

The first draft of this section keyed the guard on `github.run_attempt`
instead — attempt 1 fails on a tagged commit, a re-run converges. The review
of 2026-09-23 found the hole in that: re-running the attempt the guard itself
failed produces attempt 2 of a run that owns nothing, and it converges green
having done nothing — exactly the useless report the guard exists to prevent.
Ownership has no such hole, because re-running the refused run does not
change whose tag it is.

Two costs, both worth paying and both worth writing into the workflow rather
than leaving to be met. First, **re-running has a deadline**: GitHub lets a
run, its failed jobs or specific jobs be re-run "up to 30 days after its
initial run"
([Re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs),
read 2026-09-23), so past thirty days the recovery path is gone. Second, a
legitimate "publish this existing tag" flow, if one is ever wanted, arrives
with a tag on HEAD that this run did not create and would be refused. One
boolean input, `allow-released-commit`, covers both: a human sets it to let a
new run converge on a tag it does not own.

That escape hatch is narrower than it sounds, and the limit is worth stating
before somebody needs it. A `workflow_dispatch` on `main` checks out the
branch's current HEAD, not the commit the failed run released. So
`allow-released-commit` helps only **while `main` still points at the tagged
commit**. Once `main` has moved, a fresh dispatch finds no tag on its HEAD,
computes a new version from the last tag, and either fails step 0's registry
assertion (the last tag was never published) or releases the new commits as
the next version — neither of which finishes the old release. Beyond both the
thirty days and a moved `main`, **recovery is by hand**, and it is short
because only the two GitHub-side writes can be missing (publish comes first):

- *published, no tag*: the attestation (step 3) names the commit that was
  published; create the annotated tag on that commit through the Git refs API
  or `git tag -a` and `git push`, then do the next bullet;
- *published and tagged, no release*: `gh release create <tag> --verify-tag
  --generate-notes`, adding `--notes-start-tag <previous tag>` when there is
  one.

A tag with no published version behind it cannot be left by the workflow
under publish-before-tag; if one exists it was pushed by hand, step 0's
registry assertion stops every later run on it, and the fix is to delete that
tag, since nothing can have been published or depended on under its version.

With those three, every partial failure recovers by re-running, the ordering
stops mattering, and publish-before-tag can stay. Two concurrent releases are
a separate question, and their safety comes from somewhere else: the existing
`concurrency: group: release, cancel-in-progress: false` serialises them, so
the second run starts only after the first has finished. On the same HEAD it
then finds the first run's tag, which it does not own, and fails at the guard;
on a HEAD that has moved on, it derives the next version from that tag. The
registry check catches a double publish of one version either way. That is the
concurrency group's guarantee, not the convergence's — if the group is ever
removed, this section does not cover what happens.

One case the guard does not see, recorded so nobody believes it does: a
**fresh dispatch onto a commit that was published but never tagged** finds no
tag on HEAD, so there is nothing to own. With the same bump it computes the
same version, the attestation matches, and it finishes the old release —
benign. With a different bump it publishes a second version of the same
commit. The rule stays what it was: a partial failure is recovered by
re-running its run.

One smaller thing falls out of the same restructuring: `git describe --tags
--abbrev=0` returns the most recent tag *reachable from HEAD*, which is not
necessarily the highest semver. On a linear `main` with the serialising group
that is the same tag, but it is an assumption worth a Why-not comment rather
than an accident.

### 6.2 `npm install -g npm@latest` is unpinned (real) — and its stated reason is not

Two separate things, and #53 names only the first.

**The pin.** `release.yml:86` installs whatever npm is newest on the day, into
the job that signs the provenance attestation. `.npmrc`'s `min-release-age=3`
narrows the window but does not make the run reproducible. That is real and
worth fixing.

**The premise underneath it is out of date.** The step's comment
(`release.yml:83-84`) says trusted publishing "needs the OIDC support added in
npm 11.5.1; the npm bundled with Node 26 predates it and falls back to asking
for a token". Per §1.4 that has not been true since Node 26 shipped:
**v26.0.0 bundles npm 11.12.1 and v26.8.1 bundles npm 11.19.0**, so the npm
`actions/setup-node` puts on PATH already clears both the 11.5.1 trusted-
publishing floor and the 11.15.0 `npm trust` floor. The upgrade step is not
what makes trusted publishing work today, and a reader who trusts the comment
will believe removing it breaks publishing.

**And `@latest` is now concretely wrong, not only unpinned.** Re-measured
2026-09-23 (§1.4): `npm@latest` is **12.1.0**, a new major published the day
before, so the step as written would have put an npm major nobody here has
run into the job that signs the first provenance attestation. `.npmrc`'s
`min-release-age` would not have held it back either: a project `.npmrc` "is
not read in global mode, such as when running `npm install -g`"
([npmrc](https://docs.npmjs.com/cli/v11/configuring-npm/npmrc), read
2026-09-23).

So the recommendation is not "pin the version" but a choice between two, and
either is defensible:

- **Drop the step**, and replace the comment with what actually holds the
  floor: the npm bundled with Node 26 is ≥ 11.12.1, above the 11.5.1
  requirement. Fewer moving parts, and one less unpinned network install in
  the publishing job. The exposure is that the floor is then implicit in the
  Node version — a hypothetical Node 26.x that shipped an older npm would
  break it silently — so assert it in the job rather than imply it.
- **Keep it as a reproducibility pin**, at an exact version rather than
  `@latest` — the npm bundled with the pinned Node is the natural value — with
  a comment that says it is there to make the toolchain that signs provenance
  identical run to run, *not* to reach a floor the runtime misses.

Either way, **take the Node version from the lockfile, not from
`node-version: 26`** (added 2026-09-23). `setup-node` resolves a major-only
spec to the newest release on the day, which on 2026-09-23 was a two-day-old
v26.10.0 that the three-day `minimumReleaseAge` would have kept out of every
other install here, while `pnpm-lock.yaml` pins 26.8.1. Reading the version
pnpm provisions (`pnpm exec node --version` after a frozen install) and handing
that exact version to `setup-node` makes the npm that packs and the npm that
publishes the same one, in every job and on every re-run — which is also what
the pack-determinism caveat in §6.1 asks for. The npm version itself can then
be carried from the packing job to the publishing one and asserted equal.

Either way the comment at `release.yml:83-84` is wrong as it stands and is
corrected in the same change; §7 lists it, and `DEVELOPMENT.md`'s Releasing
step 4 repeats the same claim and is corrected with it. Note also that
nothing in this repository bumps a version pinned inside a `run:` string, so
if the pin is kept, its comment is the only maintenance instruction it will
ever get.

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

The recommendation was accepted (see the status at the top), and the
follow-up PR is #106, `fix(release)` scoped. It:

**Adds**

- the guarded steps of §6.1 in `release.yml` (a registry existence check
  before publish, a remote tag check before the tag push, a release existence
  check before `gh release create`);
- a `dry-run` boolean `workflow_dispatch` input that stops after
  `npm publish --dry-run` and echoes the computed version and tag;
- the resolution of §6.2's npm-upgrade step — either dropping it or pinning
  it to an exact version — **together with a corrected comment at
  `release.yml:83-84`**, which today asserts that the npm bundled with Node 26
  predates 11.5.1. It does not (§1.4), and leaving the claim in place while
  changing the step around it would preserve the error that made the step look
  load-bearing — and `setup-node` given the lockfile's Node version rather
  than `26` (§6.2);
- step 0 of §6.1 — the target version taken from a tag already on the release
  commit when there is one, the assertion that the last tag's version exists
  on the registry, and the refusal of a computed version whose tag sits on
  another commit — and a `PREVIOUS_TAG` derivation that excludes tags on HEAD;
- the ownership guard of §6.1: the tag is created annotated with a message
  naming the run, a run that finds a tag on HEAD it did not create fails
  loudly, a re-run of the creating run converges, and an
  `allow-released-commit` boolean input exists so the guard cannot trap a run
  that is too old to re-run, while `main` still points at the tagged commit;
- the attestation comparison of §6.1 step 3 (source commit from
  `/-/npm/v1/attestations/<name>@<version>`), rather than a digest comparison
  that would rest on build and pack reproducibility neither of which is
  established;
- optionally (F) `scripts/next-version.mjs` and a test for it, with the
  `newversion` input demoted to an optional override.

**Removes**

- nothing from `.github/release.yml`; the label categories stay as the only
  changelog.

**Changes in documentation, in the same PR**

- `DEVELOPMENT.md` "Releasing": the numbered list is currently a faithful
  description of a sequence that will no longer be a sequence. Rewrite steps
  2–6 as the convergence, say that recovery is **re-running the failed run at
  the same commit** rather than dispatching a new one (§6.1), and add the
  `dry-run` input. Step 4 also repeats the out-of-date npm claim — "Trusted
  Publishing needs the OIDC support added in npm 11.5.1, which is newer than
  the npm bundled with Node 26" — and is corrected alongside the workflow
  comment.
- `DEVELOPMENT.md` "One-time prerequisites": add the two this document found —
  that the publishing identity needs publish rights on the existing `@nulab`
  scope (§5 step 1), and that trusted publishing **cannot** be configured
  before the package exists, so the first release authenticates differently
  (§5 step 2). Both belong next to the existing two, which is where a releaser
  will look. So does the order §5 step 4 found: the environment, its `main`
  policy and the token secret exist before the first non-dry run.
- `docs/plans/adapter-implementation.md` §7 and P7d: P7d says "run `release.yml`
  with `minor`", and under §5 the first run is authenticated differently.
  Update both.

**#99 is closed by #100**, which stopped shipping `scripts.preinstall`, and
`scripts/check-published-scripts.mjs` now runs first in `pnpm build` and fails
it on any `preinstall`, `install` or `postinstall` in `package.json`, which
`npm publish` ships verbatim. The release path needs nothing further for it:
the build `release.yml` runs is that build, so neither the manifest mutation
nor the packed-manifest assertion this section once proposed is wanted.

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

**Resolved 2026-09-23** (see the status at the top): 1 — yes, the practice
stands; 3 — the temporary granular token; 4 — no required reviewers; 5 — not
now, F is deferred. The items are kept as written so the reasoning stays next
to the answer.

1. **Does the `package.json`-stays-at-`0.0.0` practice stand?** (§2, §4 —
   and note §2 on why that is not the same as reopening §15 row 27).
   Recommendation: yes — keep it, take A and F. If no, take release-please and
   accept the three collisions in §2 as a package.
2. ~~**§15 row 28, visibility.**~~ **Settled 2026-09-09** — the repository is
   public at publish time, supplied by the maintainer as a premise (§1.3, §5
   step 0, spec §15 row 28). It is listed here struck through rather than
   deleted so that a reader who arrives from an older reference finds where it
   went. What remains is a checklist item, not a decision: confirm the switch
   has actually happened before the first run.
3. **Which first-publish route** (§5 step 2). Recommendation: the temporary
   granular access token.
4. **Does `production` carry required reviewers?** (§5 step 4).
   Recommendation: **no, not for `0.1.0`** — the `workflow_dispatch` is
   already a human gate, and a required reviewer buys a second one at a real
   cost: it makes the release **impossible to re-run unattended**, which is
   precisely the recovery §6.1 is built on. A partial failure at 02:00 would
   then wait for an approver rather than for a retry. Revisit once releases
   are routine and the convergence has been exercised.
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
  `pnpm publish` with OIDC; filed 2026-05-07, **closed completed 2026-05-08**,
  fixed by [pnpm/pnpm#11526](https://github.com/pnpm/pnpm/pull/11526)
  (merged 2026-05-15).
- [`https://nodejs.org/dist/index.json`](https://nodejs.org/dist/index.json) —
  the npm bundled with each Node 26 release (v26.0.0 → 11.12.1,
  v26.8.1 → 11.19.0).
- `https://registry.npmjs.org/-/org/nulab/package` — the `nulab` org's
  fourteen packages, four of them scoped.
- [Unpublish policy](https://docs.npmjs.com/policies/unpublish) — 72 hours,
  and a version number is never reusable.
- [Contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts) —
  `github.run_attempt` increments per re-run; `github.run_id` does not.

Read 2026-09-23, for the review that corrected the passages dated so:

- [Managing environments for deployment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) —
  a workflow naming a missing environment creates it, with no protection
  rules or secrets.
- [Re-running workflows and jobs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) —
  "up to 30 days after its initial run".
- [Reusing workflow configurations](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations) —
  a called workflow can only downgrade the caller's `GITHUB_TOKEN`
  permissions.
- [npmrc](https://docs.npmjs.com/cli/v11/configuring-npm/npmrc) — the
  project `.npmrc` is not read by `npm install -g`.
- [`https://nodejs.org/dist/index.json`](https://nodejs.org/dist/index.json) —
  v26.10.0 (2026-09-21) bundles npm 11.19.1; `https://registry.npmjs.org/npm`
  — `latest` is 12.1.0, published 2026-09-22.
- [npm-pack](https://docs.npmjs.com/cli/v11/commands/npm-pack) and
  [npm/npm#17412](https://github.com/npm/npm/issues/17412) — no documented
  determinism guarantee, and the normalisation request is unresolved in the
  archived repository.
- `https://registry.npmjs.org/-/npm/v1/attestations/<name>@<version>` — the
  SLSA statement carrying the source commit and the publishing workflow.

Measurements taken for this document, rather than read:

- **npm pack determinism**, 2026-09-09 with npm 11.19.0 against a throwaway
  probe package: mtime, parent directory path and `umask` do not change the
  tarball digest; the executable bit does. The build's own reproducibility was
  **not** measured.
- **The `nulab` npm organisation**, 2026-09-09: fourteen packages, four of
  them scoped.
- **The npm bundled with Node 26**, 2026-09-09 from
  `nodejs.org/dist/index.json`: v26.0.0 → 11.12.1, v26.8.1 → 11.19.0;
  re-measured 2026-09-23: v26.10.0 → 11.19.1, against the lockfile's pinned
  26.8.1.
