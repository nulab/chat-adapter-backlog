---
paths:
  - "src/**/*.ts"
---

# Backlog API v2 facts

Endpoint-level facts invisible in `backlog-js` typings and in the code. Facts
marked "measured" were observed on a real Backlog space on the given date;
re-measure before changing code that contradicts them. Buckets, error codes
1–13, auth basics and host domains are in CLAUDE.md § Backlog API landmines and
are not repeated here.

## Endpoints the adapter uses

Bucket rule: Read = GET except Search/Icon; Update = POST/PATCH/DELETE; Search =
Get Issue List, Count Issue, Get Wiki Page List, Count Wiki Page; Icon = the
five icon endpoints (https://developer.nulab.com/docs/backlog/rate-limit/).
Endpoint pages never state a bucket; the column applies that rule mechanically.
Each endpoint's page is `https://developer.nulab.com/docs/backlog/api/2/<slug>/`.

| Method and path | Bucket | `backlog-js` 0.20.1 |
| --- | --- | --- |
| `GET /issues/:issueIdOrKey` | read | `getIssue(idOrKey, params?)` |
| `GET /issues` | **search** | `getIssues(params)` |
| `POST /issues` | update | `postIssue(params)` |
| `PATCH /issues/:issueIdOrKey` | update | `patchIssue(idOrKey, params)` |
| `GET /issues/:issueIdOrKey/comments` | read | `getIssueComments(idOrKey, {minId,maxId,count,order})` |
| `GET /issues/:issueIdOrKey/comments/count` | read | `getIssueCommentsCount(idOrKey)` |
| `POST /issues/:issueIdOrKey/comments` | update | `postIssueComments(idOrKey, {content, notifiedUserId?, attachmentId?})` |
| `GET /issues/:issueIdOrKey/comments/:commentId` | read | `getIssueComment(idOrKey, commentId)` |
| `PATCH /issues/:issueIdOrKey/comments/:commentId` | update | `patchIssueComment(idOrKey, commentId, {content})` |
| `DELETE /issues/:issueIdOrKey/comments/:commentId` | update | `deleteIssueComment(idOrKey, commentId)` |
| `GET /issues/:issueIdOrKey/comments/:commentId/notifications` | read | `getIssueCommentNotifications(idOrKey, commentId)` |
| `POST /issues/:issueIdOrKey/comments/:commentId/notifications` | update | `postIssueCommentNotifications(idOrKey, commentId, {notifiedUserId})` |
| `GET /issues/:issueIdOrKey/attachments` | read | `getIssueAttachments(idOrKey)` |
| `GET /issues/:issueIdOrKey/attachments/:attachmentId` | read | `getIssueAttachment(idOrKey, attachmentId)` → `FileData` |
| `POST /space/attachment` | update | `postSpaceAttachment(formData)` |
| `POST /stars` | update | `postStar({commentId})` → `void` |
| `DELETE /stars/:starId` | update | `removeStar(starId)` → `void` |
| `GET /notifications` | read | `getNotifications({minId,maxId,count,order})`; `senderId` absent from the typing |
| `GET /notifications/count` | read | `getNotificationsCount({alreadyRead,resourceAlreadyRead})` (typed required, doc says optional) |
| `POST /notifications/:id/markAsRead` | update | `markAsReadNotification(id)` → 204 |
| `GET /projects/:projectIdOrKey` | read | `getProject(idOrKey)` |
| `GET /projects/:projectIdOrKey/users` | read | `getProjectUsers(idOrKey)`; no `excludeGroupMembers` param |
| `GET /projects/:projectIdOrKey/issueTypes` | read | `getIssueTypes(idOrKey)` |
| `GET /projects/:projectIdOrKey/statuses` | read | `getProjectStatuses(idOrKey)` |
| `GET /priorities` | read | `getPriorities()` (space-wide, not per project) |
| `GET /users/:userId` | read | `getUser(userId)` |
| `GET /users/myself` | read | `getMyself()` |
| `GET /users/:userId/icon` | **icon** | `getUserIcon(userId)` → `FileData` |
| `GET /projects/:projectIdOrKey/webhooks[/:webhookId]` | read | `getWebhooks`, `getWebhook` |
| `POST`/`PATCH`/`DELETE /projects/:projectIdOrKey/webhooks[/:webhookId]` | update | `postWebhook`, `patchWebhook`, `deleteWebhook` |
| `GET /space/activities`, `GET /projects/:projectIdOrKey/activities` | read | `getSpaceActivities(params)`, `getProjectActivities(idOrKey, params)` |
| `GET /activities/:activityId` | read | **unwrapped**: `backlog.request({method:"GET", path:"activities/<id>"})` or raw fetch |
| `GET /rateLimit` | read; whether it consumes quota is unstated | `getRateLimit()` |

## Comment listing and paging

- `GET /issues/:issueIdOrKey/comments` takes `minId`, `maxId`, `count` (1–100,
  default 20), `order` (`asc`|`desc`, **default `desc`**)
  (https://developer.nulab.com/docs/backlog/api/2/get-comment-list/).
- `minId` and `maxId` are **exclusive** (`id > minId`, `id < maxId`): with nine
  consecutive comment ids, `minId` set to the fourth returned the fifth onward,
  `maxId` set to the seventh returned up to the sixth, in every combination of
  alone/both/`count`/`order`; adjacent ids as `minId`/`maxId` returned `[]`
  (measured 2026-09-03). Pass the previous page's edge id straight through as
  the cursor: no dedupe, no `±1`.
- `count` is cut from the head of the chosen `order`: `order=asc&maxId=X&
  count=2` returns the **two oldest** comments below X, not the two just before
  X (measured 2026-09-03). A backward page is only `order=desc&maxId`; a
  forward page is only `order=asc&minId`. Re-sort ascending before returning.
- Comment object: `{ id, projectId, issueId, content, changeLog: null | [...],
  createdUser, created, updated, stars[], notifications[] }`. A comment has
  **no** `attachments[]`; a file added with it appears only as a `changeLog`
  entry with `attachmentInfo: { id, type }` (Get Comment List page).

## Issue listing

- `GET /issues` pages by `offset` only; `count` 1–100, default 20; `order`
  default `desc`; `updatedSince`/`createdSince` and their `Until` pairs are
  `yyyy-MM-dd`, so not a timestamp cursor; every call, like `GET
  /issues/count`, draws on the **search** bucket
  (https://developer.nulab.com/docs/backlog/api/2/get-issue-list/).

## Writes

- Add Issue requires `projectId`, `summary`, `issueTypeId`, `priorityId` and
  responds **201** with a `Location` header and the Issue; Add Comment requires
  `content` (optional `notifiedUserId[]`, `attachmentId[]`) and responds
  **201** with the Comment; bodies are `application/x-www-form-urlencoded`
  (https://developer.nulab.com/docs/backlog/api/2/add-issue/,
  https://developer.nulab.com/docs/backlog/api/2/add-comment/).
- Update Comment and Delete Comment work on the caller's **own** comments only
  ("User can update own comment", "User can delete own comment"); Delete
  responds **200 with the deleted Comment object**, not 204
  (https://developer.nulab.com/docs/backlog/api/2/update-comment/,
  https://developer.nulab.com/docs/backlog/api/2/delete-comment/).

## `notifiedUserId[]` fails open

- A project non-member id and a nonexistent id both yield **201**; the
  notification is silently dropped
  (`GET .../comments/:id/notifications` → `[]`) (measured 2026-08-18).
- The comment's own author is never notified, even when listed explicitly. A
  probe that notifies the API-key owner looks identical to a rejected id; do not
  infer "dropped" from that case (measured 2026-08-18).
- A stale user id costs a missing notification, never a failed post; add no
  membership lookups ahead of a post to prevent a failure that cannot happen.

## Mention notation on write

- `<@U{userId}>`, `<@T{teamId}>`, `<@project>` in `content`, `description`,
  `comment`; mentioned users are notified even without `notifiedUserId[]`;
  non-members are not notified; invalid ids "are ignored and treated as plain
  text" (https://developer.nulab.com/docs/backlog/tips/).
- Inbound text never contains `<@U…>`; see `backlog-webhook-facts.md` §
  Mentions.

## Stars (the only API-addressable reaction)

- `POST /stars` with exactly one of `issueId`, `commentId`, `wikiId`,
  `pullRequestId`, `pullRequestCommentId` → **204** empty body;
  `backlog-js` resolves `undefined`
  (https://developer.nulab.com/docs/backlog/api/2/add-star/).
- `DELETE /stars/:starId` → 204. The page does not say whether only the
  presenter may remove a star (UNVERIFIED)
  (https://developer.nulab.com/docs/backlog/api/2/remove-star/).
- Star shape on Issue/Comment `stars[]`: `{ id, comment: null | string, url,
  title, presenter{ id, userId, name, ... }, created }`. `backlog-js` types
  `comment?: string`; real payloads carry `null`. Rely on the null.
- No endpoint lists stars on a given issue or comment; the embedded `stars[]`
  is the only per-resource view. One kind of star, no emoji; a user may add
  several to one comment. The UI's emoji reactions on comments have **no API**
  (https://support.nulab.com/hc/en-us/articles/8709986448153; endpoint index).

## Notifications (per authenticated user)

- `GET /notifications`: `minId`, `maxId`, `count` (1–100, default 20), `order`,
  `senderId`; item `{ id, alreadyRead, reason, resourceAlreadyRead, project,
  issue | null, comment | null, sender, created }`. Page newest-first with
  `maxId`; exclusivity is measured only on the comments endpoint, re-measure
  here (https://developer.nulab.com/docs/backlog/api/2/get-notification/).
- `comment.id` is the comment that caused the notification; `comment` is absent
  when the cause is the issue body or a project membership change (measured
  2026-08-20). `id` is the notification id, not the comment id.
- `reason` is numeric: 1 Assigned to Issue, 2 Issue Commented, 3 Issue Created,
  4 Issue Updated, 5 File Added, 6 Project User Added, 9 Other, 10–13 pull
  request, 14/15/17 document; 7, 8, 16 undocumented; typed as bare `number`.
- `alreadyRead` and `resourceAlreadyRead` are set by two different endpoints,
  each leaving the other field untouched (measured 2026-09-06, one bot user's
  own feed): `POST /notifications/:id/markAsRead` (Read Notification) flips
  only that notification's `resourceAlreadyRead` to `true`
  (`(false,false)` → 204 → `(false,true)` for `(alreadyRead,
  resourceAlreadyRead)`); `POST /notifications/markAsRead` (Reset Unread
  Notification Count) flips `alreadyRead` to `true` on **every** notification
  and left `GET /notifications/count?alreadyRead=false` at 16 → 0 without
  touching any `resourceAlreadyRead`. `alreadyRead` is the inbox-badge count;
  `resourceAlreadyRead` is "this notification's target was read", which is
  what Read Notification sets — code that short-circuits a repeat
  `markAsRead` must test `resourceAlreadyRead`, never `alreadyRead`.

## Attachments

- Upload is two-step: `POST /space/attachment` (multipart, one `file` part) →
  `{ id, name, size }`, then pass `attachmentId[]` to Add/Update Issue or Add
  Comment. The id is single-use and deleted after about one hour if unattached
  (https://developer.nulab.com/docs/backlog/api/2/post-attachment-file/).
- Size limit is not on the API page. A 2024-04 press release states 50 MB per
  file for all plans (https://nulab.com/ja/press/pr-2404-backlog-attachment-size-limit/);
  the English support article still lists 5–10 MB per plan
  (https://support.nulab.com/hc/en-us/articles/8683971547801). The sources
  conflict; the press release is newer. Failure is error code 10.
- Download (`GET /issues/:id/attachments/:attachmentId`) needs API auth and
  returns `application/octet-stream`; there is no public URL. `backlog-js`
  returns `{ body: ReadableStream, url, filename, contentType }`.

## Text formatting is a per-project setting

- `textFormattingRule` on Project and Space is `"markdown"` (GitHub Flavored
  Markdown) or `"backlog"` (Backlog notation: `''bold''`, `[[label>url]]`,
  `* H1`, `{code}`); `backlog-js` `Types.TextFormattingRule`
  (https://developer.nulab.com/docs/backlog/api/2/get-project/,
  https://support.nulab.com/hc/en-us/articles/8775439725721-Backlog-text-formatting-rules).
- Roughly a third of projects on a large production space (106 of 318) were
  `backlog` (measured 2026-08-26 via `GET /projects`), including admin-side
  projects. Backlog notation support is not optional. Rendering is decided at
  display time by the project's current rule (the API stores raw text), and a
  project's setting can flip, so read it rather than caching a belief about it.

## Rate limit details beyond CLAUDE.md

- Scope is per **user**, not per API key: two keys of one user share one
  budget; one program using several users' keys is discouraged
  (https://developer.nulab.com/docs/backlog/rate-limit/).
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (UTC epoch
  seconds) are on **every** response, success included; the doc example is
  `150 / 142 / 1605484860`. `Retry-After` is not documented and the 429 body is
  the standard envelope with code 13.
- `GET /rateLimit` → `{ rateLimit: { read: {limit, remaining, reset}, update,
  search, icon } }`
  (https://developer.nulab.com/docs/backlog/api/2/get-rate-limit/).

## Errors and auth beyond CLAUDE.md

- The error page maps no code to an HTTP status; only 429 ↔ 13 is stated.
  `backlog-js` throws `BacklogAuthError` for 401 and `BacklogApiError`
  otherwise, `UnexpectedError` when the body is not JSON. Real bodies add an
  `errorInfo` string the doc page does not list
  (https://developer.nulab.com/docs/backlog/error-response/).
- The API key acts as its issuing user: `GET /users/myself`, rate limits and
  "own comment" checks all resolve to that user.
- OAuth: `POST https://{space}/api/v2/oauth2/token`, `expires_in: 3600`,
  refresh-token lifetime undocumented, no scopes
  (https://developer.nulab.com/docs/backlog/auth/).

## `backlog-js` 0.20.1 specifics

- Dual ESM/CJS with separate `.d.mts`/`.d.cts`, no `"type"` field, only
  runtime dependency `qs`; exports `{ Backlog, OAuth2, Option, Entity, Types,
  Error }`.
- Constructor `new Backlog({ host, apiKey?, accessToken?, timeout?, fetch?,
  userAgent? })`. `timeout` is set as a non-standard `RequestInit` key and is a
  **no-op with native fetch**; bring your own `AbortSignal`.
- Entity methods return parsed bodies only, so `X-RateLimit-*` headers are
  **swallowed on success**; use the public `backlog.request({ method, path,
  params })`, which returns the raw `Response`, when headers matter. Errors
  expose `status`, `body` and `response`, so `err.response.headers.get(...)`
  works on a 429.
- Form bodies use `qs` `arrayFormat: "brackets"` (`notifiedUserId[]=1&...`);
  204 or `Content-Length: 0` resolves `undefined`.
- Gaps: no `GET /activities/:id`; no `senderId` on notifications; no
  `excludeGroupMembers`; no webhook receiver or inbound type (reuse
  `Entity.Activity.Activity`); no retry/backoff; `Entity.User.User` lacks
  `nulabAccount`; `ActivityType` enum labels 21 `PullRequestMerged` (doc: Pull
  Request Deleted) and omits 39/49.

## Chat concepts with no Backlog counterpart

- No DM, ephemeral message, typing indicator, modal, scheduled post, threaded
  reply (comments are a flat list per issue) or presence API exists in the
  endpoint index (https://developer.nulab.com/docs/backlog/).
