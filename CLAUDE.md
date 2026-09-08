# CLAUDE.md

Repo-specific knowledge for agents working in `@nulab/chat-adapter-backlog`.
Contributor setup and the release process live in
[DEVELOPMENT.md](./DEVELOPMENT.md); this file covers what you cannot derive by
reading the code.

## State of the repo

A Backlog adapter for [Chat SDK](https://chat-sdk.dev/). Every required
member of the `Adapter` interface is implemented and `src/index.ts` exports the
real surface, so there **is** a pattern in this repo to follow now: read the
neighbouring module before adding to one.

Layout, mirroring the PR scopes so a change's scope is its path:
`src/adapter.ts` (the class and `createBacklogAdapter`), `src/ids.ts` (the id
grammar), `src/types.ts` (public types, including the serialisable raw-message
shapes), `src/egress.ts` and `src/reads.ts`, `src/subject/*` (the issue and
pull-request halves of a thread behind one `SubjectClient`), `src/webhook/*`
(ingress), `src/client/*` (the Backlog API port), `src/format/*` (the
converters), and `src/test/fixtures/*`.

`src/subject/*` is where behaviour that differs between an issue and a pull
request belongs, and nowhere else: `subjectClientFor` in
`src/subject/client.ts` picks the half once, and every member reaches Backlog
as `decode -> subjectClientFor -> one code path for both kinds`. Exactly one
other module may ask what kind a subject is: the codec `src/ids.ts`, which has
to write `issue:<id>` versus `pr:<repositoryId>:<number>` and has no port to
route through. `src/subject/containment.test.ts` greps `src/` for the shapes
a dispatch on `kind` is written in — a `switch`, a comparison (`?.`,
`['kind']`, `==` and a backticked kind included) and a `{ kind }`
destructuring — and fails on a third module, so the rule is at least partly
executable rather than only remembered (D-PR2, docs/specs/adapter.md §14). It
is a tripwire, not a proof: it matches only a receiver it can *name*, because
its exemptions for `raw` and `source` are by name, so a check whose receiver
has no name on the line — `(await …).kind`, a parameter pattern, a predicate —
passes it. That file's header lists what it does not see; read it before
trusting a green run.

It reads the **text** of a line, not parsed code, which is why a comment is
stripped before matching: a Why-not sentence about D-PR2 is safe to write, and
`src/webhook/bulk.ts` and `src/subject/url.ts` already carry one. A string
literal is not stripped, though, so prose written *outside* a comment — a log
message, a test fixture, a doc string — must keep the `kind` read and the
subject-kind literal on separate lines, or the scan reports the sentence and
tells its author to move a comment onto `SubjectClient`.

One split is worth knowing before you touch either side: `src/client/port.ts`
owns the **API domain** types, which carry `Date` objects, while `src/types.ts`
owns the **raw-message** types reachable from `message.raw`, which carry ISO
strings so a serialised `Message` survives the queue round trip. The root and
comment shapes say which side they are on in their own names —
`BacklogRawIssue`, `BacklogRawComment`, `BacklogRawPullRequest` — so only
`BacklogChange` and `TextFormattingRule` are declared on both sides. Which of
the two the barrel exports, and why, is written at the top of `src/index.ts`;
read it there rather than trusting a second copy of it here.

`.github/workflows/ci.yml` builds the bundle, imports it in a real Node
process, constructs an adapter from it and asserts `adapter.name === 'backlog'`.
Changing the public entry means changing that smoke test in the same commit, or
the build job breaks.

## Design documents

The goal state and the route to it are written down, not inferred from this
file. Read them before touching `src/`:

- [docs/specs/adapter.md](./docs/specs/adapter.md) — what the finished adapter
  does: id grammar, config, every `Adapter` member's behaviour, webhook
  response ladder, error mapping, test requirements. Tests are written from it.
- [docs/plans/adapter-implementation.md](./docs/plans/adapter-implementation.md)
  — the PR stack that gets there, with acceptance criteria per phase and the
  decisions still open for the maintainer.
- [docs/plans/pull-request-support.md](./docs/plans/pull-request-support.md)
  — the follow-on stack that makes a pull request a thread alongside an
  issue: the kind-explicit id grammar, the subject layer, activity types
  18–20, and the measurements behind them. Its P0 has landed, so the spec
  above is the specification of record for pull-request behaviour too; this
  plan now carries the stack's status, the rationale per PR, and the
  measurement that was waived rather than satisfied (§4, P3).
- `.claude/rules/*.md` — measured Backlog behaviour and verified Chat SDK core
  behaviour, loaded automatically when a `src/**/*.ts` file is read. When the
  code contradicts a rule there, re-measure before "fixing" the code.

The sections below are the constraints those documents were written under.
When a document and this file disagree, the document is newer; fix this file
in the same PR.

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
  `esm-only` profile, and — via `scripts/check-published-types.mjs`, which runs
  after tsdown — on a `dist/index.d.ts` that imports any module but `chat`.
  Touching `exports`, `files` or the build config means running the build, not
  just the type check.
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
| `client`    | the Backlog API port: the `backlog-js` wrapper, auth, rate-limit buckets, typed errors, retries                           |
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

Read before implementing:

- [Building an adapter](https://chat-sdk.dev/docs/contributing/building) — walks
  a complete Matrix adapter end to end.
- [Publishing your adapter](https://chat-sdk.dev/docs/contributing/publishing)
- [Vendor-official adapters](https://chat-sdk.dev/docs/contributing/vendor-official)
- [Testing](https://chat-sdk.dev/docs/testing)

The interface is `Adapter<TThreadId, TRawMessage>`, shipped in `chat`'s own
`.d.ts` — read it there rather than trusting the docs page, which is not fully
in sync. As of `chat@4.39.0` it has **17 required members**:

- Properties: `name`, `userName`
- Lifecycle: `initialize(chat)`
- Thread IDs: `encodeThreadId`, `decodeThreadId`, `channelIdFromThreadId`
  (the docs page lists this one as optional; the shipped type says otherwise)
- Ingress: `handleWebhook`, `parseMessage`
- Egress: `postMessage`, `editMessage`, `deleteMessage`, `renderFormatted`
- Reactions: `addReaction`, `removeReaction`
- Reads: `fetchMessages`, `fetchThread`
- Presence: `startTyping`

…and 27 optional ones the SDK degrades gracefully around (`stream`,
`disconnect`, `openDM`, `isDM`, `reply`, `listThreads`, `fetchMessage`,
`fetchChannelInfo`, `fetchChannelMessages`, `openModal`, `postEphemeral`,
`postChannelMessage`, `scheduleMessage`, `markAsRead`, `getUser`, and others).
Implement only what Backlog can actually support.

Conventions to follow:

- Export both the class and a `createBacklogAdapter(config?)` factory, with
  `config?.x ?? process.env.X` fallbacks so zero-config construction works.
  The vendor-official review additionally expects credential fields to accept
  **resolver functions**, not only static strings, resolved per call.
- `@chat-adapter/shared` supplies the error classes to throw
  (`ValidationError`, `AuthenticationError`, `ResourceNotFoundError`,
  `PermissionError`, `AdapterRateLimitError`, `NetworkError`, `AdapterError`)
  and the message helpers `extractCard()`, `extractFiles()`, `toBuffer()`,
  `cardToFallbackText()`. Do not hand-roll equivalents.
- `handleWebhook` must, in this order: verify the request's authenticity and
  return **401** if it is missing or invalid; parse the raw body; build a lazy
  async factory (`async () => this.parseMessage(payload)`); call
  `this.chat.processMessage(this, threadId, factory, options)`; return 200
  quickly. The SDK handles `waitUntil` internally.
- Formatting goes through a `BaseFormatConverter` subclass (`toAst`,
  `fromAst`, and `renderPostable` only if Backlog's markup demands it).
- **Dependency on `chat`:** the published docs prescribe
  `"peerDependencies": { "chat": "^4.0.0" }` plus
  `"dependencies": { "@chat-adapter/shared": "^4.0.0" }`, while every
  first-party `@chat-adapter/*` package (checked: `@chat-adapter/github@4.39.0`)
  instead pins both exactly in `dependencies` (`"chat": "4.39.0"`). The exact
  pin only works inside Vercel's release-locked monorepo; a package released on
  its own cadence should follow the docs and use the peer range. Whichever is
  chosen, record why in the commit.

## `stream()` must be overridden

If `stream()` is left unimplemented, the SDK falls back to posting a message
and editing it every `streamingUpdateIntervalMs`, which defaults to **500 ms**
(`chat@4.39.0`). Against Backlog that is roughly 120 edits per minute into a
150-per-minute Update bucket — one streamed reply can exhaust the user's write
quota. `@chat-adapter/github` overrides `stream()` for exactly this reason: it
accumulates the whole `textStream` and calls `postMessage` once. Do the same
here.

## Backlog API landmines

Reference: [Backlog API v2](https://developer.nulab.com/docs/backlog/). Only v2
exists.

**Host.** Base URL is `https://<space>.backlog.com/api/v2`, but spaces also live
on `backlog.jp` and legacy `backlogtool.com` domains (the docs show
`backlog.com` and `backlogtool.com`). Take the full host as a configurable
string; never accept a subdomain slug and template a fixed domain around it.

**Auth.** ([Authentication &
Authorization](https://developer.nulab.com/docs/backlog/auth/)) API key via the
`Backlog-API-Key` header — prefer it, because the documented `?apiKey=`
query-string form leaks the key into access logs, proxies and error reports. Or
OAuth 2.0 authorization code grant against `POST /api/v2/oauth2/token`:
`Bearer` access token with `expires_in: 3600`, refreshable via
`grant_type=refresh_token`; no scopes are documented, so a token is
all-or-nothing.

**Rate limits.** ([Rate limit](https://developer.nulab.com/docs/backlog/rate-limit/),
[Get Rate Limit](https://developer.nulab.com/docs/backlog/api/2/get-rate-limit/))
Limits are **per user, per minute**, in four independent buckets:

| Bucket | Covers                                                     | Documented example |
| ------ | ---------------------------------------------------------- | ------------------ |
| read   | GET, excluding the Search and Icon endpoints               | 600                |
| update | POST, PATCH, DELETE                                        | 150                |
| search | Issue List, Count Issue, Wiki Page List, Count Wiki Page   | 150                |
| icon   | Space Logo, User Icon, Project Icon, Group Icon, Team Icon | 60                 |

Traps, in order of how easily they are missed:

1. **Issue listing and counting draw on `search`, not `read`.** The bucket that
   any polling loop consumes is the 150 one, not the 600 one.
2. **The numbers above are the documented example values.** The rate-limit page
   states limits differ between Free and Paid plans and tells you to call
   `GET /api/v2/rateLimit`. Read the real figures from that endpoint or from the
   response headers; do not hard-code 600/150/150/60 as invariants.
3. **Backlog sends no `Retry-After`.** Over limit is HTTP 429 with error code 13. Compute the backoff from `X-RateLimit-Reset`, which is **UTC epoch
   seconds**, alongside `X-RateLimit-Limit` and `X-RateLimit-Remaining`. Track
   the headers per bucket — one bucket's remaining count says nothing about
   another's.

**Errors.** ([Error response](https://developer.nulab.com/docs/backlog/error-response/))
The body is `{"errors":[{"message":"...","code":N,"moreInfo":"..."}]}` with
codes 1–13: 1 InternalError, 2 LicenceError, 3 LicenceExpiredError,
4 AccessDeniedError, 5 UnauthorizedOperationError, 6 NoResourceError,
7 InvalidRequestError, 8 SpaceOverCapacityError, 9 ResourceOverflowError,
10 TooLargeFileError, 11 AuthenticationError, 12 RequiredMFAError,
13 TooManyRequestsError. The HTTP status alone is not enough to classify a
failure — map from `errors[].code` when deciding what to throw and what to
retry.

**Webhooks have no HMAC signing.** ([Add
Webhook](https://developer.nulab.com/docs/backlog/api/2/add-webhook/)) The
endpoint accepts only `name`, `description`, `hookUrl`, `allEvent` and
`activityTypeIds[]` — there is no secret parameter and no signature header, so
Chat SDK's "verify the signature, else 401" contract cannot be satisfied the
usual way. Backlog offers only IP allowlisting or Basic auth embedded in the
URL. The workable shape: carry a high-entropy secret in the `hookUrl` path or
query, compare it in constant time, 401 on mismatch, and expose a
`webhookVerifier` escape hatch so a deployment can plug in its own check (a
reverse-proxy assertion, mTLS, an IP allowlist). Document the weaker guarantee
where users will see it; never silently skip verification.

**No realtime transport.** No SSE, no WebSocket. Push is webhooks only.
Anything else polls: `updatedSince` on
[`GET /api/v2/issues`](https://developer.nulab.com/docs/backlog/api/2/get-issue-list/)
— note its granularity is a **date** (`yyyy-MM-dd`), not a timestamp, so it
cannot be used as a fine-grained cursor on its own — and `minId` / `maxId` /
`count` (1–100) on
[`GET /api/v2/notifications`](https://developer.nulab.com/docs/backlog/api/2/get-notification/).
Both compete for the 150/min search and read budgets, so any poller needs a
persisted cursor and a backoff.

**Activity types** ([Get
Activity](https://developer.nulab.com/docs/backlog/api/2/get-activity/)) that
matter here: **1** Issue Created, **2** Issue Updated, **3** Issue Commented,
**4** Issue Deleted, **14** Issue Multi Updated, **18** Pull Request Added,
**19** Pull Request Updated, **20** Comment Added on Pull Request. **14** is
the only one whose single delivery can stand for several issues: a bulk update
from the issue list emits one type 14 naming every issue in `content.link[]`
and no type 2 or 3 for any of them, so ingress fans it out into one message
per entry (D22). The screen decides that type, not the count — one issue
updated from the issue list is a type 14 with a one-entry `link[]`, while the
same field changed on the issue's own page is a type 2. **17** Comment
Notification Added is acknowledged, not dispatched. Two routes to addressing
somebody on a comment were measured, and only one of them emits it: picking
recipients while posting the comment produces a plain type 3, while adding
recipients to an **already existing** comment via
`POST /issues/:id/comments/:commentId/notifications` produces a type 17 that
repeats that comment's own id and text
(`.claude/rules/backlog-webhook-facts.md`). What else may emit it is not
established here. **21** is documented as "Pull Request Deleted" and typed by
`backlog-js` as `PullRequestMerged`; it was not observed — merge and close
both arrive as type 19 status changes, and no delete operation exists in the
UI or the API (`.claude/rules/backlog-pull-request-facts.md`), so it is
neither dispatched nor named in the registration guidance (D-PR5). Subscribe
explicitly via `activityTypeIds[]` rather than setting `allEvent` — the full
range runs to 49 and includes git push, wiki and document events this adapter
has no meaning for. The guidance users are given is
`activityTypeIds: [1, 2, 3, 14, 18, 19, 20]`, plus **4** when deletion events
are wanted; what the code accepts is `DISPATCHED_ACTIVITY_TYPES` in
`src/webhook/payload.ts` (`[1, 2, 3, 4, 14, 18, 19, 20]` — 4 is always
dispatched when it arrives), and every other type, 21 included, is answered
200 Ignored. Leaving 14 out of the registration is the documented way to
decline the fan-out; there is no adapter option for it (D-PR4, D22).
Pull-request facts (three-coordinate addressing, no comment delete,
`read`-bucket listing, the `assignee` vs `assigner` field name) live in that
rules file; do not reason about them from the issue side.

## Dependency plan

Build on [`backlog-js`](https://github.com/nulab/backlog-js) (v0.20.1, MIT,
Nulab's own, tsdown-built, single runtime dependency `qs`), wrapped behind a
narrow internal port. It does not provide, and this repo must add:

1. Rate-limit bucket awareness (classify each request into read/update/search/
   icon and track the headers per bucket).
2. Typed errors derived from `errors[].code`.
3. 429 retry with backoff computed from `X-RateLimit-Reset`.

All three live in the **`fetch` injected into the client**, not around the
port's call sites, because that is the only seam every `backlog-js` method
funnels through. That is what lets `adapter.client(host)` hand a consumer the
very client the port speaks through — for the endpoints the port does not name
— without any of the three being bypassed. The consequence, taken knowingly:
`backlog-js` appears in the published types, so dropping it for plain `fetch`
is no longer a change invisible to consumers (docs/specs/adapter.md §3.1,
§8.2).

## Test strategy

- Vitest, colocated `src/**/*.test.ts`. Mock the platform client with
  `vi.mock` — not msw, not nock.
- Use `@chat-adapter/tests` (v4.39.0). Verified exports: the contract suites
  `threadIdContract`, `selfMessageContract` and `connectWebhookContract`; the
  factories `createMockAdapter`, `createMockChatInstance`, `createMockState`,
  `createTestMessage`, `createMockLogger` / `mockLogger`; plus subpaths
  `@chat-adapter/tests/matchers` (`toHavePosted`, `toHaveEdited`,
  `toHaveDeleted`, `toHaveReactedWith`, `toHaveStartedTyping`,
  `toHavePostedToChannel`, `toHaveDispatched`, `toBeSubscribedTo`) and
  `@chat-adapter/tests/setup`. Run the three contract suites against this
  adapter; they encode invariants (thread-ID roundtrip, self-message
  suppression, webhook connect) that are easy to break silently.
- `pnpm test` must pass with no credentials and no network. Any live suite is
  opt-in and self-skipping on absent `BACKLOG_API_KEY` — see the pattern in
  DEVELOPMENT.md. Keep it lean; the 150/min update bucket will 429 a chatty
  suite.

## `examples/`

`examples/*` are **standalone projects**, not workspace members: each one
depends on the published adapter (`"@nulab/chat-adapter-backlog": "^0"`),
installs on its own, and deploys from its own directory. Copying one out of
this repository has to leave it working, which is the rule that settles most
questions about them. `pnpm-workspace.yaml` names no packages, and nothing in
CI installs, type checks or tests an example — only the root `lint` and
`format:check` reach into `examples/` (oxfmt formats the Markdown too: it
aligns tables and normalises bullets, though it never reflows prose, so write
a README and let `pnpm format` settle it).

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
  README.md  package.json  vercel.json  .env.example  tsconfig.json
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
`framework: null` and orchestrates nothing.

Two rules about what an example may do, both load-bearing:

- **Parse `unknown` with zod, never assert.** `message.raw` reaches a handler
  as `unknown`, and parsing is also the only honest way to read a key the
  adapter's own schema does not name (`raw.payload` keeps everything Backlog
  sent). The same goes for `process.env`: one schema at module load, so a
  missing variable or a non-numeric id fails the first cold start rather than
  sending `NaN` to Backlog later.
- **Reach Backlog through `backlog.client(host)`.** That is the `backlog-js`
  client the adapter hands out for the endpoints its port does not name, and it
  carries the adapter's rate-limit accounting, its bounded 429 retry and its
  error classes. An example must not build a Backlog client of its own, and
  must not depend on `backlog-js` directly.

State is `@chat-adapter/state-memory`, and no example subscribes to a thread.

Environment variable names are shared across examples, not invented per
example: the five the adapter reads (`BACKLOG_HOST`, `BACKLOG_API_KEY`,
`BACKLOG_BOT_USER_ID`, `BACKLOG_BOT_USER_NAME`, `BACKLOG_WEBHOOK_SECRET`) plus
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
  that is the case where you must return 401. Include a timestamp staleness
  window too; verification without one is replayable.
- **Never swallow a send error and return a fabricated success.** A failed post
  must surface as a rejection, not as a synthetic message object.
- **Never mutate the caller's message envelope.** Copy before adding
  platform-specific fields.
- **Never hard-code a space host, a rate-limit number, or an activity type
  name** in a place a user cannot override or a future reader cannot trace back
  to the API docs.
