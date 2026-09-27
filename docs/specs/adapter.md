# `@nulab/chat-adapter-backlog` — adapter specification

What a consumer of the Backlog adapter for Chat SDK (`chat@4.40.0`) can
observe, and the decisions that shaped it (§12). The tests are written from
this document; when code and spec disagree, one of them is wrong. Code cites a
decision by its id (`D14`), never by section number.

Measured Backlog behaviour appears here only as far as it changes what the
adapter does. The measurements, with dates and payload excerpts, are in
`.claude/rules/backlog-api-facts.md`, `backlog-webhook-facts.md`,
`backlog-pull-request-facts.md` and `chat-sdk-core-facts.md`. Every other
Backlog claim cites a [developer.nulab.com](https://developer.nulab.com/docs/backlog/)
page.

Conventions: "the core" is the `Chat` class in `chat@4.40.0`; "the client" is
the adapter's `backlog-js` client (§8); "the space" is the one Backlog space an
adapter is configured for. `MUST` / `MUST NOT` are requirements.

## 1. Scope

A consumer constructs the adapter with a Backlog host, a bot user's
credentials and a webhook secret (or lets those come from the environment),
registers one webhook per Backlog project pointing at the Chat SDK route, and
writes ordinary `Chat` handlers: a mention of the bot in an issue, a pull
request or a comment on either reaches `onNewMention`, follow-up comments on
subscribed subjects reach `onSubscribedMessage`, `thread.post()` comments on
the issue or pull request, `thread.messages` pages through its comments, and
every Backlog API failure surfaces as one of `@chat-adapter/shared`'s error
classes. One adapter serves one space (D1).

**Not supported**, by decision rather than deferral: direct messages,
ephemeral messages, modals, buttons, slash commands, scheduled messages,
nested replies, emoji reactions, typing indicators, a realtime transport,
OAuth token acquisition or refresh, registering webhooks on the consumer's
behalf, any persistent state of the adapter's own (subscriptions and dedupe
belong to the Chat SDK `StateAdapter`), creating an issue through
`channel.post` (D24), creating, closing or merging pull requests (Backlog has
no status API), a git repository as a channel (D-PR1), listing pull
requests through `listThreads` (D-PR7), and projects that use Backlog
notation (D32).

## 2. Conceptual model

| Backlog | Chat SDK | Id grammar | Notes |
| --- | --- | --- | --- |
| Space | (the adapter's configuration) | `host` — a full hostname such as `example.backlog.com`, `example.backlog.jp`, `example.backlogtool.com` | Never a slug; the domain differs per space. |
| Project | Channel | `backlog:<host>:<projectId>` | Both kinds of thread belong to the project (D-PR1). |
| Issue | Thread | `backlog:<host>:<projectId>:issue:<issueId>` | Numeric issue id, never the issue key, which a project-key rename rewrites (D8). |
| Pull request | Thread | `backlog:<host>:<projectId>:pr:<repositoryId>:<number>` | Numeric repository id, never the name; `number` is the per-repository number every pull-request endpoint is keyed by. The space-wide pull-request `id` addresses no endpoint and appears only in raw data. |
| Issue body / pull-request body | Root message | `<host>:issue:<issueId>:r` / `<host>:pr:<repositoryId>:<number>:r` | `text` = `summary + "\n\n" + description`, trimmed. |
| Comment | Message | `<host>:<subject>:c<commentId>` | Includes Backlog's changelog comments (status, assignee, description, attachment changes). Issue and pull-request comment ids come from different sequences and may overlap. |
| Update without a comment | Message with empty text | `<host>:<subject>:u:<created>` | `created` is the webhook's top-level ISO timestamp verbatim; it contains `:`. |
| User | User | `<host>:<userId>` | Numeric user id. |
| Star on a comment | Reaction | — | One kind only; the emoji name is ignored. |

The host is part of message and user ids because the core's dedupe key is
`dedupe:<adapter.name>:<message.id>` with no thread component, and comment ids
are unique only within one space and one kind (D8). The kind is an explicit
segment on both kinds, never inferred from a segment count (D-PR2). The value
ids, raw messages and internal calls share is

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

`decodeThreadId`, `decodeMessageId`, `decodeUserId` and the channel-id decoder
throw `ValidationError("backlog", …)` on any of: wrong prefix or segment count
(thread: `backlog`, host, project id, then exactly the segments its subject
keyword takes; channel: exactly three), an empty or invalid `host`, a
non-`posint` numeric segment, an unknown subject keyword, a subject followed
by nothing or by an unknown part, `r` or `c<id>` followed by further segments,
and `u:` with nothing after it. `decodeUserId` splits on the **last** `:`; a
bare number is rejected.

A `posint` whose value exceeds `Number.MAX_SAFE_INTEGER` is rejected although
its digits match: `Number` is lossy past 2^53-1, so the id would re-encode to
something else.

A host that decodes correctly but is not the configured space is a
`ResourceNotFoundError("backlog", "space", host)` at the point of use: the id
is well-formed.

## 3. Public API

### 3.1 Exports

Runtime: `BacklogAdapter`, `createBacklogAdapter(config?)`,
`decodeMessageId`, `decodeUserId`.

Types: `BacklogAdapterConfig`, `Resolvable`, `BacklogWebhookVerifier`;
`BacklogThreadId`, `BacklogSubjectRef`; `BacklogRawMessage` and every type it
reaches — `BacklogRawIssue`, `BacklogRawComment`, `BacklogRawPullRequest`,
`BacklogUser`, `BacklogStar`, `BacklogChangeLog`, `BacklogChange`,
`BacklogWebhookPayload`; `BacklogMessageId`, `BacklogMessagePart` and
`BacklogUserId`, which the decoders return; `BacklogPostableExtras` (§3.4);
and `Backlog`, `backlog-js`'s client class, so a consumer can name what
`client()` returns without depending on `backlog-js` (D-API1).

A consumer that receives a value can name its type: the declarations contain
no type `src/index.ts` does not export, nothing from `zod`, and no import but
`chat` and `backlog-js`.

### 3.2 `createBacklogAdapter(config?)`

Returns `new BacklogAdapter(config ?? {})`. The constructor parses config and
environment together and throws one `ValidationError` naming every problem; it
never calls `process.exit`, never logs a secret, and makes no network call.

```ts
type Resolvable = string | (() => string | Promise<string>);

interface BacklogAdapterConfig {
  host?: string;
  apiKey?: Resolvable;      // exactly one of apiKey / accessToken
  accessToken?: Resolvable;
  botUserId?: number;
  botUserName?: string;
  webhookSecret?: string;   // required unless webhookVerifier is set
  webhookVerifier?: BacklogWebhookVerifier;
  logger?: Logger;
}
type BacklogWebhookVerifier = (request: Request, rawBody: string) => unknown | Promise<unknown>;
```

| Option | Default | Env fallback | Validation |
| --- | --- | --- | --- |
| `host` | — | `BACKLOG_HOST` | Matches the `host` grammar after lowercasing; a scheme, port, path or whitespace is rejected. |
| `apiKey` | — | `BACKLOG_API_KEY` | Non-empty when a string. Exactly one of `apiKey` / `accessToken`. |
| `accessToken` | — | `BACKLOG_ACCESS_TOKEN` | As above. Refreshing it is the caller's job, through the resolver form. |
| `botUserId` | `GET /users/myself` → `id` | `BACKLOG_BOT_USER_ID` | A `posint`; the env value must be one in decimal. |
| `botUserName` | `GET /users/myself` → `name`, only when `botUserId` is also unset | `BACKLOG_BOT_USER_NAME` | Not blank (an empty name would make every `@` a mention). |
| `webhookSecret` | — | `BACKLOG_WEBHOOK_SECRET`, not read when `webhookVerifier` is set | At least **16 bytes** (UTF-8), validated even beside a verifier (D2). |
| `webhookVerifier` | — | none | Replaces the secret check (D2). |
| `logger` | `new ConsoleLogger("info").child("backlog")` | none | Replaced by `chat.getLogger("backlog")` in `initialize`. |

- A fallback applies only when the field is absent from `config`; an explicit
  empty string is a validation error. The exception is a blank
  `BACKLOG_BOT_USER_ID=` or `BACKLOG_BOT_USER_NAME=`, which counts as unset,
  because a copied `.env.example` leaves those lines blank.
- `apiKey` and `accessToken` fall back as a **pair**: either one in `config`
  suppresses both variables. Both given, from any source, is an error, never
  a silent preference for one.
- An option the schema does not name is rejected rather than ignored.
- A credential resolver is invoked on **every** outbound request and its
  result is never cached. One that throws makes that call reject with
  `AuthenticationError` wrapping the cause.

**Bot identity (D23).** The id recognises the bot's own activity and an
assignment to it; the name only recognises a hand-typed `@name` (§5.4).

- `botUserId` configured → no request, ever, with or without the name.
- Id configured, name missing → one `warn` from `initialize`. The two rules
  that compare the name are off — the typed `@name` and an assignment reported
  by display name in `changes[]` — while notifications and the assignee id
  still count. `userName` is then `""`, which the core reads as "use
  `chat.userName`", so a consumer must give `Chat` a non-empty `userName` or
  the core's pattern matches every bare `@`.
- Id missing → one `GET /users/myself` from `initialize`, filling the id and,
  when unset, the name.
- A failed lookup does not reject `initialize`: it logs `warn`
  `bot identity lookup failed; retried on demand` and caches nothing, and the
  next caller that needs the id asks again. A webhook whose id still cannot be
  learned is answered 503 and not dispatched (§5.1 row 7). The async members
  that read the id reject with the lookup's error, and the synchronous
  `parseMessage` throws `AdapterError(…, "BOT_IDENTITY_UNRESOLVED")`.

### 3.3 Other public members of `BacklogAdapter`

- `readonly name = "backlog"`; `userName`, the configured or fetched
  `botUserName`, `""` while there is none.
- `client(): Backlog` — the `backlog-js` client the adapter speaks through,
  for every endpoint the `Adapter` interface does not cover. It carries the
  adapter's 429 retry, error mapping and per-request credential (§8), and
  holds no credential of its own (D-API1).
- `renderFormatted(content)` — §9.

`botUserId` is not exposed: the core's only use of it is an `@<id>` mention
pattern no Backlog text contains, and it may not be known before `initialize`.

### 3.4 Postable extras

| Extra | Applies to | Type | Effect |
| --- | --- | --- | --- |
| `notifiedUserId` | `postMessage` | `number[]` (positive integers) | Backlog `notifiedUserId[]`. Backlog silently drops an invalid or non-member id (201, no notification); the adapter does not pre-validate. |

A consumer intersects the extras with a Chat SDK postable through an annotated
variable (`const reply: PostableMarkdown & BacklogPostableExtras = { … }`); an
object literal passed inline fails `post()`'s excess-property check. A present
but mistyped extra is a `ValidationError`, never dropped. `editMessage`
accepts no extras and no files: Update Comment takes `content` only.

### 3.5 Raw message union

```ts
type BacklogRawMessage =
  | { kind: "webhook"; host: string; payload: BacklogWebhookPayload; changes: BacklogChange[] }
  | { kind: "bulkUpdate"; host: string; payload: BacklogWebhookPayload; issueId: number;
      changes: BacklogChange[] }
  | { kind: "comment"; host: string; projectId: number; subject: BacklogSubjectRef;
      comment: BacklogRawComment; changes: BacklogChange[] }
  | { kind: "issue"; host: string; issue: BacklogRawIssue; changes: [] }
  | { kind: "pullRequest"; host: string; pullRequest: BacklogRawPullRequest; changes: [] };
```

Every variant survives a JSON round trip: timestamps are the ISO strings
Backlog sends, and nothing is a `Date`.

- **`payload`** is the delivery as the webhook schema parsed it (§5.2): every
  key Backlog sent, unknown ones included, with §5.2's normalisations applied.
  `BacklogWebhookPayload` is `backlog-js`'s `Entity.Activity` types with the
  measured deviations overlaid, discriminated on `type`, so
  `payload.type === 3` narrows `content` (D25).
- **`bulkUpdate`** is one issue of a type-14 bulk update: `payload` is the
  whole delivery, identical on every message of the batch, and `issueId`
  names which `content.link[]` entry this message is (D22).
- **`issue`, `pullRequest`, `comment`** are the REST response as its schema
  parsed it (§8.3), typed as `backlog-js`'s entity with the measured
  deviations overlaid: `userId` is `null` for a Nulab-account user, a star's
  `comment` is `null`, an unset `assignee`, a pull request's `issue`, commits
  and close/merge dates are `null`, and a system comment's `content` is
  `null`. `comment` names its `subject` because a pull-request comment carries
  no parent reference of its own.
- **`changes`** is `{ field: string; newValue: string | null; oldValue: string | null }[]`.
  Value systems are not unified: a webhook `status` change carries an id and
  an assignee change a display name, while REST `changeLog` carries display
  names for both. On issues only `priority`, `status` and `resolution` carry
  ids, and three field names match neither the API parameter nor the UI label
  (`component`, `limitDate`, `assigner`). The assignee field is `assigner` on
  issues and `assignee` on pull requests. The table is in
  `.claude/rules/backlog-webhook-facts.md`; a consumer reads `raw.kind` and
  the subject kind before interpreting a value.

`parseMessage` accepts the two webhook kinds and rebuilds the message the
webhook dispatched, without an API call and without parsing `payload` again.
It throws `ValidationError` for the three REST kinds, a type-4 `webhook` raw (a
deletion is no message) and a `bulkUpdate` whose `issueId` is not in its batch:
the core never calls `parseMessage`, and a message read over REST already is a
`Message`.

### 3.6 Errors

Every error is one of `@chat-adapter/shared`'s — `ValidationError`,
`AuthenticationError`, `PermissionError`, `ResourceNotFoundError`,
`AdapterRateLimitError`, `NetworkError`, `AdapterError` — with adapter name
`"backlog"`; the mapping from Backlog responses is §8.5. No `ZodError` and no
`backlog-js` error class escapes the package.

## 4. Adapter contract coverage

`Adapter<BacklogThreadId, BacklogRawMessage>` in `chat@4.40.0` has 17 required
and 27 optional members. "Core calls it" names the runtime call site; "never"
means only a consumer or the test kit calls it. Every member accepts an issue
thread or a pull-request thread and behaves the same for both unless its row
says otherwise.

### 4.1 Required members

| Member | Status | Behaviour | Core calls it |
| --- | --- | --- | --- |
| `name` | implemented | `"backlog"`. The key in `new Chat({ adapters: { backlog } })` MUST equal it (thread-id prefix routing). | dedupe key, `Thread.toJSON`, logs |
| `userName` | implemented | §3.3. | fallback mention regex, `SentMessage.author` |
| `initialize(chat)` | implemented | Stores the `ChatInstance`, swaps the logger for `chat.getLogger("backlog")`, and resolves the bot identity (§3.2). Never rejects. | first webhook / `chat.initialize()` |
| `handleWebhook(request, options?)` | implemented | §5. | `chat.webhooks.backlog(req)` |
| `encodeThreadId` / `decodeThreadId` | implemented | §2; exact round trip of `{ host, projectId, subject }`. | never |
| `channelIdFromThreadId` | implemented | The first three segments, `backlog:<host>:<projectId>`. | `createThread`, lock key, history |
| `parseMessage(raw)` | implemented | §3.5. | never |
| `renderFormatted(content)` | implemented | §9. | never |
| `postMessage(threadId, message)` | implemented | §6.1. A channel id — what the core passes for `channel.post` — is a `ValidationError` (D24). | `thread.post`, fallbacks |
| `editMessage(threadId, messageId, message)` | implemented | §6.2. | `SentMessage.edit` |
| `deleteMessage(threadId, messageId)` | implemented; issues only | §6.3. On a pull-request thread, `AdapterError(…, "UNSUPPORTED_OPERATION")` before any call (D-PR3); on an issue comment that records a change, the same before Delete Comment (D31). | `SentMessage.delete` |
| `addReaction` / `removeReaction` | partial | One star; the emoji is ignored (§6.5). | `SentMessage.addReaction` etc. |
| `startTyping()` | no-op | Resolves immediately; Backlog has no typing indicator. | `thread.startTyping` |
| `fetchMessages(threadId, options?)` | implemented | §7.1. | `thread.messages`, `allMessages`, `refresh`, history |
| `fetchThread(threadId)` | implemented | §7.3. | `chat/ai` tools only |

### 4.2 Optional members

| Member | Status | Behaviour, or the core's degradation when absent |
| --- | --- | --- |
| `stream(threadId, textStream, options?)` | implemented, buffered (D4) | §6.4. |
| `isDM(threadId)` | implemented | Always `false`. |
| `fetchMessage(threadId, messageId)` | implemented | §7.2. |
| `fetchSubject(raw)` | implemented | §7.4. |
| `fetchChannelInfo(channelId)` | implemented | §7.5. |
| `listThreads(channelId, options?)` | implemented; issues only | §7.6 (D-PR7). |
| `getUser(userId)` | implemented | §7.7. |
| `rehydrateAttachment(attachment)` | implemented | §6.6. |
| `postChannelMessage` | absent | Core falls back to `postMessage(channelId)`, a `ValidationError`; an issue is created through `client().postIssue` (D24). |
| `markAsRead` | absent | Core throws `NotImplementedError(…, "read-receipts")` (D24). |
| `fetchChannelMessages` | absent | Core falls back to `fetchMessages(channelId)`, a `ValidationError`: a project has no single comment stream. |
| `openDM`, `postEphemeral` | absent | `chat.openDM` throws `NOT_SUPPORTED`; ephemeral returns `null`. Backlog has no DMs. |
| `openModal` | absent | Core warns "does not support modals". |
| `scheduleMessage`, `reply` | absent | Core throws `NotImplementedError`. Comments are a flat list; there is no scheduling endpoint. |
| `postObject`, `editObject` | absent | Core posts fallback text. |
| `endTyping`, `disconnect` | absent | Core skips; nothing to end or close. |
| `onThreadSubscribe`, `getChannelVisibility`, `lockScope`, `persistThreadHistory`, `persistMessageHistory`, `supportsTurnCancellation`, `botUserId` | absent | Core defaults (`"unknown"` visibility, `"thread"` lock scope, no history cache, no cross-process abort). |

An absent member is absent from the instance, so the core's own degradation
applies; the adapter never throws a "not supported" of its own.

## 5. Webhook ingress

### 5.1 Response ladder

The first failing check answers. Bodies are plain text. Every 401 has the same
body and the same log line, so an unauthenticated caller cannot tell a missing
secret from a wrong one (D2).

| # | Check | Failure → status, body | Log |
| --- | --- | --- | --- |
| 1 | Authenticity. With a `webhookVerifier`: the body is read and `await verifier(request, rawBody)` is truthy and does not throw. Without one: `?token=` is present and equal to `webhookSecret` in constant time, **checked before the body is read**. A delivery that passes is taken to be from the configured space (D19). | 401 `Unauthorized` | warn `webhook rejected: unauthorized`; a throwing verifier also logs error `webhook verifier threw` `{error}` |
| 2 | The body is JSON | 400 `Invalid JSON` | warn `webhook rejected: invalid JSON` |
| 3 | The body is an activity envelope `{ type: number, … }` | 400 `Invalid payload` | warn `webhook rejected: invalid payload` with the zod issue paths, never values |
| 4 | `type ∈ {1, 2, 3, 4, 14, 18, 19, 20}` (D10) | 200 `Ignored` | info `webhook ignored` `{host, type}` |
| 5 | The schema for that type (§5.2) | 400 `Invalid payload` | as row 3 |
| 6 | `initialize()` has run | 503 `Adapter not initialized` | error `webhook rejected: adapter not initialized` |
| 7 | The bot identity is known, or one `GET /users/myself` learns it now (D23) | 503 `Bot identity unavailable`: without the id row 8 cannot run, and dispatching anyway would let the bot answer itself | error `webhook rejected: bot identity unavailable` `{host, error}` |
| 8 | `createdUser.id` is not the bot | 200 `OK`, nothing dispatched | debug `self message skipped` |
| 9 | — | 200 `OK`, returned **before** processing completes | — |

A 5xx is the only answer that could make Backlog redeliver; whether it does is
undocumented and was not observed (§5.5). The request method is not checked:
anything that is not a delivery fails row 1 or 2. The adapter sets no body-size
limit of its own; the platform in front of it does (D30). No timestamp window
is applied (D28).

A body that passes its schema but carries an id the codec rejects
(`content.id: 0`) gets no 400 of its own: it is authenticated, and the codec's
`ValidationError` surfaces from `handleWebhook` or from the dispatched factory.

On success the adapter calls `chat.processMessage(this, threadId, factory,
options)` once per message — once per issue for a type 14 — or, for a type 4,
`chat.processMessageDeleted(…)`. Each factory builds the message from the
parsed activity without an API call. A rejection from the core
is logged as error `inbound processing failed` `{host, threadId, error}`; the
core registers the work with `options.waitUntil` itself.

### 5.2 Payload schema

The body is one Activity object as
[Get Recent Updates](https://developer.nulab.com/docs/backlog/api/2/get-recent-updates/)
returns it, plus the fields only a webhook carries. It is parsed once, by a
discriminated union on `type` of loose objects: every key the schema does not
name is kept, and the result is `raw.payload`.

Required, else 400: `type`, `created`, `project.id`, `createdUser.id`,
`createdUser.name`; `content.id` on types 1–4; `content.summary` and a
nullable `content.description` on type 1; `content.number` and
`content.repository.id` on types 18–20; `content.link[]` with an `id` on every
entry on type 14. Everything else is optional; `content.repository.name` is
captured when present (§7.3).

The only normalisations anywhere:

- An absent `notifications[]` — every body replayed from the activity API —
  or one in a shape not measured reads as `[]`.
- `content.link[].id` on type 14, a decimal string over the webhook and a
  number from the activity API, reads as a number.
- A `changes[]` `new_value` or `old_value` reads as a string, and as `null`
  when absent (a type 14 sends no `old_value`) or in a shape not measured.
- A changelog comment's `content` — `null` over the webhook, `""` over REST —
  reads as `""`.
- An absent `content.comment` or `content.assignee` reads as `null`, and an
  absent `content.changes[]` or `content.attachments[]` as `[]`.

### 5.3 Activity-type mapping

| `type` | Backlog meaning | Message id | `text` | Attachments | Mention (§5.4), besides `notifications[]` |
| --- | --- | --- | --- | --- | --- |
| 1 | Issue Created | `<host>:issue:<issueId>:r` | `summary + "\n\n" + description`, trimmed | `content.attachments[]` | `content.assignee?.id === botUserId`, or text |
| 2 | Issue Updated, with `content.comment.id` | `<host>:issue:<issueId>:c<commentId>` | `comment.content` | `content.attachments[]` | assignment change to `botUserName`, or text |
| 2 | Issue Updated, no comment id | `<host>:issue:<issueId>:u:<created>` | `""` | none | as above |
| 3 | Issue Commented | `<host>:issue:<issueId>:c<commentId>` | `comment.content` | `content.attachments[]` | text |
| 4 | Issue Deleted | root `<host>:issue:<issueId>:r` | — | — | → `chat.processMessageDeleted({ adapter, channelId, threadId, messageId, raw, deletedAt: new Date(created) })` |
| 14 | Issues updated in bulk | one per `content.link[]` entry: `…:issue:<link.id>:c<link.comment.id>`, or `…:u:<created>` without a comment | `link[].comment.content` | none | assignment change to `botUserName`, or text (D22) |
| 18 | Pull Request Added | `<host>:pr:<repository.id>:<number>:r` | `summary + "\n\n" + description`, trimmed | `content.attachments[]` if present | `content.assignee?.id === botUserId`, or text including `<@U<botUserId>>` |
| 19 | Pull Request Updated, with `content.comment.id` | `…:c<commentId>` | `comment.content` | `content.attachments[]` if present | assignment change to `botUserName`, or text |
| 19 | Pull Request Updated, no comment id | `…:u:<created>` | `""` | none | as above |
| 20 | Comment Added on Pull Request | `…:c<commentId>` | `comment.content` | `content.attachments[]` if present; a `changes[field="attachment"]` entry (§6.6) | text |
| 17, 21, 12, 13, other | Comment notification added, pull request deleted/merged, git, wiki, document, … | — | — | — | 200 Ignored (D10, D-PR5) |

A pull-request thread id is built from `project.id`, `content.repository.id`
and `content.number` — never from `content.id` and never from the linked
`content.issue` (D-PR6).

What a handler observes as a consequence of Backlog's behaviour:

- **Changelog comments.** A status, assignee, description or attachment change
  arrives as type 2 **with** `content.comment.id` and empty comment text. It
  is a comment message with empty `text` and populated `raw.changes`; a
  handler keys on `raw.changes`, never on "has text". A comment posted with a
  status change is one type 2 carrying both.
- **A bulk update is N messages** (D22). An update made from the issue list
  arrives as one type 14 however many issues it touched — one included — and
  Backlog emits no type 2 or 3 for them. Each `link[]` entry names an issue
  and a comment that now exists on it, so ingress dispatches one message per
  entry, each in its own thread, each carrying the batch's `changes[]` and
  `raw.kind: "bulkUpdate"`. `changes[]` there has no `old_value`, and the
  batch's `notifications[]` reaches every message whole.
- **The `:u:` path is rare.** Every measured field change carried a comment
  id; `:u:` keeps an update without one well-formed.
- **`edited` is always `false`** on a webhook message and `dateSent` is
  `new Date(created)`. A comment edit fires no webhook, so
  `processMessageUpdated` is never called (D18).
- **Author.** `userId = <host>:<createdUser.id>`,
  `userName = createdUser.userId ?? createdUser.name`,
  `fullName = createdUser.name`, `isMe = isBot = (createdUser.id === botUserId)`.
  Backlog has no bot attribute, and `"unknown"` would make the core's
  `getParticipants` drop everyone.
- **Attachments** are `{ type: "file", name, size, url, fetchData }`, with an
  authenticated API URL (§6.6); the MIME type is unknown until download.
- **Pull-request status changes.** Merging — in the UI or by pushing the merge
  — and closing arrive as type 19 with `changes[field="status"]` (`1` Open →
  `3` Merged / `2` Closed, ids as strings) and an empty changelog comment.
- **A pull request created with `notifiedUserId[]`** also creates a system
  comment no activity announces, so `fetchMessages` returns one message the
  webhook never delivered.
- **Linking an issue to a pull request** emits a type 3 on that issue whose
  comment is a localized system sentence, alongside the type 19. It arrives as
  an ordinary issue comment; nothing marks it as machine-generated.

### 5.4 Mention detection (D9)

Backlog stores mentions as `<@U<id>>` / `<@T<id>>` / `<@project>` but returns
the resolved text `@<display name>` everywhere. A webhook body also names the
users the activity notified, in the top-level `notifications[]`; the same
activity read from `GET /space/activities` carries `[]`. A message is a
mention when any rule holds:

1. **Text.** `(?<![\w@])@<escaped botUserName>(?![\w-])`, case-sensitive,
   against `text` (type 1 and 18: summary and description). `@Chatbot`,
   `@Chatbotさん` and `(@Chatbot)` match; `@Chatbot2`, `foo@Chatbot`,
   `@@Chatbot` and an unresolved `<@U999>` do not.
2. **Assignment at creation.** Types 1 and 18: `content.assignee?.id === botUserId`.
3. **Assignment by update.** A `changes[]` entry whose `field` is
   `"assigner"` or `"assignee"` and whose `new_value` equals `botUserName`, on
   every type. Backlog names the field `assigner` on issues (types 2 and 14)
   and `assignee` on pull requests (type 19), and reports the new assignee by
   display name; either name is accepted on either kind.
4. **A raw `<@U…>` in a pull-request summary.** Backlog leaves a `<@U…>`
   mention unrewritten in a pull request's summary, so type-18 text is also matched
   against `<@U<botUserId>>`. A handler that matches the display name in text
   finds nothing there; it reads `isMention`.
5. **Notification.** Any `notifications[]` entry with `user.id === botUserId`,
   whatever its `reason`. This is the only rule that catches a comment whose
   recipients were chosen in the notification field, which leaves no `@name`
   in the text, and an assignment a multi-field `PATCH` left out of
   `changes[]`.

On types 2, 3, 19 and 20, `content.assignee` is the **standing** assignee,
repeated on every delivery, and is not read: it would make every comment on a
bot-assigned subject a mention. An assignment on those types is a mention only
through rule 3 or rule 5.

`message.isMention` is pre-set from these. The core additionally runs its own
`@<userName>` regex — case-insensitive, ORed in — so `@chatbot` reaches a
handler with `isMention` true although rule 1 alone says false. The core can
only add mentions. A hand-typed `@Chatbot`, and a display name another user
shares, are accepted false positives.

Outbound, a consumer writes Backlog's mention syntax itself; the package
exports no helper. `<@U<id>>` in content notifies the user without `notifiedUserId`;
`notifiedUserId` notifies without a visible mention.

### 5.5 Delivery semantics

- **At least once.** The core dedupes on `dedupe:backlog:<message.id>` for
  `dedupeTtlMs` (10 minutes by default); a redelivery after that is processed
  again. `message.id` is stable across deliveries and equal to the id an
  activity replay produces, so durable idempotency keys on it.
- **200 first.** Backlog's delivery timeout is undocumented, so the response
  never waits for processing; a serverless host passes `waitUntil`.
- **Down may mean lost.** Deliveries attempted while the endpoint answered 503
  were not observed to be redelivered. Redelivery is no availability
  guarantee.
- **Subscriptions are core state.** An in-memory `StateAdapter` forgets them
  on restart.

## 6. Egress

Every egress member decodes `threadId`, refuses a host other than the
configured space, and reaches the issue or pull-request endpoints its subject
selects (D-PR2). A root or update message id (`:r`, `:u:`) is refused with
`ValidationError("backlog", "<id> is not a comment and cannot be <edited|deleted|starred>")`, naming the operation attempted
(D12).

### 6.1 `postMessage(threadId, message)`

1. Upload every `extractFiles(message)` entry, one at a time, through
   [Post Attachment File](https://developer.nulab.com/docs/backlog/api/2/post-attachment-file/).
   `file.data` must be a `Buffer`, an `ArrayBuffer` or a `Blob`; anything else,
   or a `Blob` whose bytes cannot be read, is a `ValidationError` naming the
   file, raised when that file's turn comes; a read failure is its `cause`.
2. Render the message as Markdown (§9). A `string`, `{ raw }` and
   `{ markdown }` pass through untouched; `{ ast }` is stringified; a card
   renders as fallback text (§9.1), and a caller-supplied `fallbackText` is
   posted verbatim instead.
3. [Add Comment](https://developer.nulab.com/docs/backlog/api/2/add-comment/)
   or [Add Pull Request Comment](https://developer.nulab.com/docs/backlog/api/2/add-pull-request-comment/)
   with `content`, `notifiedUserId[]` and `attachmentId[]`.
4. Return `{ id: <host>:<subject>:c<comment.id>, threadId, raw: { kind: "comment", … } }`.

A failed step rejects; no synthetic message is returned. Uploads that
succeeded before a failure are abandoned, and Backlog deletes them after an
hour. The caller's message object is never mutated.

### 6.2 `editMessage(threadId, messageId, message)`

Update Comment, or its pull-request counterpart, with the rendered `content`.
Files or extras on the edit are a `ValidationError`. Returns the updated
`RawMessage`. Backlog lets a user edit only their own comments, so a foreign
comment surfaces as `PermissionError`.

### 6.3 `deleteMessage(threadId, messageId)`

Get Comment, then
[Delete Comment](https://developer.nulab.com/docs/backlog/api/2/delete-comment/);
resolves `void`, and a 404 is `ResourceNotFoundError`. An issue comment whose
`changeLog` is not empty — one that added an attachment or changed a field —
is refused with
`AdapterError("Backlog keeps an issue comment that records a change or an attachment; edit the comment instead", "backlog", "UNSUPPORTED_OPERATION")`
before Delete Comment is sent, because Backlog answers 200 but keeps such a
comment and its attachment (D31). On a pull-request thread it throws
`AdapterError("Backlog has no endpoint to delete a pull request comment", "backlog", "UNSUPPORTED_OPERATION")`
before any call (D-PR3).

### 6.4 `stream(threadId, textStream, options?)` (D4)

Consumes the iterable to completion, joining `string` and
`{ type: "markdown_text" }` chunks and ignoring the others, then makes exactly
one `postMessage(threadId, { markdown })` and returns its result. An empty
buffer posts `" "`, the core's own fallback, so a `SentMessage` always exists.
`options.signal` is not read: under `thread.post` the core ends the iterable
when its signal aborts, so an abort posts what was buffered so far; a direct
caller's `stream()` returns when its own iterable ends.

### 6.5 Reactions

- `addReaction(threadId, messageId, emoji)`: [Add Star](https://developer.nulab.com/docs/backlog/api/2/add-star/)
  with `commentId` on an issue thread, `pullRequestCommentId` on a
  pull-request thread; the emoji is ignored. The comment is read first, and a
  star the bot already presented makes the call a no-op: Backlog accepts the
  same star twice and shows two. Two calls in flight for one comment can
  still both post.
- `removeReaction(…)`: reads the comment and deletes each star whose
  `presenter.id` is the bot through
  [Remove Star](https://developer.nulab.com/docs/backlog/api/2/remove-star/);
  without one it resolves with no call. Never deletes another user's star.

### 6.6 Files and attachments (D11)

| Source | Attachment |
| --- | --- |
| Webhook types 1–3 and 18–20 `content.attachments[]` | `type: "file"`, `name`, `size`, `url`, `fetchData` |
| REST issue comment `changeLog[]`, `field === "attachment"` with `newValue` set (an add; a removal is skipped) | the same, `name = newValue`, id from `attachmentInfo.id`, `size` unknown |
| Webhook type 20 `changes[field="attachment"]` and REST pull-request comment `changeLog[field="attachment"]` | `type: "file"`, `name`; no id is carried, so `url` and `fetchData` resolve it lazily through the pull request's attachment list by name, the newest match winning (D-PR10) |

`url` is the authenticated API URL —
`https://<host>/api/v2/issues/<issueId>/attachments/<id>` or
`https://<host>/api/v2/projects/<projectId>/git/repositories/<repositoryId>/pullRequests/<number>/attachments/<id>` —
and `fetchData()` downloads it through the client as a `Buffer`. A root
message carries no attachments; a consumer that wants a body's files asks
`client().getIssueAttachments` or `getPullRequestAttachments`.

`rehydrateAttachment(attachment)` rebuilds `fetchData` from `url` after a JSON
round trip, for a URL whose host is the configured space and whose path is one
of the two shapes above; any other attachment is returned unchanged, without
`fetchData` (§11).

### 6.7 Unsupported egress

`openDM`, `postEphemeral`, `openModal`, `scheduleMessage`, `reply`,
`postObject` / `editObject`, `channel.post` (D24), editing an issue or
pull-request body (`editMessage(:r)`, D12), deleting a pull-request comment
(D-PR3), emoji reactions (no API), and changing a pull request's status (no
API).

## 7. Reads

### 7.1 `fetchMessages(threadId, { limit?, cursor?, direction? })`

[Get Comment List](https://developer.nulab.com/docs/backlog/api/2/get-comment-list/)
and [Get Pull Request Comment](https://developer.nulab.com/docs/backlog/api/2/get-pull-request-comment/)
take `minId`, `maxId`, `count` 1–100 and `order`. Both bounds are exclusive and
`count` cuts from the head of `order`, so a backward page is
`order=desc&maxId=<cursor>`, a forward page `order=asc&minId=<cursor>`, and the
previous page's edge id is the next cursor as is.

| Input | Rule |
| --- | --- |
| `limit` | Default 50, clamped to `[1, 100]`. A non-integer is a `ValidationError`. The root message takes one slot. |
| `direction` | Default `"backward"`. |
| `cursor` | `^(0\|[1-9]\d*)$`, else `ValidationError`: a comment id, or `0` for "before the first comment", forward only. |
| a channel id as `threadId` | `ValidationError`. |

Algorithm: `startsWithRoot = direction === "forward" && cursor === undefined`;
`commentLimit = startsWithRoot ? limit - 1 : limit`; request
`count = max(commentLimit, 1)` comments; `hasMore = comments.length >= count`;
the page is the first `commentLimit` comments in ascending id order, with the
root message prepended when `startsWithRoot`, or when backward and `!hasMore`.
`nextCursor` is `undefined` when `!hasMore`; otherwise the oldest comment id on
a backward page, the newest on a forward one, or `"0"` for a forward page that
held only the root.

A forward `limit: 1` page still fetches one comment, only for `hasMore`: it is
what separates "come back with cursor 0" from "this thread has no comments".

Guarantees: pages are chronological; backward pages walk from newest to
oldest; the union of all pages in either direction is the root plus every
comment exactly once; a page never exceeds `limit`. `formatted` is `text`
parsed as Markdown (§9), `text` stays Backlog's text. A comment message has
`edited = comment.updated !== comment.created` and `editedAt`; the root has
`edited: false`, because `updated` moves on any field change. Backlog's
timestamps are second-granular, so an edit made within the second the comment
was posted reports `edited: false` with no `editedAt`. The list includes
changelog comments and, on a pull request, the system comment of §5.3.

### 7.2 `fetchMessage(threadId, messageId)`

`null`, without a call, when the message's host or subject differs from the
thread's, and for a `:u:` id (D12). `:r` reads
[Get Issue](https://developer.nulab.com/docs/backlog/api/2/get-issue/) or
[Get Pull Request](https://developer.nulab.com/docs/backlog/api/2/get-pull-request/);
`:c<id>` reads [Get Comment](https://developer.nulab.com/docs/backlog/api/2/get-comment/)
on an issue, and on a pull request — which has no single-comment endpoint —
the comment list with `minId = id - 1`, `maxId = id + 1`, `count = 1`, where an
empty page or a different id is not found. `ResourceNotFoundError` becomes
`null`; any other error propagates.

### 7.3 `fetchThread(threadId)`

Issue: one Get Issue →
`{ id, channelId, channelName: <project key>, isDM: false, metadata: { kind: "issue", host, projectId, issueId, issueKey, summary, status: { id, name }, url: https://<host>/view/<issueKey> } }`.

Pull request: one Get Pull Request →
`{ id, channelId, channelName: <project key>, isDM: false, metadata: { kind: "pullRequest", host, projectId, repositoryId, number, summary, status: { id, name }, url? } }`,
with `url = https://<host>/git/<projectKey>/<repositoryName>/pullRequests/<number>`.
The object carries neither name: the project key comes from a cache filled by
one [Get Project](https://developer.nulab.com/docs/backlog/api/2/get-project/)
per project, and the repository name from a cache filled by every pull-request
webhook that carries `content.repository.name` and, on a miss, by one
[Get Git Repository](https://developer.nulab.com/docs/backlog/api/2/get-git-repository/).
Both last the process's lifetime. A name lookup that fails is not cached, logs
`warn` `project key lookup failed; url omitted` or
`repository name lookup failed; url omitted`, and leaves `url` out.
Statuses are `1 Open`, `2 Closed`, `3 Merged`.

`metadata` names the thread and nothing more; every other field is on
`fetchSubject().raw` (D24).

### 7.4 `fetchSubject(raw)`

The issue or pull request `raw` belongs to (one Get Issue or Get Pull Request;
none for the `issue` and `pullRequest` kinds), as a `MessageSubject`:

- issue: `{ id: <threadId>, type: "issue", title: summary, description, status: status.name, url, author: { id: <host>:<createdUser.id>, name }, assignee?, labels: [issueType.name, priority.name], raw: issue }`
- pull request: `{ id, type: "pull_request", title, description, status, url?, author, assignee?, labels: [status.name, "<base> ← <branch>"], raw: pullRequest }` (D-PR8)

The core calls it lazily from `message.subject` and turns an error into `null`.

### 7.5 `fetchChannelInfo(channelId)`

[Get Project](https://developer.nulab.com/docs/backlog/api/2/get-project/) →
`{ id: channelId, name: project.name, isDM: false, metadata: { host, projectId, projectKey } }`.
It touches no cache.

### 7.6 `listThreads(channelId, { limit?, cursor? })`

[Get Issue List](https://developer.nulab.com/docs/backlog/api/2/get-issue-list/)
with `projectId[]`, `count` (`limit` as in §7.1) and `offset` (the cursor, same
pattern). The endpoint spends the **search** limit. Order is Backlog's default
for the endpoint, closed issues included (D13). Each issue →
`{ id: threadId, rootMessage, lastReplyAt: new Date(issue.updated) }`, with no
`replyCount`. `nextCursor = String(offset + issues.length)` when the page is
full, so a trailing empty page is possible. Pull requests are not listed
(D-PR7); `client().getPullRequests(projectId, repositoryId, …)` lists them
and spends `read`.

### 7.7 `getUser(userId)`

[Get User](https://developer.nulab.com/docs/backlog/api/2/get-user/) →
`{ userId: <host>:<id>, userName: user.userId ?? user.name, fullName: user.name, isBot: id === botUserId, email: user.mailAddress ?? undefined }`;
`ResourceNotFoundError` becomes `null`. `chat.getUser()` cannot route here —
the core infers the adapter from the id's shape — so a consumer calls
`adapter.getUser()`.

## 8. Backlog client

### 8.1 Calls

The adapter calls `backlog-js`'s typed methods on the client `client()` hands
out (§3.3). Which of Backlog's per-user limits
([Rate limit](https://developer.nulab.com/docs/backlog/rate-limit/)) each call
spends:

| Member | Calls | Limit |
| --- | --- | --- |
| `initialize`, `handleWebhook` | `getMyself` when the bot id is not configured (D23) | read |
| `fetchThread`, `fetchSubject` on a pull request | `getProject`, once per project per process (§7.3) | read |
| `postMessage` | `postSpaceAttachment` per file; `postIssueComments` / `postPullRequestComments` | update |
| `editMessage` | `patchIssueComment` / `patchPullRequestComments` | update |
| `deleteMessage` | `getIssueComment`; `deleteIssueComment` | read, update |
| `addReaction` / `removeReaction` | one comment read; `postStar` / `removeStar` | read, update |
| `fetchMessages` | `getIssueComments` / `getPullRequestComments`; `getIssue` / `getPullRequest` for the root | read |
| `fetchMessage`, `fetchThread`, `fetchSubject` | `getIssueComment`, `getIssue`, `getPullRequest`, `getPullRequestComments`; `getGitRepository` on a name-cache miss | read |
| `fetchChannelInfo` | `getProject` | read |
| `listThreads` | `getIssues` | **search** |
| `getUser` | `getUser` | read |
| `fetchData` | `getIssueAttachment` / `getPullRequestAttachment`; `getPullRequestAttachments` to resolve an id by name | read |

The adapter neither classifies requests into these limits nor tracks them
(D5). `attachmentId[]` is sent to `postPullRequestComments` although
`backlog-js` leaves it out of that method's type; Backlog accepts it.

### 8.2 Requests

Every request, the adapter's and a consumer's through `client()`, goes through
the `fetch` injected into the client:

- **Credentials** are resolved per request and sent as the `Backlog-API-Key`
  or `Authorization: Bearer` header
  ([Authentication](https://developer.nulab.com/docs/backlog/auth/)), never as
  the `apiKey` query parameter. A resolved value the header refuses (CR/LF) is
  an `AuthenticationError`, and no request is made.
- **Timeout.** Each request, body included, is aborted after 30 s, as a
  `NetworkError`.
- **Errors** are mapped (§8.5) before `backlog-js` sees the response, so no
  `backlog-js` error reaches a caller.

### 8.3 Responses

Each response the adapter reads is parsed once, by a schema of the fields the
adapter uses; every other key is kept as Backlog sent it, and the parsed value
is what `message.raw` carries (§3.5). The schemas normalise what Backlog sends
inconsistently: a `description` `?? ""`, `changeLog ?? []`, `stars ?? []`,
`user.userId ?? null`, `assignee ?? null`, `changeLog[].attachmentInfo ?? null`.
A response that fails its schema is `AdapterError(…, "backlog", "SCHEMA")`
naming the failing path; a 2xx body that is not JSON, or cannot be read, is a
`NetworkError`. A download's file name comes from the comment or payload that
named the file, never from `Content-Disposition`.

### 8.4 429 retry (D5)

- On HTTP 429 or error code 13, `X-RateLimit-Reset` (UTC epoch seconds) is
  trimmed and parsed; an empty or non-finite value is missing. With a reset,
  `waitMs = max(reset * 1000 - now, 1000) + jitter`, jitter uniform in
  `[0, 250)` ms; without one, `waitMs = 60 000`.
- If `waitMs > 60 000`, or this was already the retry, the call rejects with
  `AdapterRateLimitError("backlog", ceil(waitMs / 1000))`; otherwise it waits
  and sends the same request once more. Backlog sends no `Retry-After`. Both
  bounds are constants, not configuration.
- No other status is retried: a repeated `POST` would duplicate a comment.
- The wait blocks the calling promise for up to 60 s, so a runtime that caps
  execution time must allow more than that.
- Each outcome logs one `warn` — `rate limited; waiting for the limit to reset`
  or `rate limited; not retrying` — with `{ remaining?, resetAt?, waitMs, attempt }`,
  the first two omitted when the response carried no usable header. Nothing
  else about rate limits is logged.

### 8.5 Error mapping (D6)

Precedence: `errors[0].code` from the body
([Error response](https://developer.nulab.com/docs/backlog/error-response/)),
then the HTTP status, then the transport.

| Source | Thrown |
| --- | --- |
| code 11 | `AuthenticationError` |
| code 4, 5 | `PermissionError` |
| code 6 | `ResourceNotFoundError` |
| code 7, 10 | `ValidationError` |
| code 13 | `AdapterRateLimitError`, after §8.4 |
| code 1, 2, 3, 8, 9, 12 | `AdapterError(message, "backlog", String(code))` |
| status 401 / 403 / 404 / 400 / 429 without a code | `AuthenticationError` / `PermissionError` / `ResourceNotFoundError` / `ValidationError` / `AdapterRateLimitError` |
| any other status | `AdapterError(message, "backlog", String(status))` |
| `fetch` rejection, abort, DNS failure, unreadable body | `NetworkError(message, cause)` |
| a response failing its schema | `AdapterError(…, "SCHEMA")` |
| a credential resolver that throws, or resolves a value with CR/LF | `AuthenticationError` |

Every mapped error's `cause` is a plain
`{ status, code?, message, moreInfo?, url }` with the query string stripped —
never the `backlog-js` error and never the request. Backlog's message is on
`error.message` too, appended where the class composes its own
(`ResourceNotFoundError`, `AdapterRateLimitError`).

## 9. Formatting

Markdown (GFM) only (D32). Every project is treated as if its
`textFormattingRule` were `"markdown"`, and the setting is never read: on a
project set to Backlog notation, a post appears as Markdown source and incoming
notation is read as Markdown.

`toAst` is `chat`'s `parseMarkdown` (remark + GFM) and does not throw;
`fromAst` and `renderFormatted(content)` are `stringifyMarkdown(ast).trim()`,
and a failure there propagates, so a post that cannot be rendered fails rather
than posting something else. `{ markdown }` is posted verbatim, without a round
trip through `stringifyMarkdown`.

### 9.1 Cards

A card renders as Markdown fallback text:

| Card child | Rendered as |
| --- | --- |
| title, field label | `**…**` |
| `link` | `[label](url)`, or the bare URL when the label is empty or equal to it |
| `text`, subtitle | as written, unconverted |
| `table`, `chart` | `chat`'s space-aligned plain text |
| emoji placeholder (`{{emoji:tada}}`) | as written |
| `divider`, `image`, `actions` | nothing |

A single-column table's dash row turns the line above into a setext heading
(D26).

## 10. Logging

- Everything goes through the `Logger` from `chat`; nothing is written to the
  console directly.
- `debug` for per-request flow (a skipped self message); `info` for ignored
  activity types; `warn` for rejected webhooks, a name lookup that left a URL
  out and the two rate-limit outcomes; `error` for processing
  failures after the 200 (their only carrier), a webhook before `initialize`,
  and one whose bot identity could not be learned.
- Structured fields only — `host`, `projectId`, `repositoryId`, `type`,
  `threadId`, `issuePaths`, `remaining`, `resetAt`, `waitMs`, `attempt`, and
  `error` as the caught error's message. Never a body, comment text, token,
  API key, `Authorization` value or full request URL (it carries `?token=`).
- Messages are English, one line and stable.

## 11. Security

- **Secrets stay in headers.** API keys travel in `Backlog-API-Key`, tokens in
  `Authorization`; errors and logs carry URLs with the query string stripped.
- **Webhook authenticity** (D2). A secret of at least 16 bytes or a verifier
  is required at construction, and the secret is compared in constant time.
  Backlog offers no HMAC
  ([Add Webhook](https://developer.nulab.com/docs/backlog/api/2/add-webhook/)
  accepts only `name`, `description`, `hookUrl`, `allEvent`,
  `activityTypeIds[]`), so the URL secret is the strongest check available;
  an IP allowlist or Basic auth in the hook URL plugs in through
  `webhookVerifier`. Every failure is the same 401.
- **Another space's webhook is authentic** (D19). Nothing in a Backlog body
  identifies its space, so space B's webhook sent to space A's URL with space
  A's secret passes, and its ids are then read with space A's credentials.
  Two spaces can mint ids from interleaving ranges, so the outcome ranges from
  a 404 to a comment on an unrelated issue. Registering the URL only in its own
  space is the only control.
- **SSRF.** The only URLs the adapter builds are
  `https://<configured host>/api/v2/…`; `rehydrateAttachment` refuses any
  other host.
- **Body size.** Without a verifier, the body is not read until the token
  matched, so an unauthenticated caller cannot make the process buffer it. A
  verifier is handed the body, so it is read first; a deployment that cannot
  accept that puts its check in front of the function.
- **Subscription hygiene.** Registering
  `activityTypeIds: [1, 2, 3, 14, 18, 19, 20]` (plus 4 for deletions), never
  `allEvent` (D10), keeps unrelated activity away. The subscription is also
  the only switch for a kind (D-PR4) and for type 14's fan-out (D22).

## 12. Design decisions

Each row is one decision, the reason it holds, and what was rejected. The
evidence for a measured reason is in the rules file named.

| # | Decision | Why | Rejected |
| --- | --- | --- | --- |
| D1 | One Backlog space per adapter; every config field but the verifier and logger falls back to an environment variable | An API key belongs to one space, so a second space is a second adapter under its own webhook URL; zero-config construction is the Chat SDK factory convention. | `installations[]` for several spaces (built and removed: a `?host=` routing parameter, per-host names and duplicate checks for a deployment nobody ran); env-only configuration (no resolver functions). |
| D2 | A webhook secret of at least 16 bytes, or a verifier, is required; every failure is one identical 401 | Backlog has no HMAC, so the URL secret is the whole check and a guessable one is a way in; config parsing has no logger to warn into. | An optional secret; a warning for a short one. |
| D4 | `stream()` buffers and posts once; an empty buffer posts `" "` | The core's 500 ms edit loop spends about 120 updates a minute against a documented example of 150 (`backlog-api-facts.md`), and a comment edit emits no webhook anyway. `" "` keeps `stream()` resolving to a `SentMessage`, as the core does. | Omitting `stream`; throttled edits; returning `null` for an empty stream. |
| D5 | One retry on a 429, waiting for the failing response's own reset for at most 60 s, as constants; no tracking of the limits | Limits are per user and per plan, and a 429 carries its own reset (`backlog-api-facts.md`); neither first-party reference adapter tracks limits or exposes retry tuning. | Hard-coded per-plan limits; unbounded backoff; per-bucket tracking and a public snapshot (built and removed: nothing read it); `rateLimit.*` options; no retry. |
| D6 | Error class from `errors[].code` first, the status second; the detail as `cause` | Backlog maps meaning to codes and reuses statuses. | Status-only mapping; re-exporting `backlog-js` errors. |
| D7 | No host-application hooks; `client()` is the only escape hatch | Engagement and subscription state is the `StateAdapter`'s. | An engagement callback, an inbound observer, dedupe-key helpers. |
| D8 | Numeric ids; the host inside message and user ids | A project-key rename rewrites issue keys (`backlog-webhook-facts.md`); the core's dedupe key has no thread component. | Issue keys in ids; host-less message ids. |
| D9 | A mention is a notification naming the bot (any `reason`), the display name in text, or an assignment to the bot | The notification list is the only signal for recipients chosen in the notification field, and a watcher never appears in it (`backlog-webhook-facts.md`). | Text and assignment only; filtering on `reason: 2`; a case-insensitive match. |
| D10 | Types 1–4, 14 and 18–20 are processed and the rest ignored; `allEvent` is never registered | Only issue and pull-request activity maps to a thread. Type 17 carries the original comment under the id already dispatched, and dedupe holds only for `dedupeTtlMs`, so a recipient added later would redeliver the same message (`backlog-webhook-facts.md`). The accepted cost: adding the bot as a recipient to an existing comment is never a mention. | `allEvent`; dispatching 17. |
| D11 | Uploads in two steps; downloads through the client; `rehydrateAttachment` from the API URL | A Backlog attachment needs authentication, and a URL is the only handle that survives a queue. | Public URLs (none exist); `fetchMetadata` blobs. |
| D12 | Root and update messages cannot be edited, deleted or starred; `fetchMessage(:u:)` is `null` | Editing what the bot posted does not extend to rewriting a person's issue, and an update has no resource. | `editMessage(:r)` as Update Issue. |
| D13 | `listThreads` keeps Backlog's order and filters nothing | Sorting or filtering in the adapter would hide the search-limit cost. | "Open issues first". |
| D14 | Superseded by D32. The formatting rule is cached per project for the process's lifetime; synchronous members read only the cache | A third of the projects on a measured space use notation (`backlog-api-facts.md`), and the setting rarely changes. | A TTL; `fetchChannelInfo` rewriting the cache (built and removed); Markdown only. |
| D15 | `chat` peer `^4.40.0`, `@chat-adapter/shared` `^4.40.0`, `backlog-js` `^0.20.1`, `engines.node >=20`; the package's own semver from `0.1.0` | 4.40.0 is the contract verified; a caret range spares a consumer on a later minor a second core. | Exact pins; tracking `chat`'s version line. |
| D18 | No `processMessageUpdated` | A comment edit emits no webhook (`backlog-webhook-facts.md`). | Polling for edits. |
| D19 | Every authentic delivery is taken to be from the configured space | No body field identifies a space, and `projectKey` changes on a rename (`backlog-webhook-facts.md`). | Cross-checking `projectKey` (drops events after a rename). |
| D22 | A type 14 fans out to one message per `content.link[]` entry, always; its `notifications[]` is carried whole | Each entry is a real comment `fetchMessages` returns, so ignoring 14 loses changes, and leaving it out of the subscription is the switch. An entry of `notifications[]` names no issue, so pairing by order would rest on nothing Backlog documents (`backlog-webhook-facts.md`). | Ignoring 14; a config flag; one summary message; capping the batch; a single-entry batch as a type 2; pairing `notifications[i]` with `link[i]`; dropping `notifications` from `raw.payload`. |
| D23 | The bot identity is optional: without `botUserId`, one `GET /users/myself`; with it, no request; a failed lookup is retried on demand, and a webhook without an id is 503 | Every serverless cold start runs `initialize`; the core never retries a rejected `initialize`; dispatching without the id lets the bot answer itself. | Both fields required; always looking up a missing name; a lazy lookup on the first webhook only; rejecting `initialize`; dispatching without the id. |
| D24 | No `postChannelMessage`, no `markAsRead`; `ThreadInfo.metadata` names the thread only | No consumer needs them and neither first-party reference adapter has them; an issue created from a message had to guess its type and priority; a full copy in `metadata` duplicated `fetchSubject().raw`. | Keeping them because Backlog makes them possible. |
| D25 | `raw.payload` is typed as `backlog-js`'s `Entity.Activity` with the measured deviations overlaid, discriminated on `type` | One type follows `backlog-js`, and only a measured deviation is declared here. | A loose envelope with `Record<string, unknown>`; hand-written per-type interfaces. |
| D26 | Card fallback text renders a link as a Markdown link and drops a divider | The card walk `chat` uses drops a link's URL, which loses content. A dropped divider loses none, and the `---` the adapter used to emit turned the line above it into a setext heading. | Leaving `link` to `chat`; `---` or `***` for the divider. |
| D27 | Superseded by D32. Notation's `\` escape is not applied to user text | Which characters `\` escapes, and whether a literal `¥` does, is undocumented; escaping by guess would eat a caller's backslashes or mangle prices (issue #92). | Escaping the documented characters only; escaping every marker. |
| D28 | No timestamp window on webhooks | A Backlog timestamp is unsigned, so a window protects nothing, and redeliveries arrive about 20 minutes late (`backlog-webhook-facts.md`). | Rejecting payloads older than N minutes. |
| D29 | The adapter does not dispatch the bot's own activity | `selfMessageContract` requires it; the core's `isMe` check is a second line. | Relying on the core alone. |
| D30 | No webhook body-size limit of the adapter's own, and no 413 | Hosting platforms already cap request bodies, and no consumer needed a second, configurable cap (maintainer decision, 2026-09-27). | A `maxWebhookBodyBytes` option with a 413. |
| D31 | `deleteMessage` on an issue comment with a non-empty `changeLog` throws `UNSUPPORTED_OPERATION`, after one Get Comment | Backlog answers 200 but keeps any comment that records a change, emptying its content, and keeps an attached file on the issue (`backlog-api-facts.md`); resolving would fabricate a deletion, as in D-PR3. | Sending Delete Comment and resolving; refusing only a comment that added an attachment. |
| D32 | Markdown (GFM) only: the project's `textFormattingRule` is not read, and a project using Backlog notation is not supported | Notation projects exist (`backlog-api-facts.md`), but no consumer has asked for them, and the converter built for them covered only the common constructs: no `\` escaping (#92), inline code and table alignment dropped, several macros left unconverted, heading and list rules that disagreed between directions (#94), one input in 31 not surviving a round trip. Backlog's Markdown is GFM, which `chat` already parses and prints (maintainer decision, 2026-09-27). | Keeping the partial notation support; adding notation's `\` escape to it (#92); warning on a notation project (a Get Project per project for a message nobody asked for). |
| D-PR1 | A pull-request thread's channel is its project | Webhooks carry `project.id`, and a project holds both kinds of thread. | The repository as channel. |
| D-PR2 | The kind is explicit in every id, as one nested `BacklogSubjectRef` | Issues and pull requests have different endpoint families, coordinates and comment id sequences (`backlog-pull-request-facts.md`). | A flat optional-field shape; issues as the unmarked default. |
| D-PR3 | `deleteMessage` on a pull-request thread throws `UNSUPPORTED_OPERATION` before any call | The endpoint does not exist (`backlog-pull-request-facts.md`); a `ValidationError` would blame a correct call; success would be fabricated. | `ValidationError`; a no-op; omitting `deleteMessage` (it is required). |
| D-PR4 | No option selecting kinds | The webhook subscription already is that switch. | A `subjects` config. |
| D-PR5 | Type 21 is ignored and not registered | It was never observed: merge and close arrive as type 19, and nothing deletes a pull request (`backlog-pull-request-facts.md`). | Dispatching a deletion on 21. |
| D-PR6 | A pull request linked to an issue is its own thread | The link can change, and routing by it would move a thread. | Routing into the linked issue's thread. |
| D-PR7 | `listThreads` lists issues only | A pull-request list is per repository, a coordinate a channel id lacks. | Interleaving every repository's pull requests; listing pull requests only. |
| D-PR8 | `fetchSubject().type` is `"pull_request"` | The `@chat-adapter/github` convention bot authors already branch on. | `"pullRequest"`. |
| D-PR9 | The root part is `r` for both kinds | A kind-named tag would mislead on the other kind. | `i`; no tag. |
| D-PR10 | A pull-request comment's attachment resolves its id by name, the newest match winning, when read | Neither the webhook nor REST carries its id (`backlog-pull-request-facts.md`). | No `fetchData`; one list call per comment. |
| D-API1 | The public surface is the adapter, its factory, the types reachable from them, two id decoders and `client()` | Every export is permanent, and the first-party adapters export the same kinds of thing and one client getter; the decoders read a grammar no `Adapter` member reads back. | A second escape hatch; a `createApi` config field with an exported in-memory port; free-function codecs; mention helpers; the converters. |
