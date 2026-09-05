---
paths:
  - "src/**/*.ts"
---

# Backlog pull-request facts

What Backlog's Git pull-request API and activities actually deliver, measured
on a real space on 2026-09-06 unless a line says otherwise; the docs cited are
at `https://developer.nulab.com/docs/backlog/api/2/<slug>/`. Re-measure before
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

Activity `content` for types 18, 19 and 20 has exactly one key set
(measured on 17 activities):
`{ id, number, summary, description, comment: { id, content } | null,
changes[], issue: { id, key_id, issue_key, summary, description } | null,
repository: { id, name, description } }`. No `assignee`, no `attachments`,
no `status`, `base` or `branch`. `repository.name` is present on every one,
so the webhook is the free source of the name the REST object lacks.

| Operation | Activity | `content.comment` | `changes[]` |
| --- | --- | --- | --- |
| Create (with `issueId`, `assigneeId`, `notifiedUserId[]`, `attachmentId[]`) | **18** | `null` | `[]` — the assignee and the attachments are not in the activity at all |
| Plain comment | **20** | `{ id, content }` | `[]` |
| Comment with `attachmentId[]` | **20** | `{ id, content }` | `[{ field: "attachment", new_value: "<file name>", old_value: "" }]` — name only, no id |
| Summary / description / linked-issue change (`PATCH` with `comment`) | **19** | `{ id, content: <the comment text> }` | `summary`, `description` (both full bodies), `issue` (`new_value: "PROJ-54"`, `old_value: "PROJ-47"` — issue **keys**) |
| Assignee change alone | **19** | `{ id, content: "" }` | `[{ field: "assignee", new_value: "<display name>", old_value: "" }]` — **`assignee`**, not the issue side's `assigner`; unassign is `new_value: ""` |
| Assignee change **together with** other fields in one `PATCH` | 19 | as above | the `assignee` entry was **absent** while the reason-10 notification was still created (measured once — treat a multi-field 19 as possibly under-reporting the assignee) |
| Merge (measured via a `git push` of the merge to the base branch) | **19** | `{ id, content: "" }` | `[{ field: "status", new_value: "3", old_value: "1" }]` — status by **id string**, like issues; the changelog comment is authored by the pusher; `mergeCommit` stays `null`, `mergeAt`/`closeAt` are set |
| Close (from history, UI) | 19 | `{ id, content: "" }` | `[{ field: "status", new_value: "2", old_value: "1" }]` |
| Comment edit (`PATCH …/comments/:id`) | **none** — no new activity (measured; same as issue comments) | | |
| `git push` of a branch | 12 Git Pushed, `content: { repository, change_type, revision_type, ref, revision_count, revisions[] }` — no pull-request reference | | |
| Delete / type 21 | **never observed**: no delete endpoint exists, the UI offers none, and merge and close both arrive as 19. The docs' "21 Pull Request Deleted" and `backlog-js`'s `PullRequestMerged` are both names for an activity no operation was found to emit. Treat 21 as ignorable until a payload is seen. | | |

- **Mentions.** `<@U…>` and `<@project>` in a `description` or comment
  `content` are rewritten to `@<display name>` / `@<project-members label>`
  on save, like issues. In the **`summary` they are not rewritten**: the
  stored summary keeps the literal `<@U999>` (measured on create and in
  the REST `changeLog.originalValue`). The activity's `changes[].old_value`
  for `summary` shows the **resolved** form while the REST `changeLog`
  shows the raw form (measured) — the two value systems differ, as for
  issues.
- Creating a pull request with `notifiedUserId[]` (or a `<@project>` in the
  description) adds a **system comment** with `changeLog: [{ field:
  "notification", newValue: "pullRequestCreate" }]` and `notifications[]`
  (reason 12) that produces **no activity** (measured: the type-18 activity
  has `comment: null`). A comment list therefore holds an entry no webhook
  ever announced.
- A pair of type-20 activities sharing one comment id, with different
  `comment.content`, exists in this space's history (origin unknown; not
  reproducible by `PATCH`). Dedupe on the comment id must tolerate it.

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
  10 for assignment, 12 for creation) — unlike issue webhook payloads, where
  it is always `[]`. A `<@U…>` in a comment notifies without
  `notifiedUserId[]`, as for issues.
- `content` of a changelog comment is `""` in both REST and the activity
  (issues: `null` in the webhook, `""` in the API).
- `GET …/comments/:commentId` and `DELETE …/comments/:commentId` **do not
  exist**: both answer **400** `{ code: 6, message: "Undefined resource. …" }`
  (measured) — an undefined route is a 400/6, not a 404. Update
  (`PATCH …/comments/:id { content }`) exists and answers 200.
- `POST …/comments` accepts `attachmentId[]` (documented; `backlog-js`
  0.20.1 omits it from `PostPullRequestCommentsParams`).

## Paging (same code path as issue comments)

Measured on six comments with consecutive ids `n…n+5`:

- `minId` and `maxId` are **exclusive**: `minId=n+2&maxId=n+5` → `[n+3,
  n+4]`; adjacent `minId=n+2&maxId=n+3` → `[]`.
- `count` cuts from the head of `order`: `order=asc&maxId=n+5&count=2` →
  `[n, n+1]` (the two oldest), `order=desc&maxId=n+5&count=2` → `[n+4, n+3]`.
- Default is `order=desc`, all comments, changelog comments included.
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

- **Webhook body vs activity body for types 18–20.** Only the activity API
  form above was captured; whether the webhook adds fields (as it adds
  `assignee` to type 1) is UNMEASURED. Method: register a project webhook
  with `activityTypeIds[]=18,19,20,21,12` at a receiver that stores raw
  bodies, repeat the operations in the table, diff each body against
  `GET /projects/:id/activities`.
- **Notifications in the bot's own feed** (`GET /notifications` items with
  `pullRequest` / `pullRequestComment` / `repository` set; reasons 10–13):
  the fields exist on every item (measured `null` here) but a populated one
  needs a second user to mention or assign the bot. UNMEASURED.
- Redelivery behaviour for pull-request activities. UNMEASURED; no reason to
  expect a difference from issues.
