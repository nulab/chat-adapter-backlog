/**
 * The port <-> raw-message field mapping for a thread's root and its comments
 * (docs/specs/adapter.md §3.5), both directions side by side so a field added
 * to `BacklogPullRequest` cannot be mapped one way and forgotten the other.
 *
 * `src/client/port.ts` owns the API domain types (`Date` objects, the full
 * `BacklogUserRef`) and `src/types.ts` owns the shapes `message.raw` carries
 * (ISO strings, so a serialised `Message` survives the queue round trip);
 * `src/index.ts` explains why both exist. This module is the only translation
 * between them.
 *
 * It imports the port and `src/types.ts` and nothing else from `src/`, which
 * keeps it a leaf like `src/subject/url.ts` — `src/reads.ts` and
 * `src/egress.ts` import it without an import cycle through the subject layer.
 */

import type {
  BacklogComment,
  BacklogIssue,
  BacklogPullRequest,
  BacklogUserRef,
} from '../client/port';
import type {
  BacklogChange,
  BacklogRawComment,
  BacklogRawIssue,
  BacklogRawPullRequest,
} from '../types';

/**
 * A REST `changeLog` as `message.raw` carries it: the three normalised fields
 * of `BacklogChange` (docs/specs/adapter.md §3.5), without the port's
 * `attachmentInfo`, which is an id source for `commentAttachments` rather
 * than part of the change itself.
 */
export function toRawChanges(
  changeLog: BacklogComment['changeLog']
): BacklogChange[] {
  return changeLog.map((change) => ({
    field: change.field,
    newValue: change.newValue,
    oldValue: change.oldValue,
  }));
}

/**
 * A REST issue as the `{ kind: "issue" }` variant carries it — shared by
 * `fetchRoot`-derived roots, by `listThreads` and by `createChannelIssue`
 * (`src/egress.ts`), so the mapping has exactly one implementation.
 */
export function toRawIssue(issue: BacklogIssue): BacklogRawIssue {
  return {
    id: issue.id,
    issueKey: issue.issueKey,
    projectId: issue.projectId,
    summary: issue.summary,
    description: issue.description,
    status: { id: issue.status.id, name: issue.status.name },
    issueType: { id: issue.issueType.id, name: issue.issueType.name },
    priority: { id: issue.priority.id, name: issue.priority.name },
    assignee:
      issue.assignee === null
        ? null
        : { id: issue.assignee.id, name: issue.assignee.name },
    createdUser: {
      id: issue.createdUser.id,
      name: issue.createdUser.name,
      userId: issue.createdUser.userId,
    },
    created: issue.created.toISOString(),
    updated: issue.updated.toISOString(),
  };
}

/** The `toRawIssue` of a pull request (docs/specs/adapter.md §3.5). */
export function toRawPullRequest(
  pullRequest: BacklogPullRequest
): BacklogRawPullRequest {
  return {
    id: pullRequest.id,
    projectId: pullRequest.projectId,
    repositoryId: pullRequest.repositoryId,
    number: pullRequest.number,
    summary: pullRequest.summary,
    description: pullRequest.description,
    base: pullRequest.base,
    branch: pullRequest.branch,
    status: { id: pullRequest.status.id, name: pullRequest.status.name },
    assignee:
      pullRequest.assignee === null
        ? null
        : { id: pullRequest.assignee.id, name: pullRequest.assignee.name },
    issue:
      pullRequest.issue === null
        ? null
        : { id: pullRequest.issue.id, issueKey: pullRequest.issue.issueKey },
    baseCommit: pullRequest.baseCommit,
    branchCommit: pullRequest.branchCommit,
    mergeCommit: pullRequest.mergeCommit,
    closeAt:
      pullRequest.closeAt === null ? null : pullRequest.closeAt.toISOString(),
    mergeAt:
      pullRequest.mergeAt === null ? null : pullRequest.mergeAt.toISOString(),
    createdUser: {
      id: pullRequest.createdUser.id,
      name: pullRequest.createdUser.name,
      userId: pullRequest.createdUser.userId,
    },
    created: pullRequest.created.toISOString(),
    updated: pullRequest.updated.toISOString(),
  };
}

/**
 * One comment shape serves both kinds: the parent is named by the enclosing
 * raw variant's `subject`, not by the comment, because a pull-request comment
 * carries no parent reference at all (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md`).
 */
export function toRawComment(comment: BacklogComment): BacklogRawComment {
  return {
    id: comment.id,
    content: comment.content,
    createdUser: {
      id: comment.createdUser.id,
      name: comment.createdUser.name,
      userId: comment.createdUser.userId,
    },
    created: comment.created.toISOString(),
    updated: comment.updated.toISOString(),
    changeLog: toRawChanges(comment.changeLog),
    stars: comment.stars.map((star) => ({
      id: star.id,
      presenter: { id: star.presenter.id },
    })),
  };
}

/**
 * A `BacklogUserRef` from the two or three fields a raw message keeps of one.
 *
 * `mailAddress` is `null` for every user, and `userId` is `null` for an
 * assignee, which the raw shapes carry as `{ id, name }` alone. Both omissions
 * are deliberate (the header comment of `src/index.ts`), so the fields cannot
 * be recovered from a raw at all — and neither is read by anything a rebuilt
 * object feeds: §7.4 shows a user as `{ id, name }` and §7.3 as a numeric id.
 * Do not "repair" this by widening `BacklogRawIssue`; a `Message` is
 * serialised into the state adapter, and every field added to a raw shape is
 * paid for on every queue round trip.
 */
function userFromRaw(user: {
  id: number;
  name: string;
  userId?: string | null;
}): BacklogUserRef {
  return {
    id: user.id,
    userId: user.userId ?? null,
    name: user.name,
    mailAddress: null,
  };
}

/**
 * The port object a serialised `{ kind: "issue" }` raw describes. Lossy only
 * in the user fields `userFromRaw` explains; every other field of
 * `BacklogIssue` is on `BacklogRawIssue`.
 */
export function fromRawIssue(raw: BacklogRawIssue): BacklogIssue {
  return {
    id: raw.id,
    projectId: raw.projectId,
    issueKey: raw.issueKey,
    summary: raw.summary,
    description: raw.description,
    issueType: { ...raw.issueType },
    priority: { ...raw.priority },
    status: { ...raw.status },
    assignee: raw.assignee === null ? null : userFromRaw(raw.assignee),
    createdUser: userFromRaw(raw.createdUser),
    created: new Date(raw.created),
    updated: new Date(raw.updated),
  };
}

/**
 * The port object a serialised `{ kind: "pullRequest" }` raw describes. Lossy
 * in the same user fields as `fromRawIssue` and in one more of its own,
 * marked below.
 */
export function fromRawPullRequest(
  raw: BacklogRawPullRequest
): BacklogPullRequest {
  return {
    id: raw.id,
    projectId: raw.projectId,
    repositoryId: raw.repositoryId,
    number: raw.number,
    summary: raw.summary,
    description: raw.description,
    base: raw.base,
    branch: raw.branch,
    status: { ...raw.status },
    assignee: raw.assignee === null ? null : userFromRaw(raw.assignee),
    issue: raw.issue === null ? null : { ...raw.issue },
    baseCommit: raw.baseCommit,
    branchCommit: raw.branchCommit,
    mergeCommit: raw.mergeCommit,
    closeAt: raw.closeAt === null ? null : new Date(raw.closeAt),
    mergeAt: raw.mergeAt === null ? null : new Date(raw.mergeAt),
    createdUser: userFromRaw(raw.createdUser),
    created: new Date(raw.created),
    updated: new Date(raw.updated),
    // Empty for the same reason the user fields above are null:
    // `BacklogRawPullRequest` carries no `stars[]`. A pull request's own stars
    // are read through `GET …/pullRequests/:number` and feed nothing §7.4
    // shows, so an empty list here costs a caller nothing a call would have to
    // be spent on.
    stars: [],
  };
}
