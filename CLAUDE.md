# CLAUDE.md

Repo-specific knowledge for agents working in `@nulab/chat-adapter-backlog`.
Contributor setup and the release process live in
[DEVELOPMENT.md](./DEVELOPMENT.md); this file covers what you cannot derive by
reading the code.

## State of the repo

A Backlog adapter for [Chat SDK](https://chat-sdk.dev/). The toolchain is
complete; the adapter is not. `src/index.ts` exports a placeholder
`ADAPTER_ID` and nothing else. No part of the `Adapter` interface is
implemented, so there is no existing pattern in this repo to follow — the
sections below are the design constraints to follow instead.

`.github/workflows/ci.yml` asserts `ADAPTER_ID === 'backlog'` by importing
`dist/index.js` in a real Node process. When the placeholder is replaced, that
smoke test must be updated in the same change or the build job breaks.

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
- `pnpm build` fails on `publint` problems and on `attw` problems at the
  `esm-only` profile. Touching `exports`, `files` or the build config means
  running the build, not just the type check.
- The test matrix is Node 22 / 24 / 26. Do not use APIs newer than Node 22.

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

| Bucket | Covers                                                            | Documented example |
| ------ | ----------------------------------------------------------------- | ------------------ |
| read   | GET, excluding the Search and Icon endpoints                      | 600                |
| update | POST, PATCH, DELETE                                               | 150                |
| search | Issue List, Count Issue, Wiki Page List, Count Wiki Page          | 150                |
| icon   | Space Logo, User Icon, Project Icon, Group Icon, Team Icon        | 60                 |

Traps, in order of how easily they are missed:

1. **Issue listing and counting draw on `search`, not `read`.** The bucket that
   any polling loop consumes is the 150 one, not the 600 one.
2. **The numbers above are the documented example values.** The rate-limit page
   states limits differ between Free and Paid plans and tells you to call
   `GET /api/v2/rateLimit`. Read the real figures from that endpoint or from the
   response headers; do not hard-code 600/150/150/60 as invariants.
3. **Backlog sends no `Retry-After`.** Over limit is HTTP 429 with error code
   13. Compute the backoff from `X-RateLimit-Reset`, which is **UTC epoch
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
**17** Comment Notification Added. Type 17 is the "project notifications" in the
package description. Subscribe to these explicitly via `activityTypeIds[]`
rather than setting `allEvent` — the full range runs to 49 and includes git,
pull request, wiki and document events this adapter has no meaning for.

## Dependency plan

Build on [`backlog-js`](https://github.com/nulab/backlog-js) (v0.20.1, MIT,
Nulab's own, tsdown-built, single runtime dependency `qs`), wrapped behind a
narrow internal port so the adapter never leaks its types outward. It does not
provide, and this repo must add:

1. Rate-limit bucket awareness (classify each request into read/update/search/
   icon and track the headers per bucket).
2. Typed errors derived from `errors[].code`.
3. 429 retry with backoff computed from `X-RateLimit-Reset`.

The port also keeps the option open to drop `backlog-js` for plain `fetch`
without touching adapter code.

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
