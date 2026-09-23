# Adapter implementation plan

How `@nulab/chat-adapter-backlog` gets from the placeholder export to the goal
state in [docs/specs/adapter.md](../specs/adapter.md) ("the spec"). The spec
says **what**; this plan says in which order, with which acceptance bar, and
**why** each split was chosen. Section references (§n) point into the spec.
Repository rules are in [CLAUDE.md](../../CLAUDE.md) and are not repeated
beyond §2.

**P0 through P7b have landed** (§3 carries the status per phase). The phase
sections are kept in the tense they were written in, as the record of what
each PR was asked to do and what it cost. What is still open is P7b's run
against a real space and P7d, the release itself — both `0.1.0` blockers, and
§1 says which of the six done criteria hold today.
Decisions this plan assumed are settled in the spec's §15 register, not here
(§6).

## 1. Goal and definition of done

The project is done when all of the following hold on `main`:

1. Every member in spec §4.1 and §4.2 has the stated status, and the three
   `@chat-adapter/tests` contract suites pass against the shipped adapter.
2. `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`
   is green, and the test job is green on Node 20, 22, 24 and 26.
3. `pnpm test` needs no network and no credentials; the live suite (§12.3)
   skips itself and has been run at least once against a real space before the
   first release, with the result recorded in the release PR.
4. The webhook response ladder (§5.1), id grammar (§2), error mapping (§8.5)
   and paging guarantees (§7.1) each have a test per row.
5. README, `sample-messages.md`, DEVELOPMENT.md, `.env.example`, CLAUDE.md and
   the CI smoke test match the code (§13).
6. `0.1.0` is published from `release.yml` and installs into a consumer that
   imports `createBacklogAdapter` under Node 20 (§7).

**Status, 2026-09-26** (`main` at `25cf0ec`): 1, 2, 4 and 5 hold. 3 holds in
its first half only — `pnpm test` needs no network and the live suite skips
itself, but it has never been run against a real space, which needs the
credentials issue #52 is waiting on. 6 holds in its second half: the
`consumer` job in `ci.yml` packs the tarball, installs it with npm outside the
repository and constructs the adapter from the environment alone on Node 20 on
every push and pull request — including the run `release.yml` calls before it
publishes — so the consumer side is a gate rather than a check somebody
remembers to do once. The same job type checks the usage the README
documents against that tarball, and on pushes and pull requests every
`examples/*` too. Its first half has not happened: the package is unreleased
(#53). Repository visibility is no longer part of that distance — it was
settled on 2026-09-09 as a premise the maintainer supplies, the repository
being public at publish time (spec §15 row 28). Nor is the one defect found
meanwhile in the published artefact: **#99** (`scripts.preinstall` reached the
published manifest and made an npm consumer's install exit 127) was closed by
#100 on 2026-09-11. What is left is the live-suite run (**#52**), the one
remaining `0.1.0` blocker (spec §15.4), and then the release itself (#53).

## 2. Ground rules recap

- Five gates before every push; the pre-commit hook does not enforce lint.
- PR title = Conventional Commit **with a scope** from CLAUDE.md's table
  (`adapter`, `client`, `webhook`, `format`, `build`, `toolchain`, `ci`,
  `release`, `deps`, `docs`); label from the type (`feat`→`enhancement`,
  `fix`→`bug`, `docs`→`documentation`; `chore`/`ci`/`refactor`/`test` stay
  unlabeled). Tests take the scope of the code they cover.
- Squash merge only; write the squash body on purpose (the Why, consolidated).
- Stacks of at most three; declare `Stacked on #N — merge that first.` as the
  first line of the Why; after the bottom merges, `git rebase --onto` with the
  recorded parent tip.
- Library discipline: no `process.exit`, no swallowed send errors, no mutation
  of the caller's message, no hard-coded host / limit / activity-type name, no
  skipped webhook verification. No `console.*` in shipped code.
- `chat@4.40.0` is the contract; anything read from its `.d.ts` beats the docs
  page. Node 20 APIs only in `src/`.
- Comments say Why-not; tests say What; commit bodies say Why. A Backlog
  behaviour that the code depends on is cited to a developer.nulab.com URL or
  to `.claude/rules/*.md`.

## 3. Phases as a PR stack

Phase order and dependencies:

```
P0 docs ──────────────────────────────────────────────┐
P1 client ──► P2 adapter skeleton ──► P3 webhook ─────┼──► P5 egress+reads ──► P6 optional ──► P7 docs/release
P4 format (independent of P1–P3) ─────────────────────┘
```

P1→P2→P3 is one stack of depth three; merge P1 as soon as it is green so the
stack never grows. P4 branches from `main` and can be developed in parallel
with P1–P3 by a second contributor. P5 starts when P2, P3 and P4 are on
`main`. P6 stacks on P5. P7 stacks on P6 or follows it.

That ordering held. The package is still unreleased (`0.0.0`, no tag), and the
licence the plan took — that `main` may hold a compiling adapter whose
not-yet-implemented required members throw
`AdapterError("backlog", "not implemented", "NOT_IMPLEMENTED")` — was never
used: no phase left a required member throwing it. Every PR passed all five
gates on its own, and nothing is published before the definition of done is
met.

**Status per phase, 2026-09-08.** P0 (#2) through P6 are on `main`, and so is
the whole pull-request stack that followed them
([pull-request-support.md](./pull-request-support.md) §4), which rewrote the
id grammar P2 introduced. P7 is described below with its own status: P7a and
P7b have landed, P7c is decided against, P7d is the release. A further
sixteen PRs (#77–#95) landed on 2026-09-08 out of the first-release review.
They opened no new phase; the eleven decisions among them that change what
this adapter does are rows in the spec's §15.3, and the defects they left
behind are issues #92, #93 and #94 (spec §15.4).

Size estimates are lines of non-test TypeScript, to calibrate review effort,
not a commitment.

### P0 — this documentation

- **Title**: `docs(docs): add adapter specification and implementation plan`
  (scope `docs` now covers `docs/` per the CLAUDE.md table). Label
  `documentation`.
- **Scope**: `docs/specs/adapter.md`, `docs/plans/adapter-implementation.md`,
  the pointers already added to CLAUDE.md and README.md, and the parallel
  `.claude/rules/*.md` files if they land in the same PR.
- **Depends on**: nothing.
- **Acceptance**: both documents exist; CLAUDE.md links them; the forbidden
  internal identifiers do not appear anywhere under `docs/`.
- **Gates**: `pnpm format:check` does not cover Markdown; run the five gates
  anyway to prove nothing else moved.
- **Risk**: none to code. The open ⚑ decisions (§6 below) should be answered
  in review of this PR so P1–P2 do not start on assumptions.

### P1 — Backlog API port (`client`)

- **Title**: `feat(client): add rate-limit-aware Backlog API port`. Label
  `enhancement`.
- **Branch**: off `main`.
- **Scope**: `src/client/port.ts` (interface and domain types, §8.1),
  `src/client/backlog-js.ts` (§8.2), `src/client/in-memory.ts` (§8.3),
  `src/client/rate-limit.ts` (§8.4), `src/client/errors.ts` (§8.5),
  `src/client/conformance.ts` (§8.6), colocated tests. `package.json` gains
  `backlog-js ^0.20.1`, `zod ^4`, `@chat-adapter/shared ^4.39.0`
  (dependencies) and `chat ^4.39.0` (peer + dev), `@chat-adapter/tests` and
  `@chat-adapter/state-memory` (dev); `pnpm-lock.yaml` committed with it.
  Nothing is exported from `src/index.ts` yet (the placeholder stays so the
  smoke test is untouched).
- **Deliverables**: the port compiles with zero `backlog-js` types in its
  public surface; both implementations pass the conformance suite; the
  `backlog-js` implementation reads `X-RateLimit-*` from every response.
- **Acceptance criteria**:
  - Conformance suite passes for both implementations with identical
    expectations (one `describe` factory, two callers).
  - Bucket classifier: `GET /issues` and `GET /issues/count` → `search`; any
    other GET → `read`; POST/PATCH/DELETE → `update`; icon paths → `icon`.
  - 429 with `X-RateLimit-Reset` 2 s ahead: exactly one retry, then success,
    total wait ≈ 2 s under fake timers. 429 with reset 5 min ahead: throws
    `AdapterRateLimitError` with `retryAfter ≈ 300` and no wait.
    `maxRetries: 0` never retries.
  - Every row of §8.5 mapped; `error.cause` is a plain object with the
    query string stripped from `url`; a body failing the zod schema throws
    `AdapterError` with code `SCHEMA`, and `ZodError` is never observable.
  - Credentials given as functions are invoked once per request and the
    result is not memoised; a rejecting resolver becomes
    `AuthenticationError`.
  - `Backlog-API-Key` / `Authorization` headers are used; no request URL ever
    contains `apiKey=`.
  - `pnpm build` passes publint/attw with the new dependencies (the
    `backlog-js` dual package must resolve under the `esm-only` profile).
- **Tests to add** (behaviour names): "a comment id belonging to another issue
  is not found", "listing with minId and maxId excludes both bounds", "an
  issue-list call spends the search bucket, not read", "a 429 whose reset is
  imminent is retried once", "a 429 whose reset exceeds maxWaitMs throws
  without waiting", "error code 6 maps to ResourceNotFoundError even on a 400
  status", "a response that violates the schema is an AdapterError, not a
  ZodError", "the API key is sent as a header and never in the URL", "a
  resolver is called for every request", "uploading a file posts one multipart
  part named file".
- **Gates**: all five; `pnpm build` is the one that catches `backlog-js`
  packaging surprises.
- **Size**: ~900 lines + ~700 test.
- **Risks**: `backlog-js` `request()` may not expose everything needed for
  multipart uploads and stream downloads with headers → fall back to a thin
  `fetch` wrapper behind the same port (the port exists for exactly this); the
  `minimumReleaseAge` quarantine may refuse a `backlog-js` version newer than
  three days — wait, do not lower it.

### P2 — adapter skeleton (`adapter`)

- **Title**: `feat(adapter): add BacklogAdapter with config resolution and thread-ID codec`.
  Label `enhancement`.
- **Branch**: off P1. Body: `Stacked on #<P1> — merge that first.`
- **Scope**: `src/ids.ts` (§2), `src/types.ts` (§3), `src/adapter.ts`
  (constructor, env fallbacks, resolver handling, `initialize`,
  `encodeThreadId`/`decodeThreadId`/`channelIdFromThreadId`, `isDM`, `name`,
  `userName`, `api(host)`, `rateLimit(host)`; every other required member
  throws the not-implemented `AdapterError`), `src/index.ts` (replace
  `ADAPTER_ID` with the real exports), `.github/workflows/ci.yml` smoke test
  updated **in the same PR**, `src/index.test.ts` rewritten, CLAUDE.md "State
  of the repo" paragraph updated.
- **Deliverables**: `createBacklogAdapter()` constructs from env; `new Chat({ adapters: { backlog } })`
  accepts the instance type-wise; `threadIdContract` passes.
- **Acceptance criteria**:
  - Every row of the §3.2 validation column has a failing construction test
    that names the field (and env var, for shape A) in the `ValidationError`
    message.
  - `threadIdContract` with pinned encodings for the three Backlog domains.
  - Every §2.2 rejection has a test; `u:<created>` with colons round-trips.
  - `api("unknown.backlog.com")` → `ResourceNotFoundError`.
  - Optional members not yet implemented are absent (`undefined`), not stubs.
  - CI `build` job smoke test asserts on `createBacklogAdapter` and passes.
- **Tests to add**: "constructing with no config and no environment names the
  first missing variable", "an explicit empty apiKey is an error, not a
  fallback", "installations and single-space fields together are rejected",
  "two installations on the same host are rejected", "a host with a scheme is
  rejected", "a missing webhookSecret without a verifier is rejected", "thread
  ids round-trip for backlog.com, backlog.jp and backlogtool.com", "a thread id
  never contains the issue key", "the channel id is the first three segments",
  "a bare numeric user id is rejected even with one installation", "userName
  defaults to the first installation's bot name", "the package entry exports
  the factory and the class".
- **Gates**: all five; the CI smoke test change is verified by the `build` job
  on the PR itself.
- **Size**: ~450 lines + ~350 test.
- **Risks**: `exactOptionalPropertyTypes` makes shape A/B discriminated config
  types fiddly — use `?: never` fields as the GitHub adapter does; the
  `Adapter` interface may reject a `renderFormatted` with an optional second
  parameter if the maintainer declines ⚑3 — decide before P2.

### P3 — webhook ingress (`webhook`)

- **Title**: `feat(webhook): verify, parse and dispatch Backlog issue webhooks`.
  Label `enhancement`.
- **Branch**: off P2. Body: `Stacked on #<P2> — merge that first.`
- **Scope**: `src/webhook/verify.ts` (ladder rows 1–5, §5.1),
  `src/webhook/payload.ts` (zod schemas, §5.2), `src/webhook/inbound.ts`
  (payload → `Message`, mention detection, §5.3–§5.4, author mapping,
  attachments with `fetchData`), `handleWebhook` and `parseMessage` on the
  adapter, `src/test/fixtures/webhooks.ts` (neutral names: host
  `example.backlog.com`, bot `Chatbot` id 999, `Alice` id 100, `Bob` id 101,
  project 500, issue 8001; one builder per §5.3 row). `parseMessage` uses the
  Markdown converter from `chat` directly in this phase (P4 replaces it with
  the rule-aware selection) — mark the call site with a Why-not comment so P5
  finds it.
- **Deliverables**: a real `Chat` with memory state receives a mention from a
  fixture request and runs `onNewMention`; `selfMessageContract` and
  `connectWebhookContract` pass.
- **Acceptance criteria**:
  - One test per ladder row (§12.2 "webhook" list), with identical 401 bodies
    asserted by string equality across the four 401 causes.
  - The 200 is returned before the factory runs (assert ordering with a
    deferred factory).
  - Every §5.3 row maps to the specified id/text/attachments/mention; unknown
    payload keys survive into `raw.payload`.
  - Type 2 assignee change: `text === ""`, `raw.changes[0].field === "assigner"`,
    `isMention === true` when `new_value` equals the bot name; status change
    alone is not a mention.
  - Mention regex negative cases (`@Chatbot2`, `foo@Chatbot`, `<@U999>`).
  - Same fixture to two configured hosts → two thread ids, two message ids,
    two ports used.
  - A factory that throws is logged at `error` and does not reject
    `handleWebhook`.
- **Tests to add**: "a request without a token is rejected with 401",
  "an unknown host gets the same 401 body as a wrong token", "with one
  installation the host parameter is optional", "with two installations a
  missing host is rejected", "a verifier that returns false rejects even with
  a valid token", "a bulk update is acknowledged and ignored", "a status-only
  change arrives as a comment message with empty text and a status change",
  "an attachment added to the issue arrives as a changelog comment with one
  attachment", "assigning the bot is a mention", "the bot's own comment is
  acknowledged but not dispatched", "processing starts after the response is
  returned", "webhook attachments download through the configured host".
- **Gates**: all five.
- **Size**: ~600 lines + ~700 test + ~250 fixtures.
- **Risks**: `selfMessageContract` expects the adapter not to dispatch self
  messages, which means the adapter needs `botUserId` before `parseMessage` —
  fine, it is per installation; `connectWebhookContract` constructs without a
  native secret, so the constructor's "secret or verifier" rule must treat a
  verifier as sufficient for every installation.

### P4 — format converters (`format`)

- **Title**: `feat(format): convert mdast to and from Backlog Markdown and notation`.
  Label `enhancement`.
- **Branch**: off `main`; independent of P1–P3 (depends only on `chat`'s
  `BaseFormatConverter` and mdast helpers). If `chat` is not yet a dependency
  on `main` when P4 starts, P4 adds it (peer + dev) and P1 rebases — or P4
  waits for P1 to merge; whichever is sooner.
- **Scope**: `src/format/markdown.ts` (§9.3), `src/format/notation.ts`
  (§9.4–§9.5), `src/format/fallback.ts` (§9.2), `converterFor(rule)`, tests.
  No adapter wiring in this PR.
- **Acceptance criteria**:
  - A table-driven test covers every row of §9.4 (mdast → notation) and §9.5
    (notation → mdast), including nested lists, `{code}` on one line, unclosed
    `{code}`, `{quote}` blocks, `|h` tables, `#image`.
  - `renderPostable` passes `string`/`{ raw }` through unchanged and renders
    `{ markdown }` for notation projects by parsing then `fromAst`.
  - Fallback wrapper: `toAst` throwing yields one paragraph with the raw text
    and one `warn`; `fromAst` errors propagate.
  - Known lossy conversions (§9.6) are asserted as such (inline code becomes
    plain text; table alignment is dropped) so a future "fix" is a conscious
    spec change.
- **Tests to add**: "bold, italic and strikethrough round-trip through Backlog
  notation", "a fenced code block becomes a code macro with its language",
  "a code macro opened and closed on one line is one code block", "a header
  row suffixed with h becomes a table header", "a quote macro becomes a
  blockquote", "inline code is flattened to text on notation projects",
  "a markdown project renders GFM unchanged", "a converter that throws on
  input degrades to a plain paragraph".
- **Gates**: all five.
- **Size**: ~450 lines + ~350 test.
- **Risks**: notation is under-specified upstream (the support article is the
  only reference); scope creep into a full parser. Hold the line at §9.5's
  list and record anything else as a later item.

### P5 — egress, reads, stream, reactions, files (`adapter`)

- **Title**: `feat(adapter): post, edit, delete, react to and page issue comments`.
  Label `enhancement`.
- **Branch**: off `main` after P2, P3, P4 have merged.
- **Scope**: `postMessage`, `editMessage`, `deleteMessage`, `stream`,
  `addReaction`, `removeReaction`, `fetchMessages`, `fetchThread`,
  `fetchMessage`, `renderFormatted`, formatting-rule cache (§9.1) wired into
  `parseMessage`, the webhook factory (`ensureFormattingRule` before
  `parseMessage`) and every egress path; file upload via `extractFiles`;
  attachment `fetchData` for REST-derived messages (§6.6); strict postable
  extras schema (§3.4).
- **Acceptance criteria**:
  - Wiring test with a real `Chat`: mention → `onNewMention` → `thread.post`
    → exactly one `addComment` on the in-memory port with the rendered text.
  - `stream` with a 20-chunk iterable → one `addComment`, zero
    `updateComment`; the returned `RawMessage.threadId` equals the input.
  - `fetchMessages` property sweep (§12.2 "reads") passes for both directions;
    invalid cursor → `ValidationError`; channel id → `ValidationError`.
  - Notation project: `thread.post({ markdown: "**x**" })` produces `''x''`;
    Markdown project leaves it unchanged; Get Project failure falls back to
    Markdown with a `warn` and is not cached.
  - Reactions: add is idempotent (second call makes no `POST /stars`);
    remove deletes only stars whose presenter is the bot.
  - `:i`/`:u:` ids rejected for edit/delete/star; `editMessage` with files
    rejected.
  - `renderFormatted(ast, threadId)` uses the cached rule; without a target
    renders Markdown and warns once.
- **Tests to add**: "a reply is posted as a comment on the issue", "a streamed
  reply is posted once and never edited", "files are uploaded and attached to
  the comment", "a mistyped notifiedUserId is a validation error", "backward
  paging ends with a page holding the issue body", "forward paging starts
  with the issue body using one slot", "every comment appears exactly once
  across all pages", "a comment edited on Backlog reports edited and
  editedAt", "adding a reaction twice stars the comment once", "removing a
  reaction leaves other users' stars", "the issue body cannot be edited",
  "a bold reply on a notation project uses two quotes", "an unreadable
  project setting degrades to markdown for one call".
- **Gates**: all five.
- **Size**: ~700 lines + ~900 test.
- **Risks**: the fake-timer interaction between `stream` consumption and the
  core's `handleStream` accumulation; the `fetchMessages` `hasMore >= count`
  heuristic produces an occasional root-only final page — spec'd and tested,
  not a bug.

### P6 — optional members (`adapter`)

- **Title**: `feat(adapter): add issue creation, thread listing, user lookup, read receipts and subject`.
  Label `enhancement`.
- **Branch**: off P5 (stack of two) or off `main` after P5 merges.
- **Scope**: `postChannelMessage` (§6.7), `listThreads` (§7.6), `getUser`
  (§7.7), `fetchSubject` (§7.4), `fetchChannelInfo` (§7.5, replaces the rule
  cache entry), `markAsRead` (§7.8), `rehydrateAttachment` (§6.6), type-4
  deletion → `processMessageDeleted` (§5.3, ⚑9), `BacklogChannelPostableExtras`.
- **Acceptance criteria**:
  - `channel.post({ markdown: "# Title\n\nbody" })` creates an issue with
    summary `Title`, description `body`, the first issue type and the middle
    priority; explicit `issueTypeId`/`priorityId`/`assigneeId` honoured; a
    code-7 error on cached defaults refreshes and retries once; no retry on
    other errors or explicit ids; empty summary → `ValidationError` (⚑8).
  - `listThreads` returns issues in the order the port returns them, offset
    cursor, clamp to 100, trailing empty page documented.
  - `getUser(author.userId)` round-trips; `isBot` true only for the bot;
    `null` on 404.
  - `message.subject` resolves to the issue with `type: "issue"` and the
    `/view/<issueKey>` URL.
  - `markAsRead`: matched on page 1 and on page 3; not found after 3 pages →
    `info` and no update call; already-read → no update call; `:i` → no call.
  - `rehydrateAttachment` rebuilds `fetchData` for a configured host and
    leaves a foreign host untouched.
  - Type 4 webhook → `processMessageDeleted` with the root message id;
    contract with `toHaveDispatched("processMessageDeleted")`.
- **Tests to add**: "posting to a channel creates an issue whose summary is
  the first block as plain text", "stale cached defaults are refreshed once
  after a validation error", "explicit issue type and priority are never
  retried", "threads are listed with an offset cursor and a trailing empty
  page", "a user id round-trips through getUser", "the parent subject is the
  issue", "marking read finds the notification on the third page", "marking
  an already-read notification makes no update call", "a serialised
  attachment regains fetchData for a configured host", "a deleted issue is
  reported as a deleted root message".
- **Gates**: all five.
- **Size**: ~500 lines + ~600 test.
- **Risks**: `markAsRead` costs up to four calls; keep it out of the wiring
  tests' hot path. `fetchSubject` adds a read per `message.subject` access;
  document that it is lazy.

### P7 — documentation, live suite, first release (`docs`, `ci`, `release`)

Split into small PRs off `main` once P6 has merged; none of them stacks.

| PR | Title | Label | Content |
| --- | --- | --- | --- |
| P7a | `docs(docs): document setup, configuration and limitations` | `documentation` | README per §13 (publishing-checklist order), `sample-messages.md`, DEVELOPMENT.md credentials table, `.env.example`, CLAUDE.md "State of the repo" final form, feature matrix values recorded for a future catalog PR. |
| P7b | `test(adapter): add opt-in live suite against a real space` | none | §12.3 suite, self-skipping; run once locally and paste the `rateLimit(host)` snapshot into the PR. |
| P7c | `ci(ci): run the live suite on manual dispatch only` (optional) | none | A `workflow_dispatch` input that provides `BACKLOG_*` from repository secrets; never on PRs from forks. Skip if the maintainer prefers local-only. |
| P7d | `chore(release): publish the first release` | none | Verify Trusted Publishing and the `production` environment exist (DEVELOPMENT.md prerequisites), then run `release.yml` with `minor` (§7). |

**Status, 2026-09-08.**

- **P7a — landed, and then some.** All six deliverables are tracked and
  describe the two-kind adapter; the release review added #77 (what the
  adapter actually delivers) and #82 (the README links npm cannot follow, and
  the project status), so the acceptance bar below is met for everything
  except the release itself.
- **P7b — written, never run.** `src/test/live.test.ts` exists and
  self-skips (#15, extended for pull requests by #24), so criterion 3 of §1
  holds in its first half only. The run against a real space, and the
  `rateLimit(host)` snapshot that goes in the release PR, are issue **#52**;
  the remaining item of **#51** (a schema fixture recorded from a real body)
  and the two unmeasured pull-request questions (M9, M12) belong to the same
  session.
- **P7c — decided against.** No live job exists in `.github/workflows/ci.yml`
  and none reads a `BACKLOG_*` secret; the suite is opt-in, so nothing in CI
  depends on it (spec §15.1 row 19).
- **P7d — not started.** Issue **#53** carries it. Visibility is settled as
  a premise (spec §15 row 28).

- **Acceptance**: `npm pack --dry-run` contains only `dist/`, `package.json`,
  `README.md`, `LICENSE`; a scratch consumer on Node 20 imports the package
  and constructs the adapter from env; the GitHub release notes are correctly
  categorised (every `feat` PR carried `enhancement`). The first two are no
  longer P7d's to check by hand: the `consumer` job in `ci.yml` asserts the
  installed tree is exactly those four entries and constructs the adapter from
  the environment on Node 20, so #53 is left with the release notes.
- **Catalog decision**: community listing needs only a docs page and
  allowlist entries in `vercel/chat`; vendor-official additionally needs the
  catalog/scaffold entries, a changeset, product docs and an announcement.
  Record the choice in the README "Status" section; it is out of scope for
  this plan's done criteria (§8 below).

## 4. Cross-cutting checklist (every PR)

- [ ] `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`
      locally, on the pinned runtime, before pushing.
- [ ] `package.json` touched ⇒ `pnpm-lock.yaml` committed; `pnpm build` ran
      (publint/attw only run there).
- [ ] Public entry changed ⇒ `.github/workflows/ci.yml` smoke test changed in
      the same PR (P2 is the one that does this).
- [ ] Title has a scope from the table; label matches the type; stack
      declared in the first line of Why.
- [ ] Squash message written: subject = title, body = consolidated Why,
      `BREAKING CHANGE:` footer if any (none expected before `1.0.0`).
- [ ] New Backlog behaviour claim ⇒ cited to developer.nulab.com or added to
      `.claude/rules/*.md` with a date.
- [ ] No forbidden identifiers, no person names, no internal project names in
      code, tests, fixtures or docs. Fixture vocabulary: `example.backlog.com`,
      `Chatbot`, `Alice`, `Bob`.
- [ ] No `console.*`, no `any` outside tests, `import type` for types,
      `_`-prefixed unused params.

## 5. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Rate-limit exhaustion in the live suite or by a chatty consumer | 429s, failed replies | Live suite ≤ ~10 update calls, sequential; `stream` buffered (D4); `rateLimit(host)` exposed so consumers can alarm; README warns about `markAsRead` and `listThreads` (search bucket). |
| Webhook without HMAC | Forged events if the URL leaks | Mandatory secret or verifier (D2); constant-time compare; identical 401s; README documents IP allowlist / Basic auth via `webhookVerifier`; secret never logged. |
| Notation converter incompleteness | Garbled text on `backlog` projects | Table-driven tests per §9.4/§9.5; lossy cases asserted; fallback wrapper keeps `text` intact; README lists limitations. |
| `backlog-js` hides response headers | No rate-limit tracking | Port goes through `request()` or a thin `fetch` wrapper (P1 risk); the port boundary means swapping to plain `fetch` touches no adapter code. |
| `backlog-js` packaging under `esm-only` attw profile | `pnpm build` fails | Run `pnpm build` in P1 before anything else; if attw objects, mark the dependency external in tsdown and re-check. |
| Node 20 compatibility | Consumer breakage | Test matrix runs 20; avoid `Array.prototype.toSorted`/`toReversed` in `src/`, use `Buffer`/`Blob`/`FormData` globals only as available in Node 20. |
| At-least-once delivery and missed deliveries while down | Duplicate or lost events | Core dedupe on `message.id` (10 min); README explains durable dedupe by `message.id` and recommends a durable state adapter; a polling fallback is out of scope (§8). |
| Project-key renames | Broken references | Numeric ids only (D8); `issueKey` appears only in metadata and URLs. |
| Multi-space id collisions | Cross-space dedupe/routing errors | Host in every thread, channel, message and user id (D8); test "same payload to two hosts yields two threads". |
| Mention false positives (hand-typed `@Chatbot`, name collision) | Bot answers when not asked | Documented; left boundary in the regex; assignment-based mention as the reliable trigger. |
| `chat` minor release changes the `Adapter` type | Typecheck breaks on `^4.40.0` consumers | Peer range per D15; Dependabot bumps `chat` dev dependency weekly so drift surfaces in CI, not at a consumer. |
| Stack rebases after squash merges | Conflicts, duplicated diffs | Depth ≤ 3; record parent tips; `git rebase --onto`; merge P1 promptly. |

## 6. Decisions this plan assumed

All fourteen are settled, and their verdicts are **not repeated here**: they
are rows 1–12, 18 and 19 of the decision register in
[docs/specs/adapter.md](../specs/adapter.md) §15, alongside the pull-request
stack's, each with the module and the test that implement it. One register is
the point — the table this section used to carry and the spec's had drifted
into saying "not yet confirmed" about defaults the code had long since
implemented and tested, which is what issue #54 was filed for.

What a reader of *this* plan needs from it: eleven of the fourteen shipped as
the default assumed here; two were only ever about this plan's own process
(the `docs(docs)` title scope of P0, and P7c's optional CI live job, which is
skipped); and one **changed** — the live suite reads a fourth variable,
`BACKLOG_LIVE_PULL_REQUEST`, because a pull request needs a Git-enabled
project and two coordinates an issue id cannot carry. No phase was ever
blocked waiting for an answer, and none of the eleven was answered by
anything other than the code being written — which is the thing worth
noticing next time a plan opens with fourteen questions.

## 7. Versioning

Plain semver on the package's own line, starting at `0.1.0`; the bump rules
are in DEVELOPMENT.md ("Versioning"). `package.json` stays at `0.0.0` on
`main` and git tags are the version of record, so the first release is
`release.yml` with `minor` from the implicit `v0.0.0`. The dependency ranges
are D15's and are independent of the version number.

The mechanism around that number was reconsidered before the first release
in [docs/plans/release-mechanism.md](./release-mechanism.md), which verifies
what trusted publishing and provenance actually require and evaluates
release-please and its alternatives against D15. Its candidate A was accepted
on 2026-09-23 — keep the `workflow_dispatch` and make the publish job converge
so that a failed run finishes by being re-run — and deriving the bump from the
commits (its F) is deferred, so the bump is still picked by hand. The
implementation is #106; until it merges, this section and P7d describe what
`release.yml` does.

## 8. Out of scope / later

- ~~**Pull requests as threads**~~ — **done**, by the stack in
  [docs/plans/pull-request-support.md](./pull-request-support.md): types 18, 19
  and 20 dispatch, 21 is 200 Ignored (it was never observed; D-PR5), and the
  git pull-request endpoints are on the port. Read that plan, not this bullet,
  for what the seam looks like.
- **Catalog listing** (community or vendor-official) in `vercel/chat`; the
  feature-matrix values are prepared in §13 of the spec.
- **OAuth token acquisition and refresh**: callers supply a resolver; a helper
  built on `backlog-js`'s `OAuth2` could come later as a separate export.
- **Type 17 handling**: it repeats an existing comment and only marks that
  notifications were added after the fact; no Chat SDK event fits.
- **Polling fallback** via `GET /notifications` or `GET /projects/:id/activities`
  for deployments that cannot receive webhooks; needs a persisted cursor and
  competes for read/search budgets.
- **Body editing** through `editMessage(:r)` — the issue's or the pull
  request's; today a `ValidationError` for both (D12).
- **Emoji reactions** if Backlog publishes an API (UI-only today).
- **`fetchChannelMessages`** as a project-wide activity feed.
- **Bot identity verification** at `initialize` via `GET /users/myself`
  (one read per installation per process start).
- **`endTyping`/typing acknowledgement** — no Backlog counterpart.
- **Length limits** on summary/description/comment — none documented;
  surface as `ValidationError` when Backlog rejects.
