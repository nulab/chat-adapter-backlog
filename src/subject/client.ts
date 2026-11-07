import { createIssueSubjectClient } from './issue';
import { createPullRequestSubjectClient } from './pull-request';

import type {
  BacklogChange,
  BacklogRawComment,
  BacklogRawMessage,
  BacklogSubjectRef,
  BacklogUser,
} from '../types';
import type { Backlog, Option } from 'backlog-js';
import type { Attachment } from 'chat';

/**
 * A thread's root as data: everything `reads.ts` needs, read once, so no
 * caller asks the client about it again.
 */
export interface SubjectRoot {
  ref: BacklogSubjectRef;
  title: string;
  body: string;
  status: { id: number; name: string };
  assignee: BacklogUser | null;
  createdUser: BacklogUser;
  created: string;
  /** The root message's `raw`. */
  raw: BacklogRawMessage;
  channelName: string;
  threadMetadata: Record<string, unknown>;
  subject: {
    /** `"issue"` or `"pull_request"` (D-PR8). */
    type: string;
    raw: unknown;
    labels: string[];
    url: string;
  };
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
   * without caching it, so a root in hand spares the Get Pull Request (the
   * pull-request client still reads its two display names, D-PR11).
   */
  rootFrom(raw: BacklogRawMessage): Promise<SubjectRoot | undefined>;
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

  commentAttachments(comment: BacklogRawComment): Attachment[];
  webhookAttachment(attachment: WebhookAttachment): Attachment;
  /**
   * The file a webhook `changes[]` entry the caller has already recognised as
   * an attachment add names, or `undefined` for a kind whose payload never
   * names one there.
   */
  webhookChangeAttachment(change: BacklogChange): Attachment | undefined;
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
