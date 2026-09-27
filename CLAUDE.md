# CLAUDE.md

Repo-specific knowledge for agents working in `@nulab/chat-adapter-backlog`.
Contributor setup and the release process live in
[DEVELOPMENT.md](./DEVELOPMENT.md); this file covers what you cannot derive by
reading the code.

The codebase is heading into a maintenance phase. It grew one feature at a
time, and each addition saw only part of the whole, so the goal of every rule
below is a codebase a human can take over: readable at a glance, one copy of
each piece of knowledge (DRY), and nothing built for a need nobody has
(YAGNI). Speed is not the goal. When a rule here and that goal pull apart, the
goal wins and the rule gets fixed.

## State of the repo

A Backlog adapter for [Chat SDK](https://chat-sdk.dev/). Every required
member of the `Adapter` interface is implemented and `src/index.ts` exports the
real surface, so there **is** a pattern in this repo to follow now: read the
neighbouring module before adding to one.

Layout, mirroring the PR scopes so a change's scope is its path:
`src/adapter.ts` (the class and `createBacklogAdapter`), `src/config.ts` (config
plus environment, one schema), `src/ids.ts` (the id grammar), `src/types.ts`
(public types, including the serialisable raw-message shapes), `src/egress.ts` and `src/reads.ts`, `src/subject/*` (the issue and
pull-request halves of a thread behind one `SubjectClient`), `src/webhook/*`
(ingress), `src/client/*` (the Backlog API port), `src/format/*` (the
converters), and `src/test/fixtures/*`.

`src/subject/*` is where behaviour that differs between an issue and a pull
request belongs, and nowhere else: `subjectClientFor` in
`src/subject/client.ts` picks the half once, and every member reaches Backlog
as `decode -> subjectClientFor -> one code path for both kinds`. The only other
module that may ask what kind a subject is is the codec `src/ids.ts`, which has
no port to route through (D-PR2).

**Types.** The target, which the code does not reach yet: `backlog-js`'s
`Entity.*` types are the source of truth for every Backlog shape, and this
repository declares only the deviations measured against them (recorded in
`.claude/rules/*.md`) as an overlay on those types. Nothing converts to `Date`:
timestamps stay the ISO strings Backlog sends, everywhere, so one type serves
the API response and `message.raw`, which must survive a JSON round trip
through the queue anyway. The current split — `src/client/port.ts` with
`Date`-carrying domain types beside ISO-string raw types in `src/types.ts`,
is what that refactor removes; until it lands, only the raw side is published
(docs/specs/adapter.md §3.1). zod types
never reach the published `.d.ts`: `scripts/check-published-types.mjs` fails
the build on any import there but `chat` and `backlog-js`.

`.github/workflows/ci.yml`'s `consumer` job builds the package, packs the
tarball, installs it with npm outside the repository — lifecycle scripts
included, so a `preinstall` that would break a consumer's install (#99) fails
there — and runs `scripts/consumer-smoke/smoke.mjs` on Node 20, where the
entry has to resolve through `exports` and `createBacklogAdapter()` gets no
argument at all — the five `BACKLOG_*` variables are the whole configuration,
and because `BACKLOG_BOT_USER_ID` is set, `initialize` must reach no network
either, with or without the name (without the id it would ask
`GET /users/myself`; spec D23).
So `exports`, `files`, the env fallbacks and the floor of `engines.node` fail
here rather than at a consumer. Changing any of those four means changing that
consumer in the same commit; its assertions are one file, in the order a
consumer meets them.

The same job then compiles `scripts/consumer-smoke/documented-usage.ts` with
`tsc --noEmit` against the installed declarations, and — except in the run
`release.yml` calls, where `skip-examples` turns it off so an upstream release
cannot block a publish through an example — type checks every `examples/*`
against the same tarball. That file is the usage README.md documents, written
out by hand rather than extracted: a README sample that changes shape changes
it in the same commit, or the job keeps passing on the old shape while the
README shows one that may not compile. Its `chat`, `@chat-adapter/state-memory`
and TypeScript versions are read from `pnpm-lock.yaml` by the job, so a bump
there reaches the consumer without an edit in `scripts/consumer-smoke/`.

## Where each fact lives

Every fact has exactly one home. Before writing one down, find that home; if
the fact is already there, point at it or say nothing. A second copy is not
emphasis, it is the version that goes stale.

| Kind of fact                                         | Home                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------- |
| How the adapter does something                       | the code: names, types, structure                                |
| What it guarantees, member by member                 | the tests, named after the behaviour                             |
| The consumer-visible contract and design decisions   | [the spec](./docs/specs/adapter.md): §14 decisions, §15 verdicts |
| What Backlog and the Chat SDK core do, with the date | `.claude/rules/*.md`                                             |
| Why one change was made                              | the squash commit body                                           |
| Why the obvious code would break                     | a comment on that code                                           |
| How to work here: gates, CI coupling, PR rules       | this file and [DEVELOPMENT.md](./DEVELOPMENT.md)                 |

- **The spec** states what a consumer can observe and which decisions shaped
  it. It describes behaviour: it does not restate the README's content, list
  the tests to write, or record how the work was ordered. It summarises a
  measurement only as far as the measurement changes that behaviour, and
  points at the rules file for the evidence. Tests are written
  from it; when code and spec disagree, one of them is wrong and the PR that
  notices fixes it.
- **`.claude/rules/*.md`** load automatically when a `src/**/*.ts` file is
  read, so an agent editing code already has them. They record facts about
  systems this repository does not control, never the adapter's own choices.
  When the code contradicts a rule there, re-measure before "fixing" the code.
- **This file** holds what no other home can: how to work in the repository,
  and which files CI couples together. It does not restate Backlog or Chat SDK
  facts — those are in the rules — nor the adapter's behaviour — that is the
  spec.
- **`docs/plans/*.md`** exist while a plan is being carried out. A finished
  plan is deleted — git history keeps it, and a record that reads like a
  requirement misleads the next reader. Never cite a plan from code.

When a document and this file disagree, the document is newer; fix this file
in the same PR. The one exception is temporary: for Surface (YAGNI), Parse at
the boundary, the Types target and Test strategy, this file is ahead of the
spec — which still requires the in-memory port, its conformance suite and
`Date`-returning ports — until the refactor PRs rewrite those spec sections.

## Comments

The global rule applies without exception here: code says How, tests say What,
commit bodies say Why, and a comment says only **Why not** — why the code a
careful reader would write instead was not written. Keep a comment only if
deleting it would let that reader "simplify" the code into a bug. A module
with no comments is the expected state for straightforward code; comment
volume is not care.

- **Never restate the spec, a rules file or the types.** A paraphrase of
  docs/specs/adapter.md tells the reader nothing the spec does not and goes
  stale the day the spec changes. Cite the decision instead, or say nothing.
- **No section numbers in `src/`.** Not `§5.1 step 12`, not
  `docs/specs/adapter.md §3.2`, not `docs/plans/… §3.4`: sections renumber,
  plans are records, and an exported doc comment ships to a consumer who has
  neither document. When a Why-not rests on a recorded design decision, end
  it with the **decision id** alone — `(D14)`, `(D-PR3)` — which is stable and
  leads straight to the rejected alternatives in §14.
- **Measured behaviour: the consequence in the comment, the evidence in the
  rules file.** Write `a comment edit emits no webhook (measured)` and stop.
  The date, the payload excerpt and the counts are written once, in
  `.claude/rules/*.md`, which the reader already has loaded; a measurement
  that prompted a change also belongs in that change's commit body.
- **Exported doc comments are for consumers.** TSDoc on anything
  `src/index.ts` exports ships in the declaration file and appears in a
  consumer's editor. Say what a caller must know and the type cannot express —
  what it throws, what a value means, a precondition — in a sentence or two.
  Internal design history does not belong there.
- **Internal symbols get no doc comment by default**, and a module gets no
  header, unless there is a Why-not to state. A function named for what it
  does needs no summary of it.
- **In tests, the `it(...)` name is the specification.** A comment restating
  it, or narrating a fixture, is deleted; a fixture's provenance is one line
  naming the rules-file section it reproduces.
- A comment that disagrees with the code is a bug, fixed in the PR that finds
  it.

## Surface (YAGNI)

The bar for anything the adapter has is whether a consumer **needs** it — not
whether Backlog makes it possible. The scale reference is the first-party
`@chat-adapter/github` and `@chat-adapter/linear`, which implement the whole
contract in roughly 1.4k–2k lines; a feature this adapter has and they lack
needs a reason specific to Backlog.

- Every optional `Adapter` member, config option, public export, public
  method, cache, retry and defensive check names the consumer need it serves.
  "Backlog supports it", "might be useful" and "just in case" are not needs.
  Without one, delete it; do not keep it because it already works.
- Everything public is permanent once released and a test obligation now, so
  the default answer to "should this be exported?" is no.
- Until the first release is published, there is no backward compatibility:
  a breaking change is made directly, with the `!` title and `BREAKING CHANGE:`
  footer the PR rules require, and never with a shim, deprecated alias or
  fallback for the old shape. The maintainer revisits this after that release.
- A spec requirement that no consumer relies on is a deletion from the spec,
  not an implementation task. Propose the deletion; do not build around it.
- Say a thing once. Two modules that make the same decision, two types for
  the same shape, and two tests of the same behaviour are each one too many.

## Parse at the boundary, trust inside

Every external input is parsed **exactly once**, by a zod schema, in one module
per boundary: the webhook body, each Backlog API response, config plus
environment variables, and id strings. Code past that module trusts the
parsed type.

- Shape, presence and normalisation belong in the schema: `null` versus
  missing, numeric strings, positive integers, the id grammar, mutually
  exclusive config fields, the environment fallback. Inner code does no
  ad-hoc `=== undefined`, `Number.isInteger` or length re-checks of a value a
  schema already produced; if one seems needed, the schema is missing a rule.
- A check that depends on remote state — does this comment belong to this
  thread, does this project exist on this host — is not parsing. It is an
  explicit guard, and a boundary's guards are gathered in one function rather
  than spread through the callers.
- A `ZodError` is translated into a `@chat-adapter/shared` error in one place
  per boundary, and never escapes the package.

## Quality gates

Run all five before declaring work done; CI runs exactly these:

```sh
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build
```

- `pnpm lint` uses `--max-warnings 0`, so a `console.log` (allowed: `warn`,
  `error`) fails the build. `typescript/no-explicit-any` is an error outside
  `*.test.ts`.
- The pre-commit hook's oxlint step ends in `|| true` — it never blocks a
  commit. A green commit says nothing about a green CI.
- `tsconfig.json` enables `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (type-only imports must
  say `import type`), `noUnusedLocals` and `noUnusedParameters` (prefix
  intentionally unused params with `_`).
- `pnpm build` fails on `publint` problems, on `attw` problems at the
  `esm-only` profile, and via `scripts/check-published-types.mjs`, which runs
  after tsdown, on a `dist/index.d.ts` that imports any module but `chat` and
  `backlog-js`. Touching `exports`, `files`, `scripts` or the build config
  means running the build, not just the type check.
- `engines.node` is `">=20"` (matching the `chat` core package), so do not use
  APIs newer than Node 20 in shipped code. The test matrix runs the suite on
  Node 20, 22, 24 and 26, so a 26-only API now fails a job rather than reaching
  a consumer — but `pnpm typecheck` and `pnpm build` still only ever see the
  pinned runtime, so a type-level or build-time 26-ism is caught by `test`
  alone.
- One Node runs the gates and pnpm provisions it: `devEngines.runtime` in
  `package.json` (`^26.0.0`), pinned with a checksum in `pnpm-lock.yaml`.
  `pnpm exec node`, `pnpm run <script>` and a bare `node` inside a script all
  get it. A bare `node` in your own shell is a different Node, or none at all —
  never assume one exists; go through pnpm.
- `pnpm install` needs nothing but pnpm on PATH. There is no `mise.toml` any
  more, and no bootstrap Node: the standalone pnpm build has Node.js linked in,
  and the install-script ordering bug that used to make this fail
  (pnpm/pnpm#14358) is fixed in the pinned pnpm.
- No setting overrides the runtime per invocation (`--config.useNodeVersion` and
  `PNPM_SHIM_BYPASS` are accepted and ignored). To run a gate on a different
  Node, install with `--no-runtime` and put that Node on PATH — that is exactly
  what the CI matrix does. Do not edit `devEngines.runtime` to test another
  major; it changes the lockfile.
- `@types/node` tracks the runtime's major on purpose. Running it ahead makes
  `pnpm typecheck` accept APIs that do not exist at run time; holding it behind
  hides APIs that do. Move the two together.
- `pnpm-workspace.yaml` uses `allowBuilds` (pnpm 11 removed
  `onlyBuiltDependencies`), and `minimumReleaseAge: 4320` means "latest" is the
  newest release at least three days old. A brand-new version simply will not
  resolve; that is intended, so wait rather than lowering it.

## Pull requests

Three rules shape every PR here, and they interact: work reaches `main` only as
a squash commit, stacked PRs are actively used, and the release notes are
generated from labels.

### Titles

Conventional Commits, **with a scope**, because the title becomes a commit
subject on `main`: `feat(webhook): 401 a request with no path secret`.

Types used here: `feat`, `fix`, `perf`, `refactor`, `test`, `docs`, `ci`,
`chore`, `revert`. Two are deliberately absent: `style`, because oxfmt owns
formatting and a formatting-only change is a `chore` on the scope it touched;
and `build`, because `build` is a _scope_ here — the toolchain change that
would be `build:` elsewhere is `chore(build)` or `fix(build)`.

| Scope       | Covers                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `adapter`   | the `Adapter` surface: the class, `createBacklogAdapter`, thread-ID codec, egress, reads, reactions, presence, `stream()` |
| `client`    | the Backlog API port: the `backlog-js` wrapper, auth, the 429 retry, typed errors                                         |
| `webhook`   | webhook ingress: verification, body parsing, the `processMessage` dispatch                                                |
| `format`    | markup conversion — the `BaseFormatConverter` subclass and its AST both ways                                              |
| `build`     | tsdown, `exports`/`files`, `tsconfig.json`, publint/attw                                                                  |
| `toolchain` | pnpm, the pinned Node runtime, oxlint/oxfmt/vitest configuration, lefthook                                                |
| `ci`        | `.github/workflows/ci.yml` and the Node matrix                                                                            |
| `release`   | `.github/workflows/release.yml`, `.github/release.yml`, publishing, versioning                                            |
| `deps`      | dependency and lockfile bumps — what Dependabot opens                                                                     |
| `docs`      | README, DEVELOPMENT.md, CLAUDE.md/AGENTS.md, the PR template, `docs/`, `.claude/rules/`                                   |
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
- `breaking` is the first category in `release.yml`, and GitHub documents `'*'`
  as the catch-all "for pull requests that didn't match any of the previous
  categories" — categories are matched in file order and a PR lands in exactly
  one — so a breaking feature carrying both labels appears under Breaking
  Changes, which is the intent.
- Dependabot applies `dependencies` and an ecosystem label itself, and creates
  those labels if they are missing, so its PRs need nothing from you.
- **Nothing in this repository creates the six labels.** `.github/release.yml`
  only categorizes; no workflow syncs labels. They exist because the maintainer
  created them. If `gh pr edit --add-label enhancement` fails because the label
  does not exist, say so in the PR and stop — do not create one, and never
  settle for a near-miss like `feature` or `bugfix`, which the generated notes
  cannot tell apart from unlabeled.

### Squash merge

Squash merge is the standard, and the individual commits on the branch never
reach `main`. Their Why bodies are therefore lost unless they are carried into
the squash commit message. GitHub composes a default message from the PR title,
the description or the commits depending on repository settings, and that
default is not a substitute for a body somebody wrote:
[about pull request merges](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges).
So before merging, write the squash message on purpose — subject = the PR
title, body = the Why consolidated from the branch's commits and the PR
description, `BREAKING CHANGE:` footer kept if there is one.

Two consequences worth stating plainly: the PR title is a commit subject and is
held to the same standard as one, and a PR body that says "see the commits"
leaves nothing behind on `main` at all.

A non-squash merge would need a case where the separation of the commits is
itself the value on `main` _and_ each commit passes all five gates alone —
importing external history, say. That has not come up, only squash is enabled,
and anything else is the maintainer's call, not yours.

### Stacked PRs

Use them. A dependent change split into a stack gives each part a reviewable
diff and gets the bottom of it merged while the top is still being written.

**Create a stack by basing each PR on the previous branch, not `main`:**

```sh
git switch -c lollipop-onl/backlog-client        # PR A, base main
# ...
git switch -c lollipop-onl/webhook-ingress       # PR B, branched off PR A
gh pr create --base lollipop-onl/backlog-client  # not the default base
```

GitHub fixes the base when the PR is opened and will not update it if the branch
changes later
([changing the base branch](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/changing-the-base-branch-of-a-pull-request)),
so a stack member opened with the default base shows its parent's commits as its
own. Repair that by editing the base, not by rebasing.

**Declare the dependency in the PR body** so the order does not have to be
inferred from branch names. First line of the Why section:
`Stacked on #12 — merge that first.` Review and merge bottom-up: until the
parent merges, the child's diff contains the parent's commits, and a child must
never merge ahead of its parent.

**After the bottom PR is squash-merged**, two things are true and neither of
them fixes the child's branch:

1. If the merged branch is deleted — by the repository's automatic-deletion
   setting or by hand — GitHub "checks for any open pull requests in the same
   repository that specify the deleted branch as their base branch" and
   "automatically updates any such pull requests, changing their base branch to
   the merged pull request's base branch"
   ([creating and deleting branches](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/proposing-changes-to-your-work-with-pull-requests/creating-and-deleting-branches-within-your-repository)),
   so the child ends up targeting `main`. Before retargeting existed, those PRs
   were closed outright
   ([changelog](https://github.blog/changelog/2020-05-19-pull-request-retargeting/)).
   Retargeting moves the PR's base pointer and nothing else. If the branch is
   _not_ deleted, not even that happens: the child keeps a base branch that is
   now a dead end.
2. The child's branch still carries the parent's commits, while `main` has that
   content only inside the squash commit, under a different SHA — so the
   child's diff presents the parent's work a second time. GitHub documents the
   consequence: "If you keep working on the same head branch after a squash
   merge, later pull requests can include commits that were already squashed
   into the base branch. This can make merge conflicts more likely and can
   force you to resolve the same conflicts more than once", and advises
   rebasing before opening the next pull request
   ([about pull request merges](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/about-pull-request-merges)).

The recovery is a rebase that names its cut point:

```sh
git fetch origin
git rebase --onto origin/main <parent-tip> lollipop-onl/webhook-ingress
git push --force-with-lease
```

`<parent-tip>` is the parent branch's last commit before it was merged. Record
it (`git rev-parse origin/<parent-branch>`) before the branch is deleted, or
recover it afterwards from the PR's merge event or `git reflog`.

Plain `git rebase origin/main` is the form that fails. It replays every commit
on the child that is not on `main`, the parent's included, and git drops only
commits that are "clean cherry-picks (as determined by
`git log --cherry-mark ...`)"
([git-rebase](https://git-scm.com/docs/git-rebase)). A squash of more than one
commit is patch-identical to none of them, so nothing is dropped: git reapplies
changes `main` already has and hands you the conflicts. `--onto` states the
graft point and the cut point separately, so only the child's own commits are
replayed — the documented use of `git rebase --onto master topicA topicB` to
"rebase part of a branch"
([git-rebase](https://git-scm.com/docs/git-rebase)).

Force-pushing your own stack branch after that rebase is expected, and is the
one exception to leaving pushed commits alone. Use `--force-with-lease`, and
only on a stack branch — never on `main`.

**A stack is the wrong tool when:**

- The parts are not genuinely dependent. Open them as separate PRs off `main`:
  they merge in any order and none of them pays the rebase above.
- The bottom PR would leave `main` broken. That is one indivisible change, not a
  stack — every PR merges on its own and must pass all five gates on its own.
- The stack is getting deep. Each merge costs a rebase and a force-push on every
  branch above it, so keep a stack to two or three and merge the bottom promptly
  instead of accumulating.

## Chat SDK adapter contract

The interface is `Adapter<TThreadId, TRawMessage>` in `chat`'s own `.d.ts` —
the authority, where the docs page is not fully in sync. Which members this
adapter implements and why the rest are absent is spec §4; what the core does
with each member is `.claude/rules/chat-sdk-core-facts.md`. The upstream
guides still govern new work:
[Building an adapter](https://chat-sdk.dev/docs/contributing/building),
[Publishing your adapter](https://chat-sdk.dev/docs/contributing/publishing),
[Vendor-official adapters](https://chat-sdk.dev/docs/contributing/vendor-official),
[Testing](https://chat-sdk.dev/docs/testing).

Conventions that hold across the codebase:

- Export both the class and a `createBacklogAdapter(config?)` factory, with
  `config?.x ?? process.env.X` fallbacks so zero-config construction works.
  The vendor-official review additionally expects credential fields to accept
  **resolver functions**, not only static strings, resolved per call.
- `@chat-adapter/shared` supplies the error classes to throw and the message
  helpers (`extractCard()`, `extractFiles()`, `toBuffer()`,
  `cardToFallbackText()`). Do not hand-roll equivalents.
- `handleWebhook` must, in this order: verify the request's authenticity and
  return **401** if it is missing or invalid; parse the raw body; build a lazy
  async factory (`async () => this.parseMessage(payload)`); call
  `this.chat.processMessage(this, threadId, factory, options)`; return 200
  quickly. The SDK handles `waitUntil` internally.
- Formatting goes through a `BaseFormatConverter` subclass.
- `stream()` stays overridden (D4). Without it the core posts and then edits
  the message every 500 ms, which spends Backlog's update bucket faster than
  any other path in the adapter.

## Backlog API landmines

Reference: [Backlog API v2](https://developer.nulab.com/docs/backlog/); only
v2 exists. Hosts, auth, the error envelope, webhook authenticity, the absence
of a realtime transport and the activity types are measured facts, recorded in
`.claude/rules/backlog-api-facts.md`, `backlog-webhook-facts.md` and
`backlog-pull-request-facts.md`. Do not reason about pull requests from the
issue side.

**Rate limits** are per user, per minute, in four buckets, and issue listing
draws on `search`, not `read`; the table and its traps are in
`backlog-api-facts.md` § Rate limit. The adapter does not classify requests
into them or track them (docs/specs/adapter.md D5).

## Dependency plan

Build on [`backlog-js`](https://github.com/nulab/backlog-js) (v0.20.1, MIT,
Nulab's own, tsdown-built, single runtime dependency `qs`). The narrow
internal port it is currently wrapped behind is being removed in favour of
calling `backlog-js` directly (see Types and Test strategy). It does not
provide, and this repo must add:

1. Typed errors derived from `errors[].code`.
2. 429 retry with backoff computed from `X-RateLimit-Reset`: one retry, a
   wait of at most 60 s, both internal constants rather than configuration.

Per-bucket rate-limit tracking is deliberately **not** on this list. It was
built and removed: its only consumer was a public snapshot nothing in the
adapter read, and the retry needs only the failing response's own header
(docs/specs/adapter.md D5).

Both live in the **`fetch` injected into the client**, not around the
port's call sites, because that is the only seam every `backlog-js` method
funnels through. That is what lets `adapter.client()` hand a consumer the
very client the port speaks through — for the endpoints the port does not name
— without either being bypassed. The consequence, taken knowingly:
`backlog-js` appears in the published types, so dropping it for plain `fetch`
is no longer a change invisible to consumers (docs/specs/adapter.md §3.1,
§8.2).

## Test strategy

- Vitest, colocated `src/**/*.test.ts`.
- **One layer per behaviour.** A behaviour is tested where it is decided, once:
  not through `BacklogAdapter` and again through the module function behind
  it. Adapter-level tests cover wiring; module tests cover the decision.
- **Stub `backlog-js` with `vi.fn`** on the client's methods. Do not maintain a
  fake Backlog or a conformance suite to keep one honest, and never msw or
  nock. The injected `fetch` is tested at its own layer, with a stubbed `fetch`.
- **No test restates a fixture or greps source text.** A test that asserts a
  fixture equals itself, or that a string appears in a file, specifies nothing
  a reader can use.
- Run the three contract suites from `@chat-adapter/tests`
  (`threadIdContract`, `selfMessageContract`, `connectWebhookContract`)
  against this adapter; they encode invariants that are easy to break
  silently. Its other exports are listed in
  `.claude/rules/chat-sdk-core-facts.md`.
- `pnpm test` must pass with no credentials and no network. Any live suite is
  opt-in and self-skipping on absent `BACKLOG_API_KEY` — see the pattern in
  DEVELOPMENT.md. Keep it lean; a chatty suite will 429 the update bucket.

## `examples/`

`examples/*` are **standalone projects**, not workspace members: each one
depends on the published adapter (`"@nulab/chat-adapter-backlog": "^0.1.0"`),
installs on its own, and deploys from its own directory. Copying one out of
this repository has to leave it working, which is the rule that settles most
questions about them. `pnpm-workspace.yaml` names no packages, and the one
thing CI does with an example as a project is the `consumer` job's: copy it
out of the repository, point its adapter dependency at the packed tarball,
`npm install` and `npm run typecheck`. So an example has to compile against
what the package ships, not against `src/`, and it has no tests for CI to run.
The root `lint` and `format:check` reach into `examples/` as well (oxfmt
formats the Markdown too: it aligns tables and normalises bullets, though it
never reflows prose, so write a README and let `pnpm format` settle it).

`examples/README.md` is the index and carries the setup all of them share; an
example's own README does not repeat it.

Each example is one PR and touches nothing outside its own directory. An
adapter bug or gap found while writing one goes in that PR's description under
"Adapter notes" — not into `src/`, which is a separate change with a separate
scope.

The layout is the same in every example, and is the convention rather than a
suggestion:

```
examples/<name>/
  README.md  package.json  vercel.json  .vercelignore  .env.example  tsconfig.json
  api/webhooks/backlog.ts   # the Vercel function, nothing else
  src/bot.ts                # Chat + adapter + handler registration; the only side effects
  src/<logic>.ts            # the decision, as a pure function
```

No numbering on the directory, and **no tests**: an example is small enough to
read end to end, and it earns its keep by being copied rather than verified.
That is also why `src/bot.ts` keeps the side effects and `src/<logic>.ts` keeps
the rule — the thing a reader came for should not be tangled in the wiring.

Package name `chat-adapter-backlog-example-<name>`, `private: true`, and the
three scripts `typecheck` / `deploy` / `deploy:prod`. `vercel.json` sets
`framework: null` and `installCommand: "npm install"`, and orchestrates
nothing else. npm because pnpm inside a clone finds the root
`pnpm-workspace.yaml` and installs the repository instead; an explicit command
because Vercel picks the package manager from the lockfile it finds, an example
has none of its own, and an overridden `pnpm install` runs pnpm 6 there.

Two rules about what an example may do, both load-bearing:

- **Parse `unknown` with zod, never assert.** `message.raw` reaches a handler
  as `unknown`, and parsing is also the only honest way to read a key the
  adapter's own schema does not name (`raw.payload` keeps everything Backlog
  sent). The same goes for `process.env`: one schema at module load, so a
  missing variable or a non-numeric id fails the first cold start rather than
  sending `NaN` to Backlog later.
- **Reach Backlog through `backlog.client()`.** That is the `backlog-js`
  client the adapter hands out for the endpoints its port does not name, and it
  carries the adapter's bounded 429 retry and its error classes. An example must not build a Backlog client of its own, and
  must not depend on `backlog-js` directly.

State is `@chat-adapter/state-memory`, and no example subscribes to a thread.

Environment variable names are shared across examples, not invented per
example: the five the adapter reads (`BACKLOG_HOST`, `BACKLOG_API_KEY`,
`BACKLOG_BOT_USER_ID`, `BACKLOG_BOT_USER_NAME`, `BACKLOG_WEBHOOK_SECRET` — the
id set in every `.env.example` so no cold start reads it from
`GET /users/myself`, the name optional) plus
meaningful names for the rest — `DONE_STATUS_ID`, `REQUIRED_CUSTOM_FIELD_ID`,
`BUG_ISSUE_TYPE_NAME`, `INTAKE_CONTACT_USER_ID`, `AI_MODEL`,
`AI_GATEWAY_API_KEY`. No `EXAMPLE_` prefix.

Every README has the same five sections, in this order: **What it does**,
**Try it**, **How it works**, **Deploy**, **Limits**. A measured Backlog
behaviour cited in "How it works" is sourced as
`measured on a development space, <date>` and names no space, project, issue,
person or Vercel project.

## Don't

Anti-patterns observed in real adapter code:

- **No `process.exit()`** anywhere. This is a library; killing the host process
  on a config error is never correct. Throw a typed error.
- **Never skip webhook verification** because the raw body was unavailable —
  that is the case where you must return 401. (Other adapters add a timestamp
  staleness window; this one does not, because a Backlog timestamp is unsigned
  and a window would only drop measured late redeliveries — spec §5.1.)
- **Never swallow a send error and return a fabricated success.** A failed post
  must surface as a rejection, not as a synthetic message object.
- **Never mutate the caller's message envelope.** Copy before adding
  platform-specific fields.
- **Never hard-code a space host, a rate-limit number, or an activity type
  name** in a place a user cannot override or a future reader cannot trace back
  to the API docs.
