# CLAUDE.md

Repo-specific knowledge for agents working in `@nulab/chat-adapter-backlog`.
Contributor setup, the commands, CI, the pull-request conventions and the
release process live in [CONTRIBUTING.md](./CONTRIBUTING.md); this file covers
what you cannot derive by reading the code.

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
(public types, including the serialisable raw-message shapes), `src/egress.ts`
and `src/reads.ts`, `src/subject/*` (the issue and pull-request halves of a
thread behind one `SubjectClient`), `src/webhook/*` (ingress), `src/client/*`
(the `backlog-js` client and its response schemas), `src/format.ts` (the
Markdown converter), and `src/test/fixtures/*`. Every member calls
`backlog-js`'s typed methods directly; there is no port in front of it.

`src/subject/*` is where behaviour that differs between an issue and a pull
request belongs, and nowhere else: `subjectClientFor` in
`src/subject/client.ts` picks the half once, and every member reaches Backlog
as `decode -> subjectClientFor -> one code path for both kinds`. The only other
module that may ask what kind a subject is is the codec `src/ids.ts`, which has
no client to route through (D-PR2). Do not reason about pull requests from the
issue side (`.claude/rules/backlog-pull-request-facts.md`).

**Types.** `backlog-js`'s `Entity.*` types are the source of truth for every
Backlog shape, and `src/types.ts` declares only the deviations measured against
them (recorded in `.claude/rules/*.md`) as an overlay on those types. Nothing
converts to `Date` until a value becomes a `Message`'s `metadata`: timestamps
stay the ISO strings Backlog sends, so one type serves the API response and
`message.raw`, which must survive a JSON round trip through the queue anyway.
Each response schema in `src/client/responses.ts` is paired with its
overlaid type exactly once, in a named reader (`readIssue`,
`readPullRequestComments`, …) whose parameter is `z.ZodType<Validated<T>>`,
so a field the adapter validates cannot drift from the type it publishes.
Call sites take a reader, never a schema and a type argument: `Validated<T>`
accepts any subset of `T`'s fields, so a schema passed with the wrong type
would compile. zod types never reach the published `.d.ts`, so an overlay
helper type a raw shape references is exported too (the last coupling below).

**Files CI couples together.** Changing any of these means changing its
counterpart in the same commit, or CI keeps passing on the old shape:

- `exports`, `files`, the environment fallbacks or `engines.node`:
  `scripts/consumer-smoke/smoke.mjs`, which the `consumer` job runs against the
  packed tarball on Node 22.
- A README sample that changes shape: `scripts/consumer-smoke/documented-usage.ts`,
  the usage README.md documents written out by hand and compiled against the
  installed declarations.
- A declared type that `src/index.ts` does not export, or an import in the
  published declarations other than `chat` and `backlog-js`:
  `scripts/check-published-types.ts` fails `vp pack`.

## Where each fact lives

Every fact has exactly one home. Before writing one down, find that home; if
the fact is already there, point at it or say nothing. A second copy is not
emphasis, it is the version that goes stale.

| Kind of fact                                         | Home                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| How the adapter does something                       | the code: names, types, structure                          |
| What it guarantees, member by member                 | the tests, named after the behaviour                       |
| The consumer-visible contract and design decisions   | [the spec](./docs/specs/adapter.md) and its decision table |
| What Backlog and the Chat SDK core do, with the date | `.claude/rules/*.md`                                       |
| Why one change was made                              | the squash commit body                                     |
| Why the obvious code would break                     | a comment on that code                                     |
| How to work here: gates, CI coupling, PR rules       | this file and [CONTRIBUTING.md](./CONTRIBUTING.md)         |

- **The spec** states what a consumer can observe and which decisions shaped
  it. It describes behaviour: it does not restate the README's content, list
  the tests to write, or record how the work was ordered. It summarises a
  measurement only as far as the measurement changes that behaviour, and
  points at the rules file for the evidence. Tests are written
  from it; when code and spec disagree, one of them is wrong and the PR that
  notices fixes it.
- **README.md** is what a consumer reads, on npmjs.com as well as on GitHub,
  and says what they need to use the package; the spec is where the rest of
  the behaviour lives. Every link from it into this repository is absolute
  (`https://github.com/nulab/chat-adapter-backlog/blob/main/…`), because
  npmjs.com resolves no relative path (#66).
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
in the same PR.

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
  it with the **decision id** alone — `(D5)`, `(D-PR3)` — which is stable and
  leads straight to the rejected alternatives in the spec's decision table.
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

Run all three before declaring work done; CI runs exactly these, and none of
them takes a flag:

```sh
vp check && vp test && vp pack
```

- `vp check` is format, lint and type check in one run; a formatting failure
  stops it before lint and type check, so run `vp check --fix` first.
  `no-console` is an `error` (allowed: `warn`, `error`), so a `console.log`
  fails it, and so does `typescript/no-explicit-any` outside `*.test.ts`. The
  type check is tsgolint's, with `tsconfig.json` as its project.
- `tsconfig.json` enables `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `verbatimModuleSyntax` (type-only imports must
  say `import type`), `noUnusedLocals` and `noUnusedParameters` (prefix
  intentionally unused params with `_`).
- `vp pack` fails on `publint` problems, on `attw` problems at the `esm-only`
  profile, and on `scripts/check-published-types.ts` (see the couplings above).
  Touching `exports`, `files`, `scripts` or the build config means running
  `vp pack`, not just `vp check`.
- `engines.node` is `">=22"`, so do not use APIs newer than Node 22 in
  shipped code. The test matrix runs the suite on Node 22, 24 and 26, so a
  26-only API fails a job rather than reaching a consumer — but `vp check`
  and `vp pack` only ever see the pinned runtime, so a type-level or
  build-time 26-ism is caught by `test` alone.

Setup, the pinned Node and pnpm, and the supply-chain settings are in
[CONTRIBUTING.md](./CONTRIBUTING.md).

## Pull requests

Before opening a PR, read [CONTRIBUTING.md](./CONTRIBUTING.md) "Pull requests":
a title with a scope, a label read off the title's type, a squash body written
on purpose, and stacked PRs based on their parent branch.

## Chat SDK adapter contract

The interface is `Adapter<TThreadId, TRawMessage>` in `chat`'s own `.d.ts` —
the authority, where the docs page is not fully in sync. Which members this
adapter implements and why the rest are absent is the spec's "Adapter
contract coverage"; what the core does with each member is
`.claude/rules/chat-sdk-core-facts.md`. The upstream
guides still govern new work:
[Building an adapter](https://chat-sdk.dev/docs/contributing/building),
[Publishing your adapter](https://chat-sdk.dev/docs/contributing/publishing),
[Vendor-official adapters](https://chat-sdk.dev/docs/contributing/vendor-official),
[Testing](https://chat-sdk.dev/docs/testing).

`@chat-adapter/shared` supplies the error classes to throw and the message
helpers (`extractCard()`, `extractFiles()`, `toBuffer()`,
`cardToFallbackText()`). Do not hand-roll equivalents.

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
- `vp test` must pass with no credentials and no network.

## `examples/`

`examples/*` are **standalone projects**, not workspace members and outside the
root toolchain: each one depends on the published adapter
(`"@nulab/chat-adapter-backlog": "^0.1.0"`), installs on its own, and deploys
from its own directory. Copying one out of this repository has to leave it
working, which is the rule that settles most questions about them.
`examples/README.md` is the index: it carries the setup all of them share, the
file layout, the `src/bot.ts` / `src/<logic>.ts` split, and the two coding
rules every example follows (parse `unknown` with zod; reach Backlog through
`backlog.client()`). An example's own README does not repeat any of it.

**Examples are illustrations, not verified by CI or the root toolchain.** Root
lint, type check and format skip `examples/**`, and CI neither installs nor
type checks them. An LLM reviews an example when it changes, and an example
falling behind the adapter is not itself a problem: it only has to be
recognisable as an example.

- Each example is one PR and touches nothing outside its own directory. An
  adapter bug or gap found while writing one goes in that PR's description
  under "Adapter notes" — not into `src/`, which is a separate change with a
  separate scope.
- No numbering on the directory, and **no tests**: an example earns its keep
  by being copied rather than verified.
- Package name `chat-adapter-backlog-example-<name>`, `private: true`, and the
  two scripts `deploy` / `deploy:prod`.
- `vercel.json` sets `framework: null` and `installCommand: "npm install"`, and
  orchestrates nothing else. npm because pnpm inside a clone finds the root
  `pnpm-workspace.yaml` and installs the repository instead; an explicit
  command because Vercel picks the package manager from the lockfile it finds,
  an example has none of its own, and an overridden `pnpm install` runs pnpm 6
  there.
- Environment variable names are shared across examples, not invented per
  example: the four the adapter reads (`BACKLOG_HOST`, `BACKLOG_API_KEY`,
  `BACKLOG_BOT_USER_ID`, `BACKLOG_WEBHOOK_SECRET` — the id required, set in
  every `.env.example`) plus meaningful names for the rest —
  `DONE_STATUS_ID`, `REQUIRED_CUSTOM_FIELD_ID`, `BUG_ISSUE_TYPE_NAME`,
  `INTAKE_CONTACT_USER_ID`, `AI_MODEL`, `AI_GATEWAY_API_KEY`. No `EXAMPLE_`
  prefix.
- Every README has the same five sections, in this order: **What it does**,
  **Try it**, **How it works**, **Deploy**, **Limits**. A measured Backlog
  behaviour cited in "How it works" is sourced as
  `measured on a development space, <date>` and names no space, project,
  issue, person or Vercel project.

## Don't

Anti-patterns observed in real adapter code:

- **No `process.exit()`** anywhere. This is a library; killing the host process
  on a config error is never correct. Throw a typed error.
- **Never skip webhook verification** because the raw body was unavailable —
  that is the case where you must return 401. (Other adapters add a timestamp
  staleness window; this one does not, because a Backlog timestamp is unsigned
  and a window would only drop measured late redeliveries — spec D28.)
- **Never swallow a send error and return a fabricated success.** A failed post
  must surface as a rejection, not as a synthetic message object.
- **Never mutate the caller's message envelope.** Copy before adding
  platform-specific fields.
- **Never hard-code a space host, a rate-limit number, or an activity type
  name** in a place a user cannot override or a future reader cannot trace back
  to the API docs.
