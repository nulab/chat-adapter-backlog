# Pull request support plan

How `@nulab/chat-adapter-backlog` grows from an issue-only adapter into one
where a Backlog **pull request is a thread exactly the way an issue is**: its
body is the root message, its comments are messages, `thread.post()` comments
on it, and the activity types 18–20 reach `Chat` handlers the way 1–4 do
today. This plan states the target design, the order of work, the acceptance
bar per PR, and what has to be measured on a real space before code depends on
it. The behavioural contract itself is amended in
[docs/specs/adapter.md](../specs/adapter.md) by the first PR of the stack
(§6, P0); until then this document is the specification of record for
pull-request behaviour, and section references (§n) without a prefix point
into the current spec.

The package is unreleased. Nothing below preserves the current id grammar,
raw-message shapes or exported types; where the cleanest model needs a
breaking rewrite, it is chosen and the PR title carries `!`.

## 1. Goal and definition of done

Done means all of the following hold on `main`:

1. A Backlog project webhook subscribed to `[1, 2, 3, 4, 18, 19, 20]`
   produces a `Message` for every pull-request activity that has a thread
   meaning, routed to a pull-request thread id, with the same mention,
   self-message and dedupe behaviour issue activities have.
2. Every `Adapter` member that works on an issue thread works on a
   pull-request thread, or fails with a typed error naming the Backlog
   limitation (§3.6 lists the three that must fail).
3. The thread, message and raw-message vocabulary carries the kind
   explicitly (§3.2, §3.3); no member decides "issue or pull request" from
   segment counts or field presence.
4. Egress and reads have **one** code path each; kind-specific behaviour
   lives in exactly one module per kind (§3.4).
5. `pnpm test` covers both kinds with the same guarantees (paging sweep,
   ladder rows, mapping rows, contract suites) and still needs no network.
6. Every wire fact the code relies on for pull requests is either cited to a
   developer.nulab.com page or measured and recorded in
   `.claude/rules/backlog-pull-request-facts.md` with a date (§5). The
   activity-API form of every pull-request operation was measured on
   2026-09-06 and is in that file; the webhook form is the one measurement
   still open.
7. README, `sample-messages.md`, DEVELOPMENT.md, `.env.example`, CLAUDE.md
   and the CI smoke test describe the two-kind adapter.

Non-goals (declared, not deferred): creating or merging pull requests from
Chat (`postChannelMessage` keeps creating issues; Backlog documents no status
change through the API at all — see §2), treating a git **repository** as a
channel, line-level review comments (Backlog has none), and `listThreads`
interleaving issues with pull requests (§3.6, D-PR7).

## 2. Why Backlog cannot copy the GitHub shape

`@chat-adapter/github@4.39.0` models a pull request's conversation tab as an
issue thread with a flag: thread id `github:{owner}/{repo}:{number}` for PRs,
`…:issue:{number}` for issues, one `issues.createComment` call for both, and
message ids that are bare comment ids because a thread only ever holds one
kind of comment. That works because GitHub shares one number space and one
comments API across the two. Its `type?: "pr" | "issue"` field defaulting to
`"pr"` is back-compat debt the maintainers themselves annotate as such, and
it leaks: the decoded field is named `prNumber` even for issues, and PR
`ThreadInfo.metadata` carries no `type` while issue metadata does.

Backlog gives no such shortcut, and the asymmetries decide the design:

| Aspect | Issue | Pull request | Source |
| --- | --- | --- | --- |
| REST address | `/issues/:issueId` (space-wide id) | `/projects/:p/git/repositories/:r/pullRequests/:number` — three coordinates; the global `id` addresses nothing | [Get Pull Request](https://developer.nulab.com/docs/backlog/api/2/get-pull-request/) |
| Star target | `commentId` | `pullRequestCommentId`; `pullRequestId` (the **global** id) for the PR itself | [Add Star](https://developer.nulab.com/docs/backlog/api/2/add-star/) |
| Delete a comment | `DELETE /issues/:id/comments/:cid` | **no endpoint** — the route answers 400 with error code 6 `Undefined resource` (measured 2026-09-06) | endpoint index, `.claude/rules/backlog-pull-request-facts.md` |
| Fetch one comment | `GET /issues/:id/comments/:cid` | **no endpoint** (400/6, measured); the list with `minId=id-1&maxId=id+1&count=1` returns exactly that comment (measured) | [Get Pull Request Comment](https://developer.nulab.com/docs/backlog/api/2/get-pull-request-comment/) |
| Attach on comment | `attachmentId[]`; the comment's `changeLog` carries `attachmentInfo.id` | `attachmentId[]` accepted (documented and measured; `backlog-js` typing omits it), but the `changeLog` names the file **without an id** — only `GET …/attachments` has ids | [Add Pull Request Comment](https://developer.nulab.com/docs/backlog/api/2/add-pull-request-comment/) |
| List bucket | `GET /issues` → **search** | `GET …/pullRequests` and `/count` → **read** (rate-limit page; measured: `read` decremented, `search` untouched) | [Rate limit](https://developer.nulab.com/docs/backlog/rate-limit/) |
| List cursor | `offset` | `offset`; no `minId`/`maxId`, no order param | [Get Pull Request List](https://developer.nulab.com/docs/backlog/api/2/get-pull-request-list/) |
| Comment object | has `issueId` | has **no** parent reference; `changeLog` is plain `{ field, newValue, originalValue }` | Get Pull Request Comment page |
| Activity types | 1, 2, 3, 4 | 18 Added, 19 Updated, 20 Comment Added; **21 was never observed** — merge (UI or git push) and close both arrive as 19 status changes (measured 2026-09-06) | [Get Activity](https://developer.nulab.com/docs/backlog/api/2/get-activity/), `.claude/rules/backlog-pull-request-facts.md` |
| Activity `content` | measured | measured on both forms: the activity API gives `{ id, number, summary, description, comment, changes, issue{id,key_id,issue_key,…}, repository{id,name,description} }` — no `assignee`, no `attachments` — and the **webhook** adds `assignee`, `base`, `branch`, `diff` (2026-09-06) | `.claude/rules/backlog-pull-request-facts.md` |
| Assignee change field | `changes[field="assigner"]`, display name | `changes[field="assignee"]`, display name; a multi-field update was measured once to omit it | measured 2026-09-06 |
| Mentions in the title | `summary` rewritten to `@name` | `summary` keeps the raw `<@U…>`; `description` and comments are rewritten | measured 2026-09-06 |
| Notification | `issue`, `comment` | `pullRequest`, `pullRequestComment`, `repository`; reasons 10 Assigned, 11 Comment Added, 12 Added, 13 Updated | [Get Notification](https://developer.nulab.com/docs/backlog/api/2/get-notification/) |
| Status change via API | `PATCH /issues/:id { statusId }` | **none** — Update Pull Request takes `summary`, `description`, `issueId`, `assigneeId`, `notifiedUserId`, `comment` only | [Update Pull Request](https://developer.nulab.com/docs/backlog/api/2/update-pull-request/) |

Two consequences follow and shape everything in §3:

- **The kind must be an explicit, non-optional coordinate** of every thread
  id, message id and raw message, because two different endpoint families
  and two comment id sequences (measured, §5 M6) sit behind them.
  This is what GitHub's analysis calls "make the kind explicit on both sides";
  Backlog makes it mandatory rather than advisable.
- **Kind-specific behaviour must be contained**, not sprinkled: six egress
  members and five read members would otherwise each grow an `if (kind ===
  'pullRequest')` with a different exception (no delete, windowed fetch,
  different star target, different attachment URL). GitHub repeats its
  ternary six times; this adapter puts it behind one interface (§3.4).

## 3. Target design

### 3.1 Conceptual model

| Backlog | Chat SDK | Id grammar | Notes |
| --- | --- | --- | --- |
| Space | (installation) | `host` | Unchanged. |
| Project | Channel | `backlog:<host>:<projectId>` | Unchanged. Both kinds of thread belong to the project channel; the git repository is **not** a channel (D-PR1). |
| Issue | Thread | `backlog:<host>:<projectId>:issue:<issueId>` | Was `backlog:<host>:<projectId>:<issueId>`. |
| Pull request | Thread | `backlog:<host>:<projectId>:pr:<repositoryId>:<number>` | Numeric repository id, never the name: `repoIdOrName` accepts either and names can change; `number` is the per-repository PR number the REST API is keyed by. The global PR `id` appears only in raw and metadata (stars need it). |
| Issue body / PR body | Root message | `<host>:issue:<issueId>:r` / `<host>:pr:<repositoryId>:<number>:r` | `text` = `summary + "\n\n" + description`, trimmed, for both. |
| Comment | Message | `…:c<commentId>` | Same suffix for both kinds; the kind segment before it keeps the ids distinct even if the two comment id spaces overlap. |
| Update without a comment | Message with empty text | `…:u:<created>` | Same rule for both kinds. |
| User | User | `<host>:<userId>` | Unchanged. |
| Star on a comment | Reaction | — | `commentId` or `pullRequestCommentId` chosen by kind. |
| Notification | Read receipt | — | Matched on `comment.id` or `pullRequestComment.id` by kind. |

### 3.2 Grammar

```
host        = 1*( lower-alnum / "." / "-" )
posint      = ( "1"-"9" ) *DIGIT
subject     = "issue:" posint                       ; issueId
            / "pr:" posint ":" posint               ; repositoryId, number
thread-id   = "backlog:" host ":" posint ":" subject ; projectId, subject
channel-id  = "backlog:" host ":" posint
message-id  = host ":" subject ":" part
part        = "r" / "c" posint / "u:" created
user-id     = host ":" posint
created     = 1*VCHAR                                ; opaque, may contain ":"
```

Rejection rules extend §2.2 mechanically: unknown subject keyword, wrong
segment count for the keyword (`issue:` takes one posint, `pr:` two), a
subject followed by nothing or by an unknown part, `u:` with nothing after
it. `channelIdFromThreadId` remains "the first three segments".

The decoded shapes are built around one shared value, `BacklogSubjectRef`,
which is the same object wherever a thread, message, raw message or subject
client needs to say *which* issue or pull request it means (D-PR2):

```ts
type BacklogSubjectRef =
  | { kind: 'issue'; issueId: number }
  | { kind: 'pullRequest'; repositoryId: number; number: number };

interface BacklogThreadId {
  host: string;
  projectId: number;
  subject: BacklogSubjectRef;
}

type BacklogMessagePart =
  | { part: 'root' }
  | { part: 'comment'; commentId: number }
  | { part: 'update'; created: string };

type BacklogMessageId = { host: string; subject: BacklogSubjectRef } & BacklogMessagePart;
```

`threadIdContract` deep-equals `decode(encode(x))` with `x`, which a nested
`subject` satisfies as well as a flat shape would; nesting is chosen so the
`subject` value flows from `decodeThreadId` into `subjectClientFor(...)`, into
`raw.subject`, and back out of `encodeMessageId` without being re-shaped at
each boundary.

### 3.3 Raw message union

```ts
type BacklogRawMessage =
  | { kind: 'webhook'; host: string; payload: BacklogWebhookPayload; changes: BacklogChange[] }
  | { kind: 'comment'; host: string; projectId: number; subject: BacklogSubjectRef;
      comment: BacklogRawComment; changes: BacklogChange[] }
  | { kind: 'issue'; host: string; issue: BacklogRawIssue; changes: [] }
  | { kind: 'pullRequest'; host: string; pullRequest: BacklogRawPullRequest; changes: [] };
```

- `BacklogWebhookPayload` widens to the union of recognised issue **and**
  pull-request activities (§3.5); `raw.payload.type` tells them apart, and a
  helper `subjectOfActivity(payload): BacklogSubjectRef` is the single place
  that knows `content.id` means an issue for types 1–4 and
  `content.repository.id` + `content.number` mean a pull request for 18–20.
- The `comment` variant carries `subject` explicitly instead of relying on
  `comment.issueId`, because a pull-request comment has no parent reference
  of its own (§2). `BacklogRawComment` drops `issueId` accordingly; the
  issue's REST `issueId` is still on the port type (§3.7) for callers of
  `api(host)`.
- `BacklogRawPullRequest` mirrors the port's `BacklogPullRequest` with ISO
  strings, following the existing `Date`-in-port / string-in-raw split
  (`src/index.ts` header comment).
- Root raws stay two flat variants (`issue`, `pullRequest`) rather than one
  `root` variant with a nested discriminator: a consumer writing
  `if (raw.kind === 'issue') raw.issue…` is the common case and should not
  have to descend into `raw.subject.kind` to reach a typed body.

#### Facts that shaped the design below (all in `.claude/rules/backlog-pull-request-facts.md`)

- The activity `content` for 18–20 carries `repository.{id,name}` and
  `number` on every delivery, so the thread id needs no lookup and the
  repository name the REST object lacks is captured for free (§3.8).
- Comment ids for the two kinds come from different sequences (7-digit vs
  9-digit on the same space), so a bare comment id is not unique across kinds
  — the kind segment in every message id is load-bearing, not cosmetic.
- A pull-request comment's `changeLog` names an attachment but carries no id
  (§3.6, D-PR10), and the REST comment carries a populated `notifications[]`
  where the activity API reports `[]` (a webhook delivery carries the list
  too, measured later on 2026-09-06).
- Creating a pull request with `notifiedUserId[]` adds a system comment no
  activity announces, so `fetchMessages` and the webhook stream disagree by
  one entry; documented, not fixed.
- A pull request's `summary` keeps mention notation raw (`<@U…>`), so the
  type-18 mention rule matches both forms (spec §5.4 rule 5).

### 3.4 The subject layer (`src/subject/*`)

The new seam between the adapter's members and the HTTP port. The port
(`BacklogApi`) stays a flat, endpoint-shaped interface — one method per
Backlog endpoint, conformance-tested twice — and gains the pull-request
endpoints (§3.7). Above it, a `SubjectClient` presents *one* comment stream
regardless of kind:

```ts
interface SubjectClient {
  readonly ref: BacklogSubjectRef;
  readonly capabilities: { deleteComment: boolean };
  fetchRoot(): Promise<SubjectRoot>;
  listComments(options: ListCommentsOptions): Promise<BacklogComment[]>;
  getComment(commentId: number): Promise<BacklogComment>;
  addComment(input: AddCommentInput): Promise<BacklogComment>;
  updateComment(commentId: number, content: string): Promise<BacklogComment>;
  deleteComment(commentId: number): Promise<void>;
  starTarget(commentId: number): StarTarget;
  attachmentUrl(attachmentId: number): string;
  downloadAttachment(attachmentId: number): Promise<BacklogDownloadedFile>;
}

interface SubjectRoot {
  ref: BacklogSubjectRef;
  /** Global id: `issue.id` or `pullRequest.id`. */
  id: number;
  projectId: number;
  /** `EXAMPLE-42` or `repo-name#12`; display only, never identity. */
  label: string;
  title: string;
  body: string;
  status: { id: number; name: string };
  assignee: BacklogUserRef | null;
  createdUser: BacklogUserRef;
  created: Date;
  updated: Date;
  raw: { kind: 'issue'; issue: BacklogIssue } | { kind: 'pullRequest'; pullRequest: BacklogPullRequest };
}
```

Files, all under the `adapter` scope (the directory is new, the scope is not:
the CLAUDE.md table already lists egress, reads and the thread-ID codec under
`adapter`, and this layer is where those now meet):

| File | Owns |
| --- | --- |
| `src/subject/client.ts` | `SubjectClient`, `SubjectRoot`, `StarTarget`; `subjectClientFor(api, ref, context)` — the only place in the adapter where the kind selects *behaviour*. |
| `src/subject/issue.ts` | `IssueSubjectClient`: today's behaviour, moved. `getComment` is the single-fetch endpoint; `deleteComment` works; `starTarget` → `{ commentId }`. |
| `src/subject/pull-request.ts` | `PullRequestSubjectClient`: `getComment` lists with `minId: commentId - 1, maxId: commentId + 1, count: 1` and returns `ResourceNotFoundError` on an empty page (exclusive bounds measured on pull-request comments, M4 — the only way to fetch one PR comment; a returned element whose `id` differs is treated as not found); `deleteComment` throws the §3.6 error before any call; `addComment` passes `attachmentId[]`; `starTarget` → `{ pullRequestCommentId }`; `attachmentUrl` → `https://<host>/api/v2/projects/<projectId>/git/repositories/<repositoryId>/pullRequests/<number>/attachments/<id>`; comment attachments named by `changeLog` resolve their id lazily through `listPullRequestAttachments` (D-PR10). |
| `src/subject/url.ts` | `subjectWebUrl(host, root, names)`: `/view/<issueKey>` or `/git/<projectKey>/<repositoryName>/pullRequests/<number>`; the pull-request form needs two names the PR object does not carry (§3.8). |

What this buys, member by member: `postMessage`, `editMessage`,
`deleteMessage`, `addReaction`, `removeReaction`, `fetchMessages`,
`fetchMessage`, `fetchThread`, `fetchSubject` each become
`decode → subjectClientFor → the same code as today`. `src/egress.ts` and
`src/reads.ts` lose every `issueId` parameter and every direct `api.*Comment`
call; they take a `SubjectClient`. The existing issue tests keep passing with
only their id strings updated, which is the regression check that the
refactor changed structure and not behaviour.

Rejected alternative: a second set of functions (`postPullRequestComment`,
`fetchPullRequestMessages`, …) selected in `adapter.ts`. It doubles ~1,400
lines of egress/reads and their tests, and every future fix lands twice.

### 3.5 Webhook ingress

Rows added to the §5.1 ladder step 8 gate and the §5.3 mapping. `content`
shapes are the `backlog-js` hypothesis until §5 M1–M3 confirm them; the
schemas are written from the measurements, not from the typings.

| `type` | Meaning | Thread | Message id | `text` | Mention (§5.4) | Dispatch |
| --- | --- | --- | --- | --- | --- | --- |
| 18 | Pull Request Added | `pr:<repository.id>:<number>` | `…:r` | `summary + "\n\n" + description` | text — matched against both `@<botUserName>` and the raw `<@U<botUserId>>` the summary keeps; `content.assignee` is absent from the activity form (M2), read only if a webhook body carries it | `processMessage` |
| 19 | Pull Request Updated, with `comment.id` | same | `…:c<commentId>` | `comment.content ?? ""` | text, or `changes[field="assignee"]` by display name (M3, measured — the field is `assignee`, not the issue side's `assigner`) | `processMessage` |
| 19 | Pull Request Updated, no comment id | same | `…:u:<created>` | `""` | as above | `processMessage` |
| 20 | Comment Added on Pull Request | same | `…:c<commentId>` | `comment.content ?? ""` | text | `processMessage` |
| 21 | Pull Request Deleted (docs) / Merged (`backlog-js`) | — | — | — | — | 200 Ignored (D-PR5): not observed; merge and close arrive as 19 with a `status` change, and no delete operation exists (M5, measured) |
| 12, 13 | Git Pushed, Repository Created | — | — | — | — | 200 Ignored (no thread meaning) |

Required fields for 18–20 (400 when missing): `content.id`, `content.number`,
`content.repository.id`. `content.repository.name` and `project.projectKey`
are display data but are **captured into the name cache** (§3.8) when
present, so the webhook path never spends a read on them. `content.issue`
(the linked issue, `{ id, key_id, summary, … } | null`) is not identity and
is exposed on `raw.payload` only; a pull request linked to an issue is still
its own thread (D-PR6).

Registration guidance changes from `[1, 2, 3]` (+4) to `[1, 2, 3, 18, 19,
20]` (+4; 21 is omitted because it was not observed, D-PR5). No adapter option selects kinds (D-PR4): the webhook
subscription already is that switch, and a deployment that wants issues only
subscribes to issue types only.

`selfMessageContract` and the self-skip (ladder row 11) are kind-agnostic:
`createdUser.id` is on the envelope for every type.

### 3.6 Member behaviour per kind

Only the differences from the issue behaviour specified today are listed;
everything else is "the same through `SubjectClient`".

| Member | Pull-request behaviour |
| --- | --- |
| `postMessage` | `POST …/pullRequests/:n/comments` with `content`, `notifiedUserId[]`, `attachmentId[]` (measured to attach). Returns `{ kind: 'comment', subject: { kind: 'pullRequest', … } }` raw. |
| `editMessage` | `PATCH …/comments/:cid { content }`. Same restrictions (own comments only, no files, no extras). |
| `deleteMessage` | **Fails**: `AdapterError("Backlog has no endpoint to delete a pull request comment", "backlog", "UNSUPPORTED_OPERATION")`, thrown before any API call, decided by `capabilities.deleteComment`. `@chat-adapter/shared` has no not-supported class, and `ValidationError` would mislabel a correct request as the caller's fault (D-PR3). |
| `addReaction` / `removeReaction` | `POST /stars { pullRequestCommentId }`; the idempotency read and the own-star filter go through the windowed `getComment` (one read either way). |
| `fetchMessages` | Identical algorithm; root = the pull request. The §7.1 property sweep runs for both kinds from one table-driven test. |
| `fetchMessage` | `:r` → Get Pull Request; `:c` → windowed list; `:u:` → `null`; cross-subject id → `null` without a call. |
| `fetchThread` | `channelName` = project key; `metadata = { host, projectId, kind: 'pullRequest', repositoryId, repositoryName?, number, id, summary, description, status, assignee, base, branch, issue: { id, issueKey? } \| null, baseCommit, branchCommit, mergeCommit, closeAt, mergeAt, createdUserId, created, updated, url }`. Issue metadata gains `kind: 'issue'` so both kinds are self-describing (the GitHub asymmetry, avoided). |
| `fetchSubject` | `type: 'pull_request'` (the convention `@chat-adapter/github` uses; the core types `type` as `string`), `title`, `description`, `status: status.name`, `url`, `author`, `assignee?`, `labels: [status.name, \`${base} ← ${branch}\`]`, `raw: pullRequest`. Issue subjects keep `type: 'issue'`. |
| `listThreads` | Unchanged: lists the project's **issues**. A pull-request list is per repository and would need a repository coordinate the channel id does not carry; `api(host).listPullRequests(...)` is the escape hatch (D-PR7). README states the gap plainly. |
| `postChannelMessage` | Unchanged: creates an issue. |
| `markAsRead` | Match `notification.pullRequestComment?.id === commentId` when the subject is a pull request, `notification.comment?.id` when an issue — never the other, because the two comment id spaces are not known to be disjoint (M6). |
| `rehydrateAttachment` | Accepts both URL shapes: `/api/v2/issues/<posint>/attachments/<posint>` and `/api/v2/projects/<posint>/git/repositories/<posint>/pullRequests/<posint>/attachments/<posint>`; anything else is returned unchanged. The pattern lives next to `attachmentUrl` in each subject module so the two cannot drift. |
| Inbound attachments on PR comments | Type-20 `changes[field="attachment"]` and the REST `changeLog` carry a **name only**; the `Attachment` gets `name` and a lazy `fetchData` that lists `…/pullRequests/:n/attachments`, picks the newest entry with that name, and downloads it (D-PR10 ⚑). `url` is set once the id is known, so a rehydrated attachment downloads without a second list. |
| `renderFormatted`, `parseMessage`, formatting rule | Per **project**, unchanged: a pull request inherits its project's `textFormattingRule`. |

### 3.7 Port additions (`client`)

Domain types (`src/client/port.ts`, `Date`-carrying):

```ts
interface BacklogGitRepository { id: number; projectId: number; name: string; description: string }
interface BacklogPullRequest {
  id: number; projectId: number; repositoryId: number; number: number;
  summary: string; description: string; base: string; branch: string;
  status: { id: number; name: string };
  assignee: BacklogUserRef | null;
  /** `{ id }` on the list endpoint, a full issue elsewhere (doc examples disagree; M7) — normalised to the stable subset. */
  issue: { id: number; issueKey: string | null } | null;
  baseCommit: string | null; branchCommit: string | null; mergeCommit: string | null;
  closeAt: Date | null; mergeAt: Date | null;
  createdUser: BacklogUserRef; created: Date; updated: Date;
  stars: BacklogStar[];
}
/** The comment shape both endpoint families return. */
interface BacklogComment { id; content; changeLog; createdUser; created; updated; stars }
/** Issue comments additionally name their parent. */
interface BacklogIssueComment extends BacklogComment { issueId: number }
type StarTarget = { commentId: number } | { pullRequestCommentId: number };
interface PullRequestRef { projectId: number; repositoryId: number; number: number }
```

Methods, with bucket per the rate-limit page's rule (GET → read unless
Search/Icon; the classifier in `src/client/rate-limit.ts` already yields this
without a table change — a test pins it):

| Method | Endpoint | Bucket |
| --- | --- | --- |
| `listGitRepositories(projectId)` | `GET /projects/:p/git/repositories` | read |
| `getGitRepository(projectId, repositoryId)` | `GET /projects/:p/git/repositories/:r` | read |
| `listPullRequests(projectId, repositoryId, { count, offset?, statusId? })` | `GET …/pullRequests` | read |
| `getPullRequest(ref)` | `GET …/pullRequests/:n` | read |
| `listPullRequestComments(ref, { count, order, minId?, maxId? })` | `GET …/pullRequests/:n/comments` | read |
| `addPullRequestComment(ref, { content, notifiedUserId?, attachmentId? })` | `POST …/comments` | update |
| `updatePullRequestComment(ref, commentId, content)` | `PATCH …/comments/:cid` | update |
| `listPullRequestAttachments(ref)` | `GET …/pullRequests/:n/attachments` | read |
| `downloadPullRequestAttachment(ref, attachmentId)` | `GET …/attachments/:aid` | read |
| `addStar(target: StarTarget)` | `POST /stars` | update — **signature change** from `addStar(commentId)` |

`BacklogNotification` gains `pullRequest: { id: number; number: number; repositoryId: number } | null`
and `pullRequestComment: { id: number } | null`. `backlog-js` typing gaps are
irrelevant to the implementation because every call already goes through
`backlog.request({ method, path, params })`; they matter only as a warning
not to copy `PostPullRequestCommentsParams` (which omits `attachmentId`) or
`PatchPullRequestParams.comment: string[]` into the port.

The in-memory port gains seed fields `repositories`, `pullRequests`,
`pullRequestComments` (keyed by `{ repositoryId, number }`) and records the
new inputs; the conformance suite gains rows for every method above, run
against both implementations exactly as today.

### 3.8 Names the pull request does not carry

A pull request's web URL is
`https://<host>/git/<projectKey>/<repositoryName>/pullRequests/<number>`, but
`GET …/pullRequests/:n` returns `projectId` and `repositoryId` only, and the
adapter deliberately keys on ids. Two small caches, both owned by
`adapter.ts` beside the formatting-rule cache and refreshed the same way:

- `projectCache: Map<channelId, { projectKey; textFormattingRule }>` —
  **replaces** `formattingRuleCache`; the one Get Project the adapter already
  spends per channel returns both fields, so `projectKey` costs nothing
  extra. `fetchChannelInfo` replaces the entry, as today.
- `repositoryNameCache: Map<`${host}:${repositoryId}`, string>` —
  populated for free from `content.repository.name` on every pull-request
  webhook, and on a miss by one `getGitRepository` (read bucket), cached
  forever; `fetchChannelInfo` clears **every entry for the host**, not the
  calling channel's project. The key carries no project, and that is on
  purpose: a repository id already identifies a repository within a space, so
  putting the project into the key would buy exact invalidation at the price of
  a key the same repository can occupy twice — once per `projectId` a caller's
  thread id happened to name — leaving a stale name alive under whichever key
  the clear missed. Over-clearing costs one `read`-bucket Get Git Repository
  per dropped name, once, and only after a `fetchChannelInfo` somebody asked
  for. `src/adapter.ts` states the same trade at the member; keep the two in
  step. A lookup failure is not cached and yields a URL-less
  `ThreadInfo`/`MessageSubject` (`url` is optional on both) plus one `warn`,
  rather than failing the read.

### 3.9 Public surface changes

Exports added: `BacklogSubjectRef`, `BacklogMessagePart`,
`BacklogPullRequest`, `BacklogGitRepository`, `BacklogIssueComment`,
`StarTarget`, `PullRequestRef`, `ListPullRequestsOptions`,
`AddPullRequestCommentInput`; `SubjectClient` and `subjectClientFor` are
**not** exported (internal seam, like the zod schemas). `BacklogThreadId`,
`BacklogMessageId` and `BacklogRawMessage` change shape as in §3.2–§3.3.
`mentionUser`/`mentionTeam` and the converters are untouched. The CI smoke
test does not change (it constructs the adapter and reads `name`), but the
`.github/workflows/ci.yml` paragraph in CLAUDE.md is re-read to confirm.

## 4. PR stack

```
P0 docs ─────────────────────────────────────────────────────────────┐
P1 client ──► P2 adapter (subject layer, id grammar) ──► P3 webhook ─┼──► P4 adapter (PR-only members) ──► P5 docs
M  measurements (real space; feeds P0's rules file; gated P3, waived)┘
```

P1→P2→P3 was planned as one stack of depth three, merged bottom-up promptly,
with P4 and P5 off `main`. The measurements (§5) landed in P0 as
`.claude/rules/backlog-pull-request-facts.md`; every one except the webhook
body itself (M1's webhook half) and the bot's own notification feed (M9) is
recorded. The gate that read **"P3 must not merge before the webhook form is
captured"** was **waived by the maintainer** (2026-09-06) rather than
satisfied; P3 states the waiver and what it cost. The capture was then taken
after the stack merged, on a deployed receiver (2026-09-06), and cost exactly
what the waiver predicted: an `assignee` on 18 the adapter was not reading —
plus the same key on 19 and 20, where it is the standing assignee rather than
an assignment (`fix(webhook)`, §5 M1).

**Status** (2026-09-06, as this plan's P5 is written):

| PR | Branch | State |
| --- | --- | --- |
| P0 docs | `lollipop-onl/PR-activity-support` | **merged to `main`** (`fe5a75b`) |
| P1 client | `lollipop-onl/pr-client` | written and pushed; below P5 in the stack, not yet on `main` |
| P2 adapter | `lollipop-onl/pr-subject-layer` | written and pushed; not yet on `main` |
| P3 webhook | `lollipop-onl/pr-webhook` | written and pushed; not yet on `main` — shipped with **M1's webhook half waived, not measured** |
| P4 adapter | `lollipop-onl/pr-optional-members` | written and pushed; not yet on `main` |
| P5 docs | `lollipop-onl/pr-docs` | this PR |

Two things differ from the plan above and are worth knowing before the next
rebase. The stack is six deep, not three: `ci(ci): run checks on every pull
request, not only those based on main` and `fix(client): use the wire shapes
Backlog actually sends and accepts` sit **below** P1, the first because CI
skipped stacked PRs entirely and the second because P1's conformance work
found the issue-side wire shapes wrong. And P4 and P5 were branched on top of
P3 instead of off `main`, because P4 touches `fetchChannelInfo` and
`markAsRead`, both of which P2 rewrote, and P5 documents what P3 dispatches —
so every squash below still costs a `git rebase --onto` on everything above it
(CLAUDE.md "Stacked PRs"). Nothing in the stack may merge out of order.

Every PR: five gates green, title with scope, label from type, squash body
written on purpose, stack declared in the first line of the body (CLAUDE.md
"Pull requests"). Size figures are non-test TypeScript, for calibration.

### P0 — specification and plan (`docs`)

- **Title**: `docs(docs): specify pull request threads`. Label `documentation`.
- **Branch**: off `main`.
- **Scope**: amend `docs/specs/adapter.md` — §1 goal state (issues *and*
  pull requests), §2 table and grammar (§3.1–§3.2 here), §2.2 rejections,
  §3.1 exports, §3.5 raw union, §4.1/§4.2 statuses per kind, §5.1 step 8
  gate set, §5.2 required fields for 18–20, §5.3 rows for 18–21 and 12/13,
  §5.4 mention rules for pull requests, §6 opening paragraph (subject
  clients), §6.3 delete failure, §6.5 star targets, §6.6 attachment URLs,
  §7.2–§7.4 pull-request forms, §7.6 `listThreads` scope note, §7.8
  notification matching, §8.1 method table, §8.3 seed, §8.6 conformance
  guarantees, §11 registration guidance, §12.2 coverage lists, §13 README and
  `sample-messages.md` rows, §14 decisions D-PR1–D-PR8, §15 open questions.
  This plan. `.claude/rules/backlog-pull-request-facts.md` created with the
  §5 measurement list, each item either filled with a dated measurement or
  marked `UNMEASURED`. CLAUDE.md: link this plan under "Design documents",
  amend "Activity types" (18–20 now matter) and "Webhook URL hygiene".
  `docs/plans/adapter-implementation.md` §8 gains a pointer here.
- **Acceptance**: no identifier from `src/` that does not exist yet is
  presented as existing; every claim about Backlog cites a page or a dated
  measurement; the five gates still pass (Markdown is not formatted by oxfmt,
  so this proves nothing else moved).

### P1 — pull-request endpoints on the port (`client`)

- **Title**: `feat(client): add pull request, repository and star-target endpoints to the port`. Label `enhancement`.
- **Branch**: off `main`.
- **Scope**: `src/client/port.ts` (§3.7 types and methods; `BacklogComment`
  split into the common shape and `BacklogIssueComment`; `addStar(target)`),
  `src/client/schemas.ts` (pull request, repository, PR comment, notification
  extension — `issue` normalised from either doc shape), `src/client/backlog-js.ts`,
  `src/client/in-memory.ts` (seed, state, recorded inputs), `src/client/conformance.ts`,
  `src/client/backlog-js.fake-fetch.ts` (recorded PR response shapes),
  `src/client/rate-limit.test.ts` (bucket pin). Callers of `addStar(commentId)`
  and of `BacklogComment.issueId` in `src/egress.ts` / `src/reads.ts` are
  updated minimally so `main` stays green; the structural rewrite is P2.
- **Acceptance criteria**:
  - Conformance rows, both implementations: fetch a repository and a pull
    request; a missing one is `ResourceNotFoundError`; list PRs with
    `count`/`offset`; PR comments page with exclusive `minId`/`maxId` and
    `count` cut from the head of `order`; add/edit reflected in the list;
    `addPullRequestComment` accepts `attachmentId` and `notifiedUserId`;
    `addStar({ pullRequestCommentId })` stars the PR comment and
    `addStar({ commentId })` still stars an issue comment; a notification
    carries `pullRequestComment.id`; a PR attachment downloads.
  - "a pull request list call spends the read bucket, not search" (the
    opposite of issues; pinned so nobody "fixes" the classifier by name).
  - The `issue` field of a pull request parses from both documented shapes
    (`{ id }` and a full issue) into `{ id, issueKey | null }`.
  - No `backlog-js` PR typing is imported into `port.ts`.
- **Tests to add**: "a pull request is addressed by project, repository and number, never by its global id", "a pull request comment has no parent reference and is looked up through its pull request", "the list endpoint's issue stub and the get endpoint's full issue normalise to the same shape", "starring a pull request comment sends pullRequestCommentId", "a pull-request list call spends read".
- **Size**: ~450 lines + ~500 test.
- **Risks**: the doc examples for `issue` disagree (M7) — normalise to the
  intersection and widen after measuring; `repoIdOrName` is typed `string`
  in `backlog-js` but the path is built here, so pass the numeric id as a
  path segment.

### P2 — kind-explicit ids and the subject layer (`adapter`)

- **Title**: `feat(adapter)!: address issues and pull requests through one subject layer`. Labels `enhancement`, `breaking`. Body carries `BREAKING CHANGE: thread ids are backlog:<host>:<projectId>:issue:<issueId>, message ids <host>:issue:<issueId>:(r|c<id>|u:<created>); BacklogThreadId, BacklogMessageId and BacklogRawMessage changed shape.`
- **Branch**: off P1. Body: `Stacked on #<P1> — merge that first.`
- **Scope**: `src/ids.ts` (§3.2 grammar), `src/types.ts` (§3.2–§3.3 types,
  `BacklogRawComment` without `issueId`), `src/subject/{client,issue,pull-request,url}.ts`,
  `src/egress.ts` and `src/reads.ts` rewritten to take a `SubjectClient`
  (`requireCommentId` → `requireCommentPart`, `issueRefOf` → `raw.subject`),
  `adapter.ts` (`subjectClientFor` wiring; `projectCache` replacing
  `formattingRuleCache`; `repositoryNameCache`; `fetchAttachmentData` by
  subject), `src/test/fixtures/webhooks.ts` id strings, `sample-messages.md`
  regenerated, `src/index.ts` exports (§3.9), CLAUDE.md "State of the repo"
  layout line gains `src/subject/*`.
- **Acceptance criteria**:
  - `threadIdContract` cases for both kinds on three hosts with pinned
    encodings; `decode(encode(x))` deep-equals for nested `subject`.
  - Every §2.2 rejection plus the new ones ("unknown subject keyword",
    "pr: with one number", "issue: followed by nothing") has a test.
  - **Every existing egress/reads/webhook test passes with only id strings
    changed** — the diff to `*.test.ts` outside `ids.test.ts` and the new
    `subject/*.test.ts` is id literals and `subject` fields, nothing
    behavioural.
  - Pull-request threads through the adapter against the in-memory port:
    post → one `addPullRequestComment`; edit; delete → `AdapterError`
    `UNSUPPORTED_OPERATION` with zero API calls; star/unstar via
    `pullRequestCommentId`; `fetchMessages` property sweep
    `(limit) × (comments) × direction` passes for **both** kinds from one
    table; `fetchMessage(:c)` on a PR uses a one-element window and returns
    `null` on 404; `fetchThread` and `fetchSubject` carry `kind`/`type`
    for both; `rehydrateAttachment` accepts both URL shapes and refuses a
    foreign host for both.
  - `subjectClientFor` is the only place a kind selects behaviour, and the
    only `switch` on `ref.kind` outside tests and the id codec (grep-asserted
    in a test, so the containment is executable, not a comment).
- **Tests to add**: "a pull request thread id carries the repository id and number, never the repository name", "the channel of a pull request thread is its project", "a reply on a pull request thread is posted as a pull request comment", "deleting a pull request comment fails before any request because Backlog has no endpoint", "a single pull request comment is fetched through a one-element window", "reacting to a pull request comment stars it as a pull request comment", "backward paging of a pull request ends with a page holding its body", "thread info names its kind for both issues and pull requests", "the subject of a pull request comment is the pull request", "a serialised pull request attachment regains fetchData for a configured host", "kind dispatch happens in exactly one module".
- **Size**: ~700 lines moved/rewritten + ~250 new; tests ~900 (mostly the
  existing suite reshaped plus the PR mirror rows).
- **Risks**: this is the widest diff in the repo's history; review it as
  "did the issue behaviour change" (it must not) plus "is the PR mirror
  complete". Keep the commit history on the branch in reviewable steps (ids
  → types → subject layer → egress → reads → adapter) even though it squashes.
  Circular import risk between `src/subject/*` and `src/reads.ts` — the
  subject layer imports the port only.

### P3 — pull-request webhook ingress (`webhook`)

- **Title**: `feat(webhook): dispatch pull request activities 18–20`. Label `enhancement`.
- **Branch**: off P2. Body: `Stacked on #<P2> — merge that first.` The gate on
  the webhook half of M1 was **waived by the maintainer** (2026-09-06): the
  measurement needs a receiver Backlog's servers can reach, which the
  development environment cannot provide, and the activity form is measured.
  The waiver is safe only because of how the schemas are written — required
  fields are the three identity fields (`content.id`, `content.number`,
  `content.repository.id`), everything else is optional, and unknown keys are
  tolerated — so a webhook body that carries *more* than the activity form
  parses, and one that carries *less* than the three identity fields is the 400
  it should be. What stays unknown is whether a webhook adds a field the
  adapter would want (an `assignee` on 18, as type 1 does); that costs a
  missing mention, not a rejection. **That is what happened**: the capture
  taken after the stack merged (2026-09-06) found `assignee` on 18, 19 and 20,
  and `fix(webhook)` reads it — no delivery was ever rejected. The rules file
  now records only the operations whose webhook body is still uncaptured.
- **Scope**: `src/webhook/payload.ts` (schemas for 18–20 from the measured
  shapes; `DISPATCHED_ACTIVITY_TYPES` widened; `subjectOfActivity`),
  `src/webhook/inbound.ts` (root and comment builders shared with types 1–3
  via the subject ref — the issue builders are generalised, not duplicated;
  mention detection for PR assignment per M2/M3), `adapter.ts`
  `handleWebhook` (thread id by kind, 21 ignored per D-PR5, repository
  name capture), `src/test/fixtures/webhooks.ts` builders
  `pullRequestAdded`, `pullRequestUpdated`, `pullRequestCommented`,
  `pullRequestStatusChanged`, `pullRequestAssigneeChanged`,
  `pullRequestDeleted`, `gitPushed`, `sample-messages.md` regenerated.
- **Acceptance criteria**:
  - Ladder: 200 Ignored for 12/13; 400 for a type-18 body missing
    `content.repository.id` or `content.number`; self-skip on 18/19/20.
  - One test per §3.5 row: thread id, message id, text, attachments,
    mention.
  - A pull request linked to an issue produces a **pull-request** thread,
    not the issue's (`content.issue` present and ignored for routing).
  - Same fixture to two hosts → two thread ids and two ports, as for
    issues.
  - `repositoryNameCache` is populated from the webhook so the following
    `fetchThread` spends no `getGitRepository`.
  - `selfMessageContract` re-run with a type-20 fixture in addition to the
    type-3 one.
  - Type 21 is 200 Ignored (D-PR5), with the measurement cited in the test's
    describe block.
- **Tests to add**: "a new pull request is a root message on a pull request thread", "a comment on a pull request is dispatched to the pull request's thread", "a pull request linked to an issue does not route to the issue's thread", "assigning the bot to a pull request is a mention", "a git push is acknowledged and ignored", "a pull request payload missing its repository is rejected with 400", "the repository name from a webhook spares the next thread read a lookup".
- **Size**: ~350 lines + ~600 test + ~200 fixtures.
- **Risks**: measured `content` may differ from `backlog-js` (e.g. an
  `assignee` on 18, `status` value system on 19). Schemas tolerate unknown
  keys already; the risk is a *missing* key the typing promised — hence the
  gate.

### P4 — pull-request forms of the remaining optional members (`adapter`)

- **Title**: shipped as `test(adapter): pin read receipts, cache invalidation
  and live coverage for pull requests`, **unlabeled**. Two corrections to what
  this bullet originally said: "cache invalidation" replaced "thread listing
  hooks", because `listThreads` needed no hook at all (D-PR7 leaves it
  issue-scoped) while `fetchChannelInfo` did (§3.8); and the type is `test`,
  not `feat`, because P2 had already rewritten both members through the subject
  layer — every `src/` line this phase changes is a comment, so a `feat`
  subject and an `enhancement` label would advertise a feature in the generated
  release notes over a diff a user cannot observe.
- **Branch**: off P3, not off `main`: it edits `fetchChannelInfo` and
  `markAsRead`, both rewritten by P2.
- **Scope**: `markAsRead` matching by kind (§3.6), `fetchChannelInfo`
  clearing every repository name cached for the host (§3.8), `api(host)`
  documented as the route to `listPullRequests`, `src/test/live.test.ts`
  gaining an opt-in
  pull-request section behind `BACKLOG_LIVE_PULL_REQUEST=<repositoryId>:<number>`
  (Get Repository, Get Pull Request, add → edit → star → unstar one comment,
  attach one upload, **no delete — record the 404/absent-endpoint outcome as
  the measurement**), DEVELOPMENT.md credentials table row, `.env.example`.
- **Acceptance criteria**: `markAsRead` on a PR comment finds
  `pullRequestComment.id` on page 1 and page 3, ignores an issue
  notification with the same numeric id, no-ops for `:r`; the live section
  self-skips without the variable and stays within ~8 update calls.
- **Tests to add**: "marking a pull request comment read matches the pull request notification, not an issue comment with the same id", "clearing channel info forgets the host's repository names" and "clearing channel info leaves another space untouched" — the key is `host:repositoryId`, so the clear is host-wide and only a second host can tell that apart from clearing everything.
- **Size**: ~150 lines + ~250 test.

### P5 — documentation (`docs`)

- **Title**: `docs(docs): document pull request threads, ids and limitations`. Label `documentation`.
- **Scope**: README (one-liner, "Platform setup" step 5 activity types,
  "Features and limitations" rows: PR comment deletion unsupported,
  `listThreads` lists issues only, PR merge/close not reachable from Chat;
  id formats; subject types `issue`/`pull_request`), `package.json`
  `description` ("issues, pull requests, comments"), `sample-messages.md`
  already regenerated by P3 (verify), CLAUDE.md "State of the repo" final
  wording, feature-matrix values in the spec §13.
- **Acceptance**: `sample-messages.test.ts` green; every README claim about
  a limitation points at the D-PR decision or the measurement that
  justifies it.

## 5. Measurements (real space, Git-enabled project)

Recorded in `.claude/rules/backlog-pull-request-facts.md` (2026-09-06) in the
vocabulary `example.backlog.com`, project 500, repository 700, pull request
12. Status per question:

| # | Question | Status |
| --- | --- | --- |
| M1 | Exact `content` of 18, 19, 20 | **Measured on both forms.** Activity API: `{ id, number, summary, description, comment, changes, issue, repository }`, no `assignee`/`attachments`/`status`/`base`/`branch`. **Webhook** (captured 2026-09-06 on a deployed receiver, after the waived gate): the same set **plus `assignee`, `base`, `branch`, `diff`**, omitting nothing. Only `assignee` changed behaviour. Still uncaptured, and recorded as such in the rules file: the webhook deliveries for a merge, a close, a comment with `attachmentId[]` and a linked-issue change. |
| M2 | Does 18 carry `content.assignee`? | Activity form: **no** (measured with an assignee set). Webhook form: **yes** (measured 2026-09-06 — a create with `assigneeId` and no mention text was answered by the bot), so §5.4 rule 4 gained the assignment-at-creation mention. |
| M3 | 19 change fields and value systems | **Measured**: `assignee` (display name; absent from a multi-field update once), `status` (id strings `1`/`2`/`3`), `summary`, `description` (full bodies), `issue` (issue keys). Every change carried a changelog `comment.id`. |
| M4 | PR comment paging semantics | **Measured**: exclusive `minId`/`maxId`, `count` cut from the head of `order`, one-element window works. |
| M5 | What fires 21 | **Measured**: not observed — merge (UI and git push) and close are 19 status changes, no delete operation exists in the UI or the API, and the project's activity history holds no type 21. D-PR5 resolved: 21 is ignored and not registered until a payload is seen. |
| M6 | Comment id sequences | **Measured**: separate sequences (7-digit vs 9-digit); overlap possible. |
| M7 | `pullRequest.issue` shape | **Measured**: a full Issue on list and get alike; the list page's stub example is wrong. |
| M8 | `attachmentId[]` on a PR comment | **Measured**: accepted; appears in `changeLog[field="attachment"]` by name only and in `GET …/attachments` with an id. |
| M9 | Notifications with `pullRequest`/`pullRequestComment` in the bot's feed | **UNMEASURED** (fields exist on every item; a populated one needs a second user to mention or assign the bot). Gates nothing: `markAsRead` matches the field by kind either way. |
| M10 | Bucket of PR list/count | **Measured**: `read`. |
| M11 | Does editing a PR comment fire an activity? | **Measured**: no. |
| M12 | Redelivery | UNMEASURED; documentation only. |

Two facts the questions did not anticipate, both recorded: creating a pull
request with `notifiedUserId[]` produces a system comment that no activity
announces, and a pull request's `summary` keeps `<@U…>` mention notation raw.

## 6. Cross-cutting checklist (every PR)

The CLAUDE.md checklist, plus for this stack:

- [ ] No `issueId` parameter survives in `src/egress.ts` or `src/reads.ts`
      after P2; a `SubjectClient` is passed instead.
- [ ] `switch (ref.kind)` / `ref.kind === 'pullRequest'` appears only in
      `src/subject/client.ts` and in the id codec `src/ids.ts` (and tests); the
      containment test enforces it. The codec is allowlisted because writing
      `issue:<id>` versus `pr:<repo>:<n>` *is* its job and it has no port to
      route through — the alternative, sniffing which field is present, is the
      thing D-PR2 rejects. Behaviour never branches there; only the grammar
      does.
- [ ] A Backlog pull-request claim is cited to a page in §2's table or to a
      dated `backlog-pull-request-facts.md` entry; `backlog-js` typings are
      never the citation for a wire fact.
- [ ] Fixtures use repository 700 and pull request 12; no real repository or
      branch names.
- [ ] `sample-messages.md` regenerated whenever a fixture changes
      (`sample-messages.test.ts` fails otherwise).
- [ ] Breaking title (`!`) and `BREAKING CHANGE:` footer on P2 only; both
      labels (`breaking` + `enhancement`).

## 7. Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A type-21 payload appears after all | An unhandled activity | It is 200 Ignored today; the rules file says to capture and re-measure before dispatching it. |
| Webhook body differs from the measured activity body | A 400 on real deliveries, or a field (an `assignee` on 18) silently unused | **Realised as the second, benign half** (2026-09-06): no 400, and `assignee` was unused on 18–20 until `fix(webhook)` read it. Schemas tolerate unknown keys; required fields are the three identity fields only. |
| P2 is a large refactor touching every member | Behaviour regressions hidden in a wide diff | "Only id literals change in existing tests" acceptance rule; branch commits in six reviewable steps; property sweep runs for both kinds. |
| Comment id spaces overlap across kinds | Cross-kind matches in `markAsRead`, dedupe collisions | Kind segment in every message id; `markAsRead` matches by kind; M6 recorded. |
| No delete for PR comments | A bot flow that deletes its own message fails on PR threads | Typed `UNSUPPORTED_OPERATION` before any call; README row; `capabilities` lets a caller check first. |
| PR web URL needs two names ids do not carry | Extra reads on `fetchThread`/`fetchSubject` | Free capture from webhooks; one cached Get Repository on a miss; `url` omitted rather than the read failing. |
| Windowed single-comment fetch depends on exclusive bounds | Off-by-one returns a neighbour comment | M4 measures on PR comments; the client asserts `comment.id === commentId` on the returned element and treats a mismatch as not found. |
| Read-bucket cost of PR reads (get + list per page) | Same as issues; PR list is `read` not `search`, so lighter | Documented; `rateLimit(host)` exposes it. |
| Deep stack (P1→P2→P3) | Rebase churn after each squash | Merge P1 the moment it is green; P2 records P1's tip; `git rebase --onto`. |

## 8. Decisions to confirm with the maintainer (⚑)

| # | Decision | Default assumed | Rejected | Blocks |
| --- | --- | --- | --- | --- |
| D-PR1 | Channel of a pull-request thread | The **project**, like issues: webhooks carry `project.id`, the formatting rule is per project, and `channelIdFromThreadId` stays "first three segments". | The repository (would make `listThreads` list PRs but splits one project into N+1 channels and has no formatting rule of its own). | P0, P2 |
| D-PR2 | Thread-id shape | Nested `subject: BacklogSubjectRef` shared with message ids and raws; kind keyword explicit for **both** kinds (`issue:`, `pr:`). | Flat `{ kind, issueId?, repositoryId?, number? }`; keeping issues unmarked (`4 segments = issue`) for brevity — the GitHub debt, chosen deliberately not to inherit. | P2 |
| D-PR3 | `deleteMessage` on a PR thread | `AdapterError(…, "backlog", "UNSUPPORTED_OPERATION")` before any call. | `ValidationError` (mislabels a correct call); silent success (forbidden: fabricated success); omitting `deleteMessage` (it is a required member). | P2 |
| D-PR4 | Adapter option to enable/disable pull requests | None; the webhook subscription is the switch. | `subjects: ('issue' \| 'pullRequest')[]` config (duplicates what registration already decides; a mismatch would silently drop delivered events). | P0 |
| D-PR5 | Type 21 handling | 200 Ignored, not in the registration guidance: it was not observed (merge and close are 19 status changes, no delete operation exists, measured). | `processMessageDeleted` on 21 (nothing to test it against); guessing from `backlog-js`'s enum name. | P3 |
| D-PR6 | A PR linked to an issue | Its own thread; the link is metadata (`fetchThread.metadata.issue`, `raw.payload.content.issue`). | Routing PR activity into the linked issue's thread (a PR can be re-linked; the thread would move). | P3 |
| D-PR7 | `listThreads` population | Issues only, documented; `api(host).listPullRequests` for PRs. | Interleaving issues and every repository's PRs (N+1 reads, two cursor shapes in one string); listing PRs only (breaks the current behaviour with nothing gained). | P4, P5 |
| D-PR8 | `fetchSubject().type` for a pull request | `'pull_request'` (GitHub's convention; the core leaves `type` free). | `'pullRequest'` (matches our `kind` but not the ecosystem a bot author already handles). | P2 |
| D-PR9 | Root message part tag | `r` for both kinds (was `i`, which meant "issue"). | Keep `i` (misleading on a PR); no tag (irregular grammar). | P2 |
| D-PR10 | PR comment attachments have no id in `changeLog` | Lazy: `fetchData` lists `…/attachments`, matches by name (newest wins), downloads. | No `fetchData` (loses the file); an eager list per comment (a read per message). | P2 |

## 9. Out of scope / later

- **Creating pull requests** from Chat (`base`/`branch` have no Chat SDK
  postable shape; a `BacklogPullRequestPostableExtras` on a repository-aware
  entry point could come later).
- **Closing or merging** a pull request: Backlog documents no API for it.
- **`listThreads` over pull requests** by repository (would need a
  repository-scoped id the channel grammar does not have; D-PR7).
- **PR attachments on the root message** via `GET …/pullRequests/:n/attachments`
  (one extra read per root; the issue root does not do this either today).
- **Type 12 Git Pushed** as a message (a push is not a conversation; a
  future "activity feed" `fetchChannelMessages` could carry it).
- **Document activities (36–49)**: a third subject kind the same seam would
  accept; not planned.
