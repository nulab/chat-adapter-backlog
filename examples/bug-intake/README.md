# Bug intake

A bug report gets a first-response triage comment written by an AI, and is
handed to the intake contact once somebody closes it.

Read [the shared setup](../README.md#shared-setup) first; this example picks up
from there.

## What it does

Somebody files a bug and the report is thin — no version, no steps, no idea how
many people it affects. Whoever triages it has to read it, work out what is
missing, and ask. This bot does that first pass the moment the issue is filed:
it says what the report already contains, asks for each detail it does not, and
proposes a severity in the names of the project's own priorities.

Backlog's built-in AI can already summarise an issue. This is not a summary:
it is an intake desk. It **asks the reporter for what is missing** and
**proposes a severity with a reason** — and it deliberately never guesses at a
cause or a fix, because a plausible-looking diagnosis stops the reporter
finishing the report.

When the bug is closed, it goes back to the intake contact with a note saying
who closed it, so the report is confirmed by a person rather than just
disappearing.

## Try it

1. **File a thin bug.** Create an issue of type `Bug` with a summary and
   almost no description — say, only "Exporting a report does nothing." The
   bot answers with a comment like this one, addressed to the reporter:

   ```markdown
   <@U10>

   **Summary**
   Exporting a report from the report page does nothing.

   **What the report has**

   - The action that fails: clicking export on the report page.

   **What is missing**

   - Reproduction steps
   - Expected result
   - Actual result
   - Environment
   - Affected scope

   **Questions for the reporter**

   1. What steps do you take from opening the report page until export fails?
   2. What did you expect the export to produce?
   3. What happens instead — an error, a blank file, nothing at all?
   4. Which browser and OS version are you on?
   5. Does this affect every report, or only one?

   **Suggested severity**
   Normal — a single feature fails with no data loss, and no scope is known yet.
   ```

2. **File a complete one.** Create a `Bug` whose description already has steps,
   expected and actual results, the environment and the scope. The comment
   confirms what is there, `What is missing` reads
   `Nothing — this report is complete.`, and the severity comes with a reason
   drawn from the impact you described.

3. **Close a bug.** Move it to the done status. It is reassigned to the intake
   contact, who gets:

   ```markdown
   <@U77>

   Marked done by Ada Lovelace. Handing it to you for confirmation.
   ```

4. **File something else.** Create an issue of any other type. Nothing
   happens — no comment, no reassignment.

## How it works

One `onNewMessage` handler serves both jobs, in `src/bot.ts`. Everything it
decides is in `src/intake.ts`: the prompt, the fallback, and the two readers
that say whether a delivery is interesting.

**Is this an issue at all?** `decodeThreadId(thread.id)` gives the subject, and
a subject whose `kind` is not `issue` is dropped — the same webhook can carry
pull-request activity.

**Is this delivery interesting?** Both of the questions below — is it a new
report, was it just closed — are answered from the message alone, and they are
asked before anything is read, so a comment on a bug costs no API call.

**Is it a bug?** The issue is read with `backlog.client(host).getIssue(id)`
and its `issueType.name` is compared with
`BUG_ISSUE_TYPE_NAME`. That one read is also where the summary, description,
reporter and assignee come from, so the handler spends exactly one request and
then decides everything from it. Reading the issue rather than the payload is
deliberate: a type-1 or type-2 delivery does carry an issue snapshot in
`content` — including `issueType` — but a type-14 bulk update carries no
snapshot at all (measured on a development space, 2026-09-06), and `issueType`
is not among the fields the adapter's payload types declare. One read answers
all three activity types the same way.

`client(host)` hands out the `backlog-js` client the adapter makes its own
calls with, which is how both this read and the reassignment below stay inside
the adapter's bounded 429 retry and its error classes. Building a second
client here would have both silently not apply.

**Is it a new report?** `decodeMessageId(message.id).part` is `root` for an
issue's body and `comment` or `update` for anything written on it afterwards,
so the intake pass runs on the body alone. A pull request being opened is also
a `root`, which is the second reason the subject kind is checked.

**Was it just closed?** A status change arrives in `changes[]` as
`{ field: 'status', newValue: '<status id>' }` — a status **id** as a string,
where most fields carry a display name (measured on a development space,
2026-09-06). `message.raw` reaches the handler as `unknown`, so the two shapes
that can carry one are named as a zod discriminated union rather than
asserted: a type-2 update made on the issue's own page, and a `bulkUpdate`
message the adapter fans out of a type-14 delivery from the issue list.
Nothing else parses, and `newValue` is compared with `DONE_STATUS_ID`.

**Writing the comment.** `buildIntakePrompt()` produces the system prompt and
the report; `generateText()` from the Vercel AI SDK answers it, and the reply
is posted as the comment body with no parsing — the prompt fixes the Markdown
shape, so there is nothing to parse. The reporter
(`issue.createdUser.id`) is mentioned with `mentionUser()`. If the model throws
or answers with nothing, a fixed sentence is posted instead and the reason is
logged; the reporter always gets an answer.

**Handing it over.** The assignee is only changed when the contact does not
already hold the issue, so re-closing a bug that is already with the contact
costs a comment and no write.

## Deploy

This directory is a complete project: it depends on the published adapter, has
no link to the repository around it, and deploys as it stands. Copy it
somewhere of your own if you like.

Point a Vercel project at this directory (**Root Directory** →
`examples/bug-intake` if you deploy from a clone of this repository, or the
repository root if you copied the directory out). The `deploy` scripts call
the Vercel CLI through `npx`, so install it globally or let `npx` fetch it; it
is deliberately not a dependency of this example.

```sh
npm install
npm run typecheck
npm run deploy      # npx vercel deploy
```

Then set:

| Variable                 | Required | Meaning                                                                        |
| ------------------------ | -------- | ------------------------------------------------------------------------------ |
| `BACKLOG_HOST`           | yes      | Space host, no scheme — `example.backlog.com`.                                 |
| `BACKLOG_API_KEY`        | yes      | The bot user's API key. Also used for the reassignment.                        |
| `BACKLOG_BOT_USER_ID`    | yes      | The bot user's numeric id.                                                     |
| `BACKLOG_BOT_USER_NAME`  | yes      | The bot user's display name.                                                   |
| `BACKLOG_WEBHOOK_SECRET` | yes      | The secret that also sits in the hook URL.                                     |
| `INTAKE_CONTACT_USER_ID` | yes      | Numeric user id a closed bug is handed to. Startup fails if this is not an id. |
| `BUG_ISSUE_TYPE_NAME`    | no       | Issue type to triage. Defaults to `Bug`; use `バグ` on a Japanese space.       |
| `DONE_STATUS_ID`         | no       | Status id that counts as done. Defaults to `4`, Backlog's own `Closed`.        |
| `AI_MODEL`               | no       | Vercel AI Gateway model string. Defaults to `openai/gpt-5.4-nano`.             |
| `AI_GATEWAY_API_KEY`     | local    | Only for running outside Vercel; on Vercel the OIDC token authenticates.       |

The default model is deliberately a cheap one, because intake is a short,
structured job and the bot runs on every bug filed. If the triage is not sharp
enough — severities that read wrong, missing details not spotted — raise
`AI_MODEL` to a stronger model; nothing else has to change.

Register the webhook with **activity types 1, 2 and 14**: 1 for a new issue to
triage, 2 for the status change that closes one from the issue page, and 14 for
the same change made from the issue list. Never use **allEvent**.

## Limits

- **Both Backlog calls go through the adapter's client.** Reading the issue and
  reassigning it use `backlog.client(host)`, so they share the adapter's one
  bounded 429 retry and its error classes — but
  they also share its per-minute budget with everything else the adapter does,
  and a request that fails after the retry surfaces as a thrown error with the
  webhook already answered.
- **A 429 waits up to 60 seconds.** The adapter waits for Backlog's reset
  once, so `api/webhooks/backlog.ts` sets `maxDuration` to 90 seconds rather
  than 60, where the wait would be cut off silently. A reset further off, or a
  second 429, rejects with `AdapterRateLimitError`, which the function's logs
  show as a message processing error; the intake comment or the hand-off for that delivery is not
  made, and nothing retries it, because the webhook was already answered.
- **A new issue or a close costs one Get Issue**, including when the issue
  turns out to be of another type. Ordinary comments cost nothing, because the
  two questions that select a delivery are answered from the message alone.
  The `read` bucket is the 600/min one, but a bulk update of fifty issues is
  fifty handler runs, and so fifty reads, from a single request.
- **An AI call per bug filed.** It is not cached and not rate-limited here; the
  model is billed per report.
- **At-least-once delivery, in-memory dedupe.** State is
  `@chat-adapter/state-memory`, so deduplication holds for 10 minutes and only
  within one serverless instance. A redelivery after that, or to another
  instance, posts the intake comment again.
- **The issue type is matched by display name.** Renaming the type in Backlog
  silently stops the bot, and a project whose bug type is named differently
  needs its own `BUG_ISSUE_TYPE_NAME`.
- **Not handled:** issues created by the bot itself are ignored, pull requests
  are ignored entirely, a bug reopened after being handed over gets no second
  intake pass, and nothing re-reads the report after the reporter answers the
  questions.
