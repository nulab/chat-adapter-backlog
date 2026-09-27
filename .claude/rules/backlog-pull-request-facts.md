---
paths:
  - "src/**/*.ts"
---

# Backlog pull-request facts

What Backlog's Git pull-request API and activities actually deliver, measured
on a development space on 2026-09-06 unless a line says otherwise; the docs
cited are at `https://developer.nulab.com/docs/backlog/api/2/<slug>/`. Re-measure before
changing code that contradicts a fact here. Issue-side facts stay in
`backlog-api-facts.md` and `backlog-webhook-facts.md`; this file records only
where pull requests differ or where nothing issue-side applies. Vocabulary:
project 500, repository 700 (`example-repo`), pull request number 12, comment
ids relative to each other.

## Addressing

- Every REST endpoint is keyed by `projectIdOrKey` + `repoIdOrName` +
  **`number`**; the pull request's global `id` addresses nothing:
  `GET …/pullRequests/<global id>` is a 404 `No such PullRequest` (measured).
  The numeric repository id works as `repoIdOrName`.
- The global `id` is what `POST /stars` wants (`pullRequestId`); a comment
  star takes `pullRequestCommentId` (add-star page; both measured → 204).
- The pull-request object (`GET`, list, `POST`, `PATCH`, identical key set):
  `id, projectId, repositoryId, number, summary, description, base, branch,
  status{id,name}, assignee | null, issue | null, baseCommit, branchCommit,
  mergeCommit, closeAt, mergeAt, createdUser, created, updatedUser, updated,
  attachments[], stars[]`. **No repository name** anywhere on it; the web URL
  `https://<host>/git/<projectKey>/<repositoryName>/pullRequests/<number>`
  (the form a star's `url` carries, measured) needs two names the object
  lacks. `issue` is a **full** Issue object on the list endpoint too — the
  list page's `{ "id" }` example is wrong (measured).
- Statuses: `1 Open`, `2 Closed`, `3 Merged` (measured across three pull
  requests; the docs name only `1 Open`).
- `POST …/pullRequests` and `POST …/comments` answer **200**, not 201
  (measured; Add Issue and Add Comment answer 201).

## What each pull-request operation emits

**The activity API form and the webhook form differ, and the difference is the
whole of it.** The **activity API** `content` for types 18, 19 and 20 has
exactly one key set (measured on 17 activities):
`{ id, number, summary, description, comment: { id, content } | null,
changes[], issue: { id, key_id, issue_key, summary, description } | null,
repository: { id, name, description } }`. No `assignee`, no `attachments`,
no `status`, `base` or `branch`. `repository.name` is present on every one,
so the webhook is the free source of the name the REST object lacks.

The **webhook** `content` is that key set **plus `assignee`, `base`, `branch`
and `diff`**, and omits nothing from it. Measured on a development space,
2026-09-06, in two captures: first on deliveries of all three types, then
again by matching five deliveries to the same activities by activity id and
diffing both directions — the top-level key sets are identical, the shared
`content` keys hold equal values, and the four above are added on every type.
Consequences, in the order they matter:

- **`assignee` is on 18, 19 and 20**, as
  `{ id, userId, name, roleType, lang } | null` — no `mailAddress`, no
  `nulabAccount`. On 18 it is the assignment: creating a pull request with
  `assigneeId` and no mention text in summary or description is a mention of
  the assignee (measured — the bot answered). On 19 and 20 it is the
  **current** assignee, repeated on every delivery whether or not the
  assignment changed: a standing state, not an event.
- **A `PATCH` of other fields mentions nobody**, even when the bot is already
  the assignee (measured 2026-09-06): a `summary` + `description` + `issue`
  `PATCH` on a pull request assigned to the bot emitted a 19 carrying
  `assignee` = the bot, no `assignee` entry in `changes[]` and an **empty
  `notifications[]`** — nobody was notified. An assignment reports itself in
  `changes[]`, and that is the only structural evidence of one on 19.
- `roleType` inside `content.assignee` was **94** while the same user under
  `notifications[].user` was **2** in the same body (measured 2026-09-06), so
  neither is a source for the other.
- `base` and `branch` are the branch names, on every type and every delivery.
  `diff` is a diff(1)-style body of a description edit and `null` everywhere
  else — measured non-null on exactly one delivery, the 19 that changed the
  description, and `null` on 18, on 20 and on a 19 that did not.
- Two of the four are not pull-request inventions: **issue** webhook types 2
  and 3 carry `assignee` and `diff` too, with the same meanings (measured
  2026-09-06 on 26 issue deliveries; `assignee` present on every one,
  `diff` non-null only on a description edit). What is genuinely
  pull-request-only is `base` and `branch`. `diff` is named by no Backlog
  document.
- **`notifications[]` is populated on a pull-request webhook**, exactly as it
  is on an issue webhook (`backlog-webhook-facts.md` § Payload envelope) and
  unlike the activity API, which returned `[]` for the very same activities
  (measured 2026-09-06). What differs is only the reason code for the same
  act: assignment notifies with **reason 10** and a comment mention or a
  `notifiedUserId[]` comment with **reason 11**, where the issue side uses 1
  and 2. That array is the exact evidence `changes[]` only approximates.

| Operation | Activity | `content.comment` | `changes[]` |
| --- | --- | --- | --- |
| Create (with `issueId`, `assigneeId`, `notifiedUserId[]`, `attachmentId[]`) | **18** | `null` | `[]` — the assignee and the attachments are not in the activity at all |
| Plain comment | **20** | `{ id, content }` | `[]` |
| Comment with `attachmentId[]` | **20** | `{ id, content }` | `[{ field: "attachment", new_value: "<file name>", old_value: "" }]` — name only, no id |
| Summary / description / linked-issue change (`PATCH` with `comment`) | **19** | `{ id, content: <the comment text> }` | `summary`, `description` (both full bodies), `issue` (`new_value: "PROJ-54"`, `old_value: "PROJ-47"` — issue **keys**) |
| Assignee change alone | **19** | `{ id, content: "" }` | `[{ field: "assignee", new_value: "<new display name>", old_value: "<old display name>" }]` — **`assignee`**, not the issue side's `assigner`; `old_value` carries the previous display name on a reassignment and `""` when nobody was assigned before, and unassign is `new_value: ""` with the old name still in `old_value` (all measured 2026-09-06) |
| Assignee change **together with** other fields in one `PATCH` | 19 | as above | the `assignee` entry was **absent** while the reason-10 notification was still created (measured once, 2026-09-06); two later `PATCH`es the same day — `assigneeId` + `description`, and `summary` + `description` + `issue` — both reported every field they changed. One unreproduced observation against two reproductions. `content.assignee` is no fallback: a multi-field `PATCH` that changes no assignee carries the standing one and notifies nobody (above). `notifications[]` reason 10 records the assignment either way |
| Merge (measured via a `git push` of the merge to the base branch) | **19** | `{ id, content: "" }` | `[{ field: "status", new_value: "3", old_value: "1" }]` — status by **id string**, like issues; the changelog comment is authored by the pusher; `mergeCommit` stays `null`, `mergeAt`/`closeAt` are set |
| Close (from history, UI) | 19 | `{ id, content: "" }` | `[{ field: "status", new_value: "2", old_value: "1" }]` |
| Comment edit (`PATCH …/comments/:id`) | **none** — no new activity (measured; same as issue comments) | | |
| `git push` of a branch | 12 Git Pushed, `content: { repository, change_type, revision_type, ref, revision_count, revisions[] }` — no pull-request reference | | |
| Type 21 | **Not observed, twice.** The Get Activity page names it "Pull Request Deleted"; `backlog-js` 0.20.1 names it `PullRequestMerged`. Neither the UI nor the API offers a way to delete a pull request, merge and close both arrived as 19 (above), and `GET /projects/:id/activities?activityTypeId[]=21` over this project's whole history returned nothing. Re-checked in a second capture the same day with 21 **added to the webhook subscription**: a create, two assignee changes, two comments and a multi-field update produced **zero** type-21 deliveries, and `GET /space/activities?activityTypeId[]=21` was empty as well. What, if anything, emits it is unknown from the outside; capture a payload before dispatching it. | | |

- **Mentions.** `<@U…>` and `<@project>` in a `description` or comment
  `content` are rewritten to `@<display name>` / `@<project-members label>`
  on save, like issues. In the **`summary` they are not rewritten**: the
  stored summary keeps the literal `<@U999>` — in the REST object, in the
  activity `content.summary` and in the **webhook** `content.summary` alike
  (measured 2026-09-06 in all three). So the raw form is what a type-18
  message's text actually contains, not merely what storage holds, and
  matching only `@<display name>` finds nothing in such a summary. The
  activity's `changes[]` entry
  for `summary` shows the **resolved** form while the REST `changeLog` shows
  the raw form (measured) — the two value systems differ, as for issues. One
  webhook body holds both at once: a 19 that rewrote the summary carried
  `content.summary` with the literal `<@U…>` and
  `changes[0].new_value` with `@<display name>` for the same string (measured
  2026-09-06).
- `notifiedUserId[]` on a comment leaves `comment.content` without any
  `@name`, so **no textual rule can see it** (measured 2026-09-06). It is not
  invisible: the delivery names the recipient in the top-level
  `notifications[]` with reason 11. It is the counterpart of the
  `<@U…>` rule above: a visible mention without a notification is impossible,
  a notification without a visible mention is not.
- Creating a pull request with `notifiedUserId[]` (or a `<@project>` in the
  description) adds a **system comment** with `changeLog: [{ field:
  "notification", newValue: "pullRequestCreate" }]` and `notifications[]`
  (reason 12) that produces **no activity** (measured: the type-18 activity
  has `comment: null`). A comment list therefore holds an entry no webhook
  ever announced.
- A pair of type-20 activities sharing one comment id, with different
  `comment.content`, exists in this space's history (origin unknown; not
  reproducible by `PATCH`). Dedupe on the comment id must tolerate it.
- **Linking an issue to a pull request emits an activity on the issue.** The
  `PATCH` that set `issueId` produced its own 19 and, on the linked issue, a
  **type 3** whose `comment.content` is a system sentence naming the pull
  request (`<projectKey>/<repository>#<number> <summary> …`) and whose
  `changes[]` is `[]` (measured 2026-09-06). A pull-request operation can
  therefore reach a consumer as an issue-thread message; nothing in that
  type 3 says a pull request caused it except the comment text, which is
  localized.

## Comments

- Comment object (list, `POST`, `PATCH`): `{ id, content, changeLog[],
  createdUser, created, updated, stars[], notifications[], filePath,
  position, oldBlobId, newBlobId }`. **No parent reference** (`issueId` or
  pull-request id). The last four are `null` on a conversation comment and
  belong to inline diff comments, which the UI can create; the activity
  `content.comment` does not distinguish the two.
- `changeLog` entries are `{ field, newValue, originalValue }` only — **no
  `attachmentInfo`**, so a comment attachment's id is not recoverable from the
  comment; `GET …/pullRequests/:number/attachments` lists body and comment
  attachments together as `{ id, name, size, createdUser, created }`
  (measured: one uploaded on create, one via a comment, both listed).
- `notifications[]` on a REST comment **is populated** (`{ id, alreadyRead,
  reason, user, resourceAlreadyRead }`, reason 11 for a comment mention,
  10 for assignment, 12 for creation), in the same shape a webhook delivery
  carries at the top level (`backlog-webhook-facts.md` § Payload envelope,
  measured 2026-09-06); the activity API is the form that reports `[]`. A
  `<@U…>` in a comment notifies without `notifiedUserId[]`, as for issues.
- `content` of a changelog comment is `""` in both REST and the activity
  (issues: `null` in the webhook, `""` in the API).
- `GET …/comments/:commentId` and `DELETE …/comments/:commentId` **do not
  exist**: both answer **400** `{ code: 6, message: "Undefined resource. …" }`
  (measured) — an undefined route is a 400/6, not a 404. Update
  (`PATCH …/comments/:id { content }`) exists and answers 200.
- `POST …/comments` accepts `attachmentId[]` (documented; `backlog-js`
  0.20.1 omits it from `PostPullRequestCommentsParams`).

## Paging

- Same semantics as issue comments (`backlog-api-facts.md` § Comment listing
  and paging), re-measured here on six consecutive ids `n…n+5`:
  `minId=n+2&maxId=n+5` → `[n+3, n+4]`, adjacent ids → `[]`,
  `order=asc&maxId=n+5&count=2` → `[n, n+1]`,
  `order=desc&maxId=n+5&count=2` → `[n+4, n+3]`. Default is `order=desc`,
  changelog comments included.
- A **single comment** is fetched as `minId=id-1&maxId=id+1&count=1` →
  exactly `[id]` (measured). There is no other way.

## Ids

- Pull-request comment ids and issue comment ids come from **different
  sequences** (measured: 7-digit vs 9-digit on the same space at the same
  time). Overlap is possible in principle, so nothing may treat a bare
  comment id as unique across the two kinds.
- `pullRequest.number` is per repository; the global `id` is space-wide.

## Rate limit

- `GET …/pullRequests` and `GET …/pullRequests/count` decrement **`read`**
  (600 → 593 → 592 on consecutive calls; `search` unchanged), consistent
  with the rate-limit page naming only the issue and wiki list/count
  endpoints under `search`. Different from `GET /issues`.

## Attachments

- Download (`GET …/pullRequests/:number/attachments/:id`) answers with the
  file's real `content-type` (`text/plain` for a text file) and
  `content-disposition: attachment; filename*=UTF-8''<name>`, not
  `application/octet-stream` as the issue download page states for issues.
- Upload is the shared `POST /space/attachment`; the id works for
  `POST …/pullRequests` and `POST …/comments` (measured).

## Writes the API cannot make

- **Status** (close, merge, reopen) has no API: `PATCH …/pullRequests/:n`
  with `statusId` → 400 `{ code: 7, message: "error.unknownParameter :
  statusId" }` (measured). A merge is made by merging in git and pushing the
  base branch (measured to flip status to 3) or in the UI.
- `PATCH …/pullRequests/:n` with values equal to the current ones → 400
  `{ code: 7, message: "No difference" }` (measured).
- No delete for pull requests, none for their comments (above).

## Unmeasured

- **Webhook deliveries of a merge, a close and a comment carrying
  `attachmentId[]`.** The webhook `content` key set is settled and was
  re-measured against the activity API in both directions (§ What each
  pull-request operation emits). A linked-issue change has now been captured
  as a webhook too, leaving three rows of the table above whose
  `changes[]` shapes are still **activity-form** measurements: merge, close,
  and a comment with an attachment. A merge and a close have no API at all
  (§ Writes the API cannot make), so capturing them needs a git push or the
  UI against a receiver. Nothing suggests a per-operation difference — the
  added keys were the same four on every delivery of all three types — and a
  body carrying more still parses, so this is a gap in coverage rather than a
  risk.
- **Notifications in the bot's own feed** (`GET /notifications` items with
  `pullRequest` / `pullRequestComment` / `repository` set; reasons 10–13):
  the fields exist on every item (measured `null` here) but a populated one
  needs a second user to mention or assign the bot. UNMEASURED. The webhook
  body's own `notifications[]` is a different array and **is** measured
  (§ What each pull-request operation emits).
- Redelivery behaviour for pull-request activities. UNMEASURED; no reason to
  expect a difference from issues.
