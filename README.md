# @nulab/chat-adapter-backlog

A [Backlog](https://backlog.com/) adapter for [Chat SDK](https://chat-sdk.dev/):
issues and pull requests become threads, comments become messages, and your bot
replies by commenting.

[![npm version](https://img.shields.io/npm/v/@nulab/chat-adapter-backlog)](https://www.npmjs.com/package/@nulab/chat-adapter-backlog)
[![npm downloads](https://img.shields.io/npm/dm/@nulab/chat-adapter-backlog)](https://www.npmjs.com/package/@nulab/chat-adapter-backlog)
[![CI](https://github.com/nulab/chat-adapter-backlog/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/nulab/chat-adapter-backlog/actions/workflows/ci.yml?query=branch%3Amain)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/nulab/chat-adapter-backlog/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/@nulab/chat-adapter-backlog)](https://github.com/nulab/chat-adapter-backlog/blob/main/package.json)
[![types: included](https://img.shields.io/npm/types/@nulab/chat-adapter-backlog)](https://www.npmjs.com/package/@nulab/chat-adapter-backlog)
[![chat peer](https://img.shields.io/npm/dependency-version/@nulab/chat-adapter-backlog/peer/chat)](https://www.npmjs.com/package/chat)

## Features

- Issue and pull-request threads, with the project as the channel
- Post, edit and delete comments; upload and download attachments
- Mentions by notification, by `@name` in the text, or by assignment to the bot
- Backlog notation and Markdown projects both converted to and from Chat SDK's AST
- `client()` hands you the underlying [`backlog-js`](https://github.com/nulab/backlog-js) client for every other endpoint
- One bounded retry on a 429, and typed `@chat-adapter/shared` errors
- Zero-config construction from environment variables

## Installation

```sh
npm i @nulab/chat-adapter-backlog chat
```

`chat` is a peer dependency (`^4.40.0`). Node.js 20 or newer. The package is
ESM-only and ships its own types.

While the version is `0.x`, a breaking change ships as a minor release.

## Quick start

```ts
import { Chat } from 'chat';
import { createMemoryState } from '@chat-adapter/state-memory';
import { waitUntil } from '@vercel/functions';
import { createBacklogAdapter } from '@nulab/chat-adapter-backlog';

const backlog = createBacklogAdapter(); // reads the BACKLOG_* variables

const chat = new Chat({
  adapters: { backlog }, // the key must be "backlog": thread ids start with "backlog:"
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

This also needs `@chat-adapter/state-memory` and `@vercel/functions`. The
webhook answers 200 before your handler runs, so pass your runtime's
`waitUntil` on serverless platforms. Use a durable state adapter in production;
the memory state forgets everything on restart.

## Configuration

### Environment variables

Each variable is the fallback for the option of the same meaning, used only when
the option is absent (an explicit empty string is a `ValidationError`).

| Variable                 | Required                 | Meaning                                                                    |
| ------------------------ | ------------------------ | -------------------------------------------------------------------------- |
| `BACKLOG_HOST`           | yes                      | Space host without a scheme, e.g. `example.backlog.com`.                   |
| `BACKLOG_API_KEY`        | one of the two           | Personal API key of the bot user.                                          |
| `BACKLOG_ACCESS_TOKEN`   | one of the two           | OAuth 2.0 access token, instead of a key.                                  |
| `BACKLOG_BOT_USER_ID`    | recommended              | Numeric id of the bot user. When unset, read once from `GET /users/myself`. |
| `BACKLOG_BOT_USER_NAME`  | for `@name` mentions     | The bot's display name, matched against a typed `@name`.                   |
| `BACKLOG_WEBHOOK_SECRET` | unless a verifier is set | Secret carried in the webhook URL's `token` parameter; at least 16 bytes.  |

### Options

```ts
createBacklogAdapter({ host, apiKey, botUserId, botUserName, webhookSecret });
```

| Option                   | Type                                          | Default                  | Notes                                                                    |
| ------------------------ | --------------------------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `host`                   | `string`                                      | `BACKLOG_HOST`           | Spaces also live on `backlog.jp` and `backlogtool.com`.                  |
| `apiKey` / `accessToken` | `string \| (() => string \| Promise<string>)` | env                      | Exactly one. A function is called on every request, so a token can rotate. |
| `botUserId`              | `number`                                      | `GET /users/myself`      | Recognises the bot's own comments and assignment to it.                  |
| `botUserName`            | `string`                                      | `GET /users/myself`      | Fetched only when `botUserId` is unset too. Exposed as `adapter.userName`. |
| `webhookSecret`          | `string`                                      | `BACKLOG_WEBHOOK_SECRET` | Required unless `webhookVerifier` is set.                                |
| `webhookVerifier`        | `(request, rawBody) => unknown`               | —                        | Replaces the secret check; a truthy result accepts the delivery.         |
| `logger`                 | `Logger`                                      | `ConsoleLogger("info")`  | Replaced by `chat.getLogger("backlog")` on `initialize`.                 |

One adapter serves one Backlog space; a second space is a second adapter behind
its own webhook URL.

**Set `BACKLOG_BOT_USER_ID`.** Without it every cold start spends a request on
`GET /users/myself`, and a webhook that arrives while that lookup fails is
answered 503. **Always give `new Chat({ userName })` a non-empty value**: when
both it and `botUserName` are empty, every stray `@` in a comment becomes a
mention.

## Webhook setup

1. Create a bot user and add it, with permission to comment, to every project
   it should answer in.
2. Issue an API key as that user (**Personal Settings → API**) and read its
   numeric `id` and `name` from `GET /api/v2/users/myself`.
3. Generate a secret: `openssl rand -hex 32`.
4. In each project, add a webhook (**Project Settings → Integrations →
   Webhook**) pointing at

   ```
   https://<your-app>/api/webhooks/backlog?token=<secret>
   ```

   with these activity types, and **never `allEvent`**:

   | Types      | Events                                              |
   | ---------- | --------------------------------------------------- |
   | 1, 2, 3    | issue created, updated, commented                   |
   | 14         | issues updated in bulk — one message per issue      |
   | 18, 19, 20 | pull request added, updated (incl. merge), commented |
   | 4          | issue deleted — optional                            |

The subscription is the only switch per kind: leave out 18–20 and no pull
request reaches a handler; leave out 14 to avoid fanning a bulk update out into
one handler run per issue. See
[Activity-type mapping](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md#53-activity-type-mapping).

## Webhook authenticity

> [!IMPORTANT]
> **Backlog cannot sign webhooks.** There is no HMAC and no signature header, so
> the secret in the URL is the whole credential: anyone who learns the URL can
> post to it. Keep the URL out of logs and issue trackers.

- The token is compared in constant time and checked before the body is read;
  a missing and a wrong token get the same 401.
- **Register the URL only in its own space.** No Backlog payload says which
  space it came from, so a webhook from another space sent with this URL and
  secret is accepted and read with this space's credentials — which can end in
  a comment on an unrelated issue.
- For more, pass a `webhookVerifier`: an IP allowlist against
  [Backlog's sender addresses](https://support.backlog.com/hc/en-us/articles/360051330313-Webhook-sender-IP-address),
  Basic auth in the hook URL, mTLS or a reverse-proxy assertion. A verifier is
  handed the body, so with one the body is read first.

The reasoning is in the spec's
[Security](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md#11-security)
section.

## Usage

### Threads and messages

An issue and a pull request are threads of the same shape: the root message is
the summary, a blank line and the description; every comment is a message; and
`thread.post()` comments. `message.subject` tells them apart:

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

`subject.type` is `"issue"` or `"pull_request"`; the package's own fields
(`raw.kind`, `fetchThread().metadata.kind`) spell it `"pullRequest"`. A field
change without text arrives as a message with empty `text` and the change in
`message.raw.changes`.

Ids are numeric, never issue keys, so a rename does not break them. Read them
back with `adapter.decodeThreadId()`, `decodeMessageId()` and `decodeUserId()`:

```ts
import { decodeMessageId, decodeUserId } from '@nulab/chat-adapter-backlog';

decodeMessageId(message.id).part; // 'root' for the issue or pull request itself
decodeUserId(message.author.userId).userId; // the numeric Backlog user id
```

The full grammar is in the spec's
[Grammar](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md#21-grammar).

### Mentions

A message is a mention when the webhook lists the bot among the notified users,
when its text contains `@<botUserName>`, or when it assigns the subject to the
bot. Read `message.isMention` rather than matching the text yourself; the rules
are in
[Mention detection](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md#54-mention-detection-d9).

To mention someone, write Backlog's notation — `<@U<userId>>`, `<@T<teamId>>`
or `<@project>` — or pass `notifiedUserId` to notify without a visible name:

```ts
import type { PostableMarkdown } from 'chat';
import type { BacklogPostableExtras } from '@nulab/chat-adapter-backlog';

await thread.post({ markdown: '<@U100> please take a look' });

const ping: PostableMarkdown & BacklogPostableExtras = { markdown: 'ping', notifiedUserId: [100] };
await thread.post(ping);
```

Annotate the variable: an object literal passed straight to `post()` fails its
excess-property check. Backlog silently drops ids that are not project members.

### Other endpoints: `client()`

For anything outside the Chat SDK contract — custom fields, assignees, the
pull-request list — `adapter.client()` returns the `backlog-js` client the
adapter itself uses, with the same 429 retry and error classes:

```ts
const client = backlog.client();
await client.getCustomFields(500); // projectId
await client.getPullRequests(500, '700', { count: 20 }); // projectId, repositoryId
await client.patchIssue(8001, { assigneeId: 100 });
```

### Errors

Every failure is a `@chat-adapter/shared` class — `ValidationError`,
`AuthenticationError`, `PermissionError`, `ResourceNotFoundError`,
`AdapterRateLimitError`, `NetworkError` or `AdapterError` — with
`{ status, code?, message, moreInfo?, url }` in `error.cause`.

### Rate limits and retries

Backlog limits requests per user, per minute, per plan. A 429 is retried once,
after waiting for `X-RateLimit-Reset` for **up to 60 seconds**, during which the
call does not return; a longer reset or a second 429 rejects with
`AdapterRateLimitError`. Give a serverless function comfortably more than 60
seconds (on Vercel, `export const maxDuration = 90`), or a reply cut off
mid-wait disappears silently. See
[429 retry](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md#84-429-retry-d5).

### Testing your bot

Test handlers with Chat SDK's [`@chat-adapter/tests`](https://chat-sdk.dev/docs/testing)
and mock `adapter.client()` where a handler calls Backlog directly.

## Limitations

- Editing a comment fires no webhook, so `onMessageUpdated` never fires.
- A pull-request comment cannot be deleted, and `listThreads` lists issues only.
- `channel.post()` is rejected: create an issue with `client().postIssue()`.
- Creating, merging or closing a pull request has no Backlog API.
- A reaction is a single Backlog star; the emoji is ignored.
- `stream()` buffers and posts once, since editing every 500 ms would exhaust
  the update limit.
- Notation markers in your own text (`''bold''`, `%%strike%%`, `[[link]]`) are
  rendered by Backlog; post a `{ raw }` message to control escaping yourself.
- `chat.getUser()` cannot route to this adapter; call `adapter.getUser()`.
- Delivery is at least once: key durable idempotency on `message.id`.
- DMs, ephemeral messages, modals, buttons, slash commands, scheduling and
  typing indicators have no Backlog counterpart.

Member-by-member coverage is in
[Adapter contract coverage](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md#4-adapter-contract-coverage),
and the conversions that lose information in
[Known lossy conversions](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md#96-known-lossy-conversions).

## Examples

Deployable bots built on this adapter are in
[examples/](https://github.com/nulab/chat-adapter-backlog/tree/main/examples).

## Contributing

See [DEVELOPMENT.md](https://github.com/nulab/chat-adapter-backlog/blob/main/DEVELOPMENT.md).
The behaviour and its design decisions are specified in
[docs/specs/adapter.md](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md).

## License

[MIT](https://github.com/nulab/chat-adapter-backlog/blob/main/LICENSE) © Nulab Inc.
