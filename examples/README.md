# Examples

Small, deployable bots built on `@nulab/chat-adapter-backlog`. Each one is a
complete Vercel project you can point at your own space, not a snippet — and
each one does a single job somebody would actually want done.

They are listed by how much they ask of you. Read the first one first:
everything after it assumes you already have the [shared
setup](#shared-setup) working.

| Example                                              | What it does                                                                                                             | Stage                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| [`reassign-on-mention`](./reassign-on-mention)       | Mention the bot together with people, and it hands the issue to one of them at random.                                   | The minimum: read a webhook, act.        |
| [`custom-field-done-gate`](./custom-field-done-gate) | Closing an issue with a required custom field still empty hands it back to whoever closed it.                            | A small exchange: check, then push back. |
| [`bug-intake`](./bug-intake)                         | A bug report gets a first-response triage comment written by an AI, and is handed to the intake contact when it is done. | Applied: an AI writes the reply.         |

## Each example is a standalone project

An example is **not** a workspace member of this repository. It depends on the
published adapter (`@nulab/chat-adapter-backlog` from npm), installs on its
own, and deploys from its own directory — so you can copy one out of here and
it keeps working, and nothing you do to it can break this repository's install
or its tests.

That also sets what an example does _not_ have: no test runner, no lint or
format hook of its own, no entry in `pnpm-lock.yaml`, and a `vercel.json` that
names the install command and orchestrates nothing else.

```sh
cd examples/<name>
npm install
npm run typecheck
npm run deploy      # npx vercel deploy
```

The examples use **npm**, not the pnpm this repository is built with. Inside a
clone, `pnpm install` in an example directory finds the repository's
`pnpm-workspace.yaml` in a parent directory and installs the repository instead
of the example; npm has no such lookup, so it installs the directory it is run
in, copied out or not.

## Shared setup

All three examples want the same things from Backlog and the same shape of
Vercel project. Do this once; an example's own README picks up from here.

### 1. A bot user, its API key, and its numeric id

Follow **Platform setup** in the [root README](../README.md#platform-setup):
create a bot user, add it to the project, issue an API key as that user, and
read its numeric id from `GET /api/v2/users/myself`.

Two things people get wrong here, both worth stating twice:

- `BACKLOG_BOT_USER_ID` is the **numeric** `id`, not the login name. The
  adapter uses it to recognise its own activity, so a wrong value means the bot
  answers itself. Set it: left out, every cold start spends a request reading
  it again.
- The bot needs permission to comment, and — for the examples that reassign an
  issue — to update issues in the project.

### 2. A webhook secret

Backlog cannot sign webhooks, so the secret travels in the hook URL:

```sh
openssl rand -hex 32
```

The URL you register in Backlog, once the deployment exists, is:

```
https://<your-app>/api/webhooks/backlog?token=<secret>
```

`<secret>` is the value above, exactly as in `BACKLOG_WEBHOOK_SECRET`.

Read **Webhook authenticity** in the [root README](../README.md#webhook-authenticity--read-this)
before you deploy anything. The short version: the URL is the credential, so
keep it out of logs and issue trackers, and register it only in the space
`BACKLOG_HOST` names.

### 3. A Vercel project whose Root Directory is the example

In the Vercel project settings, set **Root Directory** to
`examples/<the example>` and leave the install and build commands alone.
The example's `vercel.json` already sets the install command to `npm install`,
so the install does not depend on which lockfile Vercel finds: an example has
none of its own, and the `pnpm-lock.yaml` at the top of this repository
describes the adapter, not the example. (Copy the directory out of this
repository and the Root Directory is simply the repository root.)

One Vercel project per example. They are separate deployments with separate
webhook URLs, and running two of them against the same project in Backlog is
fine — each ignores the events it has nothing to say about.

### 4. Environment variables

These five are read by `createBacklogAdapter()` and are the same in every
example:

| Variable                 | Meaning                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `BACKLOG_HOST`           | Space host, no scheme or path — for example `example.backlog.com`.         |
| `BACKLOG_API_KEY`        | The bot user's API key.                                                    |
| `BACKLOG_BOT_USER_ID`    | The bot user's numeric id.                                                 |
| `BACKLOG_BOT_USER_NAME`  | The bot user's display name; required by an example that answers mentions. |
| `BACKLOG_WEBHOOK_SECRET` | The secret from step 2, also present in the hook URL you register.         |

Each example adds a few of its own on top, documented in its README and listed
in its `.env.example`:

| Example                  | Adds                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `reassign-on-mention`    | nothing                                                                                             |
| `custom-field-done-gate` | `DONE_STATUS_ID`, `REQUIRED_CUSTOM_FIELD_ID`                                                        |
| `bug-intake`             | `DONE_STATUS_ID`, `BUG_ISSUE_TYPE_NAME`, `INTAKE_CONTACT_USER_ID`, `AI_MODEL`, `AI_GATEWAY_API_KEY` |

Every variable is validated when the bot starts, so a missing one or a
non-numeric id fails the deployment's first request rather than sending `NaN`
to Backlog later.

### 5. Which activity types to register

The webhook's activity-type checkboxes are the only switch for what reaches a
handler, and each example needs a different set. Register exactly these:

| Example                  | Activity types      | Why                                                                |
| ------------------------ | ------------------- | ------------------------------------------------------------------ |
| `reassign-on-mention`    | 1, 2, 3, 18, 19, 20 | Mentions arrive on issues and on pull requests alike.              |
| `custom-field-done-gate` | 2, 14               | It reacts to a status change, from either screen it can come from. |
| `bug-intake`             | 1, 2, 14            | A new issue to triage, plus the status change that closes it.      |

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

The same files, in the same places, so that reading a second example costs
nothing:

```
examples/<name>/
  README.md                 # What it does / Try it / How it works / Deploy / Limits
  package.json
  vercel.json
  .vercelignore             # keeps a local .env out of the deployment
  .env.example
  tsconfig.json
  api/webhooks/backlog.ts   # the Vercel function
  src/bot.ts                # Chat + adapter, and the handler registrations
  src/<logic>.ts            # the decision the example exists to demonstrate
```

`src/bot.ts` holds the side effects and `src/<logic>.ts` holds the rule, so the
thing you came to read is separate from the wiring around it. Neither is
tested: an example is small enough to read end to end, and it earns its keep by
being copied rather than by being verified.

Two things they all do the same way, and both are the interesting part rather
than boilerplate:

- **Anything typed `unknown` is parsed with zod**, never asserted.
  `message.raw` reaches a handler as `unknown`, and parsing is also what makes
  keys the adapter's own schema does not name readable at all — the payload is
  the body Backlog sent, with its unknown keys intact.
- **Backlog is called through `backlog.client()`**, the `backlog-js` client
  the adapter hands out, for the endpoints its port does not name. It is the
  same client the adapter makes its own calls with, so an example's requests
  are counted in the same rate-limit budget, retried on a 429 by the same rule,
  and fail with the same error classes.

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
- A 429 is waited out for up to the adapter's 60 seconds, so every function
  sets `maxDuration` to 90 seconds: a 60-second ceiling would cut the wait off
  silently, after the webhook had already answered.
- With no framework, Vercel serves every file outside `api/` as it stands, so
  `src/*.ts`, `README.md` and `tsconfig.json` are readable on the deployment.
  They are the same files as this repository and hold no secret; what would, a
  local `.env`, is kept out by `.vercelignore`.
