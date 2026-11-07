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

- Issues and pull requests are threads; the project is the channel
- Post, edit and delete comments; upload and download attachments
- Mentions by notification or by assignment to the bot
- Markdown (GFM) converts to and from Chat SDK's AST
- `client()` gives you the underlying [`backlog-js`](https://github.com/nulab/backlog-js) client for every other endpoint
- One bounded retry on a 429, and typed `@chat-adapter/shared` errors
- Zero-config setup from environment variables

## Installation

```sh
npm i @nulab/chat-adapter-backlog chat
npm i @chat-adapter/state-memory @vercel/functions # used by the Quick start below
```

`chat` is a peer dependency (`^4.40.0`). You need Node.js 20 or newer. The
package is ESM-only and includes its own types.

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
  userName: 'backlog-bot',
});

chat.onNewMention(async (thread, message) => {
  await thread.post({ markdown: `Saw: ${message.text}` });
});

export async function POST(request: Request) {
  return chat.webhooks.backlog(request, { waitUntil });
}
```

The webhook answers 200 before your handler runs, so pass your runtime's
`waitUntil` on serverless platforms. Use a durable state adapter in production;
the memory state forgets everything on restart.

## Configuration

### Environment variables

Each variable is the fallback for the option of the same meaning. It is used
only when the option is missing; an explicit empty string is a `ValidationError`.

| Variable                 | Required                 | Meaning                                                                    |
| ------------------------ | ------------------------ | -------------------------------------------------------------------------- |
| `BACKLOG_HOST`           | yes                      | Space host without a scheme, e.g. `example.backlog.com`.                   |
| `BACKLOG_API_KEY`        | one of the two           | Personal API key of the bot user.                                          |
| `BACKLOG_ACCESS_TOKEN`   | one of the two           | OAuth 2.0 access token, instead of a key.                                  |
| `BACKLOG_BOT_USER_ID`    | yes                      | Numeric id of the bot user.                                                |
| `BACKLOG_WEBHOOK_SECRET` | unless a verifier is set | Secret carried in the webhook URL's `token` parameter; at least 16 bytes.  |

### Options

```ts
createBacklogAdapter({ host, apiKey, botUserId, webhookSecret });
```

| Option                   | Type                                          | Default                  | Notes                                                                    |
| ------------------------ | --------------------------------------------- | ------------------------ | ------------------------------------------------------------------------ |
| `host`                   | `string`                                      | `BACKLOG_HOST`           | Spaces also live on `backlog.jp` and `backlogtool.com`.                  |
| `apiKey` / `accessToken` | `string \| (() => string \| Promise<string>)` | `BACKLOG_API_KEY` / `BACKLOG_ACCESS_TOKEN` | Exactly one. A function is called on every request, so a token can rotate. |
| `botUserId`              | `number`                                      | `BACKLOG_BOT_USER_ID`    | Required. Recognises the bot's own comments and assignment to it.        |
| `webhookSecret`          | `string`                                      | `BACKLOG_WEBHOOK_SECRET` | Required unless `webhookVerifier` is set.                                |
| `webhookVerifier`        | `(request, rawBody) => unknown`               | —                        | Replaces the secret check; a truthy result accepts the delivery.         |
| `logger`                 | `Logger`                                      | `ConsoleLogger("info")`  | Replaced by `chat.getLogger("backlog")` on `initialize`.                 |

One adapter serves one Backlog space; a second space is a second adapter behind
its own webhook URL.

`botUserId` must be configured, directly or through `BACKLOG_BOT_USER_ID`.
Find it once with `GET /users/myself` using the bot's API key, and copy the
numeric `id`, not the login `userId`:

```sh
curl -H "Backlog-API-Key: $BACKLOG_API_KEY" https://$BACKLOG_HOST/api/v2/users/myself
```

## Webhook setup

1. Create a bot user. Add it to every project it should answer in, with
   permission to comment.
2. Issue an API key as that user (**Personal Settings → API**; if the section
   is missing, an administrator must enable API access), then configure its
   numeric `id` as described under Configuration.
3. Generate a secret: `openssl rand -hex 32`.
4. In each project, add a webhook (**Project Settings → Integrations →
   Webhook**). Point it at

   ```
   https://<your-app>/api/webhooks/backlog?token=<secret>
   ```

   and select these activity types. Leave 21 unchecked (a merge or close
   arrives as a 19), and **never select `allEvent`**:

   | Types      | Events                                              |
   | ---------- | --------------------------------------------------- |
   | 1, 2, 3    | issue created, updated, commented                   |
   | 14         | issues updated in bulk — one message per issue      |
   | 18, 19, 20 | pull request added, updated (incl. merge), commented |
   | 4          | issue deleted — optional                            |

The activity types you select are the only on/off switch. Leave out 18–20 and
no pull request reaches a handler. Leaving out 14 avoids fanning a bulk update
out into one handler run per issue, but then an update made from the issue
list, even of a single issue, reaches no handler at all. See
[Activity-type mapping](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md#53-activity-type-mapping).

## Webhook authenticity

> [!IMPORTANT]
> **Backlog cannot sign webhooks.** There is no HMAC and no signature header, so
> the secret in the URL is the whole credential: anyone who learns the URL can
> post to it. Keep the URL out of logs and issue trackers.

- The token is compared in constant time, before the body is read. A missing
  and a wrong token get the same 401.
- **Register the URL only in its own space.** No Backlog payload says which
  space it came from. A webhook from another space sent with this URL and
  secret is accepted and read with this space's credentials, which can end in
  a comment on an unrelated issue.
- For more protection, pass a `webhookVerifier`: an IP allowlist against
  [Backlog's sender addresses](https://support.backlog.com/hc/en-us/articles/360051330313-Webhook-sender-IP-address),
  Basic auth in the hook URL, mTLS or a reverse-proxy assertion. A verifier is
  handed the body, so with one the body is read first.

The reasoning is in the spec's
[Security](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md#11-security)
section.

## Usage

### Threads and messages

An issue and a pull request are threads of the same shape. The root message is
the summary, a blank line and the description. Every comment is a message, and
`thread.post()` adds a comment. `message.subject` tells them apart:

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

`subject.type` is `"issue"` or `"pull_request"`. The package's own fields
(`raw.kind`, `fetchThread().metadata.kind`) spell it `"pullRequest"`. A field
change without text arrives as a message with empty `text` and the change in
`message.raw.changes`.

Ids are numeric, never issue keys, so a rename does not break them. Read a
thread id back with `adapter.decodeThreadId()`, and message and user ids with
the exported functions `decodeMessageId()` and `decodeUserId()`:

```ts
import { decodeMessageId, decodeUserId } from '@nulab/chat-adapter-backlog';

decodeMessageId(message.id).part; // 'root' for the issue or pull request itself
decodeUserId(message.author.userId).userId; // the numeric Backlog user id
```

The full grammar is in the spec's
[Grammar](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md#21-grammar).

### Mentions

A message is a mention when the webhook lists the bot among the notified users,
or when it assigns the subject to the bot at creation. Read
`message.isMention` rather than matching the text yourself. The rules
are in
[Mention detection](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md#54-mention-detection-d9).

To mention someone, write Backlog's mention syntax — `<@U<userId>>`, `<@T<teamId>>`
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

For anything outside the Chat SDK contract, such as custom fields, assignees or
the pull-request list, use `adapter.client()`. It returns the `backlog-js`
client the adapter itself uses, with the same 429 retry and error classes:

```ts
const client = backlog.client();
await client.getCustomFields(500); // projectId
await client.getPullRequests(500, '700', { count: 20 }); // projectId, repositoryId
await client.patchIssue(8001, { assigneeId: 100 });
```

### Errors

Every failure is a `@chat-adapter/shared` class — `ValidationError`,
`AuthenticationError`, `PermissionError`, `ResourceNotFoundError`,
`AdapterRateLimitError`, `NetworkError` or `AdapterError`. An error from a
Backlog API response carries `{ status, code?, message, moreInfo?, url }` in
`error.cause`.

### Rate limits and retries

Backlog limits requests per user, per minute, per plan. A 429 is retried once,
after waiting until the time in `X-RateLimit-Reset`, **at most 60 seconds**. During the wait
the call does not return. A longer reset or a second 429 rejects with
`AdapterRateLimitError`. Give a serverless function comfortably more than 60
seconds (on Vercel, `export const maxDuration = 90`), or a reply cut off
mid-wait disappears silently. See
[429 retry](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md#84-429-retry-d5).

### Testing your bot

Test handlers with Chat SDK's [`@chat-adapter/tests`](https://chat-sdk.dev/docs/testing).
Mock `adapter.client()` where a handler calls Backlog directly.

## Limitations

- Editing a comment fires no webhook, so `onMessageUpdated` never fires.
- A comment edited within the second it was posted reads as `edited: false`,
  because Backlog's timestamps are second-granular.
- A pull-request comment cannot be deleted, nor can an issue comment that
  attached a file or changed a field. `listThreads` lists issues only.
- `channel.post()` is rejected. Create an issue with `client().postIssue()`.
- Creating, merging or closing a pull request has no Backlog API.
- A reaction is a single Backlog star. The emoji is ignored.
- `stream()` buffers and posts once, since editing every 500 ms would exhaust
  the update limit. An empty stream, such as a failed AI SDK `fullStream`,
  posts a single space.
- Adding the bot to an existing comment's recipients is ignored; address the
  bot when posting the comment.
- `listThreads` and issue listing draw on Backlog's lower search limit.
- Projects that use Backlog notation are not supported: posts appear as
  Markdown source there, and incoming notation is read as Markdown. Switch the
  project to Markdown in its settings.
- `chat.getUser()` cannot route to this adapter. Call `adapter.getUser()`.
- Delivery is at least once. Key durable idempotency on `message.id`.
- DMs, ephemeral messages, modals, buttons, slash commands, scheduling and
  typing indicators have no Backlog counterpart.

Member-by-member coverage is in
[Adapter contract coverage](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md#4-adapter-contract-coverage),
and how text and cards are rendered in
[Formatting](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md#9-formatting).

## Examples

Deployable bots built on this adapter are in
[examples/](https://github.com/nulab/chat-adapter-backlog/tree/main/examples).

## Contributing

See [DEVELOPMENT.md](https://github.com/nulab/chat-adapter-backlog/blob/main/DEVELOPMENT.md).
The behaviour and its design decisions are specified in
[docs/specs/adapter.md](https://github.com/nulab/chat-adapter-backlog/blob/main/docs/specs/adapter.md).

## License

[MIT](https://github.com/nulab/chat-adapter-backlog/blob/main/LICENSE) © Nulab Inc.
