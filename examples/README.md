# Examples

Small, deployable bots built on `@nulab/chat-adapter-backlog`. Each one is a
complete Vercel project you can point at your own space, not a snippet — and
each one does a single job somebody would actually want done.

They are ordered by how much they ask of you. Read `01` first: everything after
it assumes you already have the [shared setup](#shared-setup) working.

| Example                                                    | What it does                                                                                                             | Stage                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| [`01-reassign-on-mention`](./01-reassign-on-mention)       | Mention the bot together with people, and it hands the issue to one of them at random.                                   | The minimum: read a webhook, act.        |
| [`02-custom-field-done-gate`](./02-custom-field-done-gate) | Closing an issue with a required custom field still empty hands it back to whoever closed it.                            | A small exchange: check, then push back. |
| [`03-bug-intake`](./03-bug-intake)                         | A bug report gets a first-response triage comment written by an AI, and is handed to the intake contact when it is done. | Applied: an AI writes the reply.         |

**The directories are coming in separate PRs.** This index and the workspace
wiring landed first so that each example arrives as one reviewable change; the
links above are dead until the PR that adds that example merges.

## Shared setup

All three examples need the same four things from Backlog and the same shape of
Vercel project. Do this once.

### 1. A bot user, its API key, and its numeric id

Follow **Platform setup** in the [root README](../README.md#platform-setup):
create a bot user, add it to the project, issue an API key as that user, and
read its numeric id from `GET /api/v2/users/myself`.

Two things people get wrong here, both worth stating twice:

- `BACKLOG_BOT_USER_ID` is the **numeric** `id`, not the login name. The
  adapter uses it to recognise its own activity, so a wrong value means the bot
  answers itself.
- The bot needs permission to comment, and — for the examples that reassign an
  issue — to update issues in the project.

### 2. A webhook secret

Backlog cannot sign webhooks, so the secret travels in the hook URL:

```sh
openssl rand -hex 32
```

Read **Webhook authenticity** in the [root README](../README.md#webhook-authenticity--read-this)
before you deploy anything. The short version: the URL is the credential, so
keep it out of logs and issue trackers, and check the `host` you register
against the space you register it in.

### 3. A Vercel project whose Root Directory is the example

Every example is a workspace member that depends on the adapter through
`workspace:*`, so the install and the adapter build have to happen at the
**repository root** — but the functions Vercel serves live in the example.
That is why each example ships a `vercel.json` of this shape:

```json
{
  "framework": null,
  "installCommand": "cd ../.. && pnpm install --frozen-lockfile",
  "buildCommand": "cd ../.. && pnpm build"
}
```

So, in the Vercel project settings:

- **Root Directory** → `examples/<the example>`
- Leave the install and build commands alone; `vercel.json` sets them.

One Vercel project per example. They are separate deployments with separate
webhook URLs, and running two of them against the same project in Backlog is
fine — each ignores the events it has nothing to say about.

### 4. Environment variables

These five are read by `createBacklogAdapter()` and are the same in every
example:

| Variable                 | Meaning                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `BACKLOG_HOST`           | Space host, no scheme or path — for example `example.backlog.com`. |
| `BACKLOG_API_KEY`        | The bot user's API key.                                            |
| `BACKLOG_BOT_USER_ID`    | The bot user's numeric id.                                         |
| `BACKLOG_BOT_USER_NAME`  | The bot user's display name.                                       |
| `BACKLOG_WEBHOOK_SECRET` | The secret from step 2, also present in the hook URL you register. |

Each example adds a few of its own on top, documented in its README and listed
in its `.env.example`:

| Example                     | Adds                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `01-reassign-on-mention`    | nothing                                                                                             |
| `02-custom-field-done-gate` | `DONE_STATUS_ID`, `REQUIRED_CUSTOM_FIELD_ID`                                                        |
| `03-bug-intake`             | `DONE_STATUS_ID`, `BUG_ISSUE_TYPE_NAME`, `INTAKE_CONTACT_USER_ID`, `AI_MODEL`, `AI_GATEWAY_API_KEY` |

### 5. Which activity types to register

The webhook's activity-type checkboxes are the only switch for what reaches a
handler, and each example needs a different set. Register exactly these:

| Example                     | Activity types      | Why                                                                |
| --------------------------- | ------------------- | ------------------------------------------------------------------ |
| `01-reassign-on-mention`    | 1, 2, 3, 18, 19, 20 | Mentions arrive on issues and on pull requests alike.              |
| `02-custom-field-done-gate` | 2, 14               | It reacts to a status change, from either screen it can come from. |
| `03-bug-intake`             | 1, 2, 14            | A new issue to triage, plus the status change that closes it.      |

Never use **allEvent**: the range runs to 49 and includes git, wiki and
document activity these examples have no meaning for.

Type **14** is worth understanding before you tick it. A bulk update from the
issue list arrives as one delivery covering every issue in it, with no
per-issue event — and that is true of a batch of one, so an update made from
the issue list is a type 14 even for a single issue. The adapter fans that
delivery out into one message per issue. Leaving 14 unregistered is the
supported way to decline the fan-out, at the cost of missing any update made
from the issue list. The root README's **Platform setup** covers the trade-off
in full.

## What every example looks like

The same seven files, in the same places, so that reading a second example
costs nothing:

```
examples/<NN>-<name>/
  README.md                 # What it does / Try it / How it works / Deploy / Limits
  package.json
  vercel.json
  .env.example
  tsconfig.json
  api/webhooks/backlog.ts   # the Vercel function
  src/bot.ts                # Chat + adapter, and the handler registrations
  src/<logic>.ts            # the decision, as a pure function
  src/<logic>.test.ts       # what that function is specified to do
```

The split between the last three is the point of the layout: `src/bot.ts` is
the only file with side effects, and the rule the example exists to demonstrate
lives in a pure function next to it, so the test can state the rule without a
webhook, a network or a mock.

## Running one locally

From the repository root:

```sh
pnpm install
pnpm --filter @nulab/chat-adapter-backlog-example-<name> typecheck
pnpm --filter @nulab/chat-adapter-backlog-example-<name> test
```

CI runs `typecheck` and `test` for every example on every pull request, and the
root `pnpm lint` and `pnpm format:check` cover `examples/` too.

## Limits they share

- State is in memory (`@chat-adapter/state-memory`), so deduplication holds for
  10 minutes and only within one serverless instance.
- Webhook delivery is at-least-once. Every example keeps its side effects
  idempotent on `message.id` rather than assuming one delivery.
- Backlog's rate limits are per user, per minute, and the bot user's budget is
  what an example spends. A bulk update of fifty issues is fifty handler runs
  from a single request.
- None of them subscribes to threads; each answers the delivery in front of it
  and keeps nothing between requests.
