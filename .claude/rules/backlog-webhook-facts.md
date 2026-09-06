---
paths:
  - "src/**/*.ts"
---

# Backlog webhook facts

What a Backlog webhook actually delivers, as opposed to what the payload shape
suggests. Facts marked "measured" were observed on a real Backlog space on the
given date; when code contradicts one, re-measure on a space before changing
the code toward intuition. CLAUDE.md § Backlog API landmines already covers the
no-HMAC problem and activity type ids 1/2/3/17; this file adds what it omits.

## Payload envelope

- The body is one Activity object: `{ id, project{ id, projectKey, name, ... },
  type, content, notifications[], createdUser, created }`, the same shape
  `GET /space/activities` returns ("the webhook type is the same as the Backlog
  API response for Get recent updates",
  https://support.nulab.com/hc/en-us/articles/8840133998489). Measured
  2026-09-03: one element of `GET /projects/:id/activities` posted verbatim as
  the request body is indistinguishable from a real delivery.
- No dedicated webhook-payload page exists (`/docs/backlog/webhook/` 404 on
  2026-09-04); shapes come from the Get Recent Updates page and `backlog-js`.
- Nothing in the body identifies the space (host). `projectKey` and the numeric
  ids are not unique across spaces. Derive the space from the request URL the
  webhook was registered with, never from the payload.
- A body from space B posted to space A's own hook URL — right secret, wrong
  `?host=` — is therefore **indistinguishable from a genuine delivery** and is
  answered 200 (measured 2026-09-06 across two spaces). The receiver then
  reads space B's ids through space A's credentials. That is not reliably a
  404: two spaces were observed allocating issue ids from interleaving ranges
  within minutes of each other (measured 2026-09-06), so an id from one space
  can name a real, unrelated issue in the other. Only the registered URL
  prevents this; see docs/specs/adapter.md D19 for why the payload cannot be
  cross-checked against the host.
- `content.id` is the issue's space-wide numeric id; `content.key_id` is the
  trailing number of the issue key; the `issueKey` string is absent. Key
  persisted identifiers on `content.id` and `project.id`, never on `key_id` or
  `${projectKey}-${key_id}`: renaming a project key rewrites every issue key
  under it, ids never change.
- Top-level `notifications` **is populated on a webhook delivery** and names
  every user the activity notified: `[{ id, alreadyRead, reason,
  resourceAlreadyRead, user{ id, name, roleType, lang, ... } }]` (measured
  2026-09-06). `reason` follows Get Notification's codes
  (`backlog-api-facts.md`): a comment addressed to someone through the UI
  notification field or by a `<@U…>` in its text arrives as `reason: 2`, a
  `PATCH` that changes the assignee as `reason: 1`. `content.comment.
  notifications` is still absent.
- The **same activity fetched from `GET /space/activities` or `GET /projects/
  :id/activities` carries `notifications: []`** (measured 2026-08-20,
  2026-09-03 and 2026-09-06), which is also what the Get Recent Updates page
  and `backlog-js`'s `notifications: []` typing describe. So the two bodies
  are *not* interchangeable in this one field, and the webhook is the only
  place the notification list can be read at all. An activity-API body
  replayed as a webhook is still valid — it just says nothing about who was
  notified, which is why mention detection keeps its textual and assignment
  rules (docs/specs/adapter.md §5.4).
- Top-level `created` on the webhook and on the same activity fetched later via
  the API are identical strings (measured 2026-08-31). Top-level `id` is the
  activity id, not the issue or comment id.
- `changes[]` entries on a **webhook** carry `field`, `new_value`, `old_value`
  and `type` (`"standard"`) and nothing else; `old_value` is present on an
  assignee change and is `""` when the previous assignee was empty (measured
  2026-09-03, re-measured 2026-09-06). The activity-API form of the same entry
  adds `field_text`, the localized display label — see "Webhook versus Get
  Recent Updates". Parse `changes[]` with a schema that tolerates unknown keys.
- `changes[].new_value` in activity JSON uses the same value system as the
  webhook: status as an id string (`{"field":"status","new_value":"4",
  "old_value":"3"}`), assignee as a display name. The REST comment `changeLog`
  is different (camelCase `newValue`/`originalValue`, status as a display
  name). Never rebuild one from the other (measured 2026-08-28).

## Webhook versus Get Recent Updates

The support page's "the webhook type is the same as the Backlog API response
for Get recent updates" holds for the envelope, not field for field. The same
activity was captured both ways on types 2, 3, 14 and 17 (measured on a
development space, 2026-09-06); the type-1 activity form was not read that
day, and what is known about it comes from an earlier reading (measured
2026-08-28, below). Three differences appeared, the same on every type that
carries the key in question:

- The webhook's `content` carries an **issue snapshot** the activity form
  omits entirely: `assignee`, `status`, `priority`, `issueType`, `resolution`,
  `category`, `versions`, `milestone`, `startDate`, `dueDate`,
  `estimatedHours`, `actualHours`, `parentIssueId`, `customFields` and — on
  the types that carry it at all, 2, 3 and 17 — `diff`. Code that reads the
  issue's current state off the payload works on a delivery and silently reads
  `undefined` on a replayed activity. On type 1 the absence from the activity
  form is the separate 2026-08-28 reading, not this one — see "What each issue
  operation emits".

  Every snapshot key is present on **every** issue-side delivery, and an empty
  field arrives as `null` rather than as a missing key: 41 deliveries (13 type
  1, 16 type 2, 10 type 3, 2 type 17) captured on a development space,
  2026-09-06, and none of them omits one. So `"assignee" in content`
  distinguishes a webhook body from an activity body and nothing else — test
  `content.assignee != null` for "somebody is assigned". The values are the
  issue's state **after** the event, not before it: on an assignee change the
  snapshot's `assignee` already equals that delivery's
  `changes[field="assigner"]` `new_value`. It is a full user object
  (`id`, `userId`, `name`, `roleType`, `lang`), not an `{ id, name }` pair.
- Key convention differs on one field: webhook `externalFileLinks`, activity
  `external_file_links`.
- `changes[]` entries on the activity form carry an extra `field_text`, the
  localized display label; the webhook form does not. This one has nothing to
  say about type 1, which carries no `changes[]` at all.

`notifications` differs as well and in the more consequential direction: the
activity form is always `[]`, so an activity replayed from the API cannot
answer who was notified even when the original delivery could.

## What each issue operation emits

- Issue created → type 1, `content: { id, key_id, summary, description }` plus
  the issue snapshot every webhook body carries, `assignee` among them — see
  "Webhook versus Get Recent Updates" for the list and for the rule that an
  empty field is `null` rather than absent. Type 1 is the one issue type with
  no `comment`, `changes` or `diff` key.
  The snapshot is what makes the **creation-time** assignee readable at all: a
  type-1 activity replayed from `GET /space/activities` or
  `GET /projects/:id/activities` has no `assignee` (100 most recent type-1
  activities on a production space, measured 2026-08-28), and `GET /issues/:id`
  answers with the current assignee, which a later reassignment has moved. Take
  it off the delivery or not at all.
- Plain comment → type 3 with `content.comment: { id, content }` and
  `content.changes: []`.
- Status change, alone or together with a comment → type 2 with **both**
  `content.comment.id` and `content.changes[field:"status"]` (ids as strings).
  Backlog attaches a changelog comment to every field update, so
  `comment.id !== undefined` does not mean "no field change" (measured
  2026-08-02).
- Assignee change → type 2 whose `changes[]` entry has `field: "assigner"` (not
  `assignee`) and `new_value` = the user's **display name**, not an id.
  `content.comment.content` is `null` in the webhook and `""` in the same
  activity fetched via the API (measured 2026-08-02, 2026-08-28). Compare
  `new_value` against the bot's display name; normalise with `?? ""`.
- Description edit → type 2 with `content.comment.id` set, empty
  `content.comment.content`, and `changes: [{ field: "description",
  field_text, new_value: <full new body>, old_value: <full old body>,
  type: "standard" }]`; the payload carries both complete bodies (measured
  2026-09-03). A branch that only looks at comment-ness reads this as an empty
  comment; detect it via `changes[field="description"]`.
- `PATCH /issues/:id` with `comment` and `assigneeId` in one call → **one**
  type 2 whose `content.comment.content` holds the text and whose `changes[]`
  holds `field:"assigner"`; never two deliveries (measured 2026-09-03).
- Attachment added or removed on an issue → type 2 with an auto-generated
  comment (`content.comment.id` set, the rest of `content` effectively empty).
  The change itself is visible only in that comment's REST `changeLog` as
  `field: "attachment"` (add: `newValue` set; remove: `originalValue` set; both
  carry `attachmentInfo.id`) (measured on a development space, 2026-08).
  `GET /issues/:id/attachments` mixes body and comment attachments; only
  `changeLog` tells them apart.
- Comment edit (`PATCH /issues/:id/comments/:commentId`) fires **no** webhook
  and creates **no** activity, however many times the same comment is edited
  (measured 2026-09-03). Text placed by editing reaches nobody via webhooks.
- Choosing recipients in the comment form's notification picker emits **no**
  type 17. One type 3 arrives and the chosen recipients are in its top-level
  `notifications[]` with `reason: 2` (measured on a development space,
  2026-09-06).
- Of the two routes measured, the one that does emit type 17 is Add Comment
  Notification (`POST /issues/:id/comments/:commentId/notifications`), which
  adds recipients to a comment that already exists; only that comment's own
  author may call it (Add Comment Notification docs). No other emitter was
  looked for. Measured on a development space, 2026-09-06 — the docs give no
  `content` shape:
  - `content` has the **same key set as types 2 and 3**, issue snapshot
    included; there is no `content.link` key.
  - `content.comment` is the **original** comment, id and text unchanged. No
    new comment is created, so the same comment id arrives on the type 3 and
    again on every subsequent type 17.
  - `content.changes` is `[]`.
  - `notifications[]` is populated like any other delivery and holds **only
    the recipients this call added**, with `reason: 2`. Users already
    notified on that comment do not reappear, so the array is a delta, not
    the comment's notification list. (This supersedes a 2026-09-03 note that
    recorded `[]` here.)
    `GET /issues/:id/comments/:commentId/notifications` is cumulative and
    returns every recipient, so REST and the deliveries answer different
    questions.
  - `createdUser` is the user who added the notification, which is the comment
    author — not the person being notified.
  - Measured as a **pair**: a comment posted naming recipient A, then
    recipient B added to it three seconds later. Two activities arrive with
    different activity `id`s, three seconds apart, and everything else
    identical — same `content.comment.id`, same `content.comment.content`,
    the same 24 `content` keys with the same values. The type 3's
    `notifications[]` holds A alone and the type 17's holds B alone.
  - Only `type`, the activity `id`, `created` (the three seconds between them)
    and `notifications[]` tell the two apart.
    A handler that dedupes on `content.comment.id` alone therefore drops the
    type 17 as a repeat of the type 3 and loses the later recipient entirely
    (docs/specs/adapter.md D10 accepts that cost deliberately).
- Bulk operations from the issue list ("multi update") → **one** type 14
  however many issues were touched, and **no** type 2 or 3 for any of them
  (measured 2026-08-28 and again 2026-09-06). **One** issue ticked is a type 14
  too, with a single-entry `link[]`: what separates a type 2 from a type 14 is
  the screen the edit was made from — the issue's own page versus the bulk
  update screen — never the number of issues. `content` has exactly five keys:
  `tx_id` (string), `comment{content}` (**no `id`**), `link[{id, key_id, title,
  comment{id, content}}]`, `individual_update` (boolean) and
  `changes[{field, new_value, type}]`. There is no `content.id` and no issue
  snapshot (no status, assignee or summary), and `changes[]` carries **no
  `old_value`** — a bulk update reports where the issues ended up, not where
  each of them started.
- In `link[]`, `id` and `key_id` are decimal **strings** (`"8001"` for issue id 8001) where
  every other activity writes numbers; `GET /space/activities` returns those
  two, and `tx_id`, as numbers. `individual_update` is webhook-only (absent
  from the activity form) and was `false` on all six measured deliveries; the
  bulk update screen offers no way to give two issues different values
  (checked in the UI), so what operation would produce a `true` is unknown. Do
  not branch on it.
- `link[].comment` is present even when the comment box was left empty, and its
  `id` is a comment that really was created on that issue, with a `changeLog`.
  An empty comment's `content` is `""` in the webhook and `null` in REST. A
  bulk update's per-issue comments are therefore fetchable like any others: the
  batch is the only thing Backlog collapses, not the comments.
- `changes[].field` and `new_value` follow **exactly type 2's notation** — an
  assignee change is `assigner` by display name, a `status` change is the
  status **id** as a string, and `priority`, `status` and `resolution` are the
  only fields reported by id at all, the rest being display names (several
  milestones joined `", "`), a `yyyy-MM-dd` date for `limitDate`, or the whole
  text for `summary` and `description`. The one difference between a type 2's
  entries and a type 14's is the absent `old_value` (measured 2026-09-06,
  comparing a four-field bulk update against the same fields changed singly
  from the issue page). Changing several fields at once lists them all, and
  both value systems appear in the one array — do not assume one.
- `GET /issues/:id/comments`'s `changeLog` reports `priority` and `status` as
  **display names** where the webhook reports ids (measured 2026-09-06). Those
  two fields are the whole of the conversion needed to match a webhook change
  against the same change read back over REST.
- `notifications[]` on a type 14 carries the assignee notification (reason 1)
  **once per issue**, so the same user repeats; a batch that changed no
  assignee carries `[]` (measured 2026-09-06). What is peculiar to 14 is the
  repetition, not the array being populated — the webhook form
  fills `notifications[]` on other types too (§ Mentions). An entry has the
  keys `id`, `alreadyRead`, `reason`, `resourceAlreadyRead` and `user` and
  **nothing that names an issue**, so with the same user repeated, entry *n* is
  indistinguishable from entry *m*, and the correspondence to `link[]` was only
  ever inferred by reading the issues back over REST. Treat the array as a fact
  about the batch, not about any issue in it.
- The bulk comment box has no mention autocomplete, and a plain-text `@name`
  typed there notifies nobody. The text is copied verbatim into
  `content.comment.content` and into every `link[].comment.content`.
- Issue deleted → type 4 with `content: { id, key_id }`. Types 5–13, 15–16 and
  18–49 are wiki, file, git, pull-request, member and document events.

## Type 2 `changes[]` field names and value notation

One `PATCH /issues/:id` per field, on a development space, 2026-09-06. The
`field` name is an internal name matching neither the API parameter nor the
label a user sees, and only three fields carry an id:

| API parameter | `field` | `new_value` | `type` |
| --- | --- | --- | --- |
| `priorityId` | `priority` | id string (`"2"`) | `standard` |
| `statusId` | `status` | id string (`"2"`) | `standard` |
| `resolutionId` | `resolution` | id string (`"0"`) | `standard` |
| `categoryId[]` | **`component`** | display name | `standard` |
| `milestoneId[]` | `milestone` | display name; several joined with `", "`, in an order that was not the display order on the one sample taken — the ordering rule is not established | `standard` |
| `versionId[]` | `version` | display name | `standard` |
| `dueDate` | **`limitDate`** | a bare date, `"2026-12-31"` — no time part, no `Z` | `standard` |
| `issueTypeId` | `issueType` | display name | `standard` |
| `summary` | `summary` | the whole new summary | `standard` |
| `assigneeId` | **`assigner`** | display name | `standard` |
| `customField_<id>` | **the attribute's own name** | the value | **`custom`** |

- `old_value` is present on every one of them, and is `""` when the field had
  no previous value.
- Only priority, status and resolution arrive as ids. Everything else is a
  display name, a full text or a date, so `new_value` is not resolvable
  against the API without knowing which field it belongs to.
- Three `field` names are neither the API parameter nor the display label:
  `component`, `limitDate`, `assigner`. Never derive a `field` name from an
  API parameter name.
- A custom attribute is the only entry with `type: "custom"`, and its `field`
  is the attribute's name — so `field` is not drawn from a closed vocabulary
  and `type` is what separates the two kinds. On a custom attribute the
  activity-API form's extra `field_text` is not a localized label but the
  **unresolved** i18n key — `lbl.changelog.` followed by the attribute name
  (observed; the cause is Backlog's and is not established here).
- `startDate`, `estimatedHours` and `actualHours` are **unmeasured**: on the
  project used, a `PATCH` carrying only one of them was refused with
  `code 7 "No comment content."`, and one sent together with a comment
  produced a type 3 with `changes: []` and left the field `null`. The
  notation they would use is therefore unknown; do not assume it from the
  rows above.
- Type 14 (multi update) carries `changes[]` under the same field names and
  the same notation, with no `old_value` — see the type 14 entry above.
- The REST comment `changeLog` returns priority and status as **display
  names** where the webhook returns ids; see "Payload envelope".

## Mentions

- The documented storage notation is `<@U{userId}>`, `<@T{teamId}>`,
  `<@project>` (https://developer.nulab.com/docs/backlog/tips/). The Tips page
  does not say what the API returns. Measured 2026-09-04: on save the server
  rewrites `<@U{id}>` to `@<display name>`, and both REST comment `content` and
  webhook `content.comment.content` carry the **rewritten** text. Code must not
  expect `<@U…>` in inbound text; the measured form wins until re-measured.
- A hand-typed `@Display Name` and a real mention are byte-identical in the
  stored text (measured 2026-09-04). The difference is the notification, which
  a **webhook** payload does carry (see § Payload envelope) and an
  activity-API body does not; text alone can therefore only establish
  "possibly mentioned".
- Unresolvable forms stay literal and notify nobody: `<@U0>` (ids must match
  `[1-9]\d*`), lowercase `<@u123>`, `<@project >` (whitespace inside the tag).
  A nonexistent team id resolves to the literal text `Team-<id>` (measured
  2026-09-04).
- `<@U{id}>` in text creates a notification (`reason: 2`) without
  `notifiedUserId[]`; `<@project>` notifies every project member (measured
  2026-09-04). `notifiedUserId[]` and text mentions are independent: either
  alone produces a notification, and `notifiedUserId[]` alone leaves no `@name`
  in the text.
- Who was notified is readable three ways, and only the first is available
  without a second request: the webhook's own top-level `notifications[]`,
  `GET /issues/:id/comments/:commentId/notifications`, or matching the bot's
  display name in the text. A comment whose recipients were picked in the UI
  notification field leaves **no `@name` in the stored text at all** (measured
  2026-09-06), so text matching alone misses the UI's normal way of addressing
  somebody.
- **Watching an issue does not put the watcher in `notifications[]`.** An
  account watching an issue it was neither assigned to nor named in was
  absent from all three deliveries it should have seen if watching notified:
  a plain comment, a priority-only `PATCH` and a description-only `PATCH`
  arrived with `notifications: []`. The control on the same issue — the same
  kind of comment addressing a user who was *not* watching — carried that
  user with `reason: 2` (measured 2026-09-06). So far `notifications[]`
  reports explicit addressing only: every act measured here that put a user
  in it was one somebody performed on that user.
- Watching is a separate mechanism from notifications end to end: the watcher
  got no entry in its own `GET /notifications` either, only
  `resourceAlreadyRead` and `lastContentUpdated` moving on its
  `GET /users/:id/watchings` record, and `POST /watchings` produced no
  delivery on a hook registered for types 1, 2, 3, 4, 14 and 17 (measured
  2026-09-06). No other type was subscribed, so that is an absence across the
  issue types, not across all 49.
- `reason` codes observed on a delivery, all of them explicit acts: **1**
  assigned on an issue, **2** a comment's notification field or a `<@U…>` in
  its text, **10** assigned on a pull request, **11** a pull-request
  comment's notification field or text mention (measured 2026-09-06). The
  full code table is in `backlog-api-facts.md`; these are the ones a
  delivery has actually carried here.

## Delivery semantics

- Delivery is at-least-once. A redelivery of an already delivered activity has
  been observed arriving about 20 minutes after the original (measured on a
  development space). Handlers must be idempotent on the activity `id` or on
  `content.comment.id`.
- No signature, HMAC, shared secret or verification header exists (developer
  docs, https://support.nulab.com/hc/en-us/articles/8840133998489,
  https://nulab.com/backlog/enterprise/help-guide/administrators-guide/webhook-settings/).
  The only receiver-side controls are the published sender IP list ("subject to
  change",
  https://support.backlog.com/hc/en-us/articles/360051330313-Webhook-sender-IP-address)
  and Basic-auth credentials embedded in `hookUrl`. See CLAUDE.md § Backlog API
  landmines for the path-secret + `webhookVerifier` shape.
- Outbound timeout, retry count, retry schedule, `User-Agent` and
  `Content-Type` of the webhook request are **not documented** anywhere
  (https://developer.nulab.com/docs/backlog/api/2/add-webhook/ and the support
  articles above). No measurement establishes Backlog's own timeout; do not
  encode a fixed timeout figure as a Backlog fact.
- Non-delivery while the receiver is down is **UNCONFIRMED**. Two observations
  on 2026-09-03 (receiver answering 503 with no backend for about 4 minutes and
  about 30 seconds respectively) saw no delivery within 15 and 32 minutes,
  while the same activities reached another receiver on the same project. The
  32-minute window exceeds the observed 20-minute redelivery lag, but Backlog's
  delivery log was not inspected, and whether a 503 with no backend is retried
  like a 5xx from a live receiver is unmeasured. Write neither "a down receiver
  loses nothing" nor "loses everything" as fact.
- The hook URL must be reachable from Backlog's servers; private addresses are
  rejected; HTTPS is recommended, not enforced (the docs example uses
  `http://`). The settings page can send a test payload and shows a "Sent log"
  (https://support.nulab.com/hc/en-us/articles/8840133998489).

## Registration

- `POST /projects/:projectIdOrKey/webhooks` takes `name` (required),
  `description`, `hookUrl` (required), `allEvent` (Boolean),
  `activityTypeIds[]` (Number). Role: Administrator or Project Administrator
  (https://developer.nulab.com/docs/backlog/api/2/add-webhook/). Get, List,
  Update and Delete live under the same path; Delete returns 200 with the
  deleted object. `backlog-js` types `name` and `hookUrl` as optional although
  the API requires them.
- Subscribing to `[1, 2, 3, 4, 14, 17]` covers every issue-related activity,
  including bulk updates and post-hoc notifications. `allEvent: true` also
  delivers wiki, file, git, pull-request and document events.
- 14 is the only type whose single delivery stands for several issues, so
  subscribing to it decides whether a bulk update reaches a receiver at all:
  there is no way to ask Backlog for the per-issue events instead.

## Activity type ids that concern issues

| type | name | `content` shape |
| --- | --- | --- |
| 1 | Issue Created | `{ id, key_id, summary, description }`; no `comment`, `changes` or `diff` |
| 2 | Issue Updated | `{ id, key_id, summary, description, comment{id,content}, changes[], attachments[], shared_files[], external_file_links[] }` |
| 3 | Issue Commented | same as 2; `comment.content` holds the text |
| 4 | Issue Deleted | `{ id, key_id }` |
| 14 | Issue Multi Updated | `{ tx_id, comment{content}, link[], individual_update, changes[] }`; no `content.id` (measured 2026-09-06) |
| 17 | Comment Notification Added | same key set as 2/3, no `link`; `comment` is the target comment unchanged and `changes` is `[]` (measured 2026-09-06; undocumented) |

Names: https://developer.nulab.com/docs/backlog/api/2/get-recent-updates/
(filter range `type(1-49)`; ids 27–33 undocumented). Shapes: `backlog-js`
0.20.1 `Entity.Activity` — which is the **activity** shape. A webhook body for
1, 2, 3 or 17 additionally carries the issue snapshot (`assignee`, `status`,
`priority`, …) and spells the links key `externalFileLinks`; see "Webhook
versus Get Recent Updates".
