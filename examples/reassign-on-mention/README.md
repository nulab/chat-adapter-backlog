# Reassign on mention

Mention the bot on an issue together with the people you would accept as an
owner, and it hands the issue to one of them at random and says who got it.

## What it does

It is the round-robin somebody usually does by hand in a triage meeting: you
already know which two or three people could take the ticket, and you only want
the coin flip made and recorded. This is the smallest useful bot in this
directory — one webhook in, one issue update and one comment out, no state kept
between requests.

## Try it

Register the webhook and set the environment as **Deploy** describes, then, on
any issue in the project:

**1. Mention the bot and offer it some people.** Write a comment naming the bot
and pick two teammates in the comment form's notification field:

```
@Chatbot please pick someone
```

The bot reassigns the issue and answers:

```
Assigned to @Bob (picked from 2 people you notified).
```

**2. Mention the bot and offer it nobody.** Post the same comment with the
notification field empty. The issue keeps its assignee and the bot explains
what it needs:

```
I need somebody to hand this to. Mention me together with the people to choose
from — pick them in the notification field, or write @Name in the comment — and
I will assign this issue to one of them at random.
```

**3. Assign the issue to the bot.** No comment at all: just set the assignee to
the bot user. The assignment is itself the mention, so the bot wakes up — but an
assignment notifies only the new assignee, which is the bot, so there is nobody
to choose from and you get the same explanation as in 2. Mentioning the bot in a
comment is the route that carries candidates.

Writing `@Name` in the comment text works exactly as well as the notification
field, and the two can be mixed: both put the person in the same place in the
delivery.

## How it works

One handler, `chat.onNewMention` in [`src/bot.ts`](./src/bot.ts), and the
decision it makes in [`src/reassign.ts`](./src/reassign.ts).

**Where the candidates come from.** The webhook delivery's top-level
`notifications[]` names every user the activity notified, each as
`{ id, reason, user: { id, name, … }, … }` — the people picked in the
notification field, the people `@`-mentioned in the comment text, and the new
assignee of an assignment alike (measured on a development space, 2026-09-06).
This is webhook-only data: the same activity read back from the activities API
carries `notifications: []`, so there is nowhere else to ask.

`readDelivery()` parses that array with zod rather than asserting a type onto
it. `message.raw` reaches a handler as `unknown` — the SDK's mention handler
takes a `Message` whose raw payload is unparameterised — and parsing is also
what makes `user.name` reachable at all: `raw.payload` is the body Backlog sent
with its unknown keys intact, so the name is there at run time even though the
adapter's own schema names only `user.id`. Every branch of the schema falls
back rather than throwing, and an entry without a positive `id` and a non-empty
`name` is dropped on its own: the bot addresses its pick by name, so a
candidate it cannot name is no candidate.

**Who is eliminated.** `chooseAssignee()` drops the bot itself, then drops the
current assignee — but only while somebody else is left, so mentioning the bot
on an issue that is already yours hands it back to you rather than reporting
nobody. The current assignee comes from the `content.assignee` snapshot every
delivery carries (`null` when unassigned, measured on a development space,
2026-09-06); reading it there costs nothing, and it is the state the
notification described.

**The two calls.** The reassignment is
`backlog.client(host).patchIssue(issueId, { assigneeId })`. `client(host)`
hands out the `backlog-js` client the adapter makes its own calls with, so this
request is counted in the same rate-limit budget, retried on a 429 by the same
rule, and fails with the same error classes — none of which would be true of a
second client built beside it. The reply then goes out with `thread.post()`,
mentioning the new assignee in Backlog's `<@U<id>>` notation; that notation
notifies the user on its own, so the bot needs no `notifiedUserId`.

**Pull requests are declined.** A pull request's assignee is set through a
different endpoint, so a mention on one gets a one-line reply saying so. Which
kind of subject a thread is is already encoded in its thread id, so
`backlog.decodeThreadId(message.threadId)` answers the question without the API call
`message.subject` would cost.

## Deploy

This directory is a complete project: it depends on the published adapter, has
no link to the repository around it, and deploys as it stands. Copy it
somewhere of your own if you like.

Follow the [shared setup](../README.md#shared-setup) first — the bot user, its
numeric id, and the webhook secret — then point a Vercel project at this
directory (**Root Directory** → `examples/reassign-on-mention` if you deploy
from a clone of this repository, or the repository root if you copied the
directory out).

The bot user needs permission to **comment on** and to **update** issues in the
project; without the second, the reassignment fails and the comment never
appears.

Locally:

```sh
npm install
npm run typecheck
npm run deploy      # npx vercel deploy
```

### Environment variables

This example adds none of its own:

| Variable                 | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `BACKLOG_HOST`           | Space host, no scheme or path — for example `example.backlog.com`. |
| `BACKLOG_API_KEY`        | The bot user's API key.                                            |
| `BACKLOG_BOT_USER_ID`    | The bot user's numeric id.                                         |
| `BACKLOG_BOT_USER_NAME`  | The bot user's display name.                                       |
| `BACKLOG_WEBHOOK_SECRET` | The secret carried in the hook URL you register.                   |

All five are validated at cold start, so a missing variable or a non-numeric id
fails the deployment's first request instead of sending `NaN` to Backlog later.

### The webhook

Point the hook URL at `POST /api/webhooks/backlog` on the deployment, with the
secret in it as the shared setup describes, and tick these activity types:

| Type                       | Why                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 Issue Created            | An issue opened already assigned to the bot is a mention.                                                                                                                |
| 2 Issue Updated            | An assignment or an edit that notifies the bot.                                                                                                                          |
| 3 Issue Commented          | The main route: a comment naming the bot and some candidates.                                                                                                            |
| 18, 19, 20 (pull requests) | Optional. Register them only if you want the bot to answer a mention on a pull request with the "I only reassign issues" line; leave them out and it stays silent there. |

Never tick **allEvent**, and there is no reason to tick **14** here: a bulk
update from the issue list notifies nobody, so it would wake the handler with no
candidates.

## Limits

- **A pull request is not reassigned.** Its assignee is set through a different
  endpoint than an issue's, which this example does not call. It replies with
  one line and changes nothing.
- **The pick is uniform and unaware.** No workload, no availability, no
  round-robin memory — it is `Math.random` over the people you named, and it can
  pick the same person twice in a row.
- **Only the people the delivery notified are eligible.** Project membership is
  never listed, so the bot cannot pick somebody you did not name. That is the
  point: you choose the shortlist, it chooses within it.
- **State is in memory.** Deduplication holds for 10 minutes and only within one
  serverless instance. Delivery is at-least-once, so a redelivery after that
  window reassigns again — the same shortlist, a fresh coin flip.
- **The rate limit is shared.** The reassignment and the comment both spend the
  bot user's `update` bucket, alongside everything else the adapter posts.
- **A 429 waits up to 60 seconds.** The adapter waits for Backlog's reset
  once, so `api/webhooks/backlog.ts` sets `maxDuration` to 90 seconds rather
  than 60, where the wait would be cut off silently. A reset further off, or a
  second 429, rejects with `AdapterRateLimitError`, which the function's logs
  show as a message processing error; the reassignment or the comment for that delivery is not
  made, and nothing retries it, because the webhook was already answered.
- **Nothing is remembered.** The bot never subscribes to a thread, so follow-up
  messages that do not mention it are not seen. Mention it again to reassign
  again.
