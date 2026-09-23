# @nulab/chat-adapter-backlog

A [Backlog](https://backlog.com/) adapter for [Chat SDK](https://chat-sdk.dev/) —
Backlog issues and pull requests become threads, comments become messages, and
an agent replies by commenting.

[![npm](https://img.shields.io/npm/v/@nulab/chat-adapter-backlog)](https://www.npmjs.com/package/@nulab/chat-adapter-backlog)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/nulab/chat-adapter-backlog/blob/main/LICENSE)

## Status

Releases on its own cadence, starting at `0.1.0`, and still pre-1.0: while the
major is `0`, a breaking change to the public surface ships as a minor release.

Feature-complete against the adapter contract of `chat@4.39.0`: all 17 required
members are present, plus 10 of the 27 optional ones. A few of them go as far
as Backlog allows and no further — a reaction is a star, and there is no typing
indicator to show. What each member does, and every place Backlog itself stops
short, is the matrix under **Features and limitations**.

Not listed in Chat SDK's adapter catalog yet — as neither a community nor a
vendor-official adapter. That listing is a separate decision and changes
nothing about installing or using the package.

## Installation

```sh
pnpm add @nulab/chat-adapter-backlog chat @chat-adapter/state-memory @vercel/functions
```

`chat` is a peer dependency at `^4.39.0` — a caret range, so upgrading the core
does not require a matching adapter release. Node 20 or newer. The other two
packages are only what **Quick start** uses: swap in a durable state adapter
and your runtime's own `waitUntil` as needed.

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

The memory state forgets subscriptions on restart — fine for a first run, not
for production (see **Delivery is at-least-once** below). `waitUntil` is what
keeps a serverless invocation alive after the 200: the handler runs in the
background, and without it nothing holds the function open, so the runtime may
freeze it before the reply is posted.

Every field falls back to an environment variable, so
`createBacklogAdapter()` with no argument works when the environment is set.

For a whole bot rather than a fragment — a Vercel project with the webhook
wired up, environment variables and a handler that does something useful — see
[examples/](https://github.com/nulab/chat-adapter-backlog/tree/main/examples).

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
| `BACKLOG_WEBHOOK_SECRET` | unless a verifier is set | Secret carried in the webhook URL's `token` parameter. At least 16 bytes. |

## Configuration

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `host` | `string` | — | Full hostname. Backlog spaces also live on `backlog.jp` and legacy `backlogtool.com`, so this is never a subdomain slug. |
| `apiKey` / `accessToken` | `string \| (() => string \| Promise<string>)` | — | Exactly one per installation. The function form is resolved on **every** call and never cached, so an expiring token can be refreshed without reconstructing the adapter. |
| `botUserId` | `number` | — | Positive integer, at most `Number.MAX_SAFE_INTEGER` — it is encoded into user ids. Recognises the adapter's own messages and assignment to the bot. |
| `botUserName` | `string` | — | Non-empty. Mentions arrive as resolved text, so this is what the mention pattern matches. |
| `webhookSecret` | `string` | — | Required on every installation unless `webhookVerifier` is set. **At least 16 bytes**, checked when the adapter is constructed — it is the only thing standing between the URL and your projects, so a short one is refused rather than warned about. |
| `installations` | `BacklogInstallation[]` | — | Several spaces in one adapter. Mutually exclusive with the fields above. |
| `webhookVerifier` | `(request, rawBody) => unknown` | — | Replaces the secret check entirely — for a reverse-proxy assertion, mTLS or an IP allowlist. |
| `userName` | `string` | first installation's `botUserName` | Exposed to the core as `adapter.userName`. One string for the whole adapter; per space, read `adapter.botUserName(host)`. |
| `logger` | `Logger` | `ConsoleLogger("info")` | Replaced by `chat.getLogger("backlog")` in `initialize`. |
| `rateLimit.maxWaitMs` | `number` | `60_000` | Longest wait before a 429 retry. Non-negative integer. |
| `rateLimit.maxRetries` | `number` | `1` | Non-negative integer; `0` disables retries. |
| `maxWebhookBodyBytes` | `number` | `5 * 1024 * 1024` | Positive integer. Larger bodies get a 413. Description edits carry two full bodies. |
| `createApi` | `(installation: ResolvedInstallation) => BacklogApi` | the `backlog-js`-backed port | Test seam: replaces the port every Backlog call goes through, so a consumer's suite needs no network — see **Testing**. Replacing it also takes the rate-limit accounting, the 429 retry and `client()` with it. |

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
message and user id this adapter mints. Because the URL is the only source,
getting that one parameter wrong is not a validation error but a silent
cross-space read: see **Webhook authenticity** below.

The bot may carry a different display name in each space, so ask per host:

```ts
adapter.userName;                       // 'Chatbot' — the first installation's name
adapter.botUserName('two.backlog.jp');  // 'Helperbot'
```

`adapter.userName` is a single string the Chat SDK core uses for its own
fallback `@<userName>` regex, which therefore agrees with only one space.
Mention detection itself is the adapter's and is correct everywhere: it
resolves the installation from the webhook's `?host=` and matches that space's
name. Anything you build on the mention string — stripping the prefix off a
command, addressing the bot in your own text — should read
`botUserName(host)`, not `userName`. An unconfigured host throws the same
`ResourceNotFoundError` as `api(host)`. `botUserId` stays private, because the
core's `@<id>` pattern would be wrong for every space but one.

## Platform setup

1. **Create a bot user** in the space and add it to every project it should
   answer in. It needs permission to comment, and to create issues if you use
   `channel.post()`.
2. **Issue an API key** as that user: **Personal Settings → API**. If the
   section is missing, an administrator must enable API access for the space.
3. **Find its numeric id.** `GET /api/v2/users/myself` with that key reports
   `id` — that is `botUserId`, not the login name.
4. **Generate a webhook secret**: `openssl rand -hex 32`. Anything under 16
   bytes is rejected at construction.
5. **Register a webhook per project** (Project Settings → Integrations →
   Webhook, or
   [Add Webhook](https://developer.nulab.com/docs/backlog/api/2/add-webhook/)):

   ```
   https://<your-app>/api/webhooks/backlog?host=<host>&token=<secret>
   ```

   Check the `host` against the space you are registering in. A wrong one is
   accepted silently and read with this space's credentials — **Webhook
   authenticity** below says what that does.

   Select activity types **1, 2, 3** (issue created, updated, commented),
   **14** (issues updated in bulk) and **18, 19, 20** (pull request added,
   updated, commented), plus **4** if you want issue-deletion events. Leave
   **21** unchecked: the adapter ignores it, and merging or closing a pull
   request arrives as a type-19 update anyway. **Never `allEvent`** — the full
   range runs to 49 and would deliver git push, wiki and document activity this
   adapter has no meaning for.

   These checkboxes are the on/off switch per kind, and the only one — there is
   no config option for it. Subscribe to 1, 2, 3 alone and no pull request
   reaches a handler; subscribe to 18, 19, 20 alone and no issue does.

   **Type 14 is the one that costs more than it looks.** When someone updates
   issues in bulk from the issue list, Backlog sends a *single* webhook for the
   whole batch and no per-issue event at all — so without 14 a bulk status
   change reaches no handler, while the comment it wrote on each issue is still
   there for `thread.messages()` to find. That holds even for a batch of
   **one**: an update made from the issue list is a type 14 whether it ticked
   one issue or fifty, so leaving 14 unregistered loses single-issue updates
   too, as long as they were made from that screen. With 14 registered, the adapter
   unpacks that delivery into one message per issue, each in its own thread. A
   batch of fifty issues is fifty handler runs from one request, and if your
   handler calls the Backlog API each time, fifty calls against a per-minute
   bucket. If that is more than your deployment can absorb, leave 14
   unregistered — that is the switch, and it is better than one in the adapter
   because nothing is delivered in the first place.

## Webhook authenticity — read this

**Backlog cannot sign webhooks.** [Add Webhook](https://developer.nulab.com/docs/backlog/api/2/add-webhook/)
accepts only `name`, `description`, `hookUrl`, `allEvent` and
`activityTypeIds[]`: there is no secret parameter and no signature header. So
the secret in the URL is the strongest sender-side check available, and it is
weaker than an HMAC — anyone who learns the URL can post to it.

The adapter compares it in constant time and answers **401 with an identical
body** for a missing token, a wrong token, an unknown host and a missing host,
so an unauthenticated caller cannot map your configuration. It also checks the
token **before it reads the request body**, so a caller who has found the URL
but not the secret cannot make your function buffer up to
`maxWebhookBodyBytes` (5 MiB by default) per request — that request costs it a
401 after its headers, and it never learns what the limit is.

A `webhookVerifier` is the one case where the body is read first: the verifier
is handed it, so it has to be. `maxWebhookBodyBytes` is then the only bound on
what an unauthenticated request can make the process hold; lower it, or put
the check in front of the function — a reverse proxy, an IP allowlist — if
that matters for your deployment.

Harden a deployment further with `webhookVerifier`, which replaces the secret
check: an IP allowlist against
[Backlog's published sender addresses](https://support.backlog.com/hc/en-us/articles/360051330313-Webhook-sender-IP-address)
(they are "subject to change"), Basic auth credentials in the hook URL, mTLS,
or a reverse-proxy assertion.

**A right secret with a wrong `host` is authentic.** Verification proves that
the caller knows one space's secret, and nothing more: no Backlog payload says
which space it came from, so the adapter believes the URL. Register space B's
webhook with `?host=<space A>&token=<space A's secret>` and every delivery
verifies, gets its 200, and is then addressed with space A's credentials.
Nothing is posted, and the sender sees a success.

Do not count on that being a harmless 404. Two spaces measured on 2026-09-06
were minting issue ids from interleaving ranges, so an id from one space can
name a real, unrelated issue in the other — and the bot comments there. The
adapter cannot catch this for you: the payload carries no value that can be
tied back to a host, and the one candidate for a consistency check
(`project.projectKey`) would start dropping real events the first time
somebody renames a project key (docs/specs/adapter.md D19).

So check the `host` in every hook URL you register. The trace to grep for when
a space has gone quiet is `textFormattingRule lookup failed; assuming markdown`
naming a project id that host does not have.

Keep the URL out of logs and issue trackers: it carries the secret.

## Issues and pull requests

Both are threads of the same shape: the root message's `text` is the summary, a
blank line, then the description; every comment — Backlog's auto-generated
changelog comments included — is a message, `thread.post()` comments on the
thread, and the **project** is the channel for both. Nothing in the `Adapter`
surface asks you which kind you are on; the id says it.

`message.subject` says it too, when a handler needs to branch:

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

`subject.type` is `"issue"` or **`"pull_request"`** — the same string
`@chat-adapter/github` uses. `subject.labels` carries the issue type and
priority for an issue, and the status plus `"<base> ← <branch>"` for a pull
request.

The other spelling, `"pullRequest"`, is this package's own vocabulary and
appears wherever the id grammar's subject does: `fetchThread().metadata.kind`,
the `raw.subject.kind` of a comment's raw message, and the `raw.kind` of a root
message's. Only `subject.type` follows the ecosystem.

Every timestamp in `fetchThread().metadata` — `created`, `updated` and a pull
request's `closeAt`/`mergeAt` — is an **ISO string**, the same as in
`message.raw`. A value read out of `metadata` is typed `unknown`, so a `Date`
there would be invisible to the compiler and would quietly become a string the
first time a `ThreadInfo` went through JSON.

What a pull-request thread cannot do — delete a comment, get listed by
`listThreads`, be merged, closed or created — is in the table below.

## Features and limitations

| Capability | Support |
| --- | --- |
| Issue threads | yes |
| Pull-request threads | yes |
| Post and edit a comment | yes — both kinds |
| Delete a comment | partial — issue comments only (see below) |
| File uploads and downloads | yes — a pull-request comment's attachment resolves by name (see below) |
| Mentions | yes — the webhook's notification list, a text match, or assignment to the bot |
| Reactions | partial — one Backlog star; the emoji is ignored (see below) |
| Streaming | partial — buffered, posted once (see below) |
| Issue creation via `channel.post()` | yes |
| Pull-request creation, merge or close | **no** — Backlog exposes no API (see below) |
| Thread listing | partial — issues only (see below) |
| User lookup, read receipts, parent subject | yes — both kinds |
| Message-deleted events | partial — issue deletion only; nothing deletes a pull request |
| Message-updated events | **no** — see below |
| DMs, ephemeral messages, modals, buttons, slash commands, scheduling, nested replies, typing indicators | no — Backlog has no counterpart |

Limitations worth knowing before you build on this:

- **Comment edits fire no webhook.** Editing a comment in Backlog creates no
  activity, however many times you do it, so `onMessageUpdated` never fires and
  text placed by editing reaches nobody.
- **A pull-request comment cannot be deleted.** Backlog has no endpoint for it,
  so `deleteMessage` on a pull-request thread throws `AdapterError` with code
  `UNSUPPORTED_OPERATION` before any request is made — `SentMessage.delete()`
  there is a rejection a bot author has to expect. Issue comments delete
  normally.
- **`listThreads` lists issues only.** A pull-request list is per repository, a
  coordinate the channel id does not carry;
  `api(host).listPullRequests(projectId, repositoryId, …)` is the route to one.
- **A pull request cannot be closed or merged from Chat.** Backlog exposes no
  API for a status change. Merge in git or in the UI; the change then arrives
  as a type-19 activity like any other update.
- **A pull request cannot be created from Chat either.** `channel.post()`
  creates an issue, and only an issue.
- **Creating a pull request with `notifiedUserId[]` adds a system comment no
  activity announces**, so `fetchMessages` returns one message the webhook
  stream never delivered. A consumer reconciling the two will see the
  difference.
- **A pull-request comment's attachment resolves its id by name.** Its
  `changeLog` names the file without an id, so `fetchData` lists the pull
  request's attachments and takes the newest match — two files with the same
  name in one pull request are indistinguishable. The list call is spent only
  when someone actually reads the file, not once per message.
- **A reaction is one star, and a repeat call costs a read instead of a
  second star.** `POST /stars` is not idempotent — Backlog accepts the same
  star twice from the same user and shows two (measured 2026-09-06) — so
  `addReaction` reads the comment first and does nothing when the bot's own
  star is already there. That covers a retry, a redelivered webhook and a
  handler reacting to one comment twice; it is not a lock, so two
  `addReaction` calls racing for the same comment can still leave two stars.
  `removeReaction` deletes only stars the bot presented, never a human's.
- **A root message leads with the summary.** Its `text` is the summary, a
  blank line, then the description, so a bot that reads the first word of a
  message as a command reads a word of the issue title on the thread's first
  message. Parse the line the mention is on, not the whole text.
- **`stream()` is buffered on purpose.** Left unimplemented, Chat SDK posts a
  message and edits it every 500 ms — roughly 120 edits a minute against a
  documented example limit of 150 updates a minute, so one streamed reply could
  exhaust the user's write quota. This adapter accumulates the stream and posts
  once, which makes `streamingUpdateIntervalMs` irrelevant. An **empty stream
  still posts a single space**, so `stream()` always resolves to a message the
  caller can edit or delete. Watch for that when you hand an AI SDK
  `fullStream` straight to `thread.post()`: a model failure arrives as an
  `{ type: 'error' }` chunk rather than a thrown error, Chat SDK's
  `fromFullStream` forwards text and three known chunk types and drops
  everything else, so the failure reaches this adapter as a stream with no
  content and lands in Backlog as a comment holding one space. Iterate
  `fullStream` yourself if you want the error to surface (measured against
  Chat SDK 4.40 and AI SDK 7 on 2026-09-06; the chunk filter is identical in
  the pinned 4.39.0).
- **Backlog notation is not Markdown.** A project set to `backlog` uses a
  different syntax, and the converter is deliberately lossy in two places:
  inline code becomes plain text and table column alignment is dropped.
  `&color()`, `#contents`, `#rev`, `#attach`, `#thumbnail`, wiki links and
  issue-key auto-links pass through as text.
- **Notation markers in your own text become decoration.** Backlog notation has
  a documented escape — a `\` before a special character prints it literally,
  so `\%\%Not Striked\%\%` renders as `%%Not Striked%%` — but this adapter does
  **not** apply it when rendering a message to a `backlog` project. Whatever
  markers your text already contains are markup by the time Backlog draws it:
  `price is ''100''` puts `100` in bold, `50%% off, %%today` strikes text
  through, `[[TICKET-1]]` becomes a link, a line opening with `* ` becomes an
  H1, and a line that is just `{code}` opens a code macro that swallows the
  rest. Model-generated replies hit this without trying. Escaping is not
  applied because the guide documents the rule for `%` and `\` only and does
  not say which other characters `\` covers, what it does before an ordinary
  character, how an escaped comment should read back in, or whether a literal
  `¥` escapes the way its `\(¥¥)` gloss can be read to promise — which would
  put `¥100` in a Japanese sentence at risk. Getting that set wrong would eat
  your backslashes instead of fixing anything. If you need a literal marker
  today, post a `{ raw }` postable: it bypasses the converter and reaches
  Backlog verbatim, so you can apply `\` yourself.
- **A hand-typed `@Chatbot` is indistinguishable from a real mention.** Backlog
  rewrites mentions to resolved display text before storing them, so a text
  match cannot tell a real mention from someone typing the bot's name. False
  positives are accepted. The webhook's own notification list and assignment to
  the bot are the reliable triggers — but only a webhook has that list: the
  same activity read back through `GET /space/activities` reports no
  recipients, so a poller cannot reproduce the detection.
- **`chat.getUser()` cannot route to this adapter** — the core infers the
  adapter from the id shape and does not recognise `<host>:<id>`. Call
  `adapter.getUser()` directly.
- **Read receipts are not automatic.** `markAsRead` costs one to three reads
  plus at most one update, because it pages the bot's notification feed looking
  for the comment. Do not call it for every comment. It sets that
  notification's `resourceAlreadyRead` and never touches `alreadyRead` (the
  unread-count badge, cleared only by resetting the whole feed).
- **`thread.messages` is not free.** Each page is one comment-list call for
  either kind; `listThreads` draws on the **search** bucket (a lower limit than
  `read`).
- **Delivery is at-least-once.** The core dedupes on `message.id` for ten
  minutes by default; a redelivery after that is processed again. `message.id`
  is stable across deliveries, so key durable idempotency on it — and use a
  durable `StateAdapter`, since subscriptions live in core state and an
  in-memory one forgets them on restart.
- **A project has no single comment stream**, so `fetchChannelMessages` is
  absent and `channel.messages` is not meaningful.

## Ids

Every id carries the **subject** — `issue:<issueId>` or
`pr:<repositoryId>:<number>` — so a thread id and the ids of its messages agree
about what they address.

| Kind | Shape | Example |
| --- | --- | --- |
| Channel (project) | `backlog:<host>:<projectId>` | `backlog:example.backlog.com:500` |
| Thread — issue | `backlog:<host>:<projectId>:issue:<issueId>` | `backlog:example.backlog.com:500:issue:8001` |
| Thread — pull request | `backlog:<host>:<projectId>:pr:<repositoryId>:<number>` | `backlog:example.backlog.com:500:pr:700:12` |
| Root message (issue body / pull-request description) | `<host>:<subject>:r` | `example.backlog.com:issue:8001:r`<br>`example.backlog.com:pr:700:12:r` |
| Comment | `<host>:<subject>:c<commentId>` | `example.backlog.com:issue:8001:c3001`<br>`example.backlog.com:pr:700:12:c4002` |
| Update without a comment | `<host>:<subject>:u:<created>` | `example.backlog.com:issue:8001:u:2026-09-03T04:05:06Z` |
| User | `<host>:<userId>` | `example.backlog.com:100` |

The kind is an explicit segment on **both** kinds, never inferred. Issue and
pull-request comment ids come from separate sequences and may overlap, so a
bare comment id does not identify a message on its own — keep the whole id.

Ids are **numeric, never issue keys**: renaming a project key rewrites every
issue key under it, while the numeric ids never change. `issueKey` appears only
in metadata and URLs. A pull request is likewise addressed by its numeric
repository id and its per-repository `number` — never the repository name,
which can change, and never its space-wide `id`, which appears only in metadata
and raw data.

The host is part of message and user ids because Backlog comment ids are unique
only within one space. A pull request's channel is its **project**, not its
repository.

Every numeric segment is a positive integer of at most
`Number.MAX_SAFE_INTEGER`, and the **encoders** enforce the grammar as well as
the decoders: `encodeThreadId`, `encodeChannelId`, `encodeMessageId` and
`encodeUserId` throw `ValidationError` for a value they could not read back —
a host that is not lowercased or carries a scheme, path or port, a
non-positive or non-integral id, an id past 2^53-1 (where `Number` stops
round-tripping decimal digits), or an update id with an empty timestamp.

## Mentions

Detected when the delivery names the bot among the users it notified, when the
message text matches `@<botUserName>` (case-sensitive, left-bounded, so
`@Chatbot2` and `foo@Chatbot` do not match), or when the bot is assigned the
issue or the pull request. The name compared is the one configured for the space
the event came from, so several spaces under different display names each match
their own; `adapter.botUserName(host)` reports it.

The notification list is what makes the UI's own way of addressing someone work.
A comment whose recipients were chosen in the issue's notification field —
rather than by typing `@name` — leaves no `@` in the stored text at all, so it
would otherwise arrive as an unaddressed comment. Backlog carries that list on
the **webhook** only; the same activity fetched from the activities API reports
none. The reason code is not filtered: anything Backlog notified the bot about
counts as a mention.

Through `chat`, the effective check is looser than that: the core runs its own
`@<userName>` regex **case-insensitively** and ORs the result in, so `@chatbot`
reaches your handler with `isMention` true even though this adapter answered
false. The core can only add mentions, never remove one, and it compares
`userName` — the first installation's name — so on every other space the
case-sensitive rule above is the whole story.

Two asymmetries are worth knowing.

A pull request's **summary keeps mention notation raw**: `<@U999>` stays
literal there — in storage, in the API and in the webhook body — while a
description or a comment is rewritten to `@<display name>` on save. A new pull
request's text is matched against both forms, so **read `message.isMention`
rather than re-matching the text yourself**; a handler looking for `@Chatbot`
finds nothing in a summary that says `<@U999>`.

Being the **standing assignee** is not a mention. Assignment is: opening a pull
request assigned to the bot, or changing an issue's or a pull request's assignee
to it, all count. But once the bot is the assignee, later comments, edits and
merges on that subject are ordinary messages — otherwise every review comment
would address the bot. The payload does carry the current assignee on every
event, and this adapter deliberately does not read it as an assignment; only
the change record is one.

That leaves no gap where the change record under-reports. A single `PATCH` that
changed the assignee together with another field was once measured to report the
other fields and not the assignee — but it still notified the new assignee, and
the notification list is read first. So an update naming no assignee change is a
mention when Backlog notified the bot about it and an ordinary message when it
did not, which is also the right answer for a plain edit of a subject the bot
already owns.

To mention someone outbound, use the helpers — writing `<@U…>` notifies the
user even without `notifiedUserId`:

```ts
import type { PostableMarkdown } from 'chat';
import {
  mentionUser,
  mentionTeam,
  MENTION_PROJECT_MEMBERS,
  type BacklogPostableExtras,
} from '@nulab/chat-adapter-backlog';

await thread.post({ markdown: `${mentionUser(100)} please take a look` });

const ping: PostableMarkdown & BacklogPostableExtras = { markdown: 'ping', notifiedUserId: [100, 101] };
await thread.post(ping);
```

The annotated variable is not ceremony: an object literal passed straight to
`post()` — `satisfies` included — is checked against `post()`'s own parameter
type, which knows no Backlog extras, and fails excess-property checking.

`notifiedUserId` is independent: it notifies without leaving a visible `@name`.
Backlog silently drops ids that are not project members.

## Creating an issue

`channel.post()` creates an issue, and only an issue — Backlog exposes no API
that opens a pull request, so there is no counterpart on the pull-request side.
The first block becomes the summary as plain text (Backlog renders no markup in
summaries), the rest becomes the description:

```ts
import type { PostableMarkdown } from 'chat';
import type { BacklogChannelPostableExtras } from '@nulab/chat-adapter-backlog';

const issue: PostableMarkdown & BacklogChannelPostableExtras = {
  markdown: '# Deploy fails on staging\n\nReproduces on every push to main.',
  issueTypeId: 12,   // optional; defaults to the project's first type
  priorityId: 3,     // optional; defaults to the middle priority
  assigneeId: 100,   // optional
};
const channel = chat.channel('backlog:example.backlog.com:500');
await channel.post(issue);
```

The extras go through an annotated variable for the same reason as under
**Mentions**.

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
numbers differ by plan — so read them from the API rather than assuming. Two
members do that, and they answer different questions:

```ts
// What the space applies to your credential right now: every bucket, whatever
// this process has or has not spent. Costs one request, in the `read` bucket.
await adapter.api('example.backlog.com').getRateLimit();
// { read: { limit, remaining, reset }, update: {…}, search: {…}, icon: {…} }

// What this adapter instance last saw in `X-RateLimit-*` response headers.
// Free, and only ever as complete and as current as its own traffic.
adapter.rateLimit('example.backlog.com');
// { read: {…} } — a bucket nothing here has spent is simply absent
```

`rateLimit()` is a record of observation, so two things follow. A `reset`
already in the past means that window has rolled over and `remaining` no longer
describes the budget. And where an instance handles one request and exits — a
serverless function, most obviously — it can only ever report that one
invocation's calls, which is why anything that needs to *decide* against a
budget should ask `getRateLimit()` instead.

```ts
// Anything outside the Chat SDK contract — including the pull-request list
// `listThreads` deliberately does not cover:
const api = adapter.api('example.backlog.com');
const issue = await api.getIssue(8001);
const pullRequests = await api.listPullRequests(500, 700, { count: 20 }); // projectId, repositoryId
```

Issue listing and counting spend the **search** bucket, not `read` — the trap
any polling loop falls into. Listing or counting **pull requests** spends `read`
instead, so the two lists draw on different budgets and one being exhausted says
nothing about the other.

`api(host)` names only the endpoints this adapter itself needs. For anything
else — custom fields, project settings, attachments — `client(host)` hands back
the very [`backlog-js`](https://github.com/nulab/backlog-js) client the port
speaks through, so those calls land in the same buckets, share the same 429
retry and raise the same errors:

```ts
const client = adapter.client('example.backlog.com');
const fields = await client.getCustomFields(500); // projectId
```

Build a Backlog client of your own instead and none of that holds: it spends
the same per-user limit without counting it. `client()` is unavailable in
exactly one configuration — a custom `createApi` replaces the
`backlog-js`-backed port, so there is no client to hand out and `client()`
throws an `AdapterError` with code `NO_CLIENT`.

### A 429 blocks the call for up to a minute

Backlog sends no `Retry-After`, so a 429 is retried once by waiting until
`X-RateLimit-Reset` — **up to `rateLimit.maxWaitMs`, 60 seconds by default,
during which the call simply does not return**. On a paid space the wait is
rare; on a free plan (15 updates per minute) a burst of comments reaches it
easily, and a wait of ~55 seconds was measured on 2026-09-06.

That matters wherever execution time is capped. Serverless runtimes commonly
stop a request at 60 seconds by default — no longer than the wait itself — and
kill the call in the middle of it. The comment then disappears without an
error, because the webhook already answered 200 and the work was running in the
background. Either raise the runtime's ceiling above `maxWaitMs`, or lower
`maxWaitMs` and catch `AdapterRateLimitError` yourself:

```ts
createBacklogAdapter({ rateLimit: { maxWaitMs: 5_000 } });
// beyond 5 s the call rejects with AdapterRateLimitError instead of blocking
```

Both outcomes are logged, at `warn`, through the Chat SDK logger — one line
when the adapter starts waiting, one when it refuses to:

```
rate limited; waiting for the bucket to reset
  { bucket: 'update', remaining: 0, resetAt: '2026-09-06T12:34:00.000Z', waitMs: 55_500, attempt: 1 }
rate limited; not retrying
  { bucket: 'update', remaining: 0, resetAt: '2026-09-06T12:39:00.000Z', waitMs: 300_000, attempt: 1 }
```

Nothing else about rate limiting is logged; a line per request would be one
entry per API call against a per-minute bucket. For the running counts, call
`adapter.rateLimit(host)` for what this instance has seen, or
`adapter.api(host).getRateLimit()` for what the space applies right now.

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
  // Needed to exercise `channel.post()`: it defaults to the project's first
  // issue type, and a project with none is a `ValidationError`.
  issueTypes: { 500: [{ id: 1, name: 'Task' }] },
  repositories: [{ id: 700, projectId: 500, name: 'example-repo', description: '' }],
  pullRequests: [/* BacklogPullRequest values */],
  // Keyed `<repositoryId>:<number>`, because a pull-request comment carries no
  // reference to its parent.
  pullRequestComments: { '700:12': [/* BacklogComment values */] },
});

const adapter = createBacklogAdapter({
  host: 'example.backlog.com',
  apiKey: 'test',
  botUserId: 999,
  botUserName: 'Chatbot',
  // 16 bytes minimum, in a test too: the check runs in the constructor.
  webhookSecret: 'test-webhook-secret',
  createApi: () => api,
});
```

`api.state` exposes issues, comments, repositories, pull requests and their
comments, stars, uploads, notifications and recorded inputs for assertions.

## Links

- [examples/](https://github.com/nulab/chat-adapter-backlog/tree/main/examples)
  — deployable bots built on this adapter, in order of how much they ask of you
- [Chat SDK documentation](https://chat-sdk.dev/docs)
- [Backlog API v2](https://developer.nulab.com/docs/backlog/)
- [sample-messages.md](https://github.com/nulab/chat-adapter-backlog/blob/main/sample-messages.md)
  — a payload per activity type
- [DEVELOPMENT.md](https://github.com/nulab/chat-adapter-backlog/blob/main/DEVELOPMENT.md)
  — contributor setup

## Package name

Chat SDK's convention for community adapters is the unscoped
`chat-adapter-<platform>`, but `chat-adapter-backlog` on npm is already taken
by an unrelated third-party package, so this one is published under the
`@nulab` scope.

## License

[MIT](https://github.com/nulab/chat-adapter-backlog/blob/main/LICENSE) © Nulab Inc.
