# Custom field done gate

Closing an issue with a required custom field still empty hands the issue back
to whoever closed it.

## What it does

Every team has a field that only matters at the end — a release note, a root
cause, a customer reference — and no way to insist on it. Backlog can make a
custom field required on creation, but not on close.

This bot watches for issues moving into the done status, checks one custom
field, and when it is still empty comments on the issue and reassigns it to the
person who just closed it. Nothing to remember, and the reminder reaches the
one person who can act on it.

## Try it

Point it at a text custom field of your project and set
`REQUIRED_CUSTOM_FIELD_ID` to that field's numeric id.

1. Open an issue, leave the field empty, and close it from the issue's own
   page. The bot comments and the issue comes back to you as assignee.
2. Fill the field in and close the issue again. Nothing happens.
3. Tick two issues in the issue list and close them together with **Bulk
   update**. Each one that is still empty gets its own comment — one delivery
   from Backlog, one message per issue.

What it writes:

```
@closer Release note is still empty. Please fill it in before closing.
```

The status stays as you set it. The bot hands the issue back; it does not
reopen it.

## How it works

`src/done-gate.ts` holds the decision; `src/bot.ts` is the only file that talks
to anything.

**Recognising a close.** A status change reaches the handler as
`message.raw.changes[]`, and the entry is
`{ field: 'status', newValue: '<status id>', oldValue }`. Backlog's default
status ids are 1 open, 2 in progress, 3 resolved, 4 closed, which is why
`DONE_STATUS_ID` defaults to `4` and is configurable rather than assumed
(measured on a development space, 2026-09-06).

`message.raw` arrives as `unknown`, so `closedIssueId()` parses it with zod
rather than asserting a shape onto it — and the schema is where the two
deliveries that mean "closed" are named:

- Closing from the issue's own page is **activity type 2**, and the issue is
  `payload.content.id`.
- Closing from the issue list is **activity type 14**, one delivery covering
  every issue in the batch — including a batch of one. The adapter fans it out
  into a message per issue, so the handler sees `raw.kind === 'bulkUpdate'`
  with `raw.issueId` naming which one. `changes[]` describes the whole batch
  and carries no `oldValue`.

Only these two webhook-sourced kinds parse. `changes[]` is normalised to one
shape across sources, but the values are not: a webhook writes a status **id**,
while the REST change log writes the status's **display name**. The kind is
what the schema discriminates on, so a project that named a status `"4"` cannot
trip the gate.

**Reading the current value.** The webhook says what changed, not what the
issue now holds, so the bot reads the issue back with
`backlog.client(host).getIssue(issueId)` and looks through `customFields[]` for
the configured id. `client(host)` hands out the `backlog-js` client the adapter
makes its own calls with — the port names no custom fields — so this read is
counted in the same rate-limit budget and fails with the same error classes as
everything else the adapter does.

A field is empty when its value is `null`, an empty or whitespace-only string,
an empty array, or — for a selection — an object with no `id`. Emptiness is
decided per shape rather than by falsiness, so a number field holding `0`
counts as filled in. An id that matches no field on the issue is a
configuration mistake, and the bot logs it and does nothing rather than
accusing anybody.

**Handing it back.** The bot mentions the person who closed the issue with
`<@U{id}>`, the notation Backlog resolves to a mention and a notification, and
sets `assigneeId` to the same user. It never changes the status: a bot that
reopened what somebody just closed would be in an edit war with them by the
second round, and the assignee plus a comment already puts the issue in front
of the right person.

**Not commenting twice.** Backlog delivers at least once and the dedupe state
expires after ten minutes, so before commenting the bot reads the issue's
newest comments and skips if it has already said the same sentence there. The
issue's own comments are the durable record; nothing has to be stored between
requests.

## Deploy

This directory is a complete project: it depends on the published adapter, has
no link to the repository around it, and deploys as it stands. Copy it
somewhere of your own if you like.

The [shared setup](../README.md#shared-setup) covers the bot user, its API key
and the webhook secret. Then point a Vercel project at this directory
(**Root Directory** → `examples/custom-field-done-gate` if you deploy from a
clone of this repository, or the repository root if you copied the directory
out).

Locally:

```sh
npm install
npm run typecheck
npm run deploy      # npx vercel deploy
```

On top of the five shared variables:

| Variable                   | Required | Meaning                                                              |
| -------------------------- | -------- | -------------------------------------------------------------------- |
| `DONE_STATUS_ID`           | no       | Status id that counts as closed. Defaults to `4`, Backlog's default. |
| `REQUIRED_CUSTOM_FIELD_ID` | yes      | Numeric id of the custom field that must be filled in.               |

Both are validated at startup, so a typo fails the first cold start instead of
sending `NaN` to Backlog when somebody closes an issue.

Register the webhook with **activity types 2 and 14** — nothing else. Type 2 is
a change made on the issue page, type 14 a change made from the issue list, and
between them they are every way an issue's status changes. Leave 14 out and
closes made from the issue list go unnoticed. Never use **allEvent**.

## Limits

- **The status is left alone by design.** The bot reassigns and comments; it
  does not reopen. Two bots — or a bot and a determined human — flipping a
  status back and forth is worse than an issue closed with a field empty.
- **A redelivery after ten minutes can comment twice.** The comment check reads
  only the issue's newest few comments, so a redelivery arriving after enough
  other comments to push the bot's own out of that window is not recognised.
- **Custom fields are per issue type.** A field that does not apply to the
  issue that was closed reads as absent, and the bot logs the mismatch rather
  than treating it as empty — which also means a genuinely misconfigured id
  looks the same as a field that simply does not apply here.
- **Rate limits are shared with the adapter.** Reading the issue and its
  comments spends the `read` budget, and the comment and the reassignment spend
  the `update` budget, all against the bot user's own per-minute quota.
- **A 429 waits up to 60 seconds.** The adapter waits for Backlog's reset
  once, so `api/webhooks/backlog.ts` sets `maxDuration` to 90 seconds rather
  than 60, where the wait would be cut off silently. A reset further off, or a
  second 429, rejects with `AdapterRateLimitError`, which the function's logs
  show as a message processing error; the hand-back for that delivery is not made, and nothing
  retries it, because the webhook was already answered.
- **State is in memory.** Deduplication holds for ten minutes and only within
  one serverless instance; see the [shared limits](../README.md#limits-they-share).
- **Nothing else is watched.** Pull requests have their own status and are not
  gated. A field emptied _after_ the issue was closed is not noticed, because
  the bot only ever reacts to the status change itself.
