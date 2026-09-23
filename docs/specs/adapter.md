# `@nulab/chat-adapter-backlog` — adapter specification

Goal-state specification for the Backlog adapter of Chat SDK (`chat@4.39.0`).
This document states **what** the finished adapter does — observable behaviour,
inputs, outputs, edge cases, error classes — precisely enough that tests can be
written from it before the code exists. **How** the work is ordered lives in
[docs/plans/adapter-implementation.md](../plans/adapter-implementation.md); the
constraints both were written under are in [CLAUDE.md](../../CLAUDE.md).

Measured Backlog behaviour is summarised here only as far as it changes the
adapter's observable behaviour. The measurements themselves, with dates and
payload excerpts, live in `.claude/rules/backlog-webhook-facts.md`,
`.claude/rules/backlog-api-facts.md`, `.claude/rules/backlog-pull-request-facts.md`
and `.claude/rules/chat-sdk-core-facts.md`.
Every Backlog API claim below cites a
[developer.nulab.com](https://developer.nulab.com/docs/backlog/) page or says
"measured on \<date\>".

Conventions: "the core" is the `Chat` class in `chat@4.39.0`; "the port" is the
internal `BacklogApi` interface (§8); "installation" is one configured Backlog
space. `MUST`/`MUST NOT` are requirements; `SHOULD` is a default an implementer
may deviate from with a Why-not comment. Items marked ⚑ are decisions the
register in §15 tracks; each one has a verdict there — confirmed, changed or
still open — so a ⚑ means "§15 has the answer", not "nobody has decided".

## 1. Purpose and scope

**Goal state.** A consumer installs `@nulab/chat-adapter-backlog` and `chat`,
constructs the adapter with a Backlog host, a bot user's credentials and a
webhook secret (or lets those come from environment variables), registers one
Backlog project webhook per project pointing at the Chat SDK route, and then
writes ordinary `Chat` handlers: a mention of the bot in an issue, a pull
request or a comment on either reaches `onNewMention`, follow-up comments on
subscribed issues and pull requests reach `onSubscribedMessage`,
`thread.post()` becomes a comment on the issue or pull request,
`channel.post()` creates an issue, `thread.messages` pages through the
thread's comments, and every Backlog API failure surfaces as one of
`@chat-adapter/shared`'s error classes. One adapter instance serves any number
of Backlog spaces. `pnpm test` proves all of this with no network.

**Done means** every row of §4 has the stated status, every behaviour in
§5–§9 has a test, §12's suites pass on Node 20, 22, 24 and 26, and §13's
documents exist.

**Non-goals** (declared unsupported, not deferred): direct messages, ephemeral
messages, modals, buttons, slash commands, scheduled messages, nested replies,
emoji reactions, typing indicators, realtime transport, OAuth token
acquisition or refresh, webhook registration on behalf of the consumer, any
persistent state of the adapter's own (subscriptions and dedupe belong to the
Chat SDK `StateAdapter`), creating, closing or merging pull requests (Backlog
has no status API, `.claude/rules/backlog-pull-request-facts.md`), treating a
git repository as a channel (D-PR1), and listing pull requests through
`listThreads` (D-PR7).

## 2. Conceptual model

| Backlog | Chat SDK | Id grammar | Notes |
| --- | --- | --- | --- |
| Space | (installation) | `host` — a full hostname such as `example.backlog.com`, `example.backlog.jp`, `example.backlogtool.com` | Never a slug; the domain differs per space (CLAUDE.md "Host"). |
| Project | Channel | `backlog:<host>:<projectId>` | Numeric project id. Both kinds of thread belong to the project; a git repository is not a channel (D-PR1). |
| Issue | Thread | `backlog:<host>:<projectId>:issue:<issueId>` | Numeric issue id, never the issue key: renaming a project key rewrites every issue key (measured, `.claude/rules/backlog-webhook-facts.md`). |
| Pull request | Thread | `backlog:<host>:<projectId>:pr:<repositoryId>:<number>` | Numeric repository id, never the name (`repoIdOrName` accepts either; names can change); `number` is the per-repository number every pull-request endpoint is keyed by. The global pull-request `id` addresses no endpoint and appears only in raw data and metadata (`.claude/rules/backlog-pull-request-facts.md`). |
| Issue body / pull-request body | Root message of the thread | `<host>:issue:<issueId>:r` / `<host>:pr:<repositoryId>:<number>:r` | `text` = `summary + "\n\n" + description`, trimmed, for both kinds. |
| Comment | Message | `<host>:<subject>:c<commentId>` | Includes Backlog's auto-generated changelog comments (status, assignee, description, attachment changes). The kind segment keeps issue and pull-request comment ids distinct: the two are drawn from different sequences and may overlap (measured). |
| Update without a comment | Message with empty text | `<host>:<subject>:u:<created>` | `created` is the webhook's top-level ISO timestamp verbatim; it contains `:`. |
| User | User | `<host>:<userId>` | Numeric user id, host-qualified because user ids are per space. |
| Star on a comment | Reaction | — | One kind only; emoji name is ignored. `commentId` or `pullRequestCommentId` by kind. |
| Notification (お知らせ) | Read receipt | — | `markAsRead` marks the bot user's own notification for the comment, matched by kind. |

The `host` appears in message and user ids because the core's dedupe key is
`dedupe:<adapter.name>:<message.id>` with no thread component (verified in
`chat.ts`; see `.claude/rules/chat-sdk-core-facts.md`), and comment ids are
unique only within one space and one kind.

The kind is an explicit segment on **both** kinds rather than issues being the
unmarked default (D-PR2): Backlog addresses the two through different endpoint
families with different coordinates, so nothing may infer the kind from a
segment count. The shared value every id, raw message and internal call passes
around is

```ts
type BacklogSubjectRef =
  | { kind: 'issue'; issueId: number }
  | { kind: 'pullRequest'; repositoryId: number; number: number };

interface BacklogThreadId { host: string; projectId: number; subject: BacklogSubjectRef }

type BacklogMessageId = { host: string; subject: BacklogSubjectRef } & (
  | { part: 'root' }
  | { part: 'comment'; commentId: number }
  | { part: 'update'; created: string }
);
```

### 2.1 Grammar

```
host        = 1*( lower-alnum / "." / "-" )      ; no ":" "/" scheme, port or path; lowercased
posint      = ( "1"-"9" ) *DIGIT                 ; value <= 2^53-1 (Number.MAX_SAFE_INTEGER)
subject     = "issue:" posint                    ; issueId
            / "pr:" posint ":" posint            ; repositoryId, number
thread-id   = "backlog:" host ":" posint ":" subject   ; projectId, subject
channel-id  = "backlog:" host ":" posint               ; projectId
message-id  = host ":" subject ":" part
part        = "r" / "c" posint / "u:" created
user-id     = host ":" posint
created     = 1*VCHAR                                  ; opaque, may contain ":"
```

### 2.2 Rejection rules

`decodeThreadId`, `decodeChannelId`, `decodeMessageId`, `decodeUserId` throw
`ValidationError("backlog", …)` on any of: wrong prefix or segment count
(thread: `backlog`, host, project id, then exactly the segments its subject
keyword takes — one posint after `issue:`, two after `pr:`; channel: exactly
3), empty or invalid `host`, non-`posint` numeric segment, unknown subject
keyword, a subject followed by nothing or by an unknown part, `r` or `c<id>`
followed by further segments, `u:` with nothing after it. `decodeUserId`
splits on the **last** `:`; a bare number is rejected even with a single
installation.

A `posint` whose **value** exceeds `Number.MAX_SAFE_INTEGER` is rejected as
well, although its digits match the grammar: the segment is read with
`Number`, which is lossy past 2^53-1, so `…:issue:99999999999999999999`
decoded to `1e20` and re-encoded to `…:issue:1e+20` — a round trip that
silently addressed something else.

`encodeThreadId`, `encodeChannelId`, `encodeMessageId` and `encodeUserId`
validate their input against **the same grammar** and throw the same
`ValidationError`, because a value the grammar cannot express produces a
string the matching decoder rejects: a non-lowercased host, a host with a
scheme, path or port, a numeric field that is not a positive integer ≤ 2^53-1,
and an `update` part whose `created` is empty. Nothing is normalised on the
way out — a host is rejected, not lowercased in passing, since the config path
(§3.2) is where lowercasing happens.

A host
that decodes correctly but is not a configured installation is a
`ResourceNotFoundError("backlog", "installation", host)` at the point of use
(not a decode error: the id is well-formed).

## 3. Public API

### 3.1 Exports (`src/index.ts`)

Runtime: `BacklogAdapter` (class), `createBacklogAdapter(config?)`,
`encodeThreadId`, `decodeThreadId`, `channelIdFromThreadId`,
`encodeChannelId`, `decodeChannelId`, `encodeMessageId`, `decodeMessageId`,
`encodeUserId`, `decodeUserId`,
`mentionUser(id)`, `mentionTeam(id)`, `MENTION_PROJECT_MEMBERS`,
`mentionPattern(botUserName)`, `BacklogMarkdownConverter`,
`BacklogNotationConverter`, `createInMemoryBacklogApi(seed?)`.

Types: `BacklogAdapterConfig`, `BacklogInstallation`, `ResolvedInstallation`,
`ResolvedCredential`, `Resolvable`, `BacklogThreadId`, `BacklogChannelId`, `BacklogSubjectRef`,
`BacklogMessageId`, `BacklogMessagePart`, `BacklogUserId`, `BacklogRawMessage`,
`BacklogPostableExtras`, `BacklogChannelPostableExtras`,
`BacklogWebhookPayload`, `BacklogWebhookVerifier`, `BacklogApi` and the domain
types it references (`BacklogIssue`, `BacklogPullRequest`,
`BacklogGitRepository`, `BacklogComment`, `BacklogIssueComment`,
`BacklogProject`, `BacklogUserRef`, `BacklogChange`, `BacklogStar`,
`StarTarget`, `PullRequestRef`, `BacklogNotification`,
`BacklogAttachmentInfo`, `TextFormattingRule`, request/query input types),
`RateLimitSnapshot` and `RateLimitSnapshots`, `BacklogApiErrorDetail`,
`InMemoryBacklogSeed`, and `Backlog` — `backlog-js`'s own client class,
re-exported so a consumer can name what `client(host)` returns without
depending on `backlog-js` itself.

Not exported: the internal subject layer (`SubjectClient`,
`subjectClientFor`) that selects the issue or pull-request endpoint family
for a thread — it is the seam egress and reads are written against
(docs/plans/pull-request-support.md §3.4), not a consumer surface.

Not exported: the port's `backlog-js` wrapper factory, zod schemas, the
plain-text fallback converter, fixtures. Nothing from `zod` appears in an
exported type, and `chat` and `backlog-js` are the only modules
`dist/index.d.ts` may import — `scripts/check-published-types.mjs` fails
`pnpm build` on any other, so `BacklogWebhookPayload` and
`BacklogBulkUpdatePayload` are declared by hand in `src/types.ts` rather than
aliased to a `z.infer`.

`backlog-js` does appear in one, and the exception is deliberate:
`BacklogAdapter.client(host)` returns the configured `Backlog` client the port
itself speaks through, for the endpoints the port does not name — changing an
assignee, reading an issue's custom fields, anything else a bot needs and this
adapter does not. Handing it out rather than leaving a caller to construct one
is what keeps the guarantees: the client carries the adapter's bucket
accounting, its bounded 429 retry, its `@chat-adapter/shared` error mapping
and its per-call credential resolution (§8.2), while a second client beside it
would spend the same per-user budget uncounted. The cost is that this
package's public types move with `backlog-js`'s, which is accepted because it
is the library the adapter is built on and the same vendor ships both.

`client(host)` throws `AdapterError` (`code: 'NO_CLIENT'`) when the adapter
was constructed with a `createApi` seam, because the port is then not
`backlog-js`-backed and there is no client to hand out. An unknown host is
`ResourceNotFoundError`, as it is for `api(host)`.

### 3.2 `createBacklogAdapter(config?)`

Returns `new BacklogAdapter(config ?? {})`. The constructor validates
synchronously and throws `ValidationError` on the first problem; it never calls
`process.exit`, never logs a secret, and makes no network call.

Two mutually exclusive shapes ⚑ D1:

```ts
type Resolvable = string | (() => string | Promise<string>);

interface BacklogInstallation {
  host: string;
  apiKey?: Resolvable;      // exactly one of apiKey / accessToken
  accessToken?: Resolvable;
  botUserId: number;
  botUserName: string;
  webhookSecret?: string;   // required unless config.webhookVerifier is set
}

interface BacklogAdapterConfig {
  // Shape A — one space, every field falls back to an environment variable.
  host?: string;
  apiKey?: Resolvable;
  accessToken?: Resolvable;
  botUserId?: number;
  botUserName?: string;
  webhookSecret?: string;
  // Shape B — several spaces. Mutually exclusive with shape A's fields.
  installations?: BacklogInstallation[];
  // Shared
  webhookVerifier?: BacklogWebhookVerifier;
  userName?: string;
  logger?: Logger;
  rateLimit?: { maxWaitMs?: number; maxRetries?: number };
  maxWebhookBodyBytes?: number;
  createApi?: (installation: ResolvedInstallation) => BacklogApi;
}
type BacklogWebhookVerifier = (request: Request, rawBody: string) => unknown | Promise<unknown>;
```

| Option | Type | Default | Env fallback | Validation |
| --- | --- | --- | --- | --- |
| `host` | `string` | — | `BACKLOG_HOST` | Matches `host` grammar after lowercasing; rejects `:`/`/`/scheme/whitespace. |
| `apiKey` | `Resolvable` | — | `BACKLOG_API_KEY` | Non-empty when a string. Exactly one of `apiKey`/`accessToken` per installation; the pair falls back to the environment together (below). |
| `accessToken` | `Resolvable` | — | `BACKLOG_ACCESS_TOKEN` | As above. Refresh is the caller's job (resolver form). |
| `botUserId` | `number` | — | `BACKLOG_BOT_USER_ID` | Positive integer ≤ 2^53-1 (the §2.1 `posint` range, since it is encoded into user ids and mentions); env value must parse as one. |
| `botUserName` | `string` | — | `BACKLOG_BOT_USER_NAME` | Non-empty after trim (an empty name would make every `@` a mention). |
| `webhookSecret` | `string` | — | `BACKLOG_WEBHOOK_SECRET` | Non-empty and at least **16 bytes** (UTF-8), validated whether or not a verifier is configured. Required on every installation unless `webhookVerifier` is set (D2). |
| `installations` | `BacklogInstallation[]` | — | none | Non-empty; no duplicate hosts (after lowercasing); each element validated as above. Rejected if any shape-A field is also present. |
| `webhookVerifier` | function | — | none | When set, replaces the secret check for every installation (D2). |
| `userName` | `string` | first installation's `botUserName` | none | Non-empty. Exposed to the core as `adapter.userName`. |
| `logger` | `Logger` (from `chat`) | `new ConsoleLogger("info").child("backlog")` | none | Replaced by `chat.getLogger("backlog")` in `initialize`. |
| `rateLimit.maxWaitMs` | `number` | `60_000` | none | Non-negative integer (`NaN` and `Infinity` rejected). Longest wait before a 429 retry (D5). |
| `rateLimit.maxRetries` | `number` | `1` | none | ≥ 0 integer; `0` disables retries. |
| `maxWebhookBodyBytes` | `number` | `5 * 1024 * 1024` | none | Positive integer. Larger bodies → 413 (§5.1) ⚑. |
| `createApi` | function | `backlog-js` implementation | none | Test seam; receives the resolved installation and returns a port. |

Environment fallbacks apply **only** to shape A and only when the corresponding
field is absent from `config` (an explicit empty string is a validation error,
not a fallback trigger). Missing everything → `ValidationError` naming the
first missing field and its environment variable. Internally the adapter always
holds `Map<host, ResolvedInstallation>`; shape A is one entry.

`apiKey` and `accessToken` are the one exception to "field by field": they are
a single mutually exclusive choice, so they fall back as a **pair**. An
explicit `apiKey` *or* an explicit `accessToken` in `config` suppresses
**both** `BACKLOG_API_KEY` and `BACKLOG_ACCESS_TOKEN`, and the four
combinations resolve as:

| `config` | Environment | Result |
| --- | --- | --- |
| `apiKey` | `BACKLOG_ACCESS_TOKEN` set | The explicit `apiKey`; the variable is ignored. |
| `accessToken` | `BACKLOG_API_KEY` set | The explicit `accessToken`; the variable is ignored. |
| both | either or neither | `ValidationError` — "exactly one of apiKey or accessToken is allowed, not both". |
| neither | both set | `ValidationError` — "exactly one of BACKLOG_API_KEY or BACKLOG_ACCESS_TOKEN is allowed, not both", naming the **variables** rather than the config fields. |

Otherwise a deployment that moved from OAuth to an API key, wrote `apiKey` in
`config` and forgot to unset `BACKLOG_ACCESS_TOKEN` would be refused with a
message blaming the config it had just written.

`ResolvedInstallation` is what validation produced, not a second name for
`BacklogInstallation`, and it says so in the type:

```ts
type ResolvedCredential =
  | { apiKey: Resolvable; accessToken?: never }
  | { accessToken: Resolvable; apiKey?: never };

type ResolvedInstallation = {
  host: string;             // lowercased, §2.1 host grammar
  botUserId: number;
  botUserName: string;
  webhookSecret?: string;
} & ResolvedCredential;
```

So an installation carrying both credentials or neither is a type error, and
`createApi` receives a value whose exclusivity no reader has to take on trust.
The input type stays permissive on purpose: config is assembled from
`process.env` and JSON the compiler knows nothing about, and one
`ValidationError` naming the field is a better report than a type error raised
where the object was built. `host` stays a plain `string` rather than a brand
— every construction site, fixtures and consumer test doubles included, would
have to cast into one, and its only producer is the shared host validator in
`src/ids.ts`.

Credential resolvers are invoked on **every** outbound call and their result is
never cached by the adapter (vendor-official requirement, verified in the
contract research; see `.claude/rules/chat-sdk-core-facts.md`). A resolver that
throws makes that call reject with `AuthenticationError` wrapping the cause.

### 3.3 Additional public members of `BacklogAdapter`

- `readonly name = "backlog"`; `readonly userName: string`.
- `api(host: string): BacklogApi` — the port for that installation (escape
  hatch for endpoints outside the Chat SDK contract, D7). Unknown host →
  `ResourceNotFoundError("backlog", "installation", host)`.
- `rateLimit(host: string): RateLimitSnapshots` — last observed
  `X-RateLimit-*` per bucket for that host (D5); empty object before any call,
  and never informed by another instance's traffic. The figures the space
  reports irrespective of this instance's history are one call further out:
  `api(host).getRateLimit()` (§8.4).
- `botUserName(host: string): string` — the bot's display name on that
  installation (D19). Unknown host → the same
  `ResourceNotFoundError("backlog", "installation", host)`. Unaffected by a
  `config.userName` override, which renames the adapter to the core and not
  the bot in any space.
- `renderFormatted(content, target?: string)` — see §4 and §9.3 ⚑.

`botUserId` is **not** exposed on the adapter: it differs per installation, and
the core's use of it (an extra `@<id>` mention pattern) would be wrong for
every space but one. The display name **is**, through `botUserName(host)`,
because a consumer that reads or writes a mention string needs it per space and
Backlog has already published it in every rewritten comment body (D19).

### 3.4 Postable extras

Consumers intersect these with a Chat SDK postable
(`thread.post({ markdown, notifiedUserId: [1] } satisfies PostableMarkdown & BacklogPostableExtras)`).
Extras are read with a strict schema: a present-but-mistyped extra is a
`ValidationError`, never silently dropped.

| Extra | Applies to | Type | Effect |
| --- | --- | --- | --- |
| `notifiedUserId` | `postMessage`, `postChannelMessage` | `number[]` (positive ints) | Backlog `notifiedUserId[]`. Invalid or non-member ids are silently dropped **by Backlog** (201, no notification; measured 2026-08-18) — the adapter does not pre-validate them. |
| `issueTypeId` | `postChannelMessage` | `number` | Overrides the cached default (§6.7). |
| `priorityId` | `postChannelMessage` | `number` | Overrides the cached default. |
| `assigneeId` | `postChannelMessage` | `number` | Backlog `assigneeId`. |

`editMessage` accepts no extras and no files; Backlog's Update Comment takes
`content` only
([Update Comment](https://developer.nulab.com/docs/backlog/api/2/update-comment/)).

### 3.5 Raw message union

```ts
type BacklogRawMessage =
  | { kind: "webhook"; host: string; payload: BacklogWebhookPayload; changes: BacklogChange[] }
  | { kind: "bulkUpdate"; host: string; payload: BacklogBulkUpdatePayload; issueId: number;
      changes: BacklogChange[] }
  | { kind: "comment"; host: string; projectId: number; subject: BacklogSubjectRef;
      comment: BacklogRawComment; changes: BacklogChange[] }
  | { kind: "issue"; host: string; issue: BacklogRawIssue; changes: [] }
  | { kind: "pullRequest"; host: string; pullRequest: BacklogRawPullRequest; changes: [] };
```

`parseMessage` accepts **all five** variants. The last three are the ones the
adapter produces itself — `fetchMessages`, `fetchMessage`, `listThreads`,
`postMessage`, `editMessage` and `postChannelMessage` put them on the messages
they return — and `parseMessage(message.raw)` rebuilds such a message with **no
API call**, reproducing its `id`, `threadId`, `text`, `formatted`, `author`,
`metadata.dateSent`, `metadata.edited` and `raw`. That is what makes a
`Message` recoverable from the `raw` alone, which is all the core serialises
into the state adapter. It holds because `parseMessage` builds them through the
same `buildRootMessage`/`buildCommentMessage` the reads use, not through a
second builder of its own; §12.2 asserts the round trip on each of the three.
One field is **not** reproduced: an issue comment's `attachments`, because the
download id lives in the REST changelog's `attachmentInfo` and
`BacklogRawComment` does not carry it (§6.6, the same trade `src/index.ts`
records for the user fields). A pull-request comment's attachments do survive
— that kind resolves a file by name. `formatted` follows the **cached**
formatting rule like every other `parseMessage` call (§9.1), so a cold cache
renders Markdown and warns. A raw naming a host no installation was configured
for is a `ResourceNotFoundError`.

`BacklogWebhookPayload` is the union of the recognised issue **and**
pull-request activities (§5.2), the ones that name one subject; `payload.type`
tells them apart. As with the bulk variant below, `payload` is the delivery as
received — but the type declared here is the schemas' **output**, not their
input, so it claims a validation the value has not had. `parseMessage`
therefore parses again before reading a field off `raw.payload`, whatever the
kind, and throws `ValidationError` when it does not parse. Reading through the
declaration instead is what makes §5.2's `notifications[]` fallback
unreachable at run time: the schema's `[]` never touches the value a handler
is given.
`BacklogBulkUpdatePayload` is the type-14 body instead — it names as many
issues as `content.link[]` holds, so `bulkUpdate` carries its own `issueId`
naming which entry this message is (§5.3, D22); `payload` is the whole
delivery, unstripped, reachable again from every message the batch produced —
and it is the schema's **input** type, because a delivery writes
`content.link[].id` and `key_id` as decimal strings (§5.2) and only the
adapter's own re-parse turns them into numbers; a consumer reading them off
`raw.payload` gets `string | number`. The `comment` variant names its `subject` explicitly because a
pull-request comment carries no parent reference of its own
(`.claude/rules/backlog-pull-request-facts.md`); `BacklogRawComment` therefore
has no `issueId`. The two root variants stay flat (`issue`, `pullRequest`)
rather than one `root` with a nested discriminator, so `raw.issue` is reachable
after one `kind` check. Raw shapes carry ISO strings where the port's domain
types carry `Date` (`src/index.ts`).

`changes` is normalised to `{ field: string; newValue: string | null; oldValue: string | null }`.
Value systems are **not** unified: webhook `status` changes carry ids and
assignee changes carry display names; REST `changeLog` carries display names
for both (measured 2026-08-28). On the issue side only `priority`, `status`
and `resolution` carry ids at all; every other field arrives as a display
name, a full text or a bare date, and three `field` names match neither the
API parameter nor the label a user sees (`component`, `limitDate`,
`assigner`). The measured table is in
`.claude/rules/backlog-webhook-facts.md`; a consumer that resolves a
`newValue` against the API must first know which field produced it. The
assignee field is named **`assigner`** on issues and **`assignee`** on pull
requests, and a pull request's `summary` change carries resolved mention text
in the activity but raw `<@U…>` in REST (measured 2026-09-06). Consumers read
`raw.kind` and the subject kind before interpreting.

### 3.6 Errors thrown

All from `@chat-adapter/shared`, adapter name `"backlog"`:
`ValidationError`, `AuthenticationError`, `PermissionError`,
`ResourceNotFoundError`, `AdapterRateLimitError`, `NetworkError`,
`AdapterError`. Mapping in §8.5. The id **encoders** throw `ValidationError`
too, for the input §2.2 lists. `mentionUser`/`mentionTeam` throw a built-in
`RangeError` for a non-positive-integer id (pure helpers, no adapter context).
No `ZodError` and no `backlog-js` error class ever escapes the package.

## 4. Adapter contract coverage

`Adapter<BacklogThreadId, BacklogRawMessage>` in `chat@4.39.0` has 17 required
and 27 optional members (CLAUDE.md, verified against the shipped `.d.ts`).
"Core calls it" lists the runtime call site; "never" means only the adapter or
the test kit calls it. Every member accepts an issue thread or a pull-request
thread; the pull-request form is identical unless §6 or §7 says otherwise. Only
one member fails on a pull-request thread — `deleteMessage` (D-PR3) — and
`listThreads` and `postChannelMessage` are issue-scoped because they take
channel ids (D-PR7, §6.7); each is stated where it differs.

### 4.1 Required members

| Member | Status | Behaviour | Core calls it |
| --- | --- | --- | --- |
| `name` | implemented | `"backlog"`. Config key in `new Chat({ adapters: { backlog } })` MUST equal it (thread-id prefix routing). | dedupe key, `Thread.toJSON`, logs |
| `userName` | implemented | `config.userName ?? installations[0].botUserName`. One string for the whole adapter; the per-installation name is `botUserName(host)` (§3.3, D19). | fallback mention regex `(?<!\w)@<userName>(?![\w-])`, `SentMessage.author` |
| `initialize(chat)` | implemented | Stores the `ChatInstance`, swaps logger to `chat.getLogger("backlog")`. No API call. | first webhook / `chat.initialize()` |
| `handleWebhook(request, options?)` | implemented | §5. | `chat.webhooks.backlog(req)` |
| `encodeThreadId` / `decodeThreadId` | implemented | §2 grammar; exact round trip of `{ host, projectId, subject }`, the nested `BacklogSubjectRef` (D-PR2). | never (test kit) |
| `channelIdFromThreadId` | implemented | First three segments: `backlog:<host>:<projectId>`. | `createThread`, lock key, history |
| `parseMessage(raw)` | implemented | Synchronous `BacklogRawMessage → Message`, for all five variants: a `webhook` or `bulkUpdate` raw is re-parsed against its schema, and the three the adapter produced itself round-trip back into the message they came from (§3.5). Converter chosen from the **cached** formatting rule of `raw`'s project, Markdown with a `warn` when uncached (§9.1). | never; the webhook factory calls it |
| `renderFormatted(content, target?)` | implemented | Renders mdast with the converter for `target` (thread or channel id) when its rule is cached; otherwise GFM Markdown ⚑. | never |
| `postMessage(threadId, message)` | implemented | Adds a comment (§6.1). | `thread.post`, object/ephemeral fallbacks, `channel.post` fallback (not taken: `postChannelMessage` exists) |
| `editMessage(threadId, messageId, message)` | implemented | Updates comment content (§6.2). | `SentMessage.edit` |
| `deleteMessage(threadId, messageId)` | implemented | Deletes the comment (§6.3); on a pull-request thread fails with `AdapterError(…, "UNSUPPORTED_OPERATION")` before any call — Backlog has no such endpoint (D-PR3). | `SentMessage.delete` |
| `addReaction` / `removeReaction` | partial | One star; emoji ignored (§6.5). | `SentMessage.addReaction` etc. |
| `startTyping()` | no-op | Resolves immediately. Backlog has no typing indicator. | `thread.startTyping` |
| `fetchMessages(threadId, options?)` | implemented | Paged comments plus root message (§7.1). | `thread.messages`, `allMessages`, `refresh`, history |
| `fetchThread(threadId)` | implemented | Issue or pull request → `ThreadInfo` with `metadata.kind` (§7.3). | `chat/ai` tools only |

### 4.2 Optional members

| Member | Status | Behaviour / core degradation when absent |
| --- | --- | --- |
| `stream(threadId, textStream, options?)` | **implemented, buffered** (D4) | Consumes the whole stream, joins `markdown_text` chunks, then one `postMessage`; returns its `RawMessage`. Never returns `null` before the stream is consumed (that re-enables the core's 500 ms edit loop). Empty stream — an abort that buffered nothing included — → posts `" "`, matching the core's own fallback, so a `SentMessage` always exists (§15 question 7, settled). |
| `isDM(threadId)` | implemented | Always `false`. |
| `fetchMessage(threadId, messageId)` | implemented | §7.2. |
| `fetchSubject(raw)` | implemented | §7.4; the parent issue (`type: "issue"`) or pull request (`type: "pull_request"`) as `MessageSubject`. |
| `fetchChannelInfo(channelId)` | implemented | §7.5; also refreshes the formatting-rule cache. |
| `listThreads(channelId, options?)` | implemented | §7.6; offset cursor; **issues only** (D-PR7). |
| `postChannelMessage(channelId, message)` | implemented | Creates an issue (§6.7). |
| `getUser(userId)` | implemented | §7.7. |
| `markAsRead(threadId, messageId, message?)` | implemented | §7.8. |
| `rehydrateAttachment(attachment)` | implemented | §6.6. |
| `endTyping` | absent | Core skips. |
| `disconnect` | absent | Nothing to close. |
| `openDM`, `postEphemeral` | absent | `chat.openDM` throws `NOT_SUPPORTED`; ephemeral returns `null`. Backlog has no DMs (no endpoint in the API index). |
| `openModal` | absent | Core warns "does not support modals". |
| `scheduleMessage`, `reply` | absent | Core throws `NotImplementedError`. Comments are a flat list; no scheduling endpoint. |
| `postObject`, `editObject` | absent | Core posts fallback text. |
| `fetchChannelMessages` | absent | Core falls back to `fetchMessages(channelId)`, which throws `ValidationError` ("channel ids are not threads") — deliberate: a project has no single comment stream. |
| `onThreadSubscribe`, `getChannelVisibility`, `lockScope`, `persistThreadHistory`, `supportsTurnCancellation`, `botUserId` | absent | Core defaults (`"unknown"` visibility, `"thread"` lock scope, no history cache, no cross-process abort). |

Every "absent" member is absent from the instance (a test asserts
`adapter.openDM === undefined` etc.) so the core's own degradation applies; the
adapter never throws its own "not supported".

## 5. Webhook ingress

### 5.1 Response ladder

The first failure returns. Bodies are plain text. Every 401 uses the identical
body so an unauthenticated caller cannot distinguish "wrong secret" from
"unknown host" (D2).

**`#` names a row; it is not the order the rows run in.** Rows 1–5 run in one
of two orders, decided by whether a `webhookVerifier` is configured, and the
**Position** column gives both. Read the one your deployment has:

- **`webhookVerifier` configured**: `1 → 2 → 3 → 4`, then rows 6–12 in order.
  Row 5 never runs.
- **no verifier** (the shared-secret deployment): `1 → 4 → 5 → 2`, then rows
  6–12 in order. Row 3 never runs.

| # | Position (verifier / no verifier) | Check | Failure → status, body | Log |
| --- | --- | --- | --- | --- |
| 1 | 1 / 1 | `request.method === "POST"` | 405 `Method not allowed` | debug |
| 2 | 2 / **4** | Body readable as text and ≤ `maxWebhookBodyBytes` (also checked against `Content-Length` before reading) ⚑ | 400 `Unreadable body` / 413 `Payload too large` | warn `webhook rejected` `{reason}` |
| 3 | 3 / — | If `webhookVerifier` is configured: `await verifier(request, rawBody)` is truthy and does not throw | 401 `Unauthorized` | warn `webhook rejected` `{reason: "verifier"}` (error message logged, never the body) |
| 4 | 4 / **2** | Resolve installation: `?host=` (lowercased) is a configured host; when absent, exactly one installation is configured (D3) | 401 `Unauthorized` | warn `{reason: "unknown_host" \| "missing_host"}` |
| 5 | — / **3** | If no verifier: `?token=` present and `timingSafeEqual` to the installation's `webhookSecret` after a byte-length check | 401 `Unauthorized` | warn `{reason: "missing_token" \| "token_mismatch"}` |
| 6 | 5 / 5 | `JSON.parse(rawBody)` succeeds and yields an object | 400 `Invalid JSON` | warn |
| 7 | 6 / 6 | Envelope `{ type: number }` | 400 `Invalid payload` | warn |
| 8 | 7 / 7 | `type ∈ {1, 2, 3, 4, 14, 18, 19, 20}` — `DISPATCHED_ACTIVITY_TYPES` in `src/webhook/payload.ts`, with no switch: 4 is always dispatched when it arrives, 14 fans out to one message per issue (D22), and 21 never is (D-PR5) | 200 `Ignored` | info `webhook ignored` `{host, type}` |
| 9 | 8 / 8 | Type-specific schema (§5.2) | 400 `Invalid payload` | warn with zod issue paths (no values) |
| 10 | 9 / 9 | `initialize()` has run | 503 `Adapter not initialized` ⚑ (a 5xx is the only answer that could make Backlog redeliver; whether it does is undocumented) | error |
| 11 | 10 / 10 | `createdUser.id !== botUserId` | 200 `OK` (self message, nothing dispatched) | debug `self message skipped` |
| 12 | 11 / 11 | Success | 200 `OK`, returned **before** processing completes | debug |

**Why the split.** The verifier is handed the body, so a verifier-protected
deployment cannot authenticate before buffering it; row 3 before row 4 also
keeps that deployment from revealing whether a host is configured.
`connectWebhookContract` requires only that the verifier be called with
`(Request, string)` — a buffered body, hence row 2 before row 3 — and that a
verifier win over a configured secret; the position of row 4 is this
adapter's choice, not the contract's.

With no verifier, nothing before row 5 reads the body, so buffering it first
would let anyone who has found the URL make the process hold
`maxWebhookBodyBytes` per request, and would answer 413 to a caller that never
proved it knows the secret. Authenticating first costs an unauthenticated
request nothing but its headers. The observable difference is which 4xx an
oversized unauthorised body gets — 401, not 413 — so the statuses such a
caller can distinguish shrink from {405, 400, 413, 401} to {405, 401}. Either
way row 4 precedes row 5, because the secret being compared is per
installation.

No timestamp-staleness window is applied ⚑, deliberately departing from
CLAUDE.md's "Don't" list: Backlog's payload timestamp is unsigned and therefore
attacker-controlled, so a window adds no replay protection, while legitimate
redeliveries have been measured arriving ~20 minutes late (`.claude/rules/backlog-webhook-facts.md`).

On success the adapter calls
`this.chat.processMessage(this, threadId, factory, options)` with
`factory = async () => { await this.ensureFormattingRule(host, projectId); return this.parseMessage(raw); }`
and attaches a `.catch` that logs `error` `inbound processing failed`
`{host, threadId, messageId}` — the core registers the task with
`options.waitUntil` itself. The response does not await the factory.
Failures inside the factory (formatting-rule lookup, converter) are downgraded
per §9.2 so a message is delivered rather than lost.

### 5.2 Payload schema

The body is one Activity object as returned by
[Get Recent Updates](https://developer.nulab.com/docs/backlog/api/2/get-recent-updates/);
Backlog publishes no dedicated webhook-payload page, and measured payloads
match the activity shape in the envelope but **not** field for field: a
webhook body additionally carries the issue's snapshot (`assignee`, `status`,
`priority`, …), spells one key `externalFileLinks` where the activity form says
`external_file_links`, and omits the activity form's `field_text` inside
`changes[]` (measured 2026-09-06,
`.claude/rules/backlog-webhook-facts.md`). The schema is **tolerant of unknown
keys** everywhere (`field_text`, `type` inside `changes[]`,
`shared_files`, `status`, `priority` … are all seen in real payloads) and
`raw.payload` is the parsed body as received, not a stripped copy.

Required (400 when missing): `type` number; `created` a string that names an
instant — `Date.parse` yields a finite value, which is the property the two
readers of it need (`:u:<created>` message ids in `src/ids.ts` and
`metadata.dateSent`), not a grammar: a form Backlog widens to milliseconds or
a numeric offset parses, `""` and `"yesterday"` are the 400; `project.id`
number; `createdUser.id` number; `createdUser.name` string; `content.id`
number; for types 18–20 additionally `content.number` number and
`content.repository.id` number; for type 14 `content.link[]` **instead of**
`content.id`, with `content.link[].id` on every entry (a bulk update carries
no `content.id` and no per-issue snapshot at all). `content.key_id`, `project.projectKey` and
`content.repository.name` are optional — display data, never identity — but
the last two are **captured** when present (§7.3: they are the names a
pull-request URL needs and the REST object lacks).

The top-level `notifications[]` is read but can never make a body invalid: an
absent array and an array in a shape not measured here both mean "this
delivery says nothing about who was notified", and neither is worth losing a
message over, so the field falls back to `[]` instead of failing (§5.4 rule 6).

Two more fields cannot make a body invalid, for the same reason and with the
same consequence — a 400 loses the comment the delivery carries, and Backlog
never sends it again:

- `changes[].new_value` and `.old_value` fall back to `null` when the value is
  neither a string nor a number. The value system is Backlog's own and only
  partly measured (a status as an id string, an assignee as a display name),
  so a custom attribute serialised some other way reads as "no value here"
  rather than costing the message. `raw.payload` still carries what was sent.
- `attachments[].size` is optional and falls back to absent: `null` and any
  other shape read as "this delivery says no size". It reaches
  `Attachment.size` and nothing else; only `attachments[].id` addresses the
  file.

`attachments[].name`, by contrast, stays required, and the asymmetry with the
REST side — where `src/client/schemas.ts` makes `name` and `size` both
optional — is deliberate. There, two Backlog doc pages disagree about which
keys a `changeLog` attachment carries at all; here every measured payload
names its files. And the fallbacks are not comparable: an absent `size` loses
nothing a consumer can act on, while an absent `name` would leave the adapter
either inventing a file name or dropping the file list. A measurement of an
unnamed webhook attachment is what would change this, not the symmetry with
the other schema.

| Field | Type 1 | Type 2/3 | Type 4 | Type 18 | Type 19/20 |
| --- | --- | --- | --- | --- | --- |
| `content.summary`, `content.description` | read (`description` nullable) | ignored | — | read | ignored |
| `content.assignee` | `{ id, name, … } \| null`; always sent on a webhook, `null` when unassigned (measured 2026-09-06), optional in the schema because the activity form omits it | sent, same shape; ignored — the **current** assignee, repeated on every delivery, so an assignment is read from `changes` instead | — | `{ id, name, … } \| null`, webhook-only (measured 2026-09-06); the assignment at creation, read as a mention | sent, same shape; ignored — the **current** assignee, as on 2/3 |
| `content.comment` | absent | `{ id: number, content: string \| null } \| null` | — | `null` | `{ id, content } \| null` |
| `content.changes[]` | absent | `{ field: string, new_value?: string \| number \| null, old_value?: … }[]` optional; a value of any other type reads as `null` | — | `[]` | same shape as 2/3 |
| `content.attachments[]` | `{ id, name, size? }[]` optional | same | — | optional (not measured on the activity form) | optional |
| `content.number`, `content.repository.{id,name}` | — | — | — | required / required + optional | same |
| `content.issue` | — | — | — | `{ id, key_id, issue_key?, summary, description } \| null`, the linked issue; display data (D-PR6) | same |
| `createdUser.userId` | `string \| null` optional (Nulab-account users have none) | same | same | same | same |
| `notifications[]` (top level, not under `content`) | `{ user: { id }, reason? }[]`, read for mention detection (§5.4 rule 6); never required, never a 400 | same | same | same | same |

Type 14 is off that table because its `content` shares no field with the
others (measured on a development space, 2026-09-06). It is also not decided by
how many issues the batch covered: **one** issue updated from the issue list
arrives as a type 14 with a single-entry `link[]`, while the same field changed
on that issue's own page arrives as a type 2 (measured 2026-09-06). The screen
the edit was made from is what picks the type, so nothing may read a `link[]`
of length 1 as "really a type 2":

| Field | Type 14 |
| --- | --- |
| `content.link[]` | required, one entry per issue the batch touched: `{ id, key_id?, title?, comment? }` |
| `content.link[].id`, `.key_id` | the issue id and key — decimal **strings** over the webhook, numbers from `GET /space/activities`; both forms parse |
| `content.link[].comment` | `{ id: number, content: string \| null } \| null` optional — present on every measured entry, `content: ""` when the comment box was empty, and `id` is a comment that really exists on that issue |
| `content.comment` | `{ content: string \| null }` optional — the text as typed, with **no `id`**; the ids are on the entries |
| `content.changes[]` | `{ field, new_value?, type }[]` optional, describing the batch; **no `old_value`** |
| `content.tx_id` | the transaction, string or number; not read |
| `content.individual_update` | boolean, webhook-only, `false` on all six measured deliveries; the bulk update screen has no per-issue value entry, so no known operation produces `true`; read as data, never branched on |
| `notifications[]` (on the envelope, not `content`) | `[]` when the batch changed no assignee; one reason-1 entry **per issue** when it did, the same user repeated. An entry has `id`, `alreadyRead`, `reason`, `resourceAlreadyRead` and `user` and names **no issue** |

The webhook form of types 18–20 is the activity form plus four keys —
`assignee`, `base`, `branch` and `diff` — measured on both forms and diffed
against each other by activity id (measured on a development space,
2026-09-06, `.claude/rules/backlog-pull-request-facts.md`). `base` and
`branch` are the branch names; `diff` is a diff(1)-style body carried only by
the type 19 that changed the description, and is named by no Backlog document.
Two of the four are not pull-request-specific: issue types 2 and 3 carry
`assignee` and `diff` with the same meanings. The schemas name all of them as
the record of the measurement, and nothing reads `base`, `branch` or `diff`,
which costs a consumer nothing either way: `raw.payload` is the parsed body,
so an unread key is not a lost one.

A pull-request webhook's top-level `notifications[]` **is populated**, as an
issue webhook's is; only the reason codes for the same act differ — 10 for an
assignment and 11 for a comment mention, where the issue side uses 1 and 2.
The activity API returns `[]` for the same activities on both kinds (measured
2026-09-06), so the webhook remains the only source of it. §5.4 rule 6 reads
it for every dispatched type alike, with no pull-request branch.

### 5.3 Activity-type mapping

| `type` | Backlog meaning | Message id | `text` | Attachments | Mention (§5.4) |
| --- | --- | --- | --- | --- | --- |
| 1 | Issue Created | `<host>:issue:<issueId>:r` | `summary + "\n\n" + description`, trimmed | `content.attachments[]` | `content.assignee?.id === botUserId` **or** text |
| 2 | Issue Updated, with `content.comment.id` | `<host>:issue:<issueId>:c<commentId>` | `comment.content ?? ""` | `content.attachments[]` | `changes[field="assigner"].new_value === botUserName` **or** text |
| 2 | Issue Updated, no comment id | `<host>:issue:<issueId>:u:<created>` | `""` | none | as above |
| 3 | Issue Commented | `<host>:issue:<issueId>:c<commentId>` | `comment.content ?? ""` | `content.attachments[]` | text |
| 4 | Issue Deleted (D10) | root `<host>:issue:<issueId>:r` | — | — | — → `chat.processMessageDeleted({ adapter, channelId, threadId, messageId, raw, deletedAt: new Date(created) })` |
| 14 | Issue Multi Updated (bulk) | one per `content.link[]` entry: `<host>:issue:<link.id>:c<link.comment.id>`, or `…:u:<created>` for an entry with no comment | `link[].comment.content ?? ""` | none (a bulk update names no file) | `changes[field="assigner"].new_value === botUserName` **or** text **or** the delivery's whole `notifications[]` (§5.4 rule 6, undivided — so it marks every message of the batch, D22) → **N** `chat.processMessage` calls, one per entry |
| 17 | Comment Notification Added | — | — | — | 200 Ignored (D10): emitted by `POST /issues/:id/comments/:commentId/notifications`, which adds recipients to an **existing** comment (picking them while posting emits a plain type 3 instead); `content.comment` is that original comment, so its id has already been dispatched (measured 2026-09-06) |
| 18 | Pull Request Added | `<host>:pr:<repository.id>:<number>:r` | `summary + "\n\n" + description`, trimmed | `content.attachments[]` if present | `content.assignee?.id === botUserId` **or** text (including the raw `<@U<botUserId>>` form, §5.4) |
| 19 | Pull Request Updated, with `content.comment.id` | `…:c<commentId>` | `comment.content ?? ""` | `content.attachments[]` if present | `changes[field="assignee"].new_value === botUserName` **or** text |
| 19 | Pull Request Updated, no comment id | `…:u:<created>` | `""` | none | as above |
| 20 | Comment Added on Pull Request | `…:c<commentId>` | `comment.content ?? ""` | `content.attachments[]` if present; a `changes[field="attachment"]` entry names the file but carries no id (§6.6) | text |
| 21 | Pull Request Deleted (docs) / Merged (`backlog-js`) | — | — | — | 200 Ignored (D-PR5): not observed on either of two attempts, the second made with 21 in the webhook subscription — merge and close arrive as 19 status changes and no delete operation exists in the UI or the API (both measured 2026-09-06) |
| 12, 13 | Git Pushed, Git Repository Created | — | — | — | 200 Ignored: no thread meaning |
| other | wiki, document, … | — | — | — | 200 Ignored |

Every dispatched row's Mention column reads the top-level `notifications[]`
as well (§5.4 rule 6); it is left out of the cells above because it applies
to all of them equally, while what the column names differs per type.

The thread id of a pull-request activity is built from `project.id`,
`content.repository.id` and `content.number` — never from `content.id` (the
global id addresses no endpoint) and never from `content.issue` (a linked
issue is display data; the pull request is its own thread, D-PR6).

Behavioural consequences of measured facts (details and dates in
`.claude/rules/backlog-webhook-facts.md`):

- **Changelog comments.** A status-only change, an assignee-only change, a
  description edit and an attachment add/remove each arrive as **type 2 with
  `content.comment.id` set**, `comment.content` `null` or `""`, and the change
  in `content.changes[]` (description edits carry the whole old and new body).
  They are therefore comment messages with empty `text` and populated
  `raw.changes`; handlers key on `raw.changes`, never on "has a comment".
  Comment-ness does not mean "no field change": a comment posted together with
  a status change is one type-2 event with both.
- **A bulk update is N messages, not one** (D22). A "multi update" from the
  issue list arrives as a single **type 14** whatever it touched, and Backlog
  emits no type 2 or 3 for the issues in it (measured on a development space,
  2026-09-06). The comments are nevertheless real: every `content.link[]` entry
  names an issue and the id of a comment that now exists on it with a
  changelog, and `fetchMessages` returns that comment like any other. Ingress
  therefore expands one delivery into one `chat.processMessage` per entry,
  each into its own thread, each carrying a copy of the batch's `changes[]`.
  The type-specific schema runs once before dispatch and `link[]` is projected
  once; each lazy message factory closes over its validated target. A factory
  does not re-parse the full payload or search `link[]` again. `parseMessage`
  still revalidates a serialised `raw` supplied independently of ingress.
  Three shape details differ from every other type and are load-bearing:
  `content.link[].id` and `key_id` are decimal **strings** over the webhook
  (numbers from `GET /space/activities`); `changes[]` carries `field`,
  `new_value` and `type` and **no `old_value`**, so a bulk update says where
  the issues ended up and not where each of them started; and
  `content.comment` is the text typed into the bulk comment box with **no
  `id`** — the ids are on the entries, one comment per issue. A `status`
  entry's `new_value` is a status **id** written as a string (`"4"`) while an
  `assigner` entry's is a display name, the same asymmetry §3.5 records for
  types 2 and 3, which is why the same `assigner` mention rule applies
  unchanged: the notation is type 2's throughout, and the missing `old_value`
  is the only difference between the two types' entries (measured 2026-09-06).
  `individual_update` is webhook-only and was `false` on all six measured
  deliveries; nothing branches on it.
- **N is 1 as often as it is 50.** A single issue ticked on the issue list is
  a type 14 with one `link[]` entry (measured 2026-09-06), and it takes this
  path like any other batch — one `chat.processMessage` carrying
  `raw.kind: "bulkUpdate"`, not the `webhook` kind a type 2 produces. What a
  handler reads out of `raw` must not depend on how many issues the person
  happened to tick.
- **The batch's `notifications[]` is not divided** (D22). It is `[]` unless the
  batch changed the assignee; when it did, it holds one reason-1 entry per
  issue, the same user repeated (measured 2026-09-06). That is one entry per
  `link[]` entry, which looks like a pairing — but an entry carries `id`,
  `alreadyRead`, `reason`, `resourceAlreadyRead` and `user` and names no issue,
  so the correspondence exists only in the order, which Backlog documents
  nowhere and a redelivery need not preserve. So no message gets "its"
  notification and no per-issue field is derived from the array; it reaches
  every message whole through `raw.payload`, where it means what it is — a
  fact about the batch. §5.4 rule 6 reads that same whole array for every
  message, so a batch that assigned the bot marks **every** message of the
  batch a mention. That is the answer rule 3's `assigner` comparison already
  gives for the same batch, because a bulk update assigns every issue in it to
  the same person, so the undivided array costs nothing there — and it is what
  keeps a bulk update whose recipients Backlog chose structurally from reading
  as an unaddressed batch.
- **The `:u:` path is rare.** Every measured field change carried a comment id;
  the `:u:` id exists so an update without one is still a well-formed message
  rather than a 400.
- **`edited` is always `false` for webhook messages** and `dateSent` is
  `new Date(created)`. Comment edits fire no webhook at all (measured
  2026-09-03), so `processMessageUpdated` is never called (D18).
- **Author.** `userId = <host>:<createdUser.id>`, `userName = createdUser.userId ?? createdUser.name`,
  `fullName = createdUser.name`, `isMe = createdUser.id === botUserId`,
  `isBot = isMe` (Backlog has no bot attribute; `"unknown"` would make the
  core's `getParticipants` drop everyone).
- **Attachments** on webhook messages are `{ type: "file", name, size, url, fetchData }`
  with an authenticated API URL, not a public link:
  `https://<host>/api/v2/issues/<issueId>/attachments/<id>` on an issue and
  `https://<host>/api/v2/projects/<projectId>/git/repositories/<repositoryId>/pullRequests/<number>/attachments/<id>`
  on a pull request (§6.6), and `fetchData()` downloading via the port. MIME
  type is unknown until download.
- **The issue snapshot is webhook-only.** `assignee`, `status`, `priority` and
  the rest of the issue's post-event state are on every type 1, 2, 3 and 17
  delivery — `assignee` always present and `null`, not absent, when nobody is
  assigned (measured 2026-09-06) — and on none of the bodies `GET
  /space/activities` returns (measured 2026-08-28). The schema keeps them
  optional so replaying an activity body works; assignment-based mention then
  relies on the webhook form only.
- **Pull-request activities** (`.claude/rules/backlog-pull-request-facts.md`,
  measured 2026-09-06): merging — by the UI or by pushing the merge to the
  base branch — and closing both arrive as **19** with
  `changes[field="status"]` (`1` Open → `3` Merged / `2` Closed, ids as
  strings) and an empty changelog comment; summary, description and
  linked-issue changes arrive as 19 with `summary` / `description` / `issue`
  (issue **keys**) entries and the `PATCH` `comment` text as
  `comment.content`; an assignee change alone arrives as 19 with
  `field: "assignee"` by display name (a multi-field update was measured once
  to omit the `assignee` entry and once to include it). A comment with
  `attachmentId[]` arrives as **20** with `changes[field="attachment"]` naming
  the file. Creating a pull request with `notifiedUserId[]` also creates a
  system comment (`changeLog[field="notification"]`) that **no activity
  announces**, so `fetchMessages` returns an entry the webhook path never
  delivered. Editing a pull-request comment fires no activity, as for issues.
- **The webhook form of 18–20 adds four keys** the activity form has none of:
  `assignee`, `base`, `branch` and `diff` (measured on both forms and diffed
  by activity id, 2026-09-06; §5.2). Only `assignee` changes behaviour, and
  only on 18, where it is the assignment; on 19 and 20 it is the standing
  assignee and is not read, exactly as on issue types 2 and 3, which carry the
  same key (§5.4 rule 4).
- **A pull-request operation can produce an issue-thread message.** Linking an
  issue to a pull request emits a **type 3 on that issue** whose comment is a
  localized system sentence naming the pull request and whose `changes[]` is
  empty (measured 2026-09-06), alongside the type 19 on the pull request. It
  is delivered as an ordinary issue comment; nothing in the payload marks it
  as machine-generated, so a consumer that acts on every comment acts on this
  one.

### 5.4 Mention detection (D9)

Backlog stores mentions as `<@U<id>>` / `<@T<id>>` / `<@project>`
([Tips](https://developer.nulab.com/docs/backlog/tips/)) but every payload and
API response returns the **resolved** text `@<display name>`. A webhook body
additionally names the users the activity notified, in the top-level
`notifications[]` (measured on a development space, 2026-09-06); the same
activity fetched from `GET /space/activities` carries `[]` there, so the
webhook is the **only** source of that information. Detection is therefore
notification-based, plus textual and assignment for the deliveries that carry
no notification:

1. `mentionPattern(botUserName)` = `new RegExp("(?<![\\w@])@" + escape(botUserName) + "(?![\\w-])")`,
   case-sensitive, no flags. `@Chatbot2`, `foo@Chatbot`, `@@Chatbot` and a
   leftover unresolved `<@U999>` do not match; `@Chatbot`, `@Chatbotさん`,
   `(@Chatbot)` do. Matched against the message `text` (type 1: summary and
   description, so a mention in the summary counts).
2. Type 1: `content.assignee?.id === botUserId`.
3. Type 2: any `changes[]` entry with `field === "assigner"` and
   `String(new_value ?? "") === botUserName` — Backlog reports the new
   assignee by display name, not id (measured 2026-08-02).
4. Type 19: as rule 3 with `field === "assignee"` (the pull-request field
   name, measured 2026-09-06). Type 18: `content.assignee?.id === botUserId`,
   as rule 2 — the webhook body carries the assignee the activity form omits
   (measured 2026-09-06), so opening a pull request assigned to the bot and
   mentioning nobody in its text is a mention.

   On 2, 3, 19 and 20 the same `content.assignee` is **not** an assignment and
   is not read. It is whoever the subject is assigned to right now, repeated
   on every delivery of both kinds (measured 2026-09-06), so reading it would
   make every comment on a bot-assigned subject a mention. The evidence that
   an assignment happened is the `changes[]` entry rules 3 and 4 read, and
   nothing else in the body: a `summary` + `description` + `issue` `PATCH` on
   a pull request assigned to the bot carried the bot in `content.assignee`,
   named no assignment in `changes[]`, and notified nobody (measured
   2026-09-06).

   An assignment `changes[]` leaves out is not missed, because rule 6 catches
   it. A `PATCH` that set `assigneeId` alongside another field was once
   measured to emit a 19 with no `assignee` entry while still notifying the
   new assignee (2026-09-06, never reproduced — two later multi-field
   `PATCH`es reported every field they changed), and a delivery that notifies
   somebody names them in `notifications[]`. So an update whose `changes[]`
   carries no assignment is a mention when `notifications[]` names the bot
   and is not one when it does not — which is what both measured shapes want:
   the under-reporting `PATCH` notified the new assignee, and the plain
   multi-field edit of a bot-assigned pull request notified nobody. Reading
   `content.assignee` here instead would make that second, reproducible shape
   a false mention, which is why rules 3 and 4 stop at `changes[]`.
5. A pull request's **summary carries mention notation unrewritten** — in
   storage, in the activity body and in the webhook body alike, while
   `description` and comments are rewritten to `@<display name>` everywhere
   (measured 2026-09-06 in all three). Type-18 `text` is therefore also
   matched against `<@U<botUserId>>`, and `mentionPattern` alone is not
   sufficient for it. The consequence for consumers: a type-18 message whose
   summary is the command line holds `<@U999>`, not `@Chatbot`, so a handler
   matching the display name finds nothing in text the adapter has already
   marked `isMention` — read `isMention`, not the text, to decide whether the
   bot was addressed.
6. Any top-level `notifications[]` entry with `user.id === botUserId`,
   **whatever its `reason`**. This is the only rule that reads a decision
   Backlog made rather than inferring one, and it is the only rule that fires
   for the two cases the others miss: a comment whose recipients were chosen
   in the notification field, which leaves no `@name` in the stored text at
   all, and the multi-field pull-request `PATCH` measured to omit its
   `assignee` change entry while still notifying the new assignee (rule 4).

`reason` is deliberately not filtered on. An assignment (`reason` 1 on an
issue, 10 on a pull request) is already a mention through rules 2–4, so
restricting rule 6 to `reason: 2` would change no assignment outcome — it
could only drop a directed notification whose code has not been measured
here, and would add a second place that has to track Backlog's reason table
(`.claude/rules/backlog-api-facts.md` lists 1–6, 9–13 and gaps at 7, 8, 16).
The obvious candidate for a false positive — a **watch** subscription
notifying the bot nobody addressed — does not exist: an issue watched by an
account that was neither assigned to it nor named in it delivered a comment
and two field-only `PATCH`es with `notifications: []`, while a non-watching
user addressed on the same issue arrived with `reason: 2` (measured
2026-09-06, §15 question 17, settled). What remains is a Backlog behaviour
nobody has seen yet putting the bot there unaddressed; that would read as a
mention, which is the same class of false positive rule 1 already accepts for
a hand-typed `@Chatbot`, and it errs toward the bot answering rather than
staying silent.

`message.isMention` is pre-set from these; the core additionally runs its own
`@<userName>` regex which, because `userName` defaults to `botUserName`,
agrees for the first installation — and only for it, so detection on every
other space is the adapter's alone, and a consumer building its own mention
string reads `botUserName(host)` rather than `userName` (§3.3, D19).

The two regexes do not agree on case. The core's is **case-insensitive** and
ORs its result in (`message.isMention || detectMention(...)`,
`.claude/rules/chat-sdk-core-facts.md`), so `@chatbot` reaches a handler with
`isMention` true through a `chat` consumer while rule 1 alone answers false
(measured 2026-09-06). Rule 1 stays case-sensitive: it is what the other
spaces of a multi-installation deployment are decided by, and matching a
display name loosely there widens the collision the paragraph below already
accepts. Nothing is lost by the disagreement — the core can only ever add
mentions, never remove one — and it is documented in README's Mentions section
because it is what a consumer observes.

A hand-typed `@Chatbot` is indistinguishable from a real mention; false
positives are accepted and documented. A display-name collision with another
user is likewise accepted.

Outbound helpers: `mentionUser(id)` → `<@U<id>>`, `mentionTeam(id)` →
`<@T<id>>`, `MENTION_PROJECT_MEMBERS` → `<@project>`; positive integers only.
Writing `<@U…>` in content notifies the user even without `notifiedUserId`
(Tips page; measured 2026-09-04). `notifiedUserId` is an independent mechanism
that notifies without a visible mention.

### 5.5 Delivery semantics the consumer must know

- **At-least-once.** Backlog redelivers; the core dedupes on
  `dedupe:backlog:<message.id>` for `dedupeTtlMs` (10 minutes by default).
  Redelivery after the TTL is processed again; consumers needing durable
  idempotency key on `message.id`, which is stable across deliveries and
  identical to the id an activity replay produces (webhook `created` equals the
  activity's `created`, measured 2026-08-31).
- **Return 200 first.** Backlog's delivery timeout is undocumented, so the
  adapter never makes the response wait for processing. Serverless hosts pass
  `waitUntil`.
- **Down may mean lost.** Deliveries attempted while the endpoint returned 503
  from an absent origin were not observed to be redelivered within 32 minutes
  (measured 2026-09-03; two observations, not conclusive). Do not rely on
  redelivery for availability.
- **Subscription is core state.** A restart with an in-memory `StateAdapter`
  forgets subscriptions; README recommends a durable one (D7).

## 6. Egress

Every egress member decodes `threadId`, resolves the installation, and uses the
port for that host through the subject client the thread id's `subject`
selects (issue endpoints or pull-request endpoints, D-PR2;
docs/plans/pull-request-support.md §3.4). The behaviour below is the same for
both kinds unless a subsection says otherwise. Non-comment message ids (`:r`,
`:u:`) are rejected with
`ValidationError("backlog", "<id> is not a comment and cannot be edited, deleted or starred")`
(D12).

### 6.1 `postMessage(threadId, message)`

1. Upload every `extractFiles(message)` entry via `POST /space/attachment`
   ([Post Attachment File](https://developer.nulab.com/docs/backlog/api/2/post-attachment-file/));
   the returned ids are single-use handles valid for one hour.
2. Render: `converter.renderPostable(message)` with the project's converter
   (§9). A card renders through `cardToFallbackText`, so its fallback text is
   **the project's own markup, not Markdown**: the card's title and each field
   label are bold, written `**…**` on a Markdown project and `''…''` on a
   Backlog-notation one (§9.4). A caller-supplied `fallbackText` wins over the
   generated one and is posted verbatim. A `link` and a `divider` carry markup
   too and take the project's own form — `[label](url)` / `---` on Markdown
   (§9.3), `[[label>url]]` / `----` on notation (§9.4) — because the card walk
   `renderPostable` reaches, `BaseFormatConverter.cardChildToFallbackText`,
   has no case for either and would drop a `CardLink`'s URL outright. `chat`
   ships three card walks and they disagree: only that method is missing both
   (the standalone `cardChildToFallbackText` export renders a `link` as
   `label (url)`, and `@chat-adapter/shared`'s renders a `divider` too), so
   the claim is about the one the code reaches, not about the package.
   Three things are emitted as written under either rule, and none of them is
   markup-free by accident: a `text`'s content and a card's subtitle
   (unconverted, so an author's Markdown inside one reaches a notation project
   verbatim); an emoji placeholder such as `{{emoji:tada}}`, which is left as
   the caller wrote it because Backlog renders neither form; and a `table` or
   `chart`, which `chat` renders as space-aligned plain text. Plain text is
   not the same as "renders as typed", and on a Markdown project the mechanism
   is setext: a run of `-` under a line of text is an `h2`. So a
   **single-column** table's `-------` row turns its own header into a
   heading, while a two-column table's `--------|----` re-parses as a GFM
   table instead — the outcome depends on the column count, not on tables as
   such. A `divider` is the worse case of the same mechanism, because its
   `---` sits under prose rather than under a header row: everything above it
   collapses into one `h2` (a card of title, subtitle, text and link parses as
   `[heading depth 2, paragraph]`). §9.3 records why that byte is kept anyway.
   `image` and `actions` render as nothing under both rules — `actions` by an
   explicit case in `chat`'s walk, `image` by the absence of one in every
   walk `chat` ships.
3. `POST /issues/:issueId/comments` with `content`, `notifiedUserId[]`,
   `attachmentId[]`
   ([Add Comment](https://developer.nulab.com/docs/backlog/api/2/add-comment/)),
   or `POST /projects/:projectId/git/repositories/:repositoryId/pullRequests/:number/comments`
   with the same three parameters
   ([Add Pull Request Comment](https://developer.nulab.com/docs/backlog/api/2/add-pull-request-comment/);
   `attachmentId[]` is documented and measured 2026-09-06 although
   `backlog-js` omits it from its typing).
4. Return `{ id: <host>:<subject>:c<comment.id>, threadId, raw: { kind: "comment", subject, … } }`.

A failed step rejects; no synthetic message is ever returned. Uploads that
succeeded before a failed comment are abandoned (Backlog deletes them after an
hour). The caller's message object is never mutated.

Unsupported `file.data` — anything but a `Buffer`, an `ArrayBuffer` or a
`Blob` — is a `ValidationError("backlog", …)` naming the file. Step 1
converts and uploads one file at a time, so the error is raised when that
file's turn comes: the file itself is never uploaded, while attachments from
earlier files in the same message have already been uploaded and are
abandoned exactly like the mid-upload failures above.
`@chat-adapter/shared`'s `toBuffer` is therefore called with
`throwOnUnsupported: false`: its own error is named after a `PlatformName`, a
union with no `"backlog"` member, so letting it throw would attribute the
caller's mistake to another vendor's adapter.

### 6.2 `editMessage(threadId, messageId, message)`

`PATCH /issues/:issueId/comments/:commentId`, or
`PATCH /projects/:projectId/git/repositories/:repositoryId/pullRequests/:number/comments/:commentId`
(exists and answers 200, measured 2026-09-06,
`.claude/rules/backlog-pull-request-facts.md` "Comments"), with the rendered
`content`. Files and extras on the edit are a `ValidationError` (Backlog
cannot attach on edit). Returns the updated `RawMessage`. Backlog allows
editing own comments only; a foreign comment surfaces as `PermissionError`
per §8.5.

### 6.3 `deleteMessage(threadId, messageId)`

`DELETE /issues/:issueId/comments/:commentId`
([Delete Comment](https://developer.nulab.com/docs/backlog/api/2/delete-comment/)).
Resolves `void`; 404 → `ResourceNotFoundError`.

On a pull-request thread `deleteMessage` throws
`AdapterError("Backlog has no endpoint to delete a pull request comment", "backlog", "UNSUPPORTED_OPERATION")`
**before any API call** (D-PR3): the endpoint does not exist — the route
answers 400 with error code 6 `Undefined resource` (measured 2026-09-06) — and
`ValidationError` would mislabel a well-formed call as the caller's fault.

### 6.4 `stream(threadId, textStream, options?)` (D4)

Consume the iterable to completion, concatenating `string` chunks and
`{ type: "markdown_text" }` chunks; ignore `task_update`/`plan_update` chunks.
Then exactly one `postMessage(threadId, { markdown: buffered })` and return its
result. Rationale is rate-limit protection (CLAUDE.md "`stream()` must be
overridden"). `options.signal` aborting ends consumption and posts what was
buffered so far — `" "` when that is nothing, the same as an empty stream
(§4.2, §15 question 7): the contract `stream()` keeps whatever ends it is a
`SentMessage` the caller can edit or delete, and posting nothing would mean
resolving to `null` after consumption, which question 7 rejected.

Consumption is raced against the signal rather than read with `for await`,
which can only re-check the signal once the next chunk arrives. A source that
has stopped producing — a model that stopped generating, a socket that hung —
would otherwise leave an aborted `stream()` waiting forever and post nothing at
all.

### 6.5 Reactions

- `addReaction(threadId, messageId, emoji)`: `POST /stars { commentId }` on
  an issue thread, `POST /stars { pullRequestCommentId }` on a pull-request
  thread
  ([Add Star](https://developer.nulab.com/docs/backlog/api/2/add-star/)).
  The emoji is ignored (one star kind). Before posting, read the comment; if
  the bot already has a star on it, resolve without a call. `POST /stars` is
  not idempotent server-side — the same comment starred twice by the same user
  succeeds twice and carries two stars (measured 2026-09-06,
  `.claude/rules/backlog-api-facts.md`) — and the API has no upsert, so the
  read is the only way to make a repeat call a no-op. It is read-then-write,
  which is the right shape for what actually repeats here (a retry, a
  redelivered webhook, a handler that reacts to the same comment twice) and
  not a lock: two `addReaction` calls in flight for one comment can still both
  observe no star and both post. README says so, because the visible result is
  a comment wearing two stars.
- `removeReaction(...)`: read the comment (§7.2), find `stars[]` entries
  whose `presenter.id === botUserId`, `DELETE /stars/:starId` for each
  ([Remove Star](https://developer.nulab.com/docs/backlog/api/2/remove-star/)).
  No bot star → resolve without a call. Never deletes another user's star.
- Reading a single pull-request comment is one list call with a one-element
  window (§7.2), so both members cost one read on either kind.

### 6.6 Files and attachments (D11)

Outbound is §6.1 step 1. Inbound attachments are `Attachment` objects:

| Source | Fields |
| --- | --- |
| Webhook types 1–3 `content.attachments[]` | `type: "file"`, `name`, `size`, `url` (API URL, see §5.3), `fetchData` |
| REST issue comment `changeLog[]` entries with `field === "attachment"` and `newValue` set (an add; `originalValue` set means a removal and is skipped) | same, `name = newValue`, id from `attachmentInfo.id`; `size` unknown |
| Webhook types 18–20 `content.attachments[]`, when present | same, with the pull-request URL below |
| Webhook type 20 `changes[field="attachment"]` and REST pull-request comment `changeLog[field="attachment"]` | `type: "file"`, `name = new_value / newValue`; **no id is carried** (the pull-request `changeLog` has no `attachmentInfo`, measured 2026-09-06), so `url` and `fetchData` resolve the id lazily through `GET …/pullRequests/:number/attachments` by name — the newest match when names collide ⚑ D-PR10 |

A **root** message carries no attachments at all, of either kind. The port
returns neither object's `attachments[]`: `getIssue` does not surface one, and
`BacklogPullRequest` drops the `attachments[]` a real pull request carries
(measured 2026-09-06, `.claude/rules/backlog-pull-request-facts.md`
"Addressing"), so §7.1 builds a root message with `attachments: []`. Listing
them is one extra read on **every** root message — `GET /issues/:issueIdOrKey/attachments`
and `GET /projects/:projectId/git/repositories/:repositoryId/pullRequests/:number/attachments`
— for a source that matters only when a body has files, so the adapter does
not spend it and a consumer that wants them asks through `api(host)` (§3.3):
`listPullRequestAttachments(ref)` is already on the port (§8.1), the issue
list is not and adding it is a port change.

`fetchData()` calls `GET /issues/:issueId/attachments/:attachmentId`
([Get Issue Attachment](https://developer.nulab.com/docs/backlog/api/2/get-issue-attachment/))
or `GET /projects/:projectId/git/repositories/:repositoryId/pullRequests/:number/attachments/:attachmentId`
([Download Pull Request Attachment](https://developer.nulab.com/docs/backlog/api/2/download-pull-request-attachment/))
through the port and returns a `Buffer`. `rehydrateAttachment(attachment)`
rebuilds `fetchData` from `attachment.url` after a JSON round trip; it accepts
only URLs whose host is a configured installation and whose path matches
`/api/v2/issues/<posint>/attachments/<posint>` or
`/api/v2/projects/<posint>/git/repositories/<posint>/pullRequests/<posint>/attachments/<posint>`
— anything else is returned unchanged (no `fetchData`), which keeps
attachment downloads confined to configured hosts (§11). Both builders and
both patterns live in `src/subject/url.ts`, side by side rather than one pair
per subject module: `parseAttachmentPath` has to try them in order and knows no
kind, so a third kind is one more entry in its table, not a new branch, and a
builder cannot drift from the pattern that reads it back.

### 6.7 `postChannelMessage(channelId, message)` — issue creation

Backlog requires `projectId`, `summary`, `issueTypeId`, `priorityId`
([Add Issue](https://developer.nulab.com/docs/backlog/api/2/add-issue/)).

- **Summary** = plain text of the first mdast block (headings included),
  whitespace collapsed; for `string`/`{ raw }` postables the first non-blank
  line. Summary is plain text regardless of project rule (Backlog does not
  render markup in summaries). Empty summary → `ValidationError` ⚑.
- **Description** = remaining blocks rendered with the project converter.
- **A card** is rendered once by `converter.renderPostable` (§6.1 step 2), and
  the rendered text is split on its first newline: first line → summary, the
  rest → description. The first line carries the title's bold markup, so it is
  put back through `extractPlainText` to satisfy the plain-text rule above —
  `**Deploy failed**` and `''Deploy failed''` both become `Deploy failed`. The
  description keeps the project's markup like any other description, field
  labels included, so a card's fields read `**Env**: prod` / `''Env'': prod`
  there. A **caller-supplied** `fallbackText` is parsed the same way, which is
  the cost of one rule for both: its first line is plain text to the caller but
  markup to the parser, so a leading list or heading marker is consumed —
  `- bullet summary`, `1. First step` and (on Markdown) `# Heading summary` all
  become the text after the marker. Backlog would not have rendered the marker
  in a summary field either way.
- **Defaults**: `issueTypeId` = first of
  [Get Issue Type List](https://developer.nulab.com/docs/backlog/api/2/get-issue-type-list/);
  `priorityId` = the middle element of
  [Get Priority List](https://developer.nulab.com/docs/backlog/api/2/get-priority-list/)
  (space-wide `High, Normal, Low` → `Normal`). Both cached per project / per
  host after first use. If Backlog answers a create that used cached defaults
  with a `ValidationError` (code 7), refresh both caches and retry **once**;
  never retry for other errors or when the caller supplied the ids. Empty
  issue-type or priority lists → `ValidationError`.
- Files uploaded as in §6.1; `assigneeId`, `notifiedUserId` passed through.
- Returns `{ id: <host>:issue:<issueId>:r, threadId: backlog:<host>:<projectId>:issue:<issueId>, raw: { kind: "issue", … } }`.

### 6.8 Unsupported egress

`openDM`, `postEphemeral`, `openModal`, `scheduleMessage`, `reply`,
`postObject`/`editObject`, editing the issue or pull-request body
(`editMessage(:r)` is a `ValidationError`), deleting a pull-request comment
(§6.3), emoji reactions (no API; UI-only per the support article cited in
`.claude/rules/backlog-api-facts.md`), and changing a pull request's status
(no API: `statusId` on Update Pull Request is `error.unknownParameter`,
measured 2026-09-06).

## 7. Reads

### 7.1 `fetchMessages(threadId, { limit?, cursor?, direction? })`

Backlog facts: [Get Comment List](https://developer.nulab.com/docs/backlog/api/2/get-comment-list/)
takes `minId`, `maxId`, `count` 1–100 (default 20), `order` `asc|desc`
(default `desc`). `minId`/`maxId` are **exclusive** (`id > minId`,
`id < maxId`) and `count` cuts from the head of `order` (measured 2026-09-03),
so a backward page is `order=desc&maxId=` and a forward page is
`order=asc&minId=`; the previous page's edge id is passed as the cursor with no
±1 correction.

| Input | Rule |
| --- | --- |
| `limit` | Default 50; clamped to `[1, 100]`. A non-integer (`2.5`, `NaN`, `Infinity`) → `ValidationError`: it reaches Backlog as `count`, which answers 400, and rounding would hide the caller's bug. Counts the root message as one slot. |
| `direction` | Default `"backward"`. |
| `cursor` | Must match `^(0\|[1-9]\d*)$`; anything else → `ValidationError`. It is a comment id (or `0` meaning "before the first comment", forward only). |
| `threadId` that is a channel id | `ValidationError` (see §4.2 `fetchChannelMessages`). |

On a pull-request thread the same algorithm runs against
[Get Pull Request Comment](https://developer.nulab.com/docs/backlog/api/2/get-pull-request-comment/)
(same `minId`/`maxId`/`count`/`order` parameters, same exclusive bounds and
head-cut `count`, measured 2026-09-06) and the root message is the pull
request. The list includes Backlog's changelog comments and the
`notification` system comment a `notifiedUserId[]` on creation produces
(`.claude/rules/backlog-pull-request-facts.md`).

Algorithm: `startsWithRoot = direction === "forward" && cursor === undefined`;
`commentLimit = startsWithRoot ? limit - 1 : limit`; request
`count = max(commentLimit, 1)` comments (`desc, maxId: cursor` backward;
`asc, minId: cursor` forward); `hasMore = comments.length >= count`; page =
first `commentLimit` comments sorted ascending by id; prepend the root message
when `startsWithRoot` or when backward and `!hasMore` (oldest page reached).
`nextCursor`: `undefined` when `!hasMore`; backward → oldest comment id on the
page; forward → newest comment id on the page, or `"0"` when the page held only
the root (`limit: 1` forward).

Before building the page, the adapter resolves the project's cached §9.1
converter with one cached Get Project lookup. Both the root and every comment
set `formatted` through that converter; `text` remains the original Backlog
text.

A forward first page with `limit: 1` therefore spends one comment fetch
whose result is discarded except for `hasMore`. That is the specified
behaviour, confirmed 2026-09-08 rather than left open: the fetched comment is
what separates "there are comments, come back with cursor `0`" from "this
thread has none, you are done", so skipping it would make `nextCursor` always
defined on that page and move the same call into the caller's next round trip.
A comment-count endpoint does exist for both kinds
([Count Comment](https://developer.nulab.com/docs/backlog/api/2/count-comment/),
`getIssueCommentsCount` / `getPullRequestCommentsCount`, `read` bucket), so the
alternative is a second call of the same cost answering a different question —
the total, not whether anything lies past this cursor — and only ever for that
one page.

Guarantees (each is a test): pages are chronological; backward pages walk from
newest to oldest; the union of all pages in either direction is root + every
comment exactly once; a backward final page may contain only the root; forward
`limit: 1` yields a first page of just the root; page size never exceeds
`limit`. REST-derived comment messages carry `edited = comment.updated !== comment.created`
and `editedAt`; the root message has `edited: false` because `issue.updated`
moves on any field change and does not indicate a body edit.

### 7.2 `fetchMessage(threadId, messageId)`

Both ids decoded; `null` without an API call when the message's host or
subject differs from the thread's, and for `:u:` ids (no single-fetch API
exists for an update event, D12). Issue thread: `:c<id>` →
[Get Comment](https://developer.nulab.com/docs/backlog/api/2/get-comment/);
`:r` → [Get Issue](https://developer.nulab.com/docs/backlog/api/2/get-issue/).
Pull-request thread: `:r` →
[Get Pull Request](https://developer.nulab.com/docs/backlog/api/2/get-pull-request/);
`:c<id>` → the comment list with `minId = id - 1`, `maxId = id + 1`,
`count = 1` — Backlog has no single-comment endpoint for pull requests (the
route is 400/6 `Undefined resource`), and the exclusive bounds return exactly
that comment or nothing (measured 2026-09-06); an empty page is `null`, and a
returned element whose `id` differs is treated as not found rather than
trusted. `ResourceNotFoundError` → `null`; other errors propagate. The
project's cached §9.1 converter is resolved only once a message is going to
be built, so the three `null` answers above still spend nothing.

### 7.3 `fetchThread(threadId)`

Issue thread: one Get Issue. Returns
`{ id, channelId: backlog:<host>:<projectId>, channelName: <projectKey from issueKey up to its last "-">, isDM: false, metadata }`
with `metadata = { kind: "issue", host, issueId, issueKey, projectId, summary, description, status: { id, name }, assignee: { id, name } | null, issueType: { id, name }, priority: { id, name }, createdUserId, created, updated, url: https://<host>/view/<issueKey> }`.

Pull-request thread: one Get Pull Request, plus the two names its web URL
needs and the object lacks — `projectKey` and the repository name
(`.claude/rules/backlog-pull-request-facts.md` "Addressing"). Both come from
caches the adapter already keeps or fills for free: the per-channel project
cache (§9.1, which stores `projectKey` beside `textFormattingRule` from the
same Get Project) and a `host:repositoryId → name` cache populated from
`content.repository.name` on every pull-request webhook and, on a miss, by one
[Get Git Repository](https://developer.nulab.com/docs/backlog/api/2/get-git-repository/)
(read bucket; cached until a `fetchChannelInfo` on any channel of that host
clears every name under it, §7.5).
A name lookup that fails is not cached, logs `warn`, and yields a `ThreadInfo`
without `url` rather than a failed read. Returns
`{ id, channelId, channelName: <projectKey>, isDM: false, metadata }` with
`metadata = { kind: "pullRequest", host, projectId, repositoryId, repositoryName?, number, id, summary, description, status: { id, name }, assignee: { id, name } | null, base, branch, issue: { id, issueKey } | null, baseCommit, branchCommit, mergeCommit, closeAt, mergeAt, createdUserId, created, updated, url?: https://<host>/git/<projectKey>/<repositoryName>/pullRequests/<number> }`.
Statuses are `1 Open`, `2 Closed`, `3 Merged` (measured 2026-09-06).

Every timestamp in `metadata` — `created`, `updated`, and a pull request's
`closeAt`/`mergeAt` — is an **ISO string**, not the `Date` the port returns
(decided 2026-09-08). `ThreadInfo.metadata` is `Record<string, unknown>`, so a
`Date` in it is invisible to the compiler, and a consumer that puts a
`ThreadInfo` through JSON — a queue, a cache, a tool result — gets a string
back while its code still reads it as a `Date`. It is the same reason the
raw-message shapes carry ISO strings (§3.5), and the two should not disagree
about how an instant is written.

### 7.4 `fetchSubject(raw)`

Resolves the issue or pull request that `raw` belongs to (one Get Issue or Get
Pull Request; for `kind: "issue"` / `kind: "pullRequest"` no call) and returns,
for an issue,
`{ id: <threadId>, type: "issue", title: summary, description, status: status.name, url: https://<host>/view/<issueKey>, author: { id: <host>:<createdUser.id>, name }, assignee?: { id, name }, labels: [issueType.name, priority.name], raw: issue }`
and, for a pull request,
`{ id: <threadId>, type: "pull_request", title: summary, description, status: status.name, url?: <as §7.3>, author, assignee?, labels: [status.name, "<base> ← <branch>"], raw: pullRequest }`.
`type: "pull_request"` is the string `@chat-adapter/github` uses; the core
types `MessageSubject.type` as a free `string` (D-PR8). The core calls this
lazily from `message.subject` and turns errors into `null`.

### 7.5 `fetchChannelInfo(channelId)`

[Get Project](https://developer.nulab.com/docs/backlog/api/2/get-project/) →
`{ id: channelId, name: project.name, isDM: false, metadata: { host, projectId, projectKey, textFormattingRule, archived } }`
and **replaces** this channel's project-cache entry (formatting rule and
`projectKey`), **drops** its `postChannelMessage` defaults, and **drops every
repository name cached for the host** — the documented way to pick up a changed
setting without restarting, since every one of those caches is otherwise
permanent (⚑ D14 cache policy). The repository names go by host prefix rather
than by this channel's project because their key is `` `${host}:<repositoryId>` ``
and carries no project: a repository id is already unique within a space, so a
project-scoped key would let one repository sit under two keys and leave a
stale name alive under whichever one a clear missed. Over-clearing costs one
`read`-bucket Get Git Repository per dropped name, once, and only after a
`fetchChannelInfo` somebody asked for.

### 7.6 `listThreads(channelId, { limit?, cursor? })`

[Get Issue List](https://developer.nulab.com/docs/backlog/api/2/get-issue-list/)
with `projectId[]`, `count` (default 50, clamped `[1, 100]`, non-integer →
`ValidationError` as in §7.1), `offset`
(cursor, `^(0|[1-9]\d*)$` else `ValidationError`). This endpoint draws on the
**search** bucket (150/min documented example), not read. **Pull requests are
not listed** (D-PR7): a pull-request list is per repository, a coordinate the
channel id does not carry; `api(host).listPullRequests(projectId, repositoryId, …)`
is the route to one, and it spends `read`, not `search` (measured
2026-09-06). Ordering is Backlog's
default for the endpoint (`order=desc` on its unstated default sort key); no
status filter, closed issues included — documented, not "open first". Each
issue → `{ id: threadId, rootMessage: <issue root message>, lastReplyAt: new Date(issue.updated) }`;
`replyCount` omitted. `nextCursor = String(offset + issues.length)` when the
page is full, so a trailing empty page is possible and documented.

### 7.7 `getUser(userId)`

`decodeUserId` → [Get User](https://developer.nulab.com/docs/backlog/api/2/get-user/) →
`{ userId: <host>:<id>, userName: user.userId ?? user.name, fullName: user.name, isBot: id === botUserId, email: user.mailAddress ?? undefined }`.
`ResourceNotFoundError` → `null`. `chat.getUser()` cannot route to this
adapter (the core infers adapters from id shape and does not know
`<host>:<id>`); README says to call `adapter.getUser()` directly.

### 7.8 `markAsRead(threadId, messageId, message?)`

Notifications are the **bot user's** feed
([Get Notification](https://developer.nulab.com/docs/backlog/api/2/get-notification/));
each entry carries `comment?.id` for comment-originated notifications
(measured 2026-08-20) and, for pull requests, `pullRequestComment?.id` and
`pullRequest?` ([Get Notification](https://developer.nulab.com/docs/backlog/api/2/get-notification/);
reasons 10–13; the fields exist on every item, a populated one is unmeasured).
Algorithm: comment id and kind from `messageId` (or `message.raw` when given —
they must agree); `:r`/`:u:` → return without a call (debug log). Page
`GET /notifications?count=100[&maxId=]` newest-first, at most 3 pages, until
an entry matches: `comment.id === commentId` for an issue thread,
`pullRequestComment.id === commentId` for a pull-request thread — never the
other field, because the two comment id sequences are distinct and may overlap
(measured 2026-09-06). Found and `resourceAlreadyRead` → no call. Found and
not `resourceAlreadyRead` →
[Read Notification](https://developer.nulab.com/docs/backlog/api/2/read-notification/)
`POST /notifications/:id/markAsRead`. Not found → `info` log and return.
`alreadyRead` is a different flag — the inbox-badge count, cleared only by
[Reset Unread Notification Count](https://developer.nulab.com/docs/backlog/api/2/count-notification/)
(`POST /notifications/markAsRead`) — and the short-circuit must not read it: a
notification `markAsRead` itself marked stays `alreadyRead: false` forever, so
keying off that flag would repeat the `POST` on every call (measured
2026-09-06).
Cost is 1–3 reads plus at most one update per call; README says not to call it
per comment unconditionally.

## 8. Backlog client port

### 8.1 Interface

Every method takes and returns port-owned domain types (no `backlog-js`
types), throws only §3.6 classes, and is implemented twice (§8.2, §8.3).

| Method | Endpoint | Bucket |
| --- | --- | --- |
| `getIssue(issueId)` | `GET /issues/:id` | read |
| `getProject(projectId)` | `GET /projects/:id` | read |
| `getUser(userId)` | `GET /users/:id` | read |
| `listIssues(projectId, { count, offset? })` | `GET /issues?projectId[]=` | **search** |
| `createIssue({ projectId, summary, issueTypeId, priorityId, description?, assigneeId?, notifiedUserId?, attachmentId? })` | `POST /issues` | update |
| `listIssueTypes(projectId)` | `GET /projects/:id/issueTypes` | read |
| `listPriorities()` | `GET /priorities` | read |
| `listComments(issueId, { count, order, minId?, maxId? })` | `GET /issues/:id/comments` | read |
| `getComment(issueId, commentId)` | `GET /issues/:id/comments/:cid` | read |
| `addComment(issueId, { content, notifiedUserId?, attachmentId? })` | `POST /issues/:id/comments` | update |
| `updateComment(issueId, commentId, content)` | `PATCH /issues/:id/comments/:cid` | update |
| `deleteComment(issueId, commentId)` | `DELETE /issues/:id/comments/:cid` | update |
| `addStar(target)` — `target = { commentId }` or `{ pullRequestCommentId }` | `POST /stars` | update |
| `deleteStar(starId)` | `DELETE /stars/:id` | update |
| `listNotifications({ count, maxId? })` | `GET /notifications` | read |
| `markNotificationAsRead(id)` | `POST /notifications/:id/markAsRead` | update |
| `uploadAttachment(filename, data, mimeType?)` | `POST /space/attachment` (multipart) | update |
| `downloadAttachment(issueId, attachmentId)` | `GET /issues/:id/attachments/:aid` | read |
| `listGitRepositories(projectId)` | `GET /projects/:id/git/repositories` | read |
| `getGitRepository(projectId, repositoryId)` | `GET /projects/:id/git/repositories/:rid` | read |
| `listPullRequests(projectId, repositoryId, { count, offset?, statusId? })` | `GET …/pullRequests` | read (measured 2026-09-06, not search) |
| `getPullRequest(ref)` — `ref = { projectId, repositoryId, number }` | `GET …/pullRequests/:number` | read |
| `listPullRequestComments(ref, { count, order, minId?, maxId? })` | `GET …/pullRequests/:number/comments` | read |
| `addPullRequestComment(ref, { content, notifiedUserId?, attachmentId? })` | `POST …/pullRequests/:number/comments` | update |
| `updatePullRequestComment(ref, commentId, content)` | `PATCH …/pullRequests/:number/comments/:cid` | update |
| `listPullRequestAttachments(ref)` | `GET …/pullRequests/:number/attachments` | read |
| `downloadPullRequestAttachment(ref, attachmentId)` | `GET …/pullRequests/:number/attachments/:aid` | read |
| `getRateLimit()` | `GET /rateLimit` | read |
| `rateLimit()` | none | — snapshot of §8.4 |

`addStar` takes a discriminated `StarTarget` (`{ commentId }` or
`{ pullRequestCommentId }`) rather than a bare number, so the kind cannot be
lost between the subject layer and the request. No method deletes a
pull-request comment or fetches one by id: neither route exists
(`.claude/rules/backlog-pull-request-facts.md`).

The two download methods name the file from `Content-Disposition`, the only
place Backlog puts it, and never fail over the name: a download whose bytes
arrived is a success. `filename*` is preferred over plain `filename` when a
header carries both ([RFC 6266
§4.3](https://www.rfc-editor.org/rfc/rfc6266#section-4.3)); only `filename*`
is percent-decoded, because RFC 6266 leaves plain `filename` a quoted string
(so `filename="100%.png"` is that name, not a decode failure); a `filename*`
that will not decode falls back to its raw value; and a header naming no file
falls back to the attachment id. Only the `UTF-8''` prefix is stripped, so
another charset or a populated `language` field is left in the returned name.

Bucket assignment follows the rule on the
[Rate limit](https://developer.nulab.com/docs/backlog/rate-limit/) page:
read = GET except Search and Icon; update = POST/PATCH/DELETE; search = Get
Issue List, Count Issue, Get Wiki Page List, Count Wiki Page; icon = the five
icon endpoints. The classifier is a function of method and path so an endpoint
added later is classified without editing a table of names.

Domain types normalise nullish API fields: `issue.description ?? ""`,
`comment.content: string | null` (assignee-change comments are `null`),
`comment.changeLog ?? []`, `comment.stars ?? []`, `user.userId ?? null`.
`BacklogComment` is the shape both endpoint families share (`id, content,
changeLog, createdUser, created, updated, stars`); `BacklogIssueComment`
extends it with `issueId`, which pull-request comments do not have.
`BacklogPullRequest` carries `id, projectId, repositoryId, number, summary,
description, base, branch, status, assignee | null, issue: { id, issueKey } | null,
baseCommit | null, branchCommit | null, mergeCommit | null, closeAt | null,
mergeAt | null, createdUser, created, updated, stars` — the `issue` field is a
full Issue on every endpoint (the list page's stub example is wrong, measured
2026-09-06) and is normalised to the two identity fields. `BacklogGitRepository`
carries `id, projectId, name, description`.
Responses are validated with zod because `backlog-js` declarations diverge from
the live API; a validation failure is an `AdapterError("backlog", …, "SCHEMA")`
naming the endpoint and the failing path, never a `ZodError`.

### 8.2 `backlog-js` implementation

Wraps `backlog-js@^0.20.1`. Two constraints shape it:

- **Headers.** `backlog-js` entity methods return parsed bodies and discard
  the `Response`, so headers cannot be read off a return value. They are read
  in the **injected `fetch`** instead, which is the one seam every method
  reaches the network through (`request()` ends in
  `this.fetch(url, init).then(this.checkStatus)`, 0.20.1). Bucket accounting,
  the 429 retry (§8.4) and the error mapping (§8.5) all live there, so
  `X-RateLimit-*` is read on **every** response, success or failure, whether
  the call came from this port's own `request()` or from a consumer holding
  `client(host)` (§3.1). A non-2xx throws from the injected `fetch`, before
  `checkStatus` can turn it into a `backlog-js` error, so a mapped
  `@chat-adapter/shared` error is what escapes either route.
- **Per-call credentials.** The client is constructed carrying **no**
  credential — `request()` sets an auth header only for a credential it was
  configured with — and the resolver is awaited on every attempt, its result
  placed on the `Backlog-API-Key` or `Authorization: Bearer` header
  ([Authentication](https://developer.nulab.com/docs/backlog/auth/)); the
  query-string `apiKey` form is never used (it leaks into logs and proxies).
  That is also what makes the client safe to hand out: it holds no secret of
  its own, and a token refreshed between calls is picked up by both routes.
  A resolved credential the header rejects — one carrying CR/LF — is an
  `AuthenticationError`, not a transport failure (§8.5).

Timeouts: `backlog-js`'s `timeout` option is not a real fetch timeout; the
implementation uses an `AbortSignal` (default 30 s) and maps aborts to
`NetworkError`. The timer covers consuming the response body as JSON or an
`ArrayBuffer`, not only receiving its headers, so a stalled body stream cannot
outlive the request timeout.

### 8.3 In-memory implementation

`createInMemoryBacklogApi(seed?)` is exported for consumers' tests. Seed:
`projects`, `issues`, `comments`, `users`, `issueTypes` per project,
`priorities` (default `High/Normal/Low` with ids 2/3/4, matching the
documented example), `notifications`, `repositories`, `pullRequests`,
`pullRequestComments` (keyed by `{ repositoryId, number }`), `me` (the bot
user), `now()`. It exposes
`state` (issues, comments, stars, uploads, recorded inputs, and the seeded
`issueTypes` and `priorities`) for assertions,
allocates ids from a single counter initialised above every seeded id (issues
included), applies exclusive `minId`/`maxId`, sorts by `order`, mirrors
`deleteStar` in `state`, and throws the same error classes as §8.2 — not only
for a missing resource, but for the three refusals a write can meet on a real
space: an `issueTypeId` or `priorityId` outside the seeded lists is a
`ValidationError` rather than an issue carrying a fabricated type name, an
empty comment body is a `ValidationError` on add and on update (a single space
is a body — §4.2 `stream` posts one), and updating or deleting a comment whose
`createdUser` is not `me` is a `PermissionError`. `uploadAttachment` keeps the
bytes it was handed: `size` reports their length, `recordedInputs` carries a
copy, and a download of that id returns them.

`state.issueTypes` and `state.priorities` are the lists `createIssue`
validates against, so removing an entry is how a test models a project whose
settings changed under a cached default (§6.7) — no stub of the port's own
method required. Both `rateLimit()` and `getRateLimit()` answer with the
documented example figures, so either is testable without modelling
consumption.

### 8.4 Rate-limit tracking and retry (D5)

- From every response record `{ limit, remaining, reset: Date }` under
  `(host, bucket)` from `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  `X-RateLimit-Reset` (UTC epoch **seconds**;
  [Rate limit](https://developer.nulab.com/docs/backlog/rate-limit/)).
  `rateLimit()` returns the snapshot; missing headers leave the bucket
  undefined. Limits are per **user** per minute and differ per plan, so no
  number is ever hard-coded.
- Two sources, and a caller picks by what it can rely on. `rateLimit()` is
  free but replays only what **this instance** observed: a bucket it has not
  spent is absent, a `reset` already past means the window rolled over, and an
  instance that lives for one serverless invocation sees almost nothing.
  `getRateLimit()` spends one request on `GET /rateLimit`
  ([Get Rate Limit](https://developer.nulab.com/docs/backlog/api/2/get-rate-limit/))
  and answers with the figures the space applies to the credentialed user right
  now, whatever this instance has done. Its body reports `reset` in UTC epoch
  **seconds**, as the header does. The four buckets it reports are not folded
  into `rateLimit()`, which stays a record of observation; only the response's
  own headers are, in the `read` bucket the request spends.
- On HTTP 429 or error code 13: trim and parse `X-RateLimit-Reset`; an empty or
  non-finite value is missing, not epoch zero. For a usable reset compute
  `waitMs = max(reset*1000 - now, 1000) + jitter`, where jitter is uniformly
  drawn from `[0, 250)` ms so callers released by the same epoch-second header
  do not all retry together. The one-second floor prevents a past reset from
  causing an immediate retry or an error with `retryAfter = 0`. When the header
  is missing, `waitMs = maxWaitMs` with no jitter. If `waitMs > maxWaitMs`
  (default 60 000) or retries are exhausted (`maxRetries`, default 1), throw
  `AdapterRateLimitError("backlog", ceil(waitMs/1000))`; otherwise wait and
  retry the same request. Backlog sends no `Retry-After`.
- No other status is retried; the adapter is idempotency-agnostic and a
  repeated `POST` would duplicate a comment.
- Each of the two outcomes emits exactly one `warn` (§10) — nothing else about
  rate limiting is logged, because a per-request `remaining` line would be one
  entry per API call against a 150-per-minute bucket:
  - about to wait: `rate limited; waiting for the bucket to reset` with
    `{ bucket, remaining?, resetAt?, waitMs, attempt }`;
  - about to throw: `rate limited; not retrying` with the same fields.
  `remaining` and `resetAt` are omitted when the response carried no usable
  `X-RateLimit-Remaining` / `X-RateLimit-Reset`; `attempt` is the 1-based
  number of the request that hit the limit. The port takes the `Logger` as an
  accessor resolved per request, because `initialize` replaces the adapter's
  logger while `api(host)` caches the port built before it.
- A wait of up to `maxWaitMs` blocks the calling promise, so a consumer whose
  runtime caps execution time (a serverless function's timeout) must raise that
  cap above `maxWaitMs` or lower `maxWaitMs` and handle `AdapterRateLimitError`
  itself; otherwise the runtime kills the call mid-wait and the work is lost
  silently. Documented in the README (§13).

### 8.5 Error mapping (D6)

Order of precedence: `errors[0].code` from the body
([Error response](https://developer.nulab.com/docs/backlog/error-response/)),
then HTTP status when the body has no code, then transport.

| Source | Thrown |
| --- | --- |
| code 11 AuthenticationError | `AuthenticationError` |
| code 4 AccessDeniedError, 5 UnauthorizedOperationError | `PermissionError(action)` |
| code 6 NoResourceError | `ResourceNotFoundError(resourceType, resourceId)` |
| code 7 InvalidRequestError, 10 TooLargeFileError | `ValidationError` |
| code 13 TooManyRequestsError | `AdapterRateLimitError(retryAfterSeconds)` after §8.4 |
| code 1, 2, 3, 8, 9, 12 | `AdapterError(message, "backlog", String(code))` |
| status 401 / 403 / 404 / 400 / 429 without a code | `AuthenticationError` / `PermissionError` / `ResourceNotFoundError` / `ValidationError` / `AdapterRateLimitError` |
| other status | `AdapterError(message, "backlog", String(status))` |
| `fetch` rejection, abort, DNS failure; unreadable JSON or binary response body | `NetworkError(message, cause)` |
| response fails the zod schema | `AdapterError(…, "SCHEMA")` |
| credential resolver throws, or resolves a value `backlog-js` refuses at construction | `AuthenticationError` |

Every mapped error sets `error.cause` to a plain
`BacklogApiErrorDetail { status, code?, message, moreInfo?, url }` — never the
`backlog-js` error instance and never the secret-bearing request.

When the body carried a message, that message is on `error.message` as well.
Two of the classes above take none — `ResourceNotFoundError(resourceType,
resourceId)` and `AdapterRateLimitError(retryAfterSeconds)` compose theirs
from the ids and the delay — so a code 6's "No such issue" is appended to what
the class wrote rather than reaching the caller on `cause` alone, where no log
line that prints the error would show it.

### 8.6 Conformance suite

`describeBacklogApiConformance(name, factory)` runs the same behavioural
suite against both implementations (the `backlog-js` one over a fake `fetch`
that returns recorded response shapes and real `X-RateLimit-*` headers).

The factory hands the suite a `BacklogApi` and nothing else, so a guarantee
belongs here only if **both** implementations reach it through ordinary calls.
A guarantee that needs a crafted response — a 429, a body that violates the
schema, an error code no operation produces — belongs to the wrapper's own
tests (§12.2, the **client** row), and the two lists below say which is which.
The split is deliberate rather than a gap: a fault-injection seam on the
factory would make the in-memory implementation assert retries, header
arithmetic and zod validation it does not have — it has no wire, no schema and
no retry — and a conformance suite only one implementation can satisfy is not
a conformance suite.

Guaranteed by the suite, on both implementations:

- issue/project/user/comment fetch and 404 → `ResourceNotFoundError`; a
  comment id from another issue is a 404;
- comment add/edit/delete reflected in the list, and `addComment` accepts
  `notifiedUserId`/`attachmentId`;
- an empty comment body is a `ValidationError` on add and on update, on an
  issue and on a pull request, while a single space is accepted (§4.2
  `stream` posts one for an empty stream);
- updating or deleting a comment written by another user is a
  `PermissionError` that leaves the comment unchanged — on issues, and on
  update for pull requests, which have no delete at all;
- list paging with `count`/`order`/`minId`/`maxId` and exclusive bounds; issue
  list paging with `count`/`offset`;
- a created issue appears with the bot as creator and carries the issue type
  and priority it named, resolved to their names; an `issueTypeId` or
  `priorityId` the space does not have is a `ValidationError`;
- issue types and priorities readable;
- stars carry `presenter` and are removable by star id; deleting a missing
  star is a 404;
- notifications list newest-first with `comment.id`, exclusive `maxId`,
  markable as read;
- an upload returns `{ id, name, size }` with `size` the byte length of the
  file it was given — the only place this interface makes the bytes
  observable, so it is what separates a client that sent the file from one
  that sent an empty part;
- `rateLimit()` reflects the last response's headers per bucket and a
  `GET /issues` call updates `search`, not `read`; `getRateLimit()` reports
  buckets the client has never spent, with `reset` a date read from epoch
  seconds;
- pull requests: a repository and a pull request fetch, and 404 →
  `ResourceNotFoundError`; the list pages with `count`/`offset` and spends
  `read`; comments page with exclusive `minId`/`maxId` and head-cut `count`;
  `addPullRequestComment` accepts `notifiedUserId`/`attachmentId`; a
  one-element window returns exactly the named comment;
  `addStar({ pullRequestCommentId })` stars the pull-request comment and
  `addStar({ commentId })` an issue comment; a notification carries
  `pullRequestComment.id`; a pull-request attachment downloads, carrying as
  many bytes as its listing reported.

Left to the wrapper's tests, because only the wire client has anything to
exercise them against: 429 with a near `reset` retried once and then
succeeding, 429 with a distant `reset` throwing `AdapterRateLimitError`
without waiting, and the retry's timing, jitter and `warn` lines (§8.4); the
codes of the §8.5 table neither fake models — 11, 10 and 1/2/3/8/9/12 — and
the status-only fallbacks; a response that violates the schema becoming
`AdapterError("SCHEMA")` and never a `ZodError`; non-JSON, empty and
unreadable bodies becoming `NetworkError`; the credential resolver's failure
modes; and the shape of the request itself — the key in a header and never in
the query string, one multipart part named `file`, a pull request addressed by
three coordinates.

Unmodelled is not unreachable, and 10 `TooLargeFileError` is the one to keep
apart: an oversized upload produces it against a real space, and neither fake
enforces a size limit, so it is absent from the suite because nothing here
models the limit rather than because no operation reaches it.

Three codes of the §8.5 table are covered on both implementations, and by
operations rather than by synthesised responses: **6** through every
missing-resource call, **7** through the two `ValidationError` refusals above,
**5** through the ownership refusals.

### 8.7 Auth modes

API key (`Backlog-API-Key` header) or OAuth 2.0 bearer token
(`Authorization: Bearer`). Tokens expire after 3600 s and are refreshed by the
caller through the resolver form; the adapter performs no OAuth flow
([Authentication](https://developer.nulab.com/docs/backlog/auth/)). Both
identify the bot **user**; rate limits are per user, not per key.

**Exactly one** of the two per installation. The `BacklogCredentials` union
says so, and says it with an `apiKey?: never` / `accessToken?: never` on its
members, because a union target on its own rejects only a property that
appears in **no** member — `{ apiKey, accessToken }` type-checks clean against
the bare union, since `accessToken` is not excess there, it belongs to the
other member. The port checks the same thing again when it is built, for a
value that reached it through a type assertion: both or neither is a
`ValidationError` naming the host. Both is never a silent preference for the
API key — a deployment that adds an OAuth token means to stop sending its
space's long-lived key, and going on sending it is the one outcome nothing in
the logs would reveal.

## 9. Formatting

### 9.1 Rule selection (D14)

Each project has `textFormattingRule ∈ { "markdown", "backlog" }`
([Get Project](https://developer.nulab.com/docs/backlog/api/2/get-project/)).
`markdown` is GFM; `backlog` is Backlog notation — a different syntax, not a
superset (on one production space 106 of 318 projects used `backlog`, measured
2026-08-26). The adapter keeps
`Map<channelId, { projectKey; textFormattingRule }>` — one entry per channel
holding both fields the single Get Project returns, because a pull request's
web URL needs the `projectKey` and its REST object does not carry one (§7.3):

- Populated by the first outbound/inbound operation on a channel (one Get
  Project) and by `fetchChannelInfo`, which **replaces** the entry.
- ⚑ Default policy: cache forever; `fetchChannelInfo(channelId)` is the
  documented way to pick up a changed project setting without a restart.
- Lookup failure (`PermissionError`, `NetworkError`, …) → `warn`
  `textFormattingRule lookup failed; assuming markdown` and Markdown for that
  call only; nothing is cached.
- A `textFormattingRule` that is neither of the two documented values is
  Markdown as well, so the two ways one can arrive agree.
  `src/client/schemas.ts` validates the field against a closed enum, so a rule
  Backlog adds later arrives as a lookup failure and takes the row above;
  widening that enum without teaching the converters the new rule must land on
  Markdown too, never on Backlog notation.
- `renderFormatted(content, target?)` and `parseMessage(raw)` are synchronous
  and consult only the cache; uncached → Markdown plus one `warn`. The webhook
  factory awaits the lookup before calling `parseMessage`, so the webhook path
  always honours the rule.

### 9.2 Fallback

Every converter the adapter uses is wrapped: if `toAst(text)` throws, log
`warn` `format conversion failed; falling back to plain text` `{host, projectId}`
and return `root([paragraph([text(raw)])])` so the message is delivered with
`text` intact. `fromAst` failures propagate (a post that cannot be rendered
must fail, not silently post garbage).

### 9.3 Markdown projects

`BacklogMarkdownConverter extends BaseFormatConverter`: `toAst = parseMarkdown`
(remark + GFM from `chat`), `fromAst = stringifyMarkdown(ast).trim()`;
`renderPostable` passes `string` and `{ raw }` through untouched and renders
`{ markdown }` verbatim (no round trip, so no escaping churn).

It overrides `cardChildToFallbackText` for the two children the card walk this
code reaches answers with nothing — a `link` becomes `[label](url)`, or the
bare URL when the label is empty or equal to it, and a `divider` becomes
`---`. Both are written directly rather than through `stringifyMarkdown`,
which emits a thematic break as `***`.

`---` is chosen over the safer `***` on purpose, and it is the one place in
this spec where a worse rendering is preferred: `---` is byte-for-byte what
`@chat-adapter/shared`'s card walk produced before cards were routed through
the project's converter, so keeping it means the Markdown rule's card output
does not change at all. `***` would be a second, unrequested behaviour change
riding along with a bug fix. The cost is the setext collapse described in
§6.1 step 2, which `---` in that position already caused before this change.
Everything else about a card is already GFM, so it stays with the base walk.

### 9.4 Backlog-notation projects, outbound (`fromAst`)

| mdast node | Backlog notation |
| --- | --- |
| `heading` depth n | `*` × n, space, inline content |
| `paragraph` | inline children, blank line between blocks |
| `text` | value, with notation markers left unescaped (§9.7) |
| `strong` | `''…''` |
| `emphasis` | `'''…'''` |
| `delete` | `%%…%%` |
| `inlineCode` | value unchanged (no inline code in Backlog notation — lossy) |
| `code` | `{code:lang}` / `{code}` … `{/code}` |
| `link` | `[[url]]` when label empty or equals url, else `[[label>url]]` |
| `image` | `#image(url)` |
| `break` | `&br;` |
| `thematicBreak` | `----` |
| `blockquote` | each line prefixed `> ` |
| `list` | `-` × depth (unordered) or `+` × depth (ordered), nested lists recurse |
| `table` | `\|cell\|cell\|` per row, header row suffixed `h`; alignment dropped (lossy) |
| `html`, `footnote*`, others | `defaultNodeToText` |

A card's fallback text is not built from mdast, but the markup in it follows
the rows above: `BacklogNotationConverter` overrides
`cardToFallbackText`/`cardChildToFallbackText` so a card's title and field
labels come out `''…''`, its `link` children `[[label>url]]` and its `divider`
children `----` (§6.1 step 2). Two different reasons sit behind that one
override. Bold, because the base converter's `**` is Markdown and would reach
a `backlog` project as literal asterisks, and the marker cannot be passed in as
an argument — `@chat-adapter/shared`'s `cardToFallbackText` types `boldFormat`
as `"*" | "**"`. Link and divider, because the walk `renderPostable`
reaches has no case for either and returns nothing, which loses a URL rather
than mis-rendering it; that half is not notation-specific, so the Markdown
converter overrides the same member. Neither escapes what it wraps: a title holding `''` or a trailing
`'` is emitted as written, which is the class of limit §9.7 covers.

### 9.5 Backlog-notation projects, inbound (`toAst`)

Line-based translation to mdast (via Markdown as an intermediate is
acceptable), covering: `{code}`/`{code:lang}` … `{/code}` including a pair on
one line and an unclosed block closed at EOF (contents not inline-converted);
`{quote}` … `{/quote}` and `> ` lines → `blockquote`; `*`–`******` headings;
`+`/`-` lists with depth by repetition; `----` → `thematicBreak`; tables
`|a|b|h` (header row) and `|~cell` (header cell) → `table`; `#image(...)` →
`image`; inline `'''x'''`, `''x''`, `%%x%%`, `[[label>url]]`, `[[label:url]]`,
`[[url]]`, `&br;`. Not converted (left as text): `&color(...)`, `#rev`,
`#contents`, `#attach`, `#thumbnail`, wiki links, issue-key auto-links.

"Repeat the marker" is the whole of the upstream syntax, so one rule settles
what a run of markers becomes: **a list ends at the first marker it cannot
contain** — one shallower than its own depth, or one of the other kind at that
depth — and the next list starts there. So `--- deep` then `- shallow` is two
lists rather than one item lost; `-- indented` then `- back` is two lists
rather than one list of two items, because those markers sit at different
depths; and `+ a` then `- b` is an ordered list followed by an unordered one,
never one list whose `ordered` the last marker decided. A jump of more than one
level opens a single nested list, and a marker between two open depths becomes
a second child list of the same item.

A marker with **no text after it is not a list item at all**. `-` followed by
one space ends the list and stays a paragraph, exactly as the bare `-` — which
has no whitespace for the marker rule to match — already did. `----` followed
by one space is the `thematicBreak` its unspaced form is, because `----` is
tested ahead of the list rule and a line's classification does not depend on
whether a list is open above it. Trailing whitespace therefore never decides
whether a line is a **list item**; it survives only inside paragraph text. The
rule is about the missing text and not about `----`, so `---- four` is still a
list item.

That is a rule about list items and nothing wider. A heading marker does not
share it: `*` followed by one space is a `heading` with no content where `*`
alone is a paragraph, so a trailing space does decide that line's block. This
section neither relies on that asymmetry nor settles whether headings should
follow the list rule — changing it means changing `matchHeading` and its tests.

The separator between a marker and its text is a run of whitespace taken
greedily, so an item's text never begins with whitespace: `-   one` is the item
`one`, and `-` followed by three spaces has no text either and is a paragraph.
An empty marker ends the whole run rather than its own depth alone — a `--`
with no text between two `-- x` items ends the list above it as well, and the
next marker opens a list of its own — because that line is not a list item and
every list open above it ends at the first line that is not one.

### 9.6 Known lossy conversions

Inline code and table alignment outbound to notation; colour, revision links,
TOC and attachment macros inbound; the summary of a created issue is always
plain text. Documented in README under "Limitations".

### 9.7 Notation projects: user text reaches Backlog unescaped

Backlog notation **does** have an escape. A `\` written before a special
character outputs that character literally, and `\\` outputs one `\`:
`\%\%Not Striked\%\%` renders as `%%Not Striked%%`, and `\\Homehogehoge2`
renders as `\Homehogehoge2`. One backslash escapes one character, so a
two-character marker needs two of them. Markdown projects carry the same
escape. (Backlog user guide, "特殊な文字のエスケープ" — notation
<https://backlog.com/ja/enterprise-help/userguide/userguide1862/>, Markdown
<https://backlog.com/ja/enterprise-help/userguide/userguide1865/>; read
2026-09-08. Cite the `ja` pages: the English paths for both are 404.)

The guide names the escape character as `\` glossed with a yen sign —
`「\(¥¥)」を特殊な文字の前に書くことで` on the notation page, `(¥)」を…` on the
Markdown one. That gloss is the ordinary Japanese way of writing "backslash,
the key printed ¥ on a JIS keyboard", and U+005C is what a JIS font draws as
`¥`. Whether Backlog *also* accepts a literal yen sign — half-width U+00A5 or
full-width U+FFE5 — as an escape character is a different question, and it is
unmeasured (unknown 5 below). It is not an academic one: `¥100` is ordinary
Japanese prose, and either answer has a cost.

One caveat about the Markdown page itself: Backlog's CMS has eaten its
backslashes. `userguide1865` prints its first example with input
`*Not Striked*` and result `*Not Striked*` — identical, because the input
should read `\*Not Striked\*` — and its lead sentence has lost the opening
`「\`, leaving `(¥)」を…`. The rule and the `\\` → `\` row survive intact, and
that is all "Markdown projects carry the same escape" rests on; the first
example is evidence of nothing. `userguide1862` is undamaged.

`fromAst` does not apply the escape. §9.4's `text` row emits the node's value
unchanged, so whatever notation markers a caller's prose happens to contain are
markup by the time Backlog renders the comment:

| A `text` node containing | would render as |
| --- | --- |
| `price is ''100'' before tax` | `100` in bold, the quotes gone |
| `50%% off, %%today only` | `off, ` struck through |
| `'''do not ship'''` | `do not ship` in italics |
| `see [[TICKET-1]] first` | `TICKET-1` as a link |
| `* required` opening a line | an H1 heading |
| `- one` opening a line | a list item |
| `{code}` alone on a line | an open code macro that swallows what follows |

**The right-hand column is inferred from §9.4, not observed.** Every row was
round-tripped through this package's converter, so the notation that reaches
Backlog is exactly what the left column says; how Backlog then draws it follows
from the syntax the guide documents and was not measured against a live space.

Backslashes a caller already holds are a second hazard, and a less determinate
one. `\\` collapsing to a single `\` is documented, so a Windows UNC path such
as `\\server\share` arrives one character short. What becomes of the surviving
`\s` is unknown 2 below, so the rest of that string is not settled either.

Generated text is the realistic trigger rather than a contrived one: a model
that writes `50%%` or quotes a value as `''100''` decorates a comment nobody
asked to decorate.

This is recorded as a limitation instead of fixed because the fix needs
measurements this repository does not have. The user guide demonstrates the
escape for `%` and `\` only, and five things it does not state each change what
a correct implementation would emit:

1. Which characters `\` actually escapes. `'`, `[`, `*`, `{`, `|`, `>`, `-` and
   `+` are all load-bearing in §9.4's table and none of them is documented as
   escapable.
2. What a `\` before an ordinary character does — dropped, or kept. This decides
   the whole shape of the fix: escaping too widely eats a caller's own
   backslashes, escaping too narrowly lets markers through.
3. Whether the escape reaches the line-anchored block constructs (`\*` heading,
   `\-` list, `\|` table row, `\{code\}`) or only inline markers.
4. What `toAst` owes a `\` a human typed. §9.5 carries it through as literal
   text today, so an escaped comment read back out of Backlog shows its
   backslashes in the Markdown a handler sees.
5. Whether a literal `¥` (U+00A5 or U+FFE5) escapes, as the guide's gloss can be
   read to promise. If it does, `¥100` in a Japanese sentence is already being
   mangled today and an implementation has to escape the yen sign as well; if it
   does not, escaping it would corrupt every price a comment mentions. The two
   answers demand opposite code, so this one is measured before either.

Escaping is therefore not inferred from the documentation; the set has to be
measured against a real space first. Until it is, a caller who needs a literal
marker has `postMessage`'s `{ raw }` postable, which bypasses the converter
(§9.4 is not consulted) and reaches Backlog verbatim, so the caller can apply
`\` itself.

## 10. Observability and logging

- All logging goes through the `Logger` from `chat` (`debug`, `info`, `warn`,
  `error`); `console.log` is a lint error, and `console.warn/error` are not
  used either so consumers control sinks and levels.
- Levels: `debug` for per-request flow (self-message skip, success);
  `info` for ignored activity types and "not found, giving up" outcomes;
  `warn` for rejected webhooks, degraded formatting, cache misses that fell
  back, and the two rate-limit outcomes of §8.4; `error` for processing failures after 200 was returned (the only
  carrier of that failure) and for a webhook received before `initialize`.
- Structured fields only: `host`, `projectId`, `repositoryId`, `type`,
  `commentId`, `messageId`, `threadId`, `target`, `reason`, `bucket`,
  `remaining`, `resetAt`, `waitMs`, `attempt`, and `error` (a caught error's
  `message`, never the object). A subject is identified by `threadId` or `messageId`, which carry
  its kind, so no field names an issue or pull request on its own. Never the
  raw body, comment text, tokens, API keys, `Authorization` values or the full
  request URL (it carries `?token=`).
- Messages are English, one line, stable strings (tests assert on them).

## 11. Security

- **Secrets never leave the process.** API keys travel in the
  `Backlog-API-Key` header, tokens in `Authorization`; never in a query string.
  Thrown errors and logs carry `BacklogApiErrorDetail.url` with the query
  string stripped.
- **Webhook authenticity** (D2): every installation has a `webhookSecret` or a
  `webhookVerifier` exists, enforced at construction. A secret shorter than 16
  bytes is a construction-time `ValidationError` — it is the whole of the
  check, so a guessable one is a way in, and config resolution has no logger to
  warn into. The secret is compared with `crypto.timingSafeEqual` after a
  length check. Backlog offers no HMAC
  ([Add Webhook](https://developer.nulab.com/docs/backlog/api/2/add-webhook/)
  accepts only `name`, `description`, `hookUrl`, `allEvent`,
  `activityTypeIds[]`), so the secret in `?token=` is the strongest available
  check; README states this plainly and lists IP allowlisting and Basic auth
  in the hook URL as deployment-level additions pluggable through
  `webhookVerifier`.
- **No host enumeration**: unknown or missing host, missing or wrong token,
  and a failing verifier all produce the same 401 body.
- **A misregistered `?host=` is authentic** (D19): a payload from space B sent
  to space A's hook URL with space A's own secret passes every check on the
  ladder, because nothing in a Backlog body identifies its space (measured,
  `.claude/rules/backlog-webhook-facts.md`). The receiver then addresses space
  B's ids with space A's credentials, and cross-space ids are not reliably
  absent from one another (measured 2026-09-06: two spaces minting issue ids
  from interleaving ranges), so the outcome ranges from a 404 to a comment on
  an unrelated issue in space A. The registered URL is the only control;
  README states it where the URL is registered.
- **SSRF**: the only outbound URLs the adapter constructs are
  `https://<configured host>/api/v2/...`; `rehydrateAttachment` refuses URLs on
  any other host. HTTPS is always used; no redirects are followed for
  downloads.
- **Body size**: bounded by `maxWebhookBodyBytes` (description edits can carry
  two full bodies). With no verifier configured, the body is not read until the
  token has matched (§5.1), so an unauthenticated caller cannot make the
  process buffer it. A verifier-protected deployment has to buffer first — the
  verifier is given the body — and bounds the exposure with
  `maxWebhookBodyBytes` alone; a deployment that cannot accept that puts the
  check in front of the function (a reverse proxy, an IP allowlist) instead.
- **Webhook URL hygiene**: README instructs registering
  `activityTypeIds: [1, 2, 3, 14, 18, 19, 20]` (plus 4 if deletion events are
  wanted; 21 was not observed and is not registered, D-PR5), never `allEvent`
  (D10), so unrelated project activity never reaches the endpoint. A
  deployment that wants issues only registers issue types only — that
  subscription is the switch, and the adapter has no option duplicating it
  (D-PR4). 14 is the one type whose delivery is not one message: a bulk update
  of N issues dispatches N times (D22), so a deployment whose handler calls the
  API per message leaves 14 unregistered rather than reaching for a setting.

## 12. Testing specification

`pnpm test` runs on Node 20/22/24/26 with no credentials and no network.
Tests are colocated `src/**/*.test.ts`, named after the behaviour they specify.

### 12.1 Contract suites from `@chat-adapter/tests@4.39.0`

| Suite | What this adapter provides |
| --- | --- |
| `threadIdContract` | `encode`/`decode` bound to an instance; cases for `.backlog.com`, `.backlog.jp`, `.backlogtool.com` hosts with pinned encoded strings; `isDM` split omitted (always false) or asserted false for every case. |
| `selfMessageContract` | `setup()` builds an adapter with the in-memory port and `botUserId: 999`, `createMockChatInstance()`; `makeOtherMessageRequest` = fixture type-3 comment by `Alice` with `?host=&token=`; `makeSelfMessageRequest` = same comment by `createdUser.id === 999`. Expects 200 + dispatched vs 200 + not dispatched. |
| `connectWebhookContract` | `createAdapter({ webhookVerifier })` with installations lacking `webhookSecret`; `makeWebhookRequest` includes `?host=`; `createAdapterWithSecretAndVerifier` proves the verifier wins. |

Matchers from `@chat-adapter/tests/matchers` (`toHavePosted`,
`toHaveDispatched`, `toBeSubscribedTo`, …) are registered via
`setupFiles: ["@chat-adapter/tests/setup"]`.

### 12.2 Unit and integration coverage (minimum)

- **ids**: every grammar row round-trips; every rejection rule in §2.2 has a
  case; `created` containing `:` survives `u:` round trip; user id splits on
  the last `:`.
- **config**: shape A from explicit fields, from env, mixed; each missing
  field names its env var; empty-string field is an error; shape A + B →
  error; duplicate hosts; host with scheme/port/path; `botUserId` non-integer
  env; no secret and no verifier → error; resolver functions invoked per call
  and not cached; `userName` default; `botUserName(host)` per installation,
  unchanged by a `userName` override, unknown host → `ResourceNotFoundError`.
- **webhook**: one test per ladder row in §5.1 (405, 400 unreadable, 413, 401
  verifier false/throw/`undefined`/truthy non-boolean, 401 unknown host, 401
  missing host with two
  installations, 200 missing host with one installation, 401 missing/wrong
  token, 400 invalid JSON, 400 no type, 200 ignored 14/17/99, 400 schema, 503
  uninitialised, 200 self, 200 dispatched); identical 401 bodies; both
  orders of §5.1 rows 2/4/5 (with no verifier, an oversized body with a wrong
  token or an unknown host is a 401 and `request.bodyUsed` is still `false`;
  with a verifier, the same request is a 413 and the verifier never runs); fixture-driven
  mapping for: type 3 comment, type 1 with and without bot assignee, type 2
  status change, type 2 assignee change (`content: null`), type 2 description
  edit, type 2 attachment add via changelog comment, type 2 without comment
  (`:u:`), type 3 with attachments, type 4 deletion, comment+status in one
  event; unknown keys preserved in `raw.payload`; a `notifications[]` that is
  absent or in a shape the schema replaces still dispatches, on an issue
  **and** a pull-request type, with detection falling back to the text and to
  `changes[]`; a `raw.payload` that does not parse → `ValidationError` instead
  of a message; `isMention` for every §5.4 rule including the negative cases;
  same payload to two hosts yields two threads and two distinct message ids;
  processing runs after the 200 and a throwing factory is logged, not thrown.
- **parseMessage**: each of the five §3.5 variants; a `webhook` payload that
  does not parse, a type 4 or 14 `webhook` payload, a `bulkUpdate` naming an
  issue the delivery does not cover and one whose payload is not type 14 all
  → `ValidationError`; an unconfigured host → `ResourceNotFoundError`; and the
  round trip on each of the three the adapter produces — a comment and an
  issue root from `fetchMessages`, a pull-request root from `fetchMessage`,
  the comment `postMessage` returned and the issue `postChannelMessage`
  created — asserted over `id`, `threadId`, `text`, `formatted`, `author`,
  `metadata.dateSent`, `metadata.edited` and `raw` at once, plus the one
  documented loss (an issue comment's `attachments`).
- **format**: every row of §9.4 and §9.5; single-line `{code}x{/code}`;
  unclosed `{code}`; unclosed `{quote}`; a list whose first marker is the
  deepest, a marker changing kind mid-run, a depth jump, a marker between two
  open depths, a marker with no text — at the outer depth, nested, and
  separated by several spaces — a `----` adjacent to a list with and without a
  trailing space, and a CRLF line ending; an unterminated
  `''`/`'''`/`%%`/`[[`; a `|` inside a table cell's link; a `text` node whose
  own value holds notation markers, emitted unescaped per §9.7; `toAst`
  throwing →
  plain paragraph + warn; rule cache primed by webhook path, replaced by
  `fetchChannelInfo`, lookup failure not cached; `renderFormatted`/
  `parseMessage` honour a cached `backlog` rule and warn when uncached; a card
  fallback under **both** rules over a card carrying **every** member of
  `CardChild` (`text`, `image`, `divider`, `actions`, `section`, `fields`,
  `link`, `table`, `chart`), with `image` asserted to render as nothing on
  purpose — a fixture short of one member cannot catch that child being
  dropped, which is how `link` and `divider` went missing once already.
- **egress**: `postMessage` markdown/raw/card/files/`notifiedUserId`; a card
  posted under **both** formatting rules (asterisks on `markdown`, `''` and no
  asterisk on `backlog`), a caller's `fallbackText` posted verbatim, and its
  first line stripped of a leading list or heading marker when it becomes a
  summary; mistyped extra → `ValidationError`; an `ArrayBuffer` and a `Blob`
  upload like a `Buffer`; unsupported `file.data` → `ValidationError` named
  `backlog` with that file not uploaded; `editMessage` with files → error;
  `:r`/`:u:` rejected for edit/delete/star; `stream` buffers into one comment
  and never calls `editMessage`, returns on abort even from a source that has
  stopped producing (driven by a controllable iterator, not a timeout) and
  leaves no listener on the signal; reactions add (idempotent), remove own only,
  no-op without a star; `postChannelMessage` summary/description split,
  plain-text summary, defaults, explicit ids, single retry on code 7 with
  refreshed defaults, no retry otherwise, empty summary error.
- **reads**: §7.1 guarantees as a property-style sweep over
  `(limit ∈ {1,2,3,5,50,100}) × (comments ∈ {0,1,4,7,150}) × direction`
  asserting page size, chronology, union-once and `nextCursor` values;
  cursor validation; channel id → `ValidationError`; `fetchMessage`
  cross-thread/`:u:`/404 → `null`, and without resolving the converter;
  `fetchMessages` and `fetchMessage` both set `formatted` through the
  project's rule; `fetchThread`, `fetchSubject`,
  `fetchChannelInfo`, `listThreads` (offset, trailing empty page, clamp),
  `getUser` (round trip, bot, bare number rejected, null on 404),
  `markAsRead` (first page, third page, cap reached, already read, `:r`).
- **client**: §8.6 conformance over both implementations; bucket classifier
  for every port method; header capture on success and on error; retry timing
  with fake timers; one `warn` per rate-limit wait and per refusal to wait,
  none on an unlimited request, and the logger resolved per request; every row
  of §8.5; `cause` shape; no `ZodError`; resolver errors →
  `AuthenticationError`, and so is a resolved credential containing CR/LF,
  which reaches no request at all; a 2xx non-JSON or empty body, a binary body
  read failure, and a stalled body stream all stay inside the mapped
  error/timeout boundary, the stalled-stream case on the error path as well as
  the success path; an error body without an `errors[]` array still maps
  by status and records its headers; past reset has a one-second floor, empty
  reset is missing, retry jitter stays in `[0, 250)` ms under an injected
  random source; query string stripped from `cause.url`. The client
  `client(host)` hands out is held to the same list where it can be: a call
  through it lands in the port's own snapshot, an issue list through it spends
  `search`, its credential is resolved per call and never reaches the URL, a
  CR/LF credential is an `AuthenticationError`, a failure is a
  `@chat-adapter/shared` error rather than a `backlog-js` one, and a 429 is
  retried once and then given up as `AdapterRateLimitError`.
- **wiring**: real `Chat` + memory state: mention → `onNewMention` →
  `thread.post` → comment; redelivery within TTL deduped; subscribed follow-up
  → `onSubscribedMessage`; bot's own comment not delivered; assignment to the
  bot delivers as a mention; a status-change changelog comment reaches a
  subscribed handler with `raw.changes`.
- **entry point**: `createBacklogAdapter` and `BacklogAdapter` exported;
  `adapter.name === "backlog"`; absent optional members are `undefined`; the
  hand-written `BacklogWebhookPayload` and `BacklogBulkUpdatePayload` are
  identical to their schemas' inferred types **in both directions**
  (`src/webhook/payload.test.ts`, checked by `pnpm typecheck`), and the built
  `dist/index.d.ts` imports nothing but `chat`
  (`scripts/check-published-types.mjs`, run by `pnpm build`).
- **pull requests** (each mirroring an issue-side test through the same
  table-driven suites where one exists): thread ids round-trip for both kinds
  with pinned encodings; every §2.2 rejection for the `pr:` keyword; type 18,
  19 (comment / no comment / status / assignee / summary+description+issue)
  and 20 (plain / with attachment) fixture rows; 12, 13 and 21 ignored; a
  type-18 body without `content.repository.id` is a 400; a linked issue does
  not change the thread id; `<@U<botUserId>>` in a type-18 summary is a
  mention; a reply on a pull-request thread is one `addPullRequestComment`;
  `deleteMessage` on a pull-request thread fails before any call; stars use
  `pullRequestCommentId`; the §7.1 sweep passes for pull-request threads;
  `fetchMessage(:c)` uses a one-element window and is `null` on an empty page;
  `fetchThread`/`fetchSubject` carry `kind`/`type` for both kinds and omit
  `url` when a name lookup fails; the repository name from a webhook spares
  the next `fetchThread` a Get Git Repository; `markAsRead` matches
  `pullRequestComment.id` and ignores an issue notification with the same
  numeric id; `rehydrateAttachment` accepts both URL shapes; a dispatch on a
  subject's kind exists only in `src/subject/client.ts` and the id codec
  `src/ids.ts` (`src/subject/containment.test.ts` greps `src/` for the line
  shapes its header enumerates and fails on a third module — a tripwire over
  the shapes a dispatch is written in, not a proof that none exists).

### 12.3 Opt-in live suite

`describe.skipIf(!(process.env.BACKLOG_HOST && process.env.BACKLOG_API_KEY && process.env.BACKLOG_LIVE_ISSUE_ID))`
⚑; sequential; at most ~10 update-bucket calls: Get Project, Get Issue, add →
edit → star → unstar → delete one comment, upload one small attachment and
attach it, then delete that comment; assert `rateLimit(host)` shows `read` and
`update` buckets populated. Never creates issues or touches notifications.

A second section, behind `BACKLOG_LIVE_PULL_REQUEST=<repositoryId>:<number>`,
does the same against a scratch pull request minus the deletes (there is no
delete): Get Git Repository, Get Pull Request, add → edit → star → unstar one
comment, attach one upload; at most ~8 update-bucket calls. The comments it
adds stay on the pull request, so the variable must name a scratch one. It also
needs `BACKLOG_LIVE_ISSUE_ID`, and the pull request has to live in that issue's
project: every pull-request endpoint is keyed by project + repository + number,
the variable carries only the last two, and neither Backlog nor the port maps a
repository id back to its project, so the project comes from one Get Issue in
`beforeAll`. A third variable would be the alternative; naming the project twice
for one scratch space is worse than requiring the two to share it.

## 13. Documentation deliverables

- **README.md**, following Chat SDK's publishing checklist order: title and
  one-line description; an npm-version badge and a license badge; a **Status**
  section stating the release cadence and pre-1.0 semver (`0.1.0` first, a
  breaking change is a minor while the major is `0`), the contract coverage of
  §4, and the catalog-listing choice
  ([docs/plans/adapter-implementation.md](../plans/adapter-implementation.md)
  P7); installation (`pnpm add @nulab/chat-adapter-backlog chat`);
  quick start (shape A with explicit fields); environment-variable table (the
  six `BACKLOG_*` variables, required/optional); configuration reference (§3.2
  table); platform setup (create bot user, add to project, issue API key,
  register webhook `https://<app>/api/webhooks/backlog?host=<host>&token=<secret>`
  with `activityTypeIds` 1, 2, 3, 14, 18, 19, 20 (+4), never `allEvent`, and 21 in
  neither list because it was never observed (D-PR5); a project whose pull
  requests should not reach Chat omits 18–20 — that subscription is the only
  switch, the adapter has no option duplicating it (D-PR4); where to find the
  bot's numeric id); features and limitations (§4 as a matrix, D18 "comment
  edits fire no webhook", and one row per pull-request limitation, each naming
  the decision or the measurement behind it: pull-request comments cannot be
  deleted (D-PR3 — the route answers 400 code 6 `Undefined resource`, measured
  2026-09-06), `listThreads` lists issues only (D-PR7 — a pull-request list is
  per repository, a coordinate a channel id does not carry), pull requests
  cannot be created, closed or merged from Chat (no status API: `statusId` on
  Update Pull Request is `error.unknownParameter`, measured 2026-09-06), a
  pull request linked to an issue is still its own thread (D-PR6), a git
  repository is not a channel (D-PR1); plus weaker webhook authenticity,
  durable state adapter recommendation, `streamingUpdateIntervalMs` irrelevant
  because `stream` is buffered, `chat.getUser` vs `adapter.getUser`, read
  receipts are not automatic, `recentMessages` vs `messages` cost); id formats
  for **both** kinds (§2), including that a pull-request thread id carries the
  repository id and the per-repository number and never the global
  pull-request id; mentions (§5.4); issue creation (§6.7); stars (`commentId`
  or `pullRequestCommentId`); read receipts; history paging (§7.1);
  `message.subject.type` being `"issue"` or `"pull_request"` (D-PR8); raw API
  and errors (§3.6, §8.5), with `api(host).listPullRequests` named as the route
  to a repository's pull requests, `client(host)` named as the `backlog-js`
  client for the endpoints the port does not — carrying the same buckets, retry
  and errors, and throwing `NO_CLIENT` under a custom `createApi` — and the 429
  retry stated as a wait of up to `rateLimit.maxWaitMs` that blocks the call —
  so a serverless deployment must allow more execution time than `maxWaitMs` or
  lower it and handle `AdapterRateLimitError` itself, with the two `warn` lines
  named as how the wait becomes visible; testing with
  `createInMemoryBacklogApi`, with `createApi` in the configuration table
  because that section passes it; license.
  Every link into this repository is absolute
  (`https://github.com/nulab/chat-adapter-backlog/blob/main/…` for a file,
  `/tree/main/…` for a directory), never `./file`: README.md ships in the
  tarball whatever `files` lists, and npmjs.com resolves no relative path
  (#66).
- **`sample-messages.md`** in the package root with anonymised payloads for
  every §5.3 row, issue **and** pull request — 18, 19 (comment, status,
  assignee, summary), 20 (plain and with an attachment) and the ignored 21 and
  12 — generated from `src/test/fixtures/webhooks.ts` so the file and the suite
  cannot disagree (`sample-messages.test.ts` fails otherwise). Vocabulary: host
  `example.backlog.com`, bot `Chatbot` (999), users `Alice` (100) and `Bob`
  (101), project 500, issue 8001, repository 700 (`example-repo`), pull request
  12. The pull-request payloads are the **webhook** form, which the fixtures
  model since it was measured (2026-09-06): the activity API form plus
  `assignee`, `base`, `branch` and `diff`
  (`.claude/rules/backlog-pull-request-facts.md`).
- **DEVELOPMENT.md**: credentials table gains `BACKLOG_BOT_USER_ID`,
  `BACKLOG_BOT_USER_NAME`, `BACKLOG_WEBHOOK_SECRET`, `BACKLOG_ACCESS_TOKEN`,
  `BACKLOG_LIVE_ISSUE_ID`; `.env.example` likewise; live-suite section names
  the exact calls it makes.
- **CLAUDE.md**: "State of the repo" rewritten once the placeholder is gone;
  the layout paragraph naming `src/subject/*` and saying that kind-specific
  behaviour lives there and nowhere else, with the two-module containment rule
  (`src/subject/client.ts` and `src/ids.ts`,
  `src/subject/containment.test.ts` failing on a third for the shapes it can
  see); the raw-versus-domain paragraph pointing at `src/index.ts`'s header
  rather than restating it; the smoke-test paragraph updated to the new
  assertion.
- **CI smoke tests** (`ci.yml`), two jobs against two different artifacts. The
  `build` job asserts `typeof m.createBacklogAdapter === "function"` and
  `new m.BacklogAdapter({...minimal config...}).name === "backlog"` against
  `./dist/index.js` on the pinned runtime, so a bundle tsdown emitted but
  cannot load fails the job that produced it. The `consumer` job packs the
  tarball, installs it with npm into a directory outside the repository and
  runs `scripts/consumer-smoke/smoke.mjs` on Node 20 — the floor of
  `engines.node` — asserting the published surface a path import never
  consults: the entry resolves through `exports` inside the consumer's
  `node_modules`, the installed tree is exactly `dist/`, `package.json`,
  `README.md` and `LICENSE`, `exports["."].types` names a file that shipped,
  and `createBacklogAdapter()` with **no** argument builds an adapter whose
  `name` is `"backlog"` and whose `userName` came from `BACKLOG_BOT_USER_NAME`
  (§3.2's env fallbacks, end to end). `globalThis.fetch` is replaced with a
  throw first, so "construction reaches no network" is asserted rather than
  assumed. The same job then compiles `scripts/consumer-smoke/documented-usage.ts`
  — the usage the README documents, strict under `NodeNext` — with
  `tsc --noEmit` against the installed declarations, and runs each
  `examples/*`'s own type check with its adapter dependency pointed at the
  same tarball.
- **Feature matrix** for a future catalog listing (values per Chat SDK's
  `features` keys). Every value holds for issue **and** pull-request threads
  unless its note says otherwise, and each `partial` names the decision behind
  it: `postMessage yes`, `editMessage yes`,
  `deleteMessage {partial, "Issue comments only"}` (D-PR3),
  `fileUploads yes`, `streaming {partial, "Buffered"}`, `scheduledMessages no`,
  `cardFormat {partial, "Fallback text"}`, `buttons no`, `linkButtons no`,
  `selectMenus no`, `tables {partial, "Text"}`, `fields {partial, "Text"}`,
  `imagesInCards no`, `modals no`, `slashCommands no`, `mentions yes`,
  `addReactions {partial, "Star"}`, `removeReactions {partial, "Own star"}`,
  `typingIndicator no`, `messageUpdatedEvents no`,
  `messageDeletedEvents {partial, "Issue deleted; a pull request cannot be deleted"}`
  (type 4 is dispatched; type 21 was never observed and no delete operation
  exists in the UI or the API, D-PR5), `directMessages no`,
  `ephemeralMessages no`, `userLookup yes`,
  `parentSubject {yes, "issue or pull_request"}` (D-PR8),
  `nativeClient yes`, `customApiEndpoint yes`, `fetchMessages yes`,
  `fetchSingleMessage yes`, `fetchThreadInfo yes`, `fetchChannelMessages no`,
  `listThreads {partial, "Issues only"}` (D-PR7), `fetchChannelInfo yes`,
  `postChannelMessage {yes, "Creates an issue"}` — a pull request cannot be
  created from Chat either (`base`/`branch` have no postable shape,
  docs/plans/pull-request-support.md §9). `deleteMessage` appears once, as the
  partial above; the issue-only matrix's `deleteMessage yes` is gone, not kept
  beside it.

## 14. Design decisions and rejected alternatives

| # | Decision | Why | Rejected |
| --- | --- | --- | --- |
| D1 ⚑ | Shape A (single space, env fallbacks) **and** shape B (`installations[]`), always a host-keyed map inside | Zero-config construction is the Chat SDK factory convention and what the catalog's `env` spec assumes; several spaces in one process is a real deployment shape and the payload cannot identify a space. | Installations-only (fails zero-config); env-only (cannot do multi-space). |
| D2 | Authenticity mandatory: secret per installation or global verifier; 401 on any failure; unknown host is also 401 | Backlog has no HMAC; a shared secret in the URL is the only sender-side control, and skipping verification "because Backlog cannot sign" is exactly the anti-pattern CLAUDE.md forbids. Same body for every failure avoids host enumeration. | Optional secret (silently insecure default); 404 for unknown host (leaks configuration). |
| D3 | `?host=` required only with >1 installation | The path is fixed by Chat SDK routing (`/api/webhooks/backlog`), so the discriminator must be a query parameter; forcing it for one space is needless friction. | Path segment (framework-dependent); inferring from `project.id` (ids collide across spaces). |
| D4 | `stream()` buffers and posts once | The core's 500 ms edit loop is ~120 update calls per minute against a documented example limit of 150. | Omitting `stream` (falls into that loop); throttled edits (still wasteful, and a comment edit emits no webhook anyway). |
| D5 | Bucket classification, header capture per (host, bucket), bounded retry on 429/13, `rateLimit(host)` snapshot | Limits differ per plan and are per user; only headers tell the truth. `backlog-js` swallows headers, so the port must own the HTTP boundary. One bounded retry converts most transient 429s into success without hiding sustained exhaustion. | Hard-coded 600/150/150/60; unbounded backoff; no retry at all (every 429 becomes a failed reply). |
| D6 | Error class from `errors[].code` first, status second; detail as `cause` | The error-response page maps meaning to codes, not statuses; `cause` keeps `moreInfo` for operators without leaking `backlog-js` types. | Status-only mapping; re-exporting `backlog-js` errors. |
| D7 | No host-application hooks; `api(host)` is the only escape hatch | Engagement/subscription state is the `StateAdapter`'s job; drop prediction depends on private core keys. | Engagement callback, inbound observer, dedupe-key helpers. |
| D8 | Numeric ids everywhere; host inside message and user ids | Issue keys change on project-key rename; the core's dedupe key has no thread component. | Issue keys in thread ids; host-less message ids. |
| D9 | Mention = the bot in the webhook's `notifications[]` (any `reason`), display name in text (left-bounded, case-sensitive), or assignment to the bot | The webhook's `notifications[]` **is** populated (measured 2026-09-06) and is the only signal for a comment addressed through the notification field, which leaves no `@name` in the text; text and assignment still carry every delivery that has no notification, including an activity-API body replayed as a webhook. Assignee changes arrive by display name. Only explicit addressing lands in that list: an account merely **watching** an issue stayed out of `notifications[]` across a comment and two field-only `PATCH`es, while a non-watching user addressed on the same issue arrived with `reason: 2` (measured 2026-09-06), so no `reason` needs excluding. | Text and assignment only (silently ignores the notification field, the UI's normal way to address someone); filtering to `reason: 2` (drops reason codes not measured here for no gain, since assignment is already covered and watching was measured not to notify at all); case-insensitive match (Japanese names have no case, ASCII names would over-match). |
| D10 | Types 1, 2, 3, 14 and 18, 19, 20 processed, 4 optional deletion, rest ignored; register `activityTypeIds`, never `allEvent` | Only issue and pull-request activity maps to a thread; 14 was ignored here until 2026-09-06 on the ground that it "has no per-issue comment", which measurement disproved — `content.link[].comment.id` is a comment that exists (D22); 17 carries the **original** comment, so dispatching it would re-deliver a message id already dispatched; 21 was never observed (D-PR5). | `allEvent` (wiki/git/document noise). Dispatching 17: `dedupe:backlog:<message.id>` suppresses the repeat only for `dedupeTtlMs` (§5.5), and a notification added a day later fires the same comment a second time. The accepted cost is a blind spot — a 17 whose `notifications[]` names the bot is the only signal that the bot was mentioned on a comment **after** it was posted, and acting on it needs a message id that distinguishes the notification from the comment it repeats. The pair was measured on a development space, 2026-09-06: a type 3 naming one recipient and, three seconds later, a type 17 naming another carry different activity ids but the same `content.comment.id`, the same text and an identical `content`, so `content.comment.id` cannot separate them and `notifications[]` — a delta, not the comment's recipient list — is the only field that names what the second delivery added (`.claude/rules/backlog-webhook-facts.md`). |
| D11 | Two-step uploads; inbound `fetchData` through the port; `rehydrateAttachment` via API URL | Backlog attachments require auth to download; a URL is the only serialisable handle that survives queue round trips. | Public URLs (do not exist); `fetchMetadata` blobs. |
| D12 | `:r`/`:u:` cannot be edited, deleted or starred; `fetchMessage(:u:)` is `null` | Backlog can edit an issue body, but `editMessage` semantics ("edit what I posted") do not fit rewriting a human's issue; `:u:` has no fetchable resource. | Mapping `editMessage(:r)` to Update Issue. |
| D13 | Optional set as in §4.2; `listThreads` uses Backlog's default order | Each implemented member has a one-to-one endpoint; each unsupported one has no counterpart. Sorting or filtering in the adapter would hide the search-bucket cost. | "Open issues first" (an extra filter, surprising to callers). |
| D14 ⚑ | Per-project rule, cached forever, refreshed by `fetchChannelInfo`; plain-text fallback; sync members use the cache | Correctness on notation projects is not optional (a third of projects on a measured space); a TTL adds a read per project per interval for a setting that rarely changes. | TTL cache; Markdown-only converter. |
| D15 | `chat` peer `^4.39.0`; `@chat-adapter/shared` dep `^4.39.0`; `backlog-js` `^0.20.1`; `zod` `^4`; `engines.node >=20`. The package is versioned on its own semver line from `0.1.0` (DEVELOPMENT.md "Versioning"). | The docs prescribe the peer range for external packages; the exact pin only works inside Vercel's fixed-version monorepo. `4.39.0` is the version whose contract was verified, so it is the floor of the range. An exact pin would make a consumer on `chat@4.40` install a second copy of the core and fail its `instanceof` checks. | Exact pins (breaks consumers on 4.40). |
| D16 | Layout `src/{adapter,ids,types,index}.ts`, `src/webhook/*`, `src/client/*`, `src/format/*`, `src/test/fixtures/*` | Directories mirror the PR scopes `adapter`/`webhook`/`client`/`format`, so a change's scope is its path. | Flat `src/`. |
| D17 | Measurements live in `.claude/rules/*.md`, referenced here | One place to re-measure; this spec states consequences, not evidence. | Duplicating measurements here. |
| D18 | `processMessageUpdated` unsupported | Comment edits emit no webhook (measured 2026-09-03; pull-request comment edits likewise, 2026-09-06); there is nothing to deliver. | Polling for edits (search-bucket cost, no cursor finer than a day). |
| D19 | The space is taken from `?host=` alone; the payload is **not** cross-checked against it | No body field identifies the space, and the one candidate for a consistency check cannot carry it: `project.projectKey` would have to be compared against the configured host's own project, but `projectCache` holds `projectKey` for the process's lifetime (D14), so after a project-key rename a check that rejected would drop **every** event until a `fetchChannelInfo` refreshed it — trading a misconfiguration nobody has made for silent data loss on a supported operation. A check that only warned would also land inside the dispatched factory, after the 200 (§5.1), so it could never become a 401, and the misregistration already leaves a trace there: `ensureProject` fails on a project the host does not have and logs `textFormattingRule lookup failed`. Naming the trap where the URL is registered beats a heuristic that cannot reject and cannot report. | Rejecting on a `projectKey` mismatch (drops everything after a rename); warning on one (a second meaning for the project lookup, no new information); a `spaceId` config field to compare (no payload field to compare it with). |
| D22 | Type 14 fans out: one delivery becomes one `chat.processMessage` per `content.link[]` entry, always, with no adapter option to turn it off | The comments are real. A bulk update writes a comment per issue with a changelog, `link[].comment.id` is that comment, and `fetchMessages` hands it back — so ignoring 14 makes push and pull disagree in the direction of having missed a status change, silently. The fan-out's cost is real too (one webhook, N threads, and N API calls if a handler makes one per message, out of a per-minute bucket), which is why the way out is leaving 14 out of `activityTypeIds[]`: registration already is the switch (D-PR4), and not subscribing stops the delivery instead of discarding it after arrival. A one-issue batch takes the same path: a single issue updated from the issue list is a type 14 too (measured 2026-09-06), so there is no size at which the fan-out is skipped. The batch's `notifications[]` is carried whole on every message and split between none of them: it holds one reason-1 entry per issue when the batch changed the assignee, but an entry names no issue and repeats the same user, so any per-issue meaning would come from the array's order alone. One delivery carrying several indistinguishable entries is what makes 14 different here; other types carry the array too. | Ignoring 14 (loses events that exist); a `bulkFanout` config flag (duplicates the subscription, and the copy that arrives is still paid for); one summary message into the first issue's thread (invents a message with no id and picks a thread arbitrarily); capping the batch (silently drops the tail of a transaction Backlog reported in full); treating a single-entry `link[]` as a type 2 (a handler would read a different `raw.kind` for the same operation depending on how many issues were ticked); pairing `notifications[i]` with `link[i]` (an ordering guarantee Backlog never gave, wrong the moment a redelivery or a future field reorders either array); dropping `notifications` from `raw.payload` (loses a fact the delivery carried, to prevent a misreading a comment can prevent). |
| D-PR1 | The channel of a pull-request thread is its **project** | Webhooks carry `project.id`; the formatting rule is per project; `channelIdFromThreadId` stays "first three segments". | The repository as channel (N+1 channels per project, no formatting rule of its own). |
| D-PR2 | Kind-explicit ids for **both** kinds; one nested `subject: BacklogSubjectRef` shared by thread ids, message ids, raws and the subject layer | Backlog addresses issues and pull requests through different endpoint families with different coordinates and separate comment id sequences; the GitHub adapter's "PR is the unmarked default" is back-compat debt its maintainers annotate as such. | Flat `{ kind, issueId?, repositoryId?, number? }`; keeping issues unmarked. |
| D-PR3 | `deleteMessage` on a pull-request thread throws `AdapterError(…, "UNSUPPORTED_OPERATION")` before any call | The endpoint does not exist (400/6 `Undefined resource`, measured); `ValidationError` would blame a correct call; silent success is a fabricated result; the member is required. | `ValidationError`; no-op; omitting `deleteMessage`. |
| D-PR4 | No adapter option selecting kinds | The webhook subscription already is that switch; a mismatch between an option and the subscription would silently drop delivered events. | `subjects: ('issue' \| 'pullRequest')[]` config. |
| D-PR5 | Type 21 is 200 Ignored and not in the registration guidance | It was not observed: merge (UI or git push) and close both arrive as type 19 status changes, no delete operation exists in the UI or the API, and the project's activity history holds none (measured 2026-09-06); the docs and `backlog-js` disagree on its very name. | `processMessageDeleted` on 21 (nothing to test it against). |
| D-PR6 | A pull request linked to an issue is its own thread; the link is metadata | The link can be changed (`changes[field="issue"]`, measured); routing by it would move a thread. | Routing pull-request activity into the linked issue's thread. |
| D-PR7 | `listThreads` lists issues only | A pull-request list is per repository, a coordinate the channel id lacks; `api(host).listPullRequests` covers it. | Interleaving every repository's pull requests (N+1 reads, two cursor grammars); listing pull requests only. |
| D-PR8 | `fetchSubject().type` is `"pull_request"` | The `@chat-adapter/github` convention; the core types it as a free string, so bot authors already branch on that literal. | `"pullRequest"` (matches our `kind`, not the ecosystem). |
| D-PR9 | Root part tag `r` for both kinds (was `i`) | `i` meant "issue" and would mislead on a pull request; a tagless root makes the grammar irregular. | Keep `i`; no tag. |
| D-PR10 ⚑ | Pull-request comment attachments resolve their id by **name** through the attachment list, newest match first | Neither the type-20 `changes[]` nor the REST `changeLog` carries an attachment id for pull requests (measured 2026-09-06); the list is the only id source and names are not unique. | Omitting `fetchData` on pull-request comment attachments (loses the file entirely); one list call per comment eagerly (a read per message). |
| D19 | `botUserName(host)` exposed; `botUserId` still private | `userName` is one string, so a consumer running spaces under different display names has no way to build or match its own mention string per space and must duplicate the installation config to get one; the name is already public in every rewritten comment body, while the id is not and would mislead the core's `@<id>` pattern. | Requiring one display name across all spaces (an operational constraint the adapter cannot enforce); exposing the whole `ResolvedInstallation` (leaks credentials and `botUserId`); a `userName(host)` name (reads like the core's `userName`, which it deliberately is not). |
| — | Self messages are not dispatched by the adapter | `selfMessageContract` asserts nothing is dispatched; the core's own `isMe` skip is a second line of defence. | Relying on the core alone. |
| — ⚑ | No timestamp-staleness window | See §5.1: unsigned timestamps give no protection and would drop measured late redeliveries. | Rejecting payloads older than N minutes. |

## 15. Decision register (⚑)

Every ⚑ in this document points here, and so do the decision sections of both
plans ([docs/plans/adapter-implementation.md](../plans/adapter-implementation.md)
§6 and [docs/plans/pull-request-support.md](../plans/pull-request-support.md)
§8), which no longer carry verdicts of their own. This is the **one place a
verdict is recorded**, so somebody deciding whether to release does not have
to reconcile three tables that can drift apart — the way they had by
2026-09-07, when the code had implemented every default the spec assumed and
all three documents still said the decision was open. A ⚑ elsewhere in this
document therefore means "§15 has the answer", not "nobody has decided".

One of three verdicts per row:

- **confirmed** — the assumed default stands, and code and tests implement it.
  The Evidence column names the module and the test; a row whose evidence is
  an intention rather than a file is not confirmed.
- **changed** — a different answer shipped. The row says what to, and why.
- **open** — the maintainer still has to decide. §15.4 gives each open item a
  recommendation and says whether it blocks `0.1.0`.

Numbers 1–17 are the questions this section has carried since P0 and keep
their numbers, so an existing "§15 question 7" reference still resolves;
18–31 are decisions that until now lived only in a plan, or in no document at
all. Every open item has a row, so the Verdict column alone is a complete
answer to "what is left to decide". Reviewed 2026-09-08 against `main` at
`72b0148`.

### 15.1 Register

| # | Decision | Verdict | Evidence |
| --- | --- | --- | --- |
| 1 | D1 config shape: single-space fields with env fallbacks **and** `installations[]` | **confirmed** — both shapes, mutually exclusive, a host-keyed map inside | The constructor rejects the two shapes together, an empty `installations[]`, two installations on one host, and both credential environment variables set together (`src/adapter.ts`) — while an explicit credential ignores the other's leftover variable rather than failing, which is #90's fix and not an oversight; `src/adapter.test.ts` "installations and single-space fields together are rejected", "two installations on the same host are rejected", "constructs from environment variables when config is empty", "rejects both credentials in the environment, naming the variables", "an explicit apiKey ignores an access token left in the environment" (#10, tightened by #88 and #90) |
| 2 | D14 formatting-rule cache policy | **confirmed** — cache forever, no TTL; `fetchChannelInfo` replaces the entry | `BacklogAdapter.fetchChannelInfo` replaces the `projectCache` entry, drops the channel's cached issue defaults and clears every repository name cached for the host; `src/adapter.test.ts` "fetching channel info replaces the cached formatting rule", "clearing channel info forgets the host’s repository names" — the source spells that apostrophe `\u2019`, so grep for `repository names` (#16, #24) |
| 3 | `renderFormatted(content, target?)` second parameter | **confirmed** — accepted, and used: a cached rule for the target's channel picks the converter, otherwise Markdown plus one `warn` | `BacklogAdapter.renderFormatted` and `channelIdOfTarget` (`src/adapter.ts`); `src/adapter.test.ts` "without a target renders Markdown and warns once", "rendering for an unparseable target warns and falls back to markdown" (#10, #83) |
| 4 | Webhook before `initialize()` (§5.1 row 10) | **confirmed** — 503 `Adapter not initialized` | `BacklogAdapter.handleWebhook`; `src/adapter.test.ts` "a webhook before initialize() has run gets 503" (#12) |
| 5 | Non-POST webhook request | **confirmed** — 405 `Method not allowed` | `src/webhook/verify.ts`; `src/webhook/verify.test.ts` "a non-POST request is rejected with 405" (#12) |
| 6 | `maxWebhookBodyBytes` knob | **confirmed** — kept, 5 MiB default, 413 | `DEFAULT_MAX_WEBHOOK_BODY_BYTES = 5 * 1024 * 1024` (`src/adapter.ts`), checked against `Content-Length` and again while reading (`src/webhook/verify.ts`); `src/webhook/verify.test.ts` covers both paths, `src/adapter.test.ts` "rejects a maxWebhookBodyBytes of %s" (#12, buffering order fixed by #81) |
| 7 | Empty stream posts `" "` | **confirmed**, and widened to an abort that buffered nothing — see §15.2 | `BacklogAdapter.stream` posts `" "` whenever the buffer is empty (#84) |
| 8 | Empty summary in `postChannelMessage` | **confirmed** — `ValidationError`, no placeholder | `createChannelIssue` in `src/egress.ts` throws before the port call; `src/adapter.test.ts` "an empty summary is a validation error" (#16) |
| 9 | Type-4 deletion in the first release | **confirmed** — shipped; see §15.2 | `DISPATCHED_ACTIVITY_TYPES` includes 4 and dispatches `chat.processMessageDeleted` unconditionally (`src/webhook/payload.ts`) (#12) |
| 10 | Retry defaults | **confirmed** — `maxRetries: 1`, `maxWaitMs: 60_000`, both overridable, `maxRetries: 0` supported | `DEFAULT_MAX_RETRIES` / `DEFAULT_MAX_WAIT_MS` in `src/client/rate-limit.ts`, validated in `src/adapter.ts`; `src/client/rate-limit.test.ts` "retries once when the reset is within maxWaitMs", "gives up without waiting when the wait would exceed maxWaitMs", "maxRetries: 0 never retries even with an imminent reset" (#9, bounded further by #71) |
| 11 | Live-suite variables | **changed** — four, not three: `BACKLOG_LIVE_PULL_REQUEST=<repositoryId>:<number>` joined `BACKLOG_HOST`, `BACKLOG_API_KEY`, `BACKLOG_LIVE_ISSUE_ID` | `src/test/live.test.ts` reads all four and skips the pull-request half independently of the issue half, because a pull request needs a Git-enabled project and two coordinates an issue id cannot carry (#15, #24). The suite itself has still never been run — §15.4 |
| 12 | No timestamp-staleness window | **confirmed** — accepted, with the departure documented rather than CLAUDE.md amended | `src/webhook/verify.ts` applies no timestamp check; §5.1 states the departure and its reason (unsigned timestamps give no protection and would drop measured late redeliveries). The plan's rider "amend CLAUDE.md wording for this adapter" was **not** taken up: CLAUDE.md's "Don't" list is generic adapter guidance, and the reader who needs this adapter's choice is reading §5.1 (#12) |
| 13 | D-PR10 pull-request comment attachment resolution | **confirmed** — lazy list-and-match by name, newest match wins | The type-20 / `changeLog` attachment builder in `src/subject/pull-request.ts` resolves `fetchData` through `GET …/pullRequests/:number/attachments` only when the consumer asks (#22) |
| 14 | D-PR2 nested `subject` in the id grammar | **confirmed** — nested `BacklogSubjectRef`, kind keyword explicit for both kinds | `BacklogSubjectRef` (`src/types.ts`) is written and read only by `src/ids.ts` and dispatched only by `subjectClientFor` (`src/subject/client.ts`); `src/subject/containment.test.ts` fails the build on a third module that dispatches on `.kind` — a tripwire, not a proof, and its header lists what it cannot see (#22, weakened deliberately by #83) |
| 15 | D-PR7 `listThreads` population | **confirmed** — issues only, documented, with the pull-request route named | `BacklogAdapter.listThreads` and its Why-not comment; a caller holding a repository uses `api(host).listPullRequests`, which spends `read` rather than `search` (measured 2026-09-06); README row (#24, #25) |
| 16 | Webhook form of types 18–20 | **confirmed** — measured, and rule 4 gained the predicted mention; see §15.2 | Two captures on a deployed receiver, 2026-09-06, matched to their activities by id (`.claude/rules/backlog-pull-request-facts.md`); the schemas name `assignee`, `base`, `branch` and `diff`, and `assigneeIdOf` in `src/webhook/inbound.ts` is read on 18, not on 19 or 20 (#23, narrowed to the root activities by #32) |
| 17 | D9 rule 6 accepts any `reason` | **confirmed** — measured; a watcher appears in no `notifications[]`; see §15.2 | Measured 2026-09-06 (`.claude/rules/backlog-webhook-facts.md`); `src/webhook/inbound.ts` reads every `reason` (#35) |
| 18 | P0 documentation title scope: `docs(docs)` or `docs(adapter)` | **confirmed** — `docs(docs)`, and it is now history | #2 landed as `docs(docs): add adapter specification and implementation plan`; CLAUDE.md's scope table lists `docs` as covering `docs/`. Nothing is left to decide |
| 19 | Optional CI job for the live suite (implementation plan P7c) | **confirmed** — skipped | `.github/workflows/ci.yml` has no live job and reads no `BACKLOG_*` secret. The suite is opt-in and self-skipping, so nothing in CI depends on it; revisit only alongside #52 |
| 20 | D-PR1 channel of a pull-request thread | **confirmed** — the project, exactly as for issues | `channelIdFromThreadId` is the first three segments for both kinds (`src/ids.ts`); the formatting rule and the project cache are per project, and a repository has neither (#22) |
| 21 | D-PR3 `deleteMessage` on a pull-request thread | **confirmed** — `AdapterError` with `UNSUPPORTED_OPERATION`, thrown before any call | `deleteComment` in `src/subject/pull-request.ts` rejects without a request, citing the measured 400/6 `Undefined resource`; the subject client carries `capabilities: { deleteComment: false }` so no member has to ask what kind it holds, and the README row is what tells a consumer (#22, #25) |
| 22 | D-PR4 adapter option to enable or disable pull requests | **confirmed** — none; the webhook subscription is the switch | No `subjects` field exists on `BacklogAdapterConfig` (`src/types.ts`); leaving 18–20 out of `activityTypeIds[]` is the documented way to decline them, and 14 is declined the same way (#22, #23) |
| 23 | D-PR5 type 21 | **confirmed** — 200 Ignored, and absent from the registration guidance | `DISPATCHED_ACTIVITY_TYPES` excludes 21 (`src/webhook/payload.ts`); `src/webhook/payload.test.ts` "a git push and a type-21 activity are not among them" cites the two measurements that never saw one, the second with 21 subscribed (#23) |
| 24 | D-PR6 a pull request linked to an issue | **confirmed** — its own thread; the link is metadata and never routes | the `issue` key of `threadMetadata` in `src/subject/pull-request.ts`, and `raw.payload.content.issue`; `src/webhook/payload.test.ts` "a pull request linked to an issue is still its own subject" (#23) |
| 25 | D-PR8 `fetchSubject().type` for a pull request | **confirmed** — `'pull_request'` | `subjectType: 'pull_request'` in `src/subject/pull-request.ts`, documented on `SubjectClient` (`src/subject/client.ts`); `src/reads.test.ts` and `src/subject/pull-request.test.ts` assert it (#22) |
| 26 | D-PR9 root message part tag | **confirmed** — `r` for both kinds | `src/ids.ts` encodes and parses `r`; `src/ids.test.ts` and the `threadIdContract` roundtrip cover it (#22) |
| 27 | D15 version line | **confirmed 2026-09-07** — the package's own semver, starting at `0.1.0`; #17, which had it track `chat`'s line, is superseded | #58; §7 of the implementation plan and DEVELOPMENT.md "Versioning". The dependency **ranges** are the other half of D15 and are unchanged (§14) |
| 28 | Repository visibility at publish time | **open — blocks `0.1.0`** | §15.4 |
| 29 | Whether done criterion 3 stands: the live suite must run against a real space before `0.1.0` | **open — blocks `0.1.0`** | §15.4. The suite exists and self-skips (row 11); the run itself is issue #52 |
| 30 | M9 and M12, the two pull-request questions left unmeasured | **open — does not block `0.1.0`** | §15.4; [docs/plans/pull-request-support.md](../plans/pull-request-support.md) §5. No code reads either |
| 31 | Catalog listing: community or vendor-official | **open — does not block `0.1.0`** | §15.4. §13 holds the feature-matrix values a listing needs |

### 15.2 The four questions whose answer needed an argument

The rows above point here for the four that were settled with reasoning
rather than by writing the code. The text is the record of how each was
decided, kept as it was written.

**Question 7.**
~~**Empty stream** (§4.2 `stream`): post `" "` like the core fallback
(assumed) or return `null` after consumption.~~ **Settled**: `" "` stands.
An empty stream is not hypothetical — `fromFullStream` in `chat` yields
only strings, `markdown_text`/`task_update`/`plan_update` and `text-delta`
and drops every other chunk type (read in 4.39.0,
`.claude/rules/chat-sdk-core-facts.md`), so an AI SDK `fullStream` whose
model failed arrives here empty rather than throwing. `" "` keeps the
contract every caller can rely on (`stream()` resolves to a `SentMessage`
the handler can edit or delete) and matches the core's own fallback for the
same input; `null` after consumption is a shape no measurement covers, and
it would hand `thread.post(stream)` a null the caller has to branch on for
a case they cannot distinguish from success. The cost is a comment holding
one space, which is visible in Backlog and therefore documented in README's
Streaming limitation rather than hidden. The same answer covers an
`options.signal` abort that buffered nothing: the caller cannot tell the two
apart, and §6.4 said "if non-empty" only because it was written before this
question was settled.

**Question 9.**
~~**Type 4 deletion**: ship in the first release or defer.~~ **Settled**:
shipped. Type 4 is dispatched unconditionally as
`chat.processMessageDeleted`; there is no option to turn it off, and the
registration guidance still leaves 4 optional so a project that does not
want deletions simply does not subscribe to it.

**Question 16.**
~~**Webhook form of types 18–20**: the activity API form is measured; if a
webhook body turns out to add `content.assignee` (as type 1 does), rule 4
of §5.4 gains an assignment-at-creation mention.~~ **Settled**: it does.
The measurement waived before P3 (it needs a receiver Backlog's servers
can reach) was taken afterwards on a deployed receiver, with every
delivery matched to the same activity by activity id and diffed in both
directions (measured on a development space, 2026-09-06). The webhook
`content` is the activity key set plus `assignee`, `base`, `branch` and
`diff`, on all three types, and the keys the two forms share hold equal
values.

Rule 4 gained the assignment-at-creation mention on 18 as predicted. What
the question did not anticipate is that the same key is on 19 and 20 as
the **standing** assignee, and on issue types 2 and 3 as well — repeated
on every delivery whether or not the assignment changed. It is therefore
read on 18 alone: a multi-field `PATCH` that changed no assignee carried
the bot in `content.assignee` and notified nobody, so reading it on 19
would make every edit of a bot-assigned pull request a mention. An
assignment on any other type reports itself in `changes[]`, and one
`changes[]` leaves out is covered by rule 6, which reads whom Backlog
notified.

`base`, `branch` and `diff` change no behaviour; the schemas name them as
the record of the measurement (§5.2). What remains unmeasured is narrower
and recorded as such in `.claude/rules/backlog-pull-request-facts.md`:
the webhook deliveries for a merge, a close and a comment with
`attachmentId[]`, whose `changes[]` shapes are still activity-form
measurements. A merge and a close have no API, so capturing them needs a
git push or the UI (docs/plans/pull-request-support.md §4 P3, §5 M1).

**Question 17.**
~~**D9 rule 6 accepts any `reason`** — confirm, or name the reason codes
to exclude.~~ **Settled**: any `reason` stands, and the candidate false
positive has been measured away. A second account watching an issue it
was neither assigned to nor named in appears in **no** `notifications[]`:
a plain comment, a priority-only `PATCH` and a description-only `PATCH`
on that issue all arrived with `notifications: []`, while the control —
the same kind of comment on the same issue, addressing a user who was not
watching it — carried that user with `reason: 2` (measured on a
development space, 2026-09-06). Watching is a separate mechanism end to
end: it creates no entry in the watcher's own `GET /notifications`
either, and `POST /watchings` produced no delivery on a hook registered
for types 1, 2, 3, 4, 14 and 17 — the issue types; no other type was
subscribed. So `notifications[]` names only users somebody addressed, as
far as the acts measured here, and every `reason` observed on a delivery
is an explicit act — 1 and 10 an assignment (issue, pull request), 2 and
11 a comment's notification field or a mention in its text. `<@project>`
is not a counter-example: it addresses every project member deliberately,
so a bot that is a project member is being spoken to by the same
definition rule 1 already uses for a hand-typed `@Chatbot`.

### 15.3 Settled in the release review of 2026-09-08

Decisions this section never carried a ⚑ for, settled while the `v0.1.0`
milestone was being cleared. They are here so this register is the whole
picture on that date; the behaviour itself is specified in the section the
named PR amends, which is where it must be read from.

| Decision | Verdict | Where it is specified |
| --- | --- | --- |
| A forward first page fetches one comment (`limit: 1`) | **confirmed** — as it stands | §7.1. The one comment is what distinguishes "there are comments, so restart at cursor 0" from "there are none, so this is the end". Backlog does expose Count Comment, but it costs the same one `read`, so asking it instead saves nothing (#88) |
| `ThreadInfo.metadata` timestamps | **changed** — ISO strings, not `Date` (breaking) | §7.3. `metadata` is `Record<string, unknown>`, so a `Date` in it is invisible to the type and turns into a string in any consumer that round-trips the object through JSON — the same reason `src/types.ts`'s raw shapes carry ISO strings while `src/client/port.ts` carries `Date` (#88) |
| Ids, hosts and numeric config the adapter cannot honour | **changed** — rejected with a `ValidationError` instead of being carried into a request (breaking) | §2 grammar, §3.2 config table (#88) |
| `dist/index.d.ts.map` | **changed** — no longer emitted; the JavaScript map stays | `files` does not ship `src/`, so a declaration map could only point at sources that are not published (#95, split out of #82) |
| The d.ts pass under TypeScript 7 | **confirmed** — as it stands | attw at the `esm-only` profile, publint and `scripts/check-published-types.mjs` all pass on the current output; the follow-up #95 named — asserting that the built `.d.ts` still *declares* the package's entry points — is described in that PR and not yet filed (§15.4) |
| What `parseMessage` accepts | **changed** — all five raw shapes, the ones the adapter itself produces included | §4.1 (#91, issue #49) |
| `webhookSecret` minimum length | **changed** — under 16 bytes is a hard `ValidationError`, not a warning | §3.2 config table, §11 (#81) |
| An unknown `textFormattingRule` | **confirmed** — treated as Markdown, as §9.2 already specified | §9.2 (#83) |
| What `src/subject/containment.test.ts` proves | **changed** — it is a tripwire, not a proof: it matches only a receiver it can name | The test's own header lists what it cannot see, and CLAUDE.md says the same (#83) |
| Card fallback text | **changed** — rendered in the project's own notation rather than always Markdown | §9.4 (#85) |
| Backlog-notation escaping in user text | **not implemented, and carved out** — documented as a limitation | §9.7 (#86). The escape syntax exists; applying it needs a measurement on a notation project, so it is issue **#92**, waiting on the same space as #52 |

### 15.4 Open

Four items are still the maintainer's to decide, in the order they would stop
a release: the first two block `0.1.0`, the last two do not. A closing
paragraph names what the same review carved into follow-up issues instead,
because those are work, not decisions.

**28. Repository visibility at publish time — blocks `0.1.0`.** The
repository is `internal` while `release.yml` runs
`npm publish --access public`. On the day the package appears on the registry
its README is served to anonymous readers, and every absolute link in it, the
license badge's target and `package.json`'s `homepage` resolve to a 404 for
them; `--provenance` from a non-public repository is also unverified here.
Recommendation: make the repository public before running the release, which
settles all four at once. The alternative — publishing from an internal
repository with relative links and no badge — costs the package its
provenance attestation and is harder to undo, because the README published
for a version is immutable. Either way the call has to be made **before** the
first `release.yml` run (#82 carries the same note for the releaser).

**29. The live suite has never been run — blocks `0.1.0`.** Criterion 3 of
[docs/plans/adapter-implementation.md](../plans/adapter-implementation.md) §1
requires it to have run at least once against a real space, with the result
in the release PR, and §12.3 is written for that run. It needs credentials
and a Git-enabled project on a development space (**#52**). Recommendation:
keep the criterion. The suite is the only thing that ever executes the port
against Backlog's real wire shapes, and #19 (`fix(client): use the wire
shapes Backlog actually sends and accepts`) is what that class of mistake
looks like when it is found late. Two other items ride along on that run and
should be taken in the same session rather than opened separately: the
remaining item of **#51** (a schema fixture recorded from a real body, so the
test doubles can catch drift) and the two measurements below.

**30. M9 and M12 stay unmeasured — not a blocker.**
[docs/plans/pull-request-support.md](../plans/pull-request-support.md) §5: M9
is a populated `pullRequest` / `pullRequestComment` in the bot's own
notification feed, M12 is redelivery. Neither gates behaviour — `markAsRead`
matches by kind either way, and redelivery is documentation — and both need
the same space as the live suite.

**31. Catalog listing: community or vendor-official — not a blocker.** Prepared
but never chosen (§13 holds the feature-matrix values; the implementation
plan's §8 keeps it out of scope). Community listing needs a docs page and
allowlist entries in `vercel/chat`; vendor-official additionally needs
catalog and scaffold entries, a changeset, product docs and an announcement.
Recommendation: publish `0.1.0` first and list it as community, because the
vendor-official path asks for an announcement of an adapter nobody has
installed yet. Record whichever is chosen in README's "Status" section.

**Carved out rather than left open.** Three defects and one build check found
in the same review are follow-up issues, not decisions, and none of them
blocks `0.1.0`: **#92** (apply Backlog notation's `\` escape to user text —
needs #52's space), **#93** (a `Blob` whose `arrayBuffer()` rejects leaks an
unattributed exception), **#94** (a heading marker with no text is an empty
heading, unlike a list marker), and the export assertion for
`scripts/check-published-types.mjs` described in #95's follow-up section,
which has no issue yet.
