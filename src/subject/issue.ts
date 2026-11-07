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
  SubjectRoot,
  WebhookAttachment,
} from './client';
import type { Backlog, Option } from 'backlog-js';
import type { Attachment } from 'chat';

type IssueRef = Extract<BacklogSubjectRef, { kind: 'issue' }>;

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

  /**
   * Get Comment answers for a comment id under any issue id, so a comment of
   * another issue is refused here rather than read into this thread.
   */
  async function getComment(commentId: number): Promise<BacklogRawComment> {
    const comment = await readIssueComment(
      client.getIssueComment(issueId, commentId)
    );
    if (comment.issueId !== issueId) {
      throw new ResourceNotFoundError('backlog', 'comment', String(commentId));
    }
    return comment;
  }

  function rootOf(issue: BacklogRawIssue): SubjectRoot {
    const url = issueWebUrl(host, issue.issueKey);
    return {
      title: issue.summary,
      body: issue.description,
      status: issue.status,
      assignee: issue.assignee,
      createdUser: issue.createdUser,
      created: issue.created,
      raw: { kind: 'issue', host, issue, changes: [] },
      channelName: projectKeyOf(issue.issueKey),
      threadMetadata: {
        kind: 'issue',
        host,
        projectId: context.projectId,
        issueId,
        issueKey: issue.issueKey,
        summary: issue.summary,
        status: { id: issue.status.id, name: issue.status.name },
        url,
      },
      subject: {
        type: 'issue',
        raw: issue,
        labels: [issue.issueType.name, issue.priority.name],
        url,
      },
    };
  }

  return {
    ref,

    async fetchRoot(): Promise<SubjectRoot> {
      return rootOf(await readIssue(client.getIssue(issueId)));
    },

    async rootFrom(raw: BacklogRawMessage): Promise<SubjectRoot | undefined> {
      return raw.kind === 'issue' ? rootOf(raw.issue) : undefined;
    },

    listComments(options: ListCommentsOptions): Promise<BacklogRawComment[]> {
      return readIssueComments(client.getIssueComments(issueId, options));
    },

    getComment,

    addComment(input: AddCommentInput): Promise<BacklogRawComment> {
      return readIssueComment(client.postIssueComments(issueId, input));
    },

    updateComment(
      commentId: number,
      content: string
    ): Promise<BacklogRawComment> {
      return readIssueComment(
        client.patchIssueComment(issueId, commentId, { content })
      );
    },

    /**
     * Refuses a comment that records a change or an attachment: Backlog
     * answers 200 but keeps it, with its content emptied (measured), so
     * resolving would fabricate a deletion (D31).
     */
    async deleteComment(commentId: number): Promise<void> {
      const comment = await getComment(commentId);
      if (comment.changeLog.length > 0) {
        throw new AdapterError(
          'Backlog keeps an issue comment that records a change or an attachment; edit the comment instead',
          'backlog',
          'UNSUPPORTED_OPERATION'
        );
      }
      await send(client.deleteIssueComment(issueId, commentId));
    },

    starTarget(commentId: number): Option.Project.PostStarParams {
      return { commentId };
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

    webhookAttachment(attachment: WebhookAttachment): Attachment {
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
  };
}
