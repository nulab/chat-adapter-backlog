import { AdapterError, ResourceNotFoundError } from '@chat-adapter/shared';

import {
  download,
  readIssue,
  readIssueComment,
  readIssueComments,
  send,
} from '../client/responses';
import { issueAttachmentUrl } from './url';

import type {
  BacklogChange,
  BacklogRawComment,
  BacklogRawIssue,
  BacklogRawMessage,
  BacklogSubjectRef,
} from '../types';
import type {
  AddCommentInput,
  ListCommentsOptions,
  SubjectClient,
  SubjectContext,
  SubjectNames,
  SubjectRoot,
} from './client';
import type { Backlog, Option } from 'backlog-js';
import type { Attachment } from 'chat';

type IssueRef = Extract<BacklogSubjectRef, { kind: 'issue' }>;

/**
 * Throws rather than rebuilding what it needs from `SubjectRoot`, because
 * `issueKey`, `issueType` and `priority` are not on that shape, and a
 * placeholder would ship a wrong issue key into a thread's metadata and URL.
 */
function issueOf(root: SubjectRoot): BacklogRawIssue {
  if (root.source.kind !== 'issue') {
    throw new AdapterError(
      'a pull request root was passed to the issue subject client',
      'backlog',
      'INVALID_SUBJECT_ROOT'
    );
  }
  return root.source.issue;
}

function issueWebUrl(host: string, issueKey: string): string {
  return `https://${host}/view/${issueKey}`;
}

/** `<projectKey>-<number>`, which spares a `channelName` a Get Project. */
function projectKeyOf(issueKey: string): string {
  const lastDash = issueKey.lastIndexOf('-');
  return lastDash === -1 ? issueKey : issueKey.slice(0, lastDash);
}

export function createIssueSubjectClient(
  client: Backlog,
  ref: IssueRef,
  context: SubjectContext
): SubjectClient {
  const { host } = context;
  const { issueId } = ref;

  function downloadAttachment(attachmentId: number): Promise<Buffer> {
    return download(client.getIssueAttachment(issueId, attachmentId));
  }

  function rootOf(issue: BacklogRawIssue): SubjectRoot {
    return {
      ref,
      title: issue.summary,
      body: issue.description,
      status: issue.status,
      assignee: issue.assignee,
      createdUser: issue.createdUser,
      created: issue.created,
      source: { kind: 'issue', issue },
    };
  }

  function readComment(request: Promise<unknown>): Promise<BacklogRawComment> {
    return readIssueComment(request);
  }

  return {
    ref,

    async fetchRoot(): Promise<SubjectRoot> {
      return rootOf(await readIssue(client.getIssue(issueId)));
    },

    rootFrom(raw: BacklogRawMessage): SubjectRoot | undefined {
      return raw.kind === 'issue' ? rootOf(raw.issue) : undefined;
    },

    listComments(options: ListCommentsOptions): Promise<BacklogRawComment[]> {
      return readIssueComments(client.getIssueComments(issueId, options));
    },

    /**
     * Get Comment answers for a comment id under any issue id, so a comment
     * of another issue is refused here rather than read into this thread.
     */
    async getComment(commentId: number): Promise<BacklogRawComment> {
      const comment = await readIssueComment(
        client.getIssueComment(issueId, commentId)
      );
      if (comment.issueId !== issueId) {
        throw new ResourceNotFoundError(
          'backlog',
          'comment',
          String(commentId)
        );
      }
      return comment;
    },

    addComment(input: AddCommentInput): Promise<BacklogRawComment> {
      return readComment(client.postIssueComments(issueId, input));
    },

    updateComment(
      commentId: number,
      content: string
    ): Promise<BacklogRawComment> {
      return readComment(
        client.patchIssueComment(issueId, commentId, { content })
      );
    },

    async deleteComment(commentId: number): Promise<void> {
      await send(client.deleteIssueComment(issueId, commentId));
    },

    starTarget(commentId: number): Option.Project.PostStarParams {
      return { commentId };
    },

    rootRaw(root: SubjectRoot): BacklogRawMessage {
      return { kind: 'issue', host, issue: issueOf(root), changes: [] };
    },

    commentAttachments(comment: BacklogRawComment): Attachment[] {
      const attachments: Attachment[] = [];
      for (const change of comment.changeLog) {
        // A removal names the file in `originalValue` and leaves `newValue`
        // null: it names a file that is no longer on the issue.
        if (
          change.field !== 'attachment' ||
          change.newValue === null ||
          change.attachmentInfo === null
        ) {
          continue;
        }
        const attachmentId = change.attachmentInfo.id;
        attachments.push({
          type: 'file',
          name: change.newValue,
          url: issueAttachmentUrl(host, issueId, attachmentId),
          fetchData: () => downloadAttachment(attachmentId),
        });
      }
      return attachments;
    },

    webhookAttachment(attachment: {
      id: number;
      name: string;
      size?: number | undefined;
    }): Attachment {
      return {
        type: 'file',
        name: attachment.name,
        ...(attachment.size === undefined ? {} : { size: attachment.size }),
        url: issueAttachmentUrl(host, issueId, attachment.id),
        fetchData: () => downloadAttachment(attachment.id),
      };
    },

    /**
     * An issue webhook carries no `changes[field="attachment"]` at all: an
     * attachment add arrives as a changelog comment whose change is visible
     * only in that comment's REST `changeLog` (measured).
     */
    webhookChangeAttachment(_change: BacklogChange): Attachment | undefined {
      return undefined;
    },

    channelName(root: SubjectRoot, _names: SubjectNames): string | undefined {
      return projectKeyOf(issueOf(root).issueKey);
    },

    threadMetadata(
      root: SubjectRoot,
      _names: SubjectNames
    ): Record<string, unknown> {
      const issue = issueOf(root);
      return {
        kind: 'issue',
        host,
        projectId: context.projectId,
        issueId,
        issueKey: issue.issueKey,
        summary: issue.summary,
        status: { id: issue.status.id, name: issue.status.name },
        url: issueWebUrl(host, issue.issueKey),
      };
    },

    subjectType: 'issue',

    subjectRaw(root: SubjectRoot): unknown {
      return issueOf(root);
    },

    subjectLabels(root: SubjectRoot): string[] {
      const issue = issueOf(root);
      return [issue.issueType.name, issue.priority.name];
    },

    webUrl(root: SubjectRoot, _names: SubjectNames): string | undefined {
      return issueWebUrl(host, issueOf(root).issueKey);
    },

    repositoryIdForName: undefined,
  };
}
