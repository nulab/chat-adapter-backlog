# @nulab/chat-adapter-backlog

A [Backlog](https://backlog.com/) adapter for [Chat SDK](https://chat-sdk.dev/) —
Backlog issues and pull requests become threads, comments become messages, and
an agent replies by commenting.

[![npm](https://img.shields.io/npm/v/@nulab/chat-adapter-backlog)](https://www.npmjs.com/package/@nulab/chat-adapter-backlog)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/nulab/chat-adapter-backlog/blob/main/LICENSE)

## Status

Pre-1.0, starting at `0.1.0`: while the major is `0`, a breaking change ships as
a minor release. All 17 required members of `chat@4.40.0`'s adapter contract
are implemented, plus 10 of the 27 optional ones; **Features and limitations**
says where Backlog stops short. Not yet listed in Chat SDK's adapter catalog.

## Installation

```sh
pnpm add @nulab/chat-adapter-backlog chat @chat-adapter/state-memory @vercel/functions
```

`chat` is a peer dependency at `^4.40.0`. Node 20 or newer. The other two
packages are only what **Quick start** uses: swap in a durable state adapter
and your runtime's own `waitUntil`.

## Quick start

```ts
import { Chat } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';
import { waitUntil } from '@vercel/functions';
import { createBacklogAdapter } from '@nulab/chat-adapter-backlog';

const backlog = createBacklogAdapter({
  host: 'example.backlog.com',
  apiKey: process.env.BACKLOG_API_KEY,
  botUserId: 999,
  botUserName: 'Chatbot',
  webhookSecret: process.env.BACKLOG_WEBHOOK_SECRET,
});

// The config key must equal the adapter's name: Chat SDK routes thread ids by
// their prefix, and every thread id this adapter mints starts with "backlog:".
const chat = new Chat({
  adapters: { backlog },
  state: createMemoryState(),
  userName: backlog.userName,
});

chat.onNewMention(async (thread, message) => {
  await thread.post({ markdown: `Saw: ${message.text}` });
});

export async function POST(request: Request) {
  return chat.webhooks.backlog(request, { waitUntil });
}
```

The webhook answers 200 before the handler runs; `waitUntil` keeps a
serverless invocation alive until it finishes. A long-lived Node server can omit
it. The memory state forgets subscriptions on restart, so use a durable one in
production.

Every field falls back to an environment variable, so `createBacklogAdapter()`
with no argument works when the environment is set. For a whole deployable bot,
see [examples/](https://github.com/nulab/chat-adapter-backlog/tree/main/examples).

## Environment variables

A fallback applies only when the field is absent from the config object; an
explicit empty string is a validation error.

| Variable | Required | Meaning |
| --- | --- | --- |
| `BACKLOG_HOST` | yes | Space host without a scheme, port or path. |
| `BACKLOG_API_KEY` | one of the two | Personal API key, sent in the `Backlog-API-Key` header. |
| `BACKLOG_ACCESS_TOKEN` | one of the two | OAuth 2.0 bearer token instead of a key. |
| `BACKLOG_BOT_USER_ID` | recommended | Numeric id of the bot user. Read from `GET /api/v2/users/myself` when unset or blank — see **Bot identity**. |
| `BACKLOG_BOT_USER_NAME` | for mentions | The bot's display name, needed for a typed `@name` to count — see **Bot identity**. |
| `BACKLOG_WEBHOOK_SECRET` | unless a verifier is set | Secret carried in the webhook URL's `token` parameter. At least 16 bytes. |

## Configuration

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `host` | `string` | — | Full hostname: spaces also live on `backlog.jp` and `backlogtool.com`. |
| `apiKey` / `accessToken` | `string \| (() => string \| Promise<string>)` | — | Exactly one. The function form is resolved on **every** request and never cached, so an expiring token can be refreshed without reconstructing the adapter. |
| `botUserId` | `number` | `GET /users/myself` | Recognises the bot's own messages and assignment to it. |
| `botUserName` | `string` | `GET /users/myself` when `botUserId` is also unset | What a typed `@name` is matched against. Also `adapter.userName`. |
| `webhookSecret` | `string` | — | Required unless `webhookVerifier` is set. **At least 16 bytes**, checked at construction. |
| `webhookVerifier` | `(request, rawBody) => unknown` | — | Replaces the secret check — for an IP allowlist, mTLS or a reverse-proxy assertion. |
| `logger` | `Logger` | `ConsoleLogger("info")` | Replaced by `chat.getLogger("backlog")` in `initialize`. |

One adapter serves one Backlog space: a second space is a second adapter under
its own webhook URL. An unknown option is a `ValidationError`.

### Bot identity

With `botUserId` unset, `initialize` asks `GET /api/v2/users/myself` — the user
the key or token acts as — once, and fills a missing `botUserName` too. Set
`BACKLOG_BOT_USER_ID` and no request is ever made, which matters where every
cold start runs `initialize` again.

Without `botUserName` beside a configured id, `initialize` logs one warning: a
typed `@name` no longer counts as a mention, while notifications and
assignments still do. `adapter.userName` is then `""`, and the Chat SDK core
falls back to `new Chat({ userName })` for its own `@<name>` match. **Always give
`new Chat({ userName })` a non-empty value**: with both empty, every stray `@`
in a comment becomes a mention.

A failed lookup does not fail `initialize`; the next webhook or call that needs
the id asks again. A webhook whose bot identity still cannot be learned is
answered **503** and not dispatched, because without the id the bot cannot tell
its own comments apart.

## Platform setup

1. **Create a bot user** in the space and add it, with permission to comment,
   to every project it should answer in.
2. **Issue an API key** as that user: **Personal Settings → API**. If the
   section is missing, an administrator must enable API access.
3. **Pin its id.** `GET /api/v2/users/myself` with that key reports `id` —
   `BACKLOG_BOT_USER_ID`, not the login name — and `name`, the
   `BACKLOG_BOT_USER_NAME`.
4. **Generate a webhook secret**: `openssl rand -hex 32`.
5. **Register a webhook per project** (Project Settings → Integrations →
   Webhook, or [Add Webhook](https://developer.nulab.com/docs/backlog/api/2/add-webhook/)),
   only in the space this deployment is configured for:

   ```
   https://<your-app>/api/webhooks/backlog?token=<secret>
   ```

   Select activity types **1, 2, 3** (issue created, updated, commented),
   **14** (issues updated in bulk) and **18, 19, 20** (pull request added,
   updated, commented), plus **4** for issue-deletion events. Leave **21**
   unchecked — merging or closing a pull request arrives as a type 19 — and
   **never select `allEvent`**, which delivers git, wiki and document activity
   the adapter has no meaning for.

   These checkboxes are the only on/off switch per kind: subscribe to 1, 2, 3
   alone and no pull request reaches a handler.

   **Type 14 costs more than it looks.** An update made from the issue list is
   a single type-14 webhook for the whole batch — even a batch of one — and
   Backlog sends no per-issue event for it, so without 14 those updates reach no
   handler. With 14, the adapter unpacks the delivery into one message per
   issue: fifty issues are fifty handler runs, and fifty API calls if the
   handler makes one each. If that is more than your deployment can absorb,
   leave 14 unregistered.

## Webhook authenticity — read this

**Backlog cannot sign webhooks.** [Add Webhook](https://developer.nulab.com/docs/backlog/api/2/add-webhook/)
accepts only `name`, `description`, `hookUrl`, `allEvent` and
`activityTypeIds[]`: there is no secret parameter and no signature header. The
secret in the URL is the strongest sender-side check available, and it is
weaker than an HMAC — anyone who learns the URL can post to it. Keep the URL out
of logs and issue trackers.

The adapter compares the token in constant time, answers **401 with an
identical body** for a missing and a wrong token, and checks it **before
reading the request body**, so a caller who found the URL but not the secret
costs your function nothing but its headers. A `webhookVerifier` is handed the
body, so with one the body is read first. The adapter sets no body-size limit;
your platform or a reverse proxy does.

Harden a deployment with `webhookVerifier`: an IP allowlist against
[Backlog's published sender addresses](https://support.backlog.com/hc/en-us/articles/360051330313-Webhook-sender-IP-address)
(they are "subject to change"), Basic auth credentials in the hook URL, mTLS, or
a reverse-proxy assertion.

**A right secret from the wrong space is authentic.** No Backlog payload says
which space it came from, so the adapter takes every verified delivery to be
from the configured one. Register space B's webhook with space A's URL and
secret, and every delivery verifies and is then read with space A's
credentials. That is not reliably a harmless 404: two spaces were measured
minting issue ids from interleaving ranges, so an id from one can name a real,
unrelated issue in the other, and the bot comments there. Nothing in the
payload lets the adapter catch this (docs/specs/adapter.md D19), so register
the URL only in its own space. The trace of a misregistration is
`project lookup failed` naming a project id the space does not have.

## Issues and pull requests

Both are threads of the same shape: the root message's `text` is the summary, a
blank line, then the description; every comment — Backlog's changelog comments
included — is a message; `thread.post()` comments on the thread; and the
**project** is the channel. `message.subject` tells the kinds apart when a
handler needs to:

```ts
chat.onNewMention(async (thread, message) => {
  const subject = await message.subject; // null if the lookup failed
  if (subject?.type === 'pull_request') {
    await thread.post({ markdown: `Reviewing ${subject.title}` });
    return;
  }
  await thread.post({ markdown: `Saw: ${message.text}` });
});
```

`subject.type` is `"issue"` or **`"pull_request"`**, the string
`@chat-adapter/github` uses. `subject.labels` carries the issue type and
priority for an issue, and the status plus `"<base> ← <branch>"` for a pull
request. Elsewhere — `fetchThread().metadata.kind`, `raw.subject.kind`,
`raw.kind` — the package's own spelling is `"pullRequest"`.

A field change arrives as a comment with empty `text` and the change in
`message.raw.changes`, so key a handler on `raw.changes`, not on "has text".

## Features and limitations

| Capability | Support |
| --- | --- |
| Issue and pull-request threads | yes |
| Post and edit a comment | yes |
| Delete a comment | partial — issue comments only |
| File uploads and downloads | yes |
| Mentions | yes — notification, text match, or assignment to the bot |
| Reactions | partial — one Backlog star; the emoji is ignored |
| Streaming | partial — buffered, posted once |
| Issue creation via `channel.post()` | **no** — call `client().postIssue()` |
| Pull-request creation, merge or close | **no** — Backlog exposes no API |
| Thread listing | partial — issues only |
| User lookup, parent subject | yes |
| Message-deleted events | partial — issue deletion only |
| Message-updated events | **no** |
| DMs, ephemeral messages, modals, buttons, slash commands, scheduling, nested replies, typing indicators | no — Backlog has no counterpart |

- **Comment edits fire no webhook**, so `onMessageUpdated` never fires and text
  placed by editing reaches nobody.
- **A pull-request comment cannot be deleted.** Backlog has no endpoint, so
  `deleteMessage` there throws `AdapterError` with code
  `UNSUPPORTED_OPERATION` before any request.
- **`listThreads` lists issues only.** A pull-request list is per repository;
  use `client().getPullRequests(projectId, repositoryId, …)`.
- **`channel.post()` rejects with `ValidationError`**: a project is not a
  thread. Create an issue with `client().postIssue(...)`.
- **A pull request created with `notifiedUserId[]` gets a system comment no
  activity announces**, so `fetchMessages` returns one message the webhook
  never delivered.
- **A pull-request comment's attachment resolves its id by name.** Backlog
  names the file without an id, so `fetchData` lists the pull request's
  attachments and takes the newest match; two files with one name are
  indistinguishable.
- **A reaction is one star.** Backlog accepts the same star twice, so
  `addReaction` reads the comment first and does nothing when the bot's star
  is there. It is not a lock: two calls racing can still leave two stars.
  `removeReaction` deletes only the bot's stars.
- **A root message leads with the summary**, so a bot that reads the first word
  as a command reads the issue title. Parse the line the mention is on.
- **`stream()` is buffered on purpose.** Otherwise Chat SDK edits the message
  every 500 ms — about 120 edits a minute against a documented example limit of
  150 updates — so the adapter posts once, and `streamingUpdateIntervalMs` does
  not apply. An **empty stream posts a single space**, so `stream()` always
  resolves to a message. Handing an AI SDK `fullStream` to `thread.post()`
  hits this on a model failure: the error chunk is dropped by Chat SDK's
  `fromFullStream`, and the comment holds one space. Iterate `fullStream`
  yourself to surface the error.
- **Backlog notation is not Markdown.** On a project set to `backlog`, inline
  code becomes plain text and table alignment is dropped; `&color()`,
  `#contents`, `#rev`, `#attach`, `#thumbnail`, wiki links and issue-key
  auto-links pass through as text.
- **Notation markers in your own text become decoration.** The adapter does not
  apply notation's `\` escape, so on a `backlog` project `price is ''100''`
  bolds `100`, `50%% off, %%today` strikes text through, `[[TICKET-1]]` becomes
  a link and a line that is just `{code}` swallows the rest. Model-generated
  replies hit this without trying. Which characters `\` escapes is undocumented,
  so it is not guessed; post a `{ raw }` postable, which reaches Backlog
  verbatim, and escape it yourself.
- **`chat.getUser()` cannot route to this adapter**; call `adapter.getUser()`.
- **`thread.messages` is not free**: each page is one comment-list call.
  `listThreads` draws on Backlog's lower **search** limit.
- **Delivery is at least once.** The core dedupes on `message.id` for ten
  minutes by default; `message.id` is stable across deliveries, so key durable
  idempotency on it, and use a durable `StateAdapter`.
- **A project has no single comment stream**, so `channel.messages` is not
  meaningful.

## Ids

Every id carries the **subject** — `issue:<issueId>` or
`pr:<repositoryId>:<number>` — so a thread id and its message ids agree about
what they address.

| Kind | Shape | Example |
| --- | --- | --- |
| Channel (project) | `backlog:<host>:<projectId>` | `backlog:example.backlog.com:500` |
| Thread — issue | `backlog:<host>:<projectId>:issue:<issueId>` | `backlog:example.backlog.com:500:issue:8001` |
| Thread — pull request | `backlog:<host>:<projectId>:pr:<repositoryId>:<number>` | `backlog:example.backlog.com:500:pr:700:12` |
| Root message | `<host>:<subject>:r` | `example.backlog.com:issue:8001:r` |
| Comment | `<host>:<subject>:c<commentId>` | `example.backlog.com:pr:700:12:c4002` |
| Update without a comment | `<host>:<subject>:u:<created>` | `example.backlog.com:issue:8001:u:2026-09-03T04:05:06Z` |
| User | `<host>:<userId>` | `example.backlog.com:100` |

Ids are **numeric, never issue keys or repository names**, which a rename
rewrites. Issue and pull-request comment ids come from separate sequences and
may overlap, so keep the whole id rather than a bare comment id. Every numeric
segment is a positive integer of at most `Number.MAX_SAFE_INTEGER`; anything
outside the grammar is a `ValidationError`.

A thread id is read back with `adapter.decodeThreadId(id)`; message and user ids
with the two exported decoders:

```ts
import { decodeMessageId, decodeUserId } from '@nulab/chat-adapter-backlog';

decodeMessageId(message.id);
// { host, subject: { kind: 'issue', issueId: 8001 }, part: 'root' }
decodeUserId(message.author.userId).userId; // 100 — the numeric Backlog user id
```

## Mentions

A message is a mention when the webhook names the bot among the users it
notified, when its text matches `@<botUserName>` (case-sensitive and bounded, so
`@Chatbot2` and `foo@Chatbot` do not match), or when it assigns the issue or
pull request to the bot. The notification list is what makes the UI's
notification field work: recipients chosen there leave no `@` in the text.
Only a webhook carries that list; the same activity read from the activities
API reports none.

- **The core's check is looser.** Chat SDK runs its own `@<userName>` match
  case-insensitively and ORs it in, so `@chatbot` reaches your handler as a
  mention.
- **A pull request's summary keeps mention notation raw** — `<@U999>`, not
  `@Chatbot`. The adapter matches both, so **read `message.isMention`** rather
  than re-matching the text.
- **Being the standing assignee is not a mention.** Becoming the assignee is;
  later comments and edits on a subject the bot owns are ordinary messages.
- **A hand-typed `@Chatbot` is indistinguishable from a real mention**, and is
  accepted as one.

To mention someone outbound, write Backlog's notation — `<@U<userId>>`,
`<@T<teamId>>` or `<@project>`; it notifies even without `notifiedUserId`.
`notifiedUserId` notifies without a visible `@name`, and Backlog silently drops
ids that are not project members:

```ts
import type { PostableMarkdown } from 'chat';
import type { BacklogPostableExtras } from '@nulab/chat-adapter-backlog';

await thread.post({ markdown: '<@U100> please take a look' });

const ping: PostableMarkdown & BacklogPostableExtras = { markdown: 'ping', notifiedUserId: [100, 101] };
await thread.post(ping);
```

The annotated variable is required: an object literal passed straight to
`post()` fails its excess-property check, and an unannotated variable leaves
the extras unchecked until a `ValidationError` at run time.

## Errors

Every failure is a class from `@chat-adapter/shared` — `ValidationError`,
`AuthenticationError`, `PermissionError`, `ResourceNotFoundError`,
`AdapterRateLimitError`, `NetworkError` or `AdapterError` — chosen from
Backlog's `errors[].code` before the HTTP status. `error.cause` carries
`{ status, code?, message, moreInfo?, url }` with the query string stripped. No
`zod` or `backlog-js` error escapes the package.

## Rate limits and the raw API

Backlog limits requests **per user, per minute**, differently per plan. The
adapter does not track the limits; a request Backlog refuses with a 429 is
retried once or surfaced as `AdapterRateLimitError`. Issue listing draws on the
**search** limit, pull-request listing on `read`.

For anything outside the Chat SDK contract — custom fields, an assignee, the
pull-request list, [Get Rate Limit](https://developer.nulab.com/docs/backlog/api/2/get-rate-limit/)
— `client()` hands back the [`backlog-js`](https://github.com/nulab/backlog-js)
client the adapter itself uses, with the same 429 retry and errors. A client of
your own would have neither.

```ts
const client = adapter.client();
const fields = await client.getCustomFields(500); // projectId
const pullRequests = await client.getPullRequests(500, '700', { count: 20 }); // projectId, repositoryId
```

### A 429 blocks the call for up to a minute

A 429 is retried once, after waiting until `X-RateLimit-Reset` — **up to 60
seconds, during which the call does not return**. A reset further off, or a
second 429, rejects with `AdapterRateLimitError` at once. On a free plan (15
updates per minute) a burst of comments reaches the wait easily.

Wherever execution time is capped, allow comfortably more than 60 seconds — on
Vercel, `export const maxDuration = 90` in the function's module. Otherwise the
runtime kills the call mid-wait, and because the webhook already answered 200,
the reply disappears without an error. Both outcomes log one `warn` through the
Chat SDK logger:

```
rate limited; waiting for the limit to reset
  { remaining: 0, resetAt: '2026-09-06T12:34:00.000Z', waitMs: 55_500, attempt: 1 }
rate limited; not retrying
  { remaining: 0, resetAt: '2026-09-06T12:39:00.000Z', waitMs: 300_000, attempt: 1 }
```

## Testing

A bot's handlers receive a `Thread` and a `Message`, so test them with Chat
SDK's own kit, [`@chat-adapter/tests`](https://chat-sdk.dev/docs/testing), and
mock `adapter.client()` where a handler reaches Backlog directly. No network or
credentials are needed.

## Links

- [examples/](https://github.com/nulab/chat-adapter-backlog/tree/main/examples)
  — deployable bots built on this adapter
- [Chat SDK documentation](https://chat-sdk.dev/docs)
- [Backlog API v2](https://developer.nulab.com/docs/backlog/)
- [sample-messages.md](https://github.com/nulab/chat-adapter-backlog/blob/main/sample-messages.md)
  — a payload per activity type
- [docs/specs/adapter.md](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md)
  — the full behaviour specification
- [DEVELOPMENT.md](https://github.com/nulab/chat-adapter-backlog/blob/main/DEVELOPMENT.md)
  — contributor setup

## Package name

`chat-adapter-backlog`, Chat SDK's convention for community adapters, is taken
on npm by an unrelated package, so this one is published under `@nulab`.

## License

[MIT](https://github.com/nulab/chat-adapter-backlog/blob/main/LICENSE) © Nulab Inc.
