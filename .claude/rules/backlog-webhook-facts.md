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
  type, content, notifications: [], createdUser, created }`, the same shape
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
- `notifications` is always `[]` (emptied 2022-02-09 per the Get Recent Updates
  page; `backlog-js` types it `notifications: []`). Measured 2026-08-20 and
  2026-09-03: `[]` on types 2, 3 and 17, and `content.comment.notifications`
  is absent too, including for comments posted through the UI mention picker
  and for API comments sent with `notifiedUserId[]`.
- Top-level `created` on the webhook and on the same activity fetched later via
  the API are identical strings (measured 2026-08-31). Top-level `id` is the
  activity id, not the issue or comment id.
- `changes[]` entries carry `field`, `new_value`, `old_value` plus extra keys
  `field_text` (localized label) and `type` (`"standard"`); `old_value` is `""`
  when the previous assignee was empty (measured 2026-09-03). Parse `changes[]`
  with a schema that tolerates unknown keys.
- `changes[].new_value` in activity JSON uses the same value system as the
  webhook: status as an id string (`{"field":"status","new_value":"4",
  "old_value":"3"}`), assignee as a display name. The REST comment `changeLog`
  is different (camelCase `newValue`/`originalValue`, status as a display
  name). Never rebuild one from the other (measured 2026-08-28).

## What each issue operation emits

- Issue created → type 1, `content: { id, key_id, summary, description }` plus
  `assignee` in the webhook when set. Type 1 activities returned by
  `GET /space/activities` and `GET /projects/:id/activities` lack `assignee`
  (100 most recent type-1 activities on a production space, measured
  2026-08-28). The creation-time assignee is not recoverable from any API;
  `GET /issues/:id` returns the current one.
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
- Add Comment Notification (`POST /issues/:id/comments/:commentId/
  notifications`) → type 17 with `content.comment` = the target comment (`id`,
  and `content` as of the call); `notifications` still `[]` (measured
  2026-09-03). The docs give no `content` shape for type 17.
- Bulk operations from the issue list ("multi update") → one type 14
  `{ tx_id, comment{content}, link[{id,key_id,title,comment{id,content}}],
  changes[{field,new_value,type}] }`, not one type 2 per issue (measured
  2026-08-28; shape per `backlog-js` `IssueMultiUpdateContent`). A status
  change made this way never arrives as type 2.
- Issue deleted → type 4 with `content: { id, key_id }`. Types 5–13, 15–16 and
  18–49 are wiki, file, git, pull-request, member and document events.

## Mentions

- The documented storage notation is `<@U{userId}>`, `<@T{teamId}>`,
  `<@project>` (https://developer.nulab.com/docs/backlog/tips/). The Tips page
  does not say what the API returns. Measured 2026-09-04: on save the server
  rewrites `<@U{id}>` to `@<display name>`, and both REST comment `content` and
  webhook `content.comment.content` carry the **rewritten** text. Code must not
  expect `<@U…>` in inbound text; the measured form wins until re-measured.
- A hand-typed `@Display Name` and a real mention are byte-identical in the
  stored text (measured 2026-09-04). The only difference is the notification,
  which the payload does not carry. Text-based detection can therefore only
  establish "possibly mentioned".
- Unresolvable forms stay literal and notify nobody: `<@U0>` (ids must match
  `[1-9]\d*`), lowercase `<@u123>`, `<@project >` (whitespace inside the tag).
  A nonexistent team id resolves to the literal text `Team-<id>` (measured
  2026-09-04).
- `<@U{id}>` in text creates a notification (`reason: 2`) without
  `notifiedUserId[]`; `<@project>` notifies every project member (measured
  2026-09-04). `notifiedUserId[]` and text mentions are independent: either
  alone produces a notification, and `notifiedUserId[]` alone leaves no `@name`
  in the text.
- The only ways to learn who was notified are `GET /issues/:id/comments/
  :commentId/notifications` or matching the bot's display name in the text. A
  fixture with a populated `notifications` array tests code that never runs.

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

## Activity type ids that concern issues

| type | name | `content` shape |
| --- | --- | --- |
| 1 | Issue Created | `{ id, key_id, summary, description }`; webhook adds `assignee` (measured) |
| 2 | Issue Updated | `{ id, key_id, summary, description, comment{id,content}, changes[], attachments[], shared_files[], external_file_links[] }` |
| 3 | Issue Commented | same as 2; `comment.content` holds the text |
| 4 | Issue Deleted | `{ id, key_id }` |
| 14 | Issue Multi Updated | `{ tx_id, comment{content}, link[], changes[] }` |
| 17 | Comment Notification Added | `content.comment` of the target comment (measured 2026-09-03; undocumented) |

Names: https://developer.nulab.com/docs/backlog/api/2/get-recent-updates/
(filter range `type(1-49)`; ids 27–33 undocumented). Shapes: `backlog-js`
0.20.1 `Entity.Activity`.
