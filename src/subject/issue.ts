/**
 * The issue half of the subject layer (docs/plans/pull-request-support.md
 * §3.4): today's issue behaviour behind the `SubjectClient` interface, so
 * `src/egress.ts` and `src/reads.ts` never name an issue endpoint again.
 */

import { AdapterError } from '@chat-adapter/shared';

import { fromRawIssue, toRawIssue } from './raw';
import { issueAttachmentUrl } from './url';

import type {
  AddCommentInput,
  BacklogApi,
  BacklogComment,
  BacklogIssue,
  BacklogNotification,
  ListCommentsOptions,
  StarTarget,
} from '../client/port';
import type {
  BacklogChange,
  BacklogRawMessage,
  BacklogSubjectRef,
} from '../types';
import type {
  SubjectClient,
  SubjectContext,
  SubjectNames,
  SubjectRoot,
} from './client';
import type { Attachment } from 'chat';

type IssueRef = Extract<BacklogSubjectRef, { kind: 'issue' }>;

/**
 * `SubjectRoot.source` is a union both kinds share, so the mismatched arm is
 * reachable only by handing an issue client a pull request's root, which
 * `subjectClientFor` cannot do. It throws rather than rebuilding what it needs
 * from `SubjectRoot` because `issueKey`, `issueType` and `priority` are not on
 * that shape at all, and a silent placeholder would ship a wrong issue key
 * into a thread's metadata and web URL.
 */
function issueOf(root: SubjectRoot): BacklogIssue {
  if (root.source.kind !== 'issue') {
    throw new AdapterError(
      'a pull request root was passed to the issue subject client',
      'backlog',
      'INVALID_SUBJECT_ROOT'
    );
  }
  return root.source.issue;
}

/**
 * `https://<host>/view/<issueKey>`, the only web URL an issue needs — unlike a
 * pull request, everything in it is on the object the read already fetched
 * (docs/specs/adapter.md §7.3).
 */
function issueWebUrl(host: string, issueKey: string): string {
  return `https://${host}/view/${issueKey}`;
}

/**
 * The project key an issue key carries: `issueKey` is `<projectKey>-<number>`,
 * so trimming at its last `-` spares the Get Project call a `channelName`
 * would otherwise cost (docs/specs/adapter.md §7.3).
 */
function projectKeyOf(issueKey: string): string {
  const lastDash = issueKey.lastIndexOf('-');
  return lastDash === -1 ? issueKey : issueKey.slice(0, lastDash);
}

export function createIssueSubjectClient(
  api: BacklogApi,
  ref: IssueRef,
  context: SubjectContext
): SubjectClient {
  const { host } = context;
  const { issueId } = ref;

  async function downloadAttachment(attachmentId: number): Promise<Buffer> {
    const file = await api.downloadAttachment(issueId, attachmentId);
    return file.data;
  }

  function rootOf(issue: BacklogIssue): SubjectRoot {
    return {
      ref,
      title: issue.summary,
      body: issue.description,
      status: issue.status,
      assignee: issue.assignee,
      createdUser: issue.createdUser,
      created: issue.created,
      updated: issue.updated,
      source: { kind: 'issue', issue },
    };
  }

  return {
    ref,
    capabilities: { deleteComment: true },

    async fetchRoot(): Promise<SubjectRoot> {
      return rootOf(await api.getIssue(issueId));
    },

    rootFrom(raw: BacklogRawMessage): SubjectRoot | undefined {
      // A `webhook` or `comment` raw names its subject without carrying it,
      // and a `pullRequest` raw is another subject's root, so both are a read
      // the caller still has to spend.
      return raw.kind === 'issue' ? rootOf(fromRawIssue(raw.issue)) : undefined;
    },

    listComments(options: ListCommentsOptions): Promise<BacklogComment[]> {
      return api.listComments(issueId, options);
    },

    getComment(commentId: number): Promise<BacklogComment> {
      return api.getComment(issueId, commentId);
    },

    addComment(input: AddCommentInput): Promise<BacklogComment> {
      return api.addComment(issueId, input);
    },

    updateComment(commentId: number, content: string): Promise<BacklogComment> {
      return api.updateComment(issueId, commentId, content);
    },

    async deleteComment(commentId: number): Promise<void> {
      // Delete Comment answers 200 with the deleted comment
      // (`.claude/rules/backlog-api-facts.md`); the body says nothing a caller
      // of `deleteMessage` can use, so it is discarded rather than widening
      // the interface with a value only one kind could ever return.
      await api.deleteComment(issueId, commentId);
    },

    starTarget(commentId: number): StarTarget {
      return { commentId };
    },

    rootRaw(root: SubjectRoot): BacklogRawMessage {
      return {
        kind: 'issue',
        host,
        issue: toRawIssue(issueOf(root)),
        changes: [],
      };
    },

    commentAttachments(comment: BacklogComment): Attachment[] {
      const attachments: Attachment[] = [];
      for (const change of comment.changeLog) {
        // A removal names the file in `originalValue` (`oldValue` here) and
        // leaves `newValue` null; it is skipped because it names a file that
        // is no longer on the issue. `size` stays unset: a changelog entry
        // does not carry one, only the webhook payload does.
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
        // Spread rather than `size: attachment.size`: a payload that omits
        // `size` (§5.2) has to leave the key unset, which is not the same as
        // setting it to `undefined` under `exactOptionalPropertyTypes`.
        ...(attachment.size === undefined ? {} : { size: attachment.size }),
        url: issueAttachmentUrl(host, issueId, attachment.id),
        fetchData: () => downloadAttachment(attachment.id),
      };
    },

    /**
     * Nothing, on every entry: an issue webhook carries no
     * `changes[field="attachment"]` at all. An attachment add arrives as a
     * type-2 changelog comment whose change is visible only in that comment's
     * REST `changeLog` (measured 2026-08,
     * `.claude/rules/backlog-webhook-facts.md`), which is why §6.6's issue row
     * names the REST source and no webhook one — the file is not missing here,
     * it was never in the payload.
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
        issueId,
        issueKey: issue.issueKey,
        projectId: context.projectId,
        summary: issue.summary,
        description: issue.description,
        status: issue.status,
        assignee:
          issue.assignee === null
            ? null
            : { id: issue.assignee.id, name: issue.assignee.name },
        issueType: issue.issueType,
        priority: issue.priority,
        createdUserId: issue.createdUser.id,
        created: issue.created,
        updated: issue.updated,
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

    notificationCommentId(
      notification: BacklogNotification
    ): number | undefined {
      return notification.comment?.id;
    },
  };
}
