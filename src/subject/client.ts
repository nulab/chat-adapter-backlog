import { createIssueSubjectClient } from './issue';
import { createPullRequestSubjectClient } from './pull-request';

import type {
  BacklogChange,
  BacklogRawComment,
  BacklogRawIssue,
  BacklogRawMessage,
  BacklogRawPullRequest,
  BacklogSubjectRef,
  BacklogUser,
} from '../types';
import type { Backlog, Option } from 'backlog-js';
import type { Attachment } from 'chat';

/**
 * Display names a subject's web URL needs and its REST object does not
 * carry. Both are optional because a lookup that fails yields a URL-less
 * `ThreadInfo` rather than a failed read.
 */
export interface SubjectNames {
  projectKey?: string | undefined;
  repositoryName?: string | undefined;
}

/** A thread's root message, the same shape for both kinds. */
export interface SubjectRoot {
  ref: BacklogSubjectRef;
  title: string;
  body: string;
  status: { id: number; name: string };
  assignee: BacklogUser | null;
  createdUser: BacklogUser;
  created: string;
  source:
    | { kind: 'issue'; issue: BacklogRawIssue }
    | { kind: 'pullRequest'; pullRequest: BacklogRawPullRequest };
}

export interface SubjectContext {
  host: string;
  projectId: number;
}

export type ListCommentsOptions = Option.Issue.GetIssueCommentsParams;
export type AddCommentInput = Option.Issue.PostIssueCommentsParams;

export interface WebhookAttachment {
  id: number;
  name: string;
  size?: number | undefined;
}

export interface SubjectClient {
  readonly ref: BacklogSubjectRef;

  fetchRoot(): Promise<SubjectRoot>;
  /**
   * The root a raw message already carries, or `undefined` when it carries
   * none: the core calls `fetchSubject` on every `message.subject` access
   * without caching it, so a root in hand spares a read each time.
   */
  rootFrom(raw: BacklogRawMessage): SubjectRoot | undefined;
  listComments(options: ListCommentsOptions): Promise<BacklogRawComment[]>;
  getComment(commentId: number): Promise<BacklogRawComment>;
  addComment(input: AddCommentInput): Promise<BacklogRawComment>;
  updateComment(commentId: number, content: string): Promise<BacklogRawComment>;
  deleteComment(commentId: number): Promise<void>;
  /**
   * Issue and pull-request comment ids come from different sequences and may
   * overlap (measured), so a star aimed at the wrong field would land on
   * somebody else's comment.
   */
  starTarget(commentId: number): Option.Project.PostStarParams;

  rootRaw(root: SubjectRoot): BacklogRawMessage;
  commentAttachments(comment: BacklogRawComment): Attachment[];
  webhookAttachment(attachment: WebhookAttachment): Attachment;
  /**
   * The file a webhook `changes[]` entry the caller has already recognised as
   * an attachment add names, or `undefined` for a kind whose payload never
   * names one there.
   */
  webhookChangeAttachment(change: BacklogChange): Attachment | undefined;

  channelName(root: SubjectRoot, names: SubjectNames): string | undefined;
  threadMetadata(
    root: SubjectRoot,
    names: SubjectNames
  ): Record<string, unknown>;
  /** `"issue"` or `"pull_request"` (D-PR8). */
  readonly subjectType: string;
  subjectRaw(root: SubjectRoot): unknown;
  subjectLabels(root: SubjectRoot): string[];
  webUrl(root: SubjectRoot, names: SubjectNames): string | undefined;
  /**
   * The repository whose display name `webUrl` needs, or `undefined` for a
   * kind whose URL needs none, so the adapter can fill `SubjectNames`
   * without asking what kind it is holding.
   */
  readonly repositoryIdForName: number | undefined;
}

/** The one place a subject's kind selects behaviour (D-PR2). */
export function subjectClientFor(
  client: Backlog,
  ref: BacklogSubjectRef,
  context: SubjectContext
): SubjectClient {
  switch (ref.kind) {
    case 'issue':
      return createIssueSubjectClient(client, ref, context);
    case 'pullRequest':
      return createPullRequestSubjectClient(client, ref, context);
  }
}
