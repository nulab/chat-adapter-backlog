# @nulab/chat-adapter-backlog

A [Backlog](https://backlog.com/) adapter for [Chat SDK](https://chat-sdk.dev/) —
Backlog issues become threads, comments become messages, and an agent replies
by commenting.

## Status

**In progress — not yet installable.** Nothing is published to npm, and the
package entry still exports only a placeholder, so none of the imports below
resolve yet. They document the surface the finished adapter exposes, so that
this file is reviewed alongside the code that implements it rather than written
afterwards.

What is on `main` today: the Backlog API client port (with rate-limit buckets,
typed errors and bounded 429 retry), the id codec, and the Markdown and
Backlog-notation converters. Webhook ingress and the egress members land behind
them.

The finished behaviour is specified in
[docs/specs/adapter.md](./docs/specs/adapter.md) and the order of work in
[docs/plans/adapter-implementation.md](./docs/plans/adapter-implementation.md).
Registration in the [Chat SDK adapter catalog](https://chat-sdk.dev/adapters),
and whether this ships as a community or a
[vendor-official](https://chat-sdk.dev/docs/contributing/vendor-official)
adapter, are both open.

## Installation

```sh
pnpm add @nulab/chat-adapter-backlog chat
```

`chat` is a peer dependency at `^4.39.0`. Node 20 or newer.

## Quick start

```ts
import { Chat } from 'chat';
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
const chat = new Chat({ adapters: { backlog } });

chat.onNewMention(async (thread, message) => {
  await thread.post({ markdown: `Saw: ${message.text}` });
});

export async function POST(request: Request) {
  return chat.webhooks.backlog(request);
}
```

Every field falls back to an environment variable, so
`createBacklogAdapter()` with no argument works when the environment is set.

## Environment variables

Fallbacks apply only to the single-space shape, and only when the field is
absent from the config object. An explicit empty string is a validation error,
not a request to fall back.

| Variable | Required | Meaning |
| --- | --- | --- |
| `BACKLOG_HOST` | yes | Space host without a scheme, port or path. |
| `BACKLOG_API_KEY` | one of the two | Personal API key, sent in the `Backlog-API-Key` header. |
| `BACKLOG_ACCESS_TOKEN` | one of the two | OAuth 2.0 bearer token instead of a key. |
| `BACKLOG_BOT_USER_ID` | yes | Numeric id of the bot user; `GET /api/v2/users/myself` reports it. |
| `BACKLOG_BOT_USER_NAME` | yes | The bot's display name, as Backlog renders it in a comment. |
| `BACKLOG_WEBHOOK_SECRET` | unless a verifier is set | Secret carried in the webhook URL's `token` parameter. |

## Configuration

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `host` | `string` | — | Full hostname. Backlog spaces also live on `backlog.jp` and legacy `backlogtool.com`, so this is never a subdomain slug. |
| `apiKey` / `accessToken` | `string \| (() => string \| Promise<string>)` | — | Exactly one per installation. The function form is resolved on **every** call and never cached, so an expiring token can be refreshed without reconstructing the adapter. |
| `botUserId` | `number` | — | Positive integer. Recognises the adapter's own messages and assignment to the bot. |
| `botUserName` | `string` | — | Non-empty. Mentions arrive as resolved text, so this is what the mention pattern matches. |
| `webhookSecret` | `string` | — | Required on every installation unless `webhookVerifier` is set. |
| `installations` | `BacklogInstallation[]` | — | Several spaces in one adapter. Mutually exclusive with the fields above. |
| `webhookVerifier` | `(request, rawBody) => unknown` | — | Replaces the secret check entirely — for a reverse-proxy assertion, mTLS or an IP allowlist. |
| `userName` | `string` | first installation's `botUserName` | Exposed to the core as `adapter.userName`. |
| `logger` | `Logger` | `ConsoleLogger("info")` | Replaced by `chat.getLogger("backlog")` in `initialize`. |
| `rateLimit.maxWaitMs` | `number` | `60_000` | Longest wait before a 429 retry. |
| `rateLimit.maxRetries` | `number` | `1` | `0` disables retries. |
| `maxWebhookBodyBytes` | `number` | `5 * 1024 * 1024` | Larger bodies get a 413. Description edits carry two full bodies. |

### Several spaces

```ts
createBacklogAdapter({
  installations: [
    { host: 'one.backlog.com', apiKey: () => readKey('one'), botUserId: 999, botUserName: 'Chatbot', webhookSecret: '…' },
    { host: 'two.backlog.jp',  apiKey: () => readKey('two'), botUserId: 42,  botUserName: 'Chatbot', webhookSecret: '…' },
  ],
});
```

Register each space's webhook with its own `?host=`. Nothing in a Backlog
payload identifies the space — `projectKey` and the numeric ids are not unique
across spaces — so the host comes from the URL, and it is part of every thread,
message and user id this adapter mints.

## Platform setup

1. **Create a bot user** in the space and add it to every project it should
   answer in. It needs permission to comment, and to create issues if you use
   `channel.post()`.
2. **Issue an API key** as that user: **Personal Settings → API**. If the
   section is missing, an administrator must enable API access for the space.
3. **Find its numeric id.** `GET /api/v2/users/myself` with that key reports
   `id` — that is `botUserId`, not the login name.
4. **Generate a webhook secret**: `openssl rand -hex 32`.
5. **Register a webhook per project** (Project Settings → Integrations →
   Webhook, or
   [Add Webhook](https://developer.nulab.com/docs/backlog/api/2/add-webhook/)):

   ```
   https://<your-app>/api/webhooks/backlog?host=<host>&token=<secret>
   ```

   Select activity types **1, 2 and 3** (issue created, updated, commented) and
   **4** if you want deletion events. **Never `allEvent`** — the full range runs
   to 49 and would deliver wiki, git, pull-request and document activity this
   adapter has no meaning for.

## Webhook authenticity — read this

**Backlog cannot sign webhooks.** [Add Webhook](https://developer.nulab.com/docs/backlog/api/2/add-webhook/)
accepts only `name`, `description`, `hookUrl`, `allEvent` and
`activityTypeIds[]`: there is no secret parameter and no signature header. So
the secret in the URL is the strongest sender-side check available, and it is
weaker than an HMAC — anyone who learns the URL can post to it.

The adapter compares it in constant time and answers **401 with an identical
body** for a missing token, a wrong token, an unknown host and a missing host,
so an unauthenticated caller cannot map your configuration.

Harden a deployment further with `webhookVerifier`, which replaces the secret
check: an IP allowlist against
[Backlog's published sender addresses](https://support.backlog.com/hc/en-us/articles/360051330313-Webhook-sender-IP-address)
(they are "subject to change"), Basic auth credentials in the hook URL, mTLS,
or a reverse-proxy assertion.

Keep the URL out of logs and issue trackers: it carries the secret.

## Features and limitations

| Capability | Support |
| --- | --- |
| Post, edit, delete a comment | yes |
| File uploads and downloads | yes |
| Mentions | yes — text match, or assignment to the bot |
| Reactions | partial — one Backlog star; the emoji is ignored |
| Streaming | partial — buffered, posted once (see below) |
| Issue creation via `channel.post()` | yes |
| Thread listing, user lookup, read receipts, parent subject | yes |
| Message-deleted events | partial — issue deletion only |
| Message-updated events | **no** — see below |
| DMs, ephemeral messages, modals, buttons, slash commands, scheduling, nested replies, typing indicators | no — Backlog has no counterpart |

Limitations worth knowing before you build on this:

- **Comment edits fire no webhook at all** (measured). Editing a comment in
  Backlog creates no activity, however many times you do it, so
  `onMessageUpdated` can never fire and text placed by editing reaches nobody.
- **`stream()` is buffered on purpose.** Left unimplemented, Chat SDK posts a
  message and edits it every 500 ms — roughly 120 edits a minute against a
  documented example limit of 150 updates a minute, so one streamed reply could
  exhaust the user's write quota. This adapter accumulates the stream and posts
  once, which makes `streamingUpdateIntervalMs` irrelevant.
- **Backlog notation is not Markdown.** A project set to `backlog` uses a
  different syntax, and the converter is deliberately lossy in two places:
  inline code becomes plain text and table column alignment is dropped.
  `&color()`, `#contents`, `#rev`, `#attach`, `#thumbnail`, wiki links and
  issue-key auto-links pass through as text.
- **A hand-typed `@Chatbot` is indistinguishable from a real mention.** Backlog
  rewrites mentions to resolved display text before storing them and the
  payload's `notifications` array is always empty, so detection is textual.
  False positives are accepted; assignment to the bot is the reliable trigger.
- **`chat.getUser()` cannot route to this adapter** — the core infers the
  adapter from the id shape and does not recognise `<host>:<id>`. Call
  `adapter.getUser()` directly.
- **Read receipts are not automatic.** `markAsRead` costs one to three reads
  plus at most one update, because it pages the bot's notification feed looking
  for the comment. Do not call it for every comment.
- **`thread.messages` is not free.** Each page is a Get Comment List call;
  `listThreads` draws on the **search** bucket (a lower limit than `read`).
- **Delivery is at-least-once.** The core dedupes on `message.id` for ten
  minutes by default; a redelivery after that is processed again. `message.id`
  is stable across deliveries, so key durable idempotency on it — and use a
  durable `StateAdapter`, since subscriptions live in core state and an
  in-memory one forgets them on restart.
- **A project has no single comment stream**, so `fetchChannelMessages` is
  absent and `channel.messages` is not meaningful.

## Ids

| Kind | Shape | Example |
| --- | --- | --- |
| Channel (project) | `backlog:<host>:<projectId>` | `backlog:example.backlog.com:500` |
| Thread (issue) | `backlog:<host>:<projectId>:<issueId>` | `backlog:example.backlog.com:500:8001` |
| Issue body | `<host>:<issueId>:i` | `example.backlog.com:8001:i` |
| Comment | `<host>:<issueId>:c<commentId>` | `example.backlog.com:8001:c3001` |
| Update without a comment | `<host>:<issueId>:u:<created>` | `example.backlog.com:8001:u:2026-09-03T04:05:06Z` |
| User | `<host>:<userId>` | `example.backlog.com:100` |

Ids are **numeric, never issue keys**: renaming a project key rewrites every
issue key under it, while the numeric ids never change. `issueKey` appears only
in metadata and URLs. The host is inside message and user ids because the
core's dedupe key carries no thread component and Backlog comment ids are
unique only within one space.

## Mentions

Detected when the message text matches `@<botUserName>` (case-sensitive,
left-bounded, so `@Chatbot2` and `foo@Chatbot` do not match), or when the bot
is assigned the issue.

To mention someone outbound, use the helpers — writing `<@U…>` notifies the
user even without `notifiedUserId`:

```ts
import { mentionUser, mentionTeam, MENTION_PROJECT_MEMBERS } from '@nulab/chat-adapter-backlog';

await thread.post({ markdown: `${mentionUser(100)} please take a look` });
await thread.post({ markdown: 'ping', notifiedUserId: [100, 101] });
```

`notifiedUserId` is independent: it notifies without leaving a visible `@name`.
Backlog silently drops ids that are not project members.

## Creating an issue

`channel.post()` creates one. The first block becomes the summary as plain
text (Backlog renders no markup in summaries), the rest becomes the
description:

```ts
const channel = chat.channel('backlog:example.backlog.com:500');
await channel.post({
  markdown: '# Deploy fails on staging\n\nReproduces on every push to main.',
  issueTypeId: 12,   // optional; defaults to the project's first type
  priorityId: 3,     // optional; defaults to the middle priority
  assigneeId: 100,   // optional
});
```

## Errors

Every failure surfaces as a class from `@chat-adapter/shared` —
`ValidationError`, `AuthenticationError`, `PermissionError`,
`ResourceNotFoundError`, `AdapterRateLimitError`, `NetworkError` or
`AdapterError`. The class is chosen from Backlog's own `errors[].code` before
the HTTP status, because Backlog reuses one status for several codes.

`error.cause` carries `{ status, code?, message, moreInfo?, url }` with the
query string stripped, so it never leaks the secret. No `zod` or `backlog-js`
error ever escapes the package.

## Rate limits and the raw API

Limits are **per user, per minute**, in four independent buckets, and the
numbers differ by plan — so read them from the API rather than assuming:

```ts
adapter.rateLimit('example.backlog.com');
// { read: { limit, remaining, reset }, update: {…}, search: {…} }

// Anything outside the Chat SDK contract:
const issue = await adapter.api('example.backlog.com').getIssue(8001);
```

Issue listing and counting spend the **search** bucket, not `read` — the trap
any polling loop falls into.

## Testing

`createInMemoryBacklogApi` is a full in-memory port, so a consumer's tests need
no network and no credentials:

```ts
import { createBacklogAdapter, createInMemoryBacklogApi } from '@nulab/chat-adapter-backlog';

const api = createInMemoryBacklogApi({
  projects: [
    { id: 500, projectKey: 'EXAMPLE', name: 'Example', textFormattingRule: 'markdown' },
  ],
  issues: [/* BacklogIssue values — see the type for the full shape */],
});

const adapter = createBacklogAdapter({
  host: 'example.backlog.com',
  apiKey: 'test',
  botUserId: 999,
  botUserName: 'Chatbot',
  webhookSecret: 'test',
  createApi: () => api,
});
```

`api.state` exposes issues, comments, stars, uploads and recorded inputs for
assertions.

## Links

- [Chat SDK documentation](https://chat-sdk.dev/docs)
- [Backlog API v2](https://developer.nulab.com/docs/backlog/)
- [sample-messages.md](./sample-messages.md) — a payload per activity type
- [DEVELOPMENT.md](./DEVELOPMENT.md) — contributor setup

## Package name

Chat SDK's convention for community adapters is the unscoped
`chat-adapter-<platform>`, but `chat-adapter-backlog` on npm is already taken
by an unrelated third-party package, so this one is published under the
`@nulab` scope.

## License

[MIT](./LICENSE) © Nulab Inc.
