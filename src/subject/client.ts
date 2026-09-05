/**
 * The seam between the adapter's members and the HTTP port
 * (docs/plans/pull-request-support.md §3.4). The port stays endpoint-shaped —
 * one method per Backlog endpoint, conformance-tested twice — while a
 * `SubjectClient` presents *one* comment stream regardless of whether the
 * thread is an issue or a pull request, so `src/egress.ts` and `src/reads.ts`
 * have one code path each instead of six `if (kind === "pullRequest")`
 * branches with a different exception behind every one.
 *
 * `subjectClientFor` at the bottom of this file is the only place in `src/`
 * where a subject's kind selects **behaviour**. `src/ids.ts` also reads it, to
 * write `issue:<id>` versus `pr:<repo>:<n>` — that is a codec's whole job and
 * it has no port to route through, so the containment test allowlists exactly
 * those two files and fails on any third. The rule is executable rather than a
 * comment somebody has to remember.
 *
 * This layer imports the port and nothing else from `src/`, which is what
 * keeps `src/reads.ts` free to import it back.
 */

import { createIssueSubjectClient } from './issue';
import { createPullRequestSubjectClient } from './pull-request';

import type {
  AddCommentInput,
  BacklogApi,
  BacklogComment,
  BacklogIssue,
  BacklogNotification,
  BacklogPullRequest,
  BacklogUserRef,
  ListCommentsOptions,
  StarTarget,
} from '../client/port';
import type { BacklogRawMessage, BacklogSubjectRef } from '../types';
import type { Attachment } from 'chat';

/**
 * Display names a subject's web URL needs and its REST object does not carry
 * (docs/specs/adapter.md §7.3). Both are optional because a lookup that fails
 * yields a URL-less `ThreadInfo` rather than a failed read.
 */
export interface SubjectNames {
  projectKey?: string | undefined;
  repositoryName?: string | undefined;
}

/**
 * A thread's root message, normalised across the two kinds (§3.4). It carries
 * no space-wide `id` and no `projectId`: nothing reads them here — a star
 * takes its target from `starTarget`, `threadMetadata` takes the project from
 * `SubjectContext` and everything else from `source` — and a pull request's
 * global id addresses no endpoint at all (measured 2026-09-06,
 * `.claude/rules/backlog-pull-request-facts.md`).
 */
export interface SubjectRoot {
  ref: BacklogSubjectRef;
  title: string;
  body: string;
  status: { id: number; name: string };
  assignee: BacklogUserRef | null;
  createdUser: BacklogUserRef;
  created: Date;
  updated: Date;
  /** The port domain object this root was built from. */
  source:
    | { kind: 'issue'; issue: BacklogIssue }
    | { kind: 'pullRequest'; pullRequest: BacklogPullRequest };
}

/** Everything `subjectClientFor` needs beyond the ref itself. */
export interface SubjectContext {
  host: string;
  projectId: number;
}

export interface SubjectClient {
  readonly ref: BacklogSubjectRef;
  /**
   * What Backlog will and will not do for this kind. `deleteComment` is
   * `false` for a pull request because the route does not exist (D-PR3), and
   * a caller can check it instead of provoking the error.
   */
  readonly capabilities: { deleteComment: boolean };

  fetchRoot(): Promise<SubjectRoot>;
  /**
   * The root this subject's own serialised raw describes, without a call, or
   * `undefined` when the raw is not this subject's root (§7.4).
   *
   * It rebuilds the **port** object `SubjectRoot.source` is typed as, rather
   * than passing the raw one through, because the members below read fields
   * off `source` that `SubjectRoot` itself does not have (`issueKey`,
   * `base`/`branch`). The rebuild is lossy in the three places
   * `src/subject/raw.ts` names, and all three are cheaper than the
   * alternative: a Get Issue or Get Pull Request on **every**
   * `message.subject` access, since the core calls `fetchSubject` lazily and
   * does not cache it (`.claude/rules/chat-sdk-core-facts.md`), to recover
   * fields §7.4 never looks at.
   */
  rootFrom(raw: BacklogRawMessage): SubjectRoot | undefined;
  listComments(options: ListCommentsOptions): Promise<BacklogComment[]>;
  getComment(commentId: number): Promise<BacklogComment>;
  addComment(input: AddCommentInput): Promise<BacklogComment>;
  updateComment(commentId: number, content: string): Promise<BacklogComment>;
  deleteComment(commentId: number): Promise<void>;

  /** `POST /stars`: `commentId` or `pullRequestCommentId` (§6.5). */
  starTarget(commentId: number): StarTarget;

  /** The `BacklogRawMessage` variant for this subject's root (§3.5). */
  rootRaw(root: SubjectRoot): BacklogRawMessage;
  /** Attachments a REST comment carries, resolved the way this kind allows (§6.6). */
  commentAttachments(comment: BacklogComment): Attachment[];
  /** One `content.attachments[]` entry from a webhook body (§5.3). */
  webhookAttachment(attachment: {
    id: number;
    name: string;
    size: number;
  }): Attachment;

  /** `ThreadInfo.channelName` (§7.3). */
  channelName(root: SubjectRoot, names: SubjectNames): string | undefined;
  /** `ThreadInfo.metadata` (§7.3); names its own `kind` for both kinds. */
  threadMetadata(
    root: SubjectRoot,
    names: SubjectNames
  ): Record<string, unknown>;
  /** `MessageSubject.type` (§7.4, D-PR8): `"issue"` or `"pull_request"`. */
  readonly subjectType: string;
  /** The port domain object §7.4 puts on `MessageSubject.raw`: the issue, or the pull request. */
  subjectRaw(root: SubjectRoot): unknown;
  /** `MessageSubject.labels` (§7.4). */
  subjectLabels(root: SubjectRoot): string[];
  /** The web URL, or `undefined` when a display name could not be resolved. */
  webUrl(root: SubjectRoot, names: SubjectNames): string | undefined;
  /**
   * The repository whose display name `webUrl` needs, or `undefined` for a
   * kind whose URL needs none. It exists so the adapter can fill
   * `SubjectNames` without asking what kind it is holding (§7.3, §3.8).
   */
  readonly repositoryIdForName: number | undefined;
  /**
   * The comment id a notification is about, or `undefined` when it is about
   * something else. Matched on `comment.id` for an issue and
   * `pullRequestComment.id` for a pull request and never the other way round:
   * the two id sequences are distinct and may overlap (§7.8, measured
   * 2026-09-06).
   */
  notificationCommentId(notification: BacklogNotification): number | undefined;
}

/**
 * The one place a subject's kind selects behaviour (D-PR2,
 * docs/plans/pull-request-support.md §6). Every member of the adapter reaches
 * Backlog as `decode -> subjectClientFor -> the same code for both kinds`, so
 * a fix to egress or reads lands once rather than twice.
 */
export function subjectClientFor(
  api: BacklogApi,
  ref: BacklogSubjectRef,
  context: SubjectContext
): SubjectClient {
  switch (ref.kind) {
    case 'issue':
      return createIssueSubjectClient(api, ref, context);
    case 'pullRequest':
      return createPullRequestSubjectClient(api, ref, context);
  }
}
