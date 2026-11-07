import { AdapterError, ResourceNotFoundError } from '@chat-adapter/shared';

import {
  download,
  readGitRepository,
  readProject,
  readPullRequest,
  readPullRequestAttachments,
  readPullRequestComment,
  readPullRequestComments,
} from '../client/responses';
import { pullRequestAttachmentUrl } from './url';

import type { PullRequestAttachment } from '../client/responses';
import type {
  BacklogChange,
  BacklogRawComment,
  BacklogRawMessage,
  BacklogRawPullRequest,
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

type PullRequestSubjectRef = Extract<
  BacklogSubjectRef,
  { kind: 'pullRequest' }
>;

/**
 * Names are not unique on a pull request and the list is the only id
 * source, so the newest entry carrying the name is the one the comment being
 * read added; a tie goes to the larger id, the later upload (D-PR10).
 */
function newestNamed(
  attachments: readonly PullRequestAttachment[],
  name: string
): PullRequestAttachment | undefined {
  let newest: PullRequestAttachment | undefined;
  for (const attachment of attachments) {
    if (attachment.name !== name) {
      continue;
    }
    const created = Date.parse(attachment.created);
    const newestCreated =
      newest === undefined ? -Infinity : Date.parse(newest.created);
    if (
      newest === undefined ||
      created > newestCreated ||
      (created === newestCreated && attachment.id > newest.id)
    ) {
      newest = attachment;
    }
  }
  return newest;
}

export function createPullRequestSubjectClient(
  client: Backlog,
  ref: PullRequestSubjectRef,
  context: SubjectContext
): SubjectClient {
  const { host, projectId } = context;
  const repositoryId = String(ref.repositoryId);
  const { number } = ref;

  function downloadAttachment(attachmentId: number): Promise<Buffer> {
    return download(
      client.getPullRequestAttachment(
        projectId,
        repositoryId,
        number,
        attachmentId
      )
    );
  }

  async function downloadNamed(name: string): Promise<Buffer> {
    const attachments = await readPullRequestAttachments(
      client.getPullRequestAttachments(projectId, repositoryId, number)
    );
    const attachment = newestNamed(attachments, name);
    if (attachment === undefined) {
      throw new ResourceNotFoundError('backlog', 'pullRequestAttachment', name);
    }
    return downloadAttachment(attachment.id);
  }

  /**
   * Neither a comment's `changeLog` nor a type-20 delivery's `changes[]`
   * holds an attachment id (measured), so there is no `url` to build, and
   * the list call that could find one waits in `fetchData`: resolving it
   * eagerly would spend a read per comment on every page of
   * `fetchMessages` (D-PR10).
   */
  function namedAttachment(name: string): Attachment {
    return { type: 'file', name, fetchData: () => downloadNamed(name) };
  }

  /**
   * The two names the web URL needs and the REST object lacks, read on every
   * root rather than cached (D-PR11). The URL form is the one a star's `url`
   * carries (measured).
   */
  async function rootOf(
    pullRequest: BacklogRawPullRequest
  ): Promise<SubjectRoot> {
    const [project, repository] = await Promise.all([
      readProject(client.getProject(projectId)),
      readGitRepository(client.getGitRepository(projectId, repositoryId)),
    ]);
    const url = `https://${host}/git/${project.projectKey}/${repository.name}/pullRequests/${number}`;
    return {
      ref,
      title: pullRequest.summary,
      body: pullRequest.description,
      status: pullRequest.status,
      assignee: pullRequest.assignee,
      createdUser: pullRequest.createdUser,
      created: pullRequest.created,
      raw: { kind: 'pullRequest', host, pullRequest, changes: [] },
      channelName: project.projectKey,
      threadMetadata: {
        kind: 'pullRequest',
        host,
        projectId,
        repositoryId: ref.repositoryId,
        number,
        summary: pullRequest.summary,
        status: { id: pullRequest.status.id, name: pullRequest.status.name },
        url,
      },
      subject: {
        type: 'pull_request',
        raw: pullRequest,
        labels: [
          pullRequest.status.name,
          `${pullRequest.base} ← ${pullRequest.branch}`,
        ],
        url,
      },
    };
  }

  function listComments(
    options: ListCommentsOptions
  ): Promise<BacklogRawComment[]> {
    return readPullRequestComments(
      client.getPullRequestComments(projectId, repositoryId, number, options)
    );
  }

  return {
    ref,

    async fetchRoot(): Promise<SubjectRoot> {
      return await rootOf(
        await readPullRequest(
          client.getPullRequest(projectId, repositoryId, number)
        )
      );
    },

    async rootFrom(raw: BacklogRawMessage): Promise<SubjectRoot | undefined> {
      return raw.kind === 'pullRequest' ? rootOf(raw.pullRequest) : undefined;
    },

    listComments,

    /**
     * Backlog has no Get Pull Request Comment (the route answers 400 with
     * code 6), so a single comment is a list window the exclusive bounds
     * narrow to that id (measured). Anything else the window returns is
     * somebody else's comment, not this one.
     */
    async getComment(commentId: number): Promise<BacklogRawComment> {
      const [comment] = await listComments({
        minId: commentId - 1,
        maxId: commentId + 1,
        count: 1,
        order: 'desc',
      });
      if (comment === undefined || comment.id !== commentId) {
        throw new ResourceNotFoundError(
          'backlog',
          'pullRequestComment',
          String(commentId)
        );
      }
      return comment;
    },

    addComment(input: AddCommentInput): Promise<BacklogRawComment> {
      // `attachmentId[]` is accepted (documented and measured) although
      // `backlog-js` leaves it out of this endpoint's parameter type, which
      // a variable rather than a literal lets through.
      const params: Option.PullRequest.PostPullRequestCommentsParams = input;
      return readPullRequestComment(
        client.postPullRequestComments(projectId, repositoryId, number, params)
      );
    },

    updateComment(
      commentId: number,
      content: string
    ): Promise<BacklogRawComment> {
      return readPullRequestComment(
        client.patchPullRequestComments(
          projectId,
          repositoryId,
          number,
          commentId,
          { content }
        )
      );
    },

    /**
     * The endpoint does not exist (400/6, measured), so this fails before any
     * request (D-PR3). `AdapterError` rather than `ValidationError`: the call
     * is well-formed, and the platform is what makes it impossible.
     */
    deleteComment(_commentId: number): Promise<void> {
      return Promise.reject(
        new AdapterError(
          'Backlog has no endpoint to delete a pull request comment',
          'backlog',
          'UNSUPPORTED_OPERATION'
        )
      );
    },

    starTarget(commentId: number): Option.Project.PostStarParams {
      return { pullRequestCommentId: commentId };
    },

    commentAttachments(comment: BacklogRawComment): Attachment[] {
      return comment.changeLog.flatMap((change) =>
        change.field === 'attachment' && change.newValue !== null
          ? [namedAttachment(change.newValue)]
          : []
      );
    },

    webhookAttachment(attachment: WebhookAttachment): Attachment {
      return {
        type: 'file',
        name: attachment.name,
        ...(attachment.size === undefined ? {} : { size: attachment.size }),
        url: pullRequestAttachmentUrl(
          host,
          projectId,
          ref.repositoryId,
          number,
          attachment.id
        ),
        fetchData: () => downloadAttachment(attachment.id),
      };
    },

    /**
     * A comment posted with `attachmentId[]` arrives as type 20 with
     * `changes[{ field: "attachment", new_value: "<name>" }]` and no
     * `content.attachments` (measured), so it resolves through the same name
     * lookup as the REST `changeLog` of the same comment.
     */
    webhookChangeAttachment(change: BacklogChange): Attachment | undefined {
      return change.newValue === null
        ? undefined
        : namedAttachment(change.newValue);
    },
  };
}
