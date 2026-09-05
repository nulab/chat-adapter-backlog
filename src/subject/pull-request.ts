/**
 * The pull-request half of the subject layer
 * (docs/plans/pull-request-support.md §3.4). Every difference from an issue is
 * a measured Backlog fact, not a design choice: three-coordinate addressing,
 * no Get Pull Request Comment, no Delete Pull Request Comment, and comment
 * attachments that carry a name but no id
 * (`.claude/rules/backlog-pull-request-facts.md`, measured 2026-09-06).
 */

import { AdapterError, ResourceNotFoundError } from '@chat-adapter/shared';

import { fromRawPullRequest, toRawPullRequest } from './raw';
import { pullRequestAttachmentUrl } from './url';

import type {
  AddCommentInput,
  BacklogApi,
  BacklogComment,
  BacklogNotification,
  BacklogPullRequest,
  BacklogPullRequestAttachment,
  ListCommentsOptions,
  PullRequestRef,
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

type PullRequestSubjectRef = Extract<
  BacklogSubjectRef,
  { kind: 'pullRequest' }
>;

/** See `issueOf` in `./issue.ts`: the mismatched arm is unreachable through `subjectClientFor`. */
function pullRequestOf(root: SubjectRoot): BacklogPullRequest {
  if (root.source.kind !== 'pullRequest') {
    throw new AdapterError(
      'an issue root was passed to the pull request subject client',
      'backlog',
      'INVALID_SUBJECT_ROOT'
    );
  }
  return root.source.pullRequest;
}

/**
 * The attachment a `changeLog` name resolves to: the **newest** entry
 * carrying that name (D-PR10). Names are not unique on a pull request and the
 * list is the only id source, so "newest wins" is the only rule that picks the
 * file the comment being read actually added; ties fall back to the larger id,
 * which is the later upload.
 */
function newestNamed(
  attachments: readonly BacklogPullRequestAttachment[],
  name: string
): BacklogPullRequestAttachment | undefined {
  let newest: BacklogPullRequestAttachment | undefined;
  for (const attachment of attachments) {
    if (attachment.name !== name) {
      continue;
    }
    if (
      newest === undefined ||
      attachment.created.getTime() > newest.created.getTime() ||
      (attachment.created.getTime() === newest.created.getTime() &&
        attachment.id > newest.id)
    ) {
      newest = attachment;
    }
  }
  return newest;
}

export function createPullRequestSubjectClient(
  api: BacklogApi,
  ref: PullRequestSubjectRef,
  context: SubjectContext
): SubjectClient {
  const { host } = context;
  const pullRequestRef: PullRequestRef = {
    projectId: context.projectId,
    repositoryId: ref.repositoryId,
    number: ref.number,
  };

  async function downloadAttachment(attachmentId: number): Promise<Buffer> {
    const file = await api.downloadPullRequestAttachment(
      pullRequestRef,
      attachmentId
    );
    return file.data;
  }

  async function downloadNamed(name: string): Promise<Buffer> {
    const attachments = await api.listPullRequestAttachments(pullRequestRef);
    const attachment = newestNamed(attachments, name);
    if (attachment === undefined) {
      throw new ResourceNotFoundError('backlog', 'pullRequestAttachment', name);
    }
    return downloadAttachment(attachment.id);
  }

  /**
   * The `Attachment` a file **name** stands for, which is all a pull request
   * ever carries: neither a comment's `changeLog` nor a type-20 activity's
   * `changes[]` holds an id (measured 2026-09-06), so there is no `url` to
   * build here and the list call that could find one is deferred into
   * `fetchData` — eager resolution would spend a read per comment on every
   * page of `fetchMessages`, and a name matching nothing is a failure only
   * the reader of that file should see (D-PR10).
   */
  function namedAttachment(name: string): Attachment {
    return {
      type: 'file',
      name,
      fetchData: () => downloadNamed(name),
    };
  }

  /**
   * `https://<host>/git/<projectKey>/<repositoryName>/pullRequests/<number>`,
   * the form a star's `url` carries (measured 2026-09-06). Both names come
   * from outside: the pull request object carries neither, and a lookup that
   * failed leaves the thread without a URL rather than failing the read
   * (docs/specs/adapter.md §7.3).
   */
  function webUrl(names: SubjectNames): string | undefined {
    const { projectKey, repositoryName } = names;
    if (projectKey === undefined || repositoryName === undefined) {
      return undefined;
    }
    return `https://${host}/git/${projectKey}/${repositoryName}/pullRequests/${ref.number}`;
  }

  function rootOf(pullRequest: BacklogPullRequest): SubjectRoot {
    return {
      ref,
      title: pullRequest.summary,
      body: pullRequest.description,
      status: pullRequest.status,
      assignee: pullRequest.assignee,
      createdUser: pullRequest.createdUser,
      created: pullRequest.created,
      updated: pullRequest.updated,
      source: { kind: 'pullRequest', pullRequest },
    };
  }

  return {
    ref,
    capabilities: { deleteComment: false },

    async fetchRoot(): Promise<SubjectRoot> {
      return rootOf(await api.getPullRequest(pullRequestRef));
    },

    rootFrom(raw: BacklogRawMessage): SubjectRoot | undefined {
      // See `rootFrom` in `./issue.ts`: every other variant is a read the
      // caller still has to spend.
      return raw.kind === 'pullRequest'
        ? rootOf(fromRawPullRequest(raw.pullRequest))
        : undefined;
    },

    listComments(options: ListCommentsOptions): Promise<BacklogComment[]> {
      return api.listPullRequestComments(pullRequestRef, options);
    },

    /**
     * Backlog has no Get Pull Request Comment — the route answers 400 with
     * error code 6 `Undefined resource` — so a single comment is one list call
     * through a window the exclusive `minId`/`maxId` bounds narrow to exactly
     * that id (measured 2026-09-06).
     */
    async getComment(commentId: number): Promise<BacklogComment> {
      const page = await api.listPullRequestComments(pullRequestRef, {
        minId: commentId - 1,
        maxId: commentId + 1,
        count: 1,
        order: 'desc',
      });
      const comment = page[0];
      // An element whose id differs is not found rather than returned: the
      // window is meant to hold one comment, and trusting whatever came back
      // would hand the caller somebody else's comment under the id it asked
      // for.
      if (comment === undefined || comment.id !== commentId) {
        throw new ResourceNotFoundError(
          'backlog',
          'pullRequestComment',
          String(commentId)
        );
      }
      return comment;
    },

    addComment(input: AddCommentInput): Promise<BacklogComment> {
      return api.addPullRequestComment(pullRequestRef, input);
    },

    updateComment(commentId: number, content: string): Promise<BacklogComment> {
      return api.updatePullRequestComment(pullRequestRef, commentId, content);
    },

    /**
     * D-PR3: the endpoint does not exist (400/6 `Undefined resource`,
     * measured 2026-09-06), so this fails before any request. `AdapterError`
     * rather than `ValidationError` because the call is well-formed — the
     * platform, not the caller, is what makes it impossible.
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

    starTarget(commentId: number): StarTarget {
      return { pullRequestCommentId: commentId };
    },

    rootRaw(root: SubjectRoot): BacklogRawMessage {
      return {
        kind: 'pullRequest',
        host,
        pullRequest: toRawPullRequest(pullRequestOf(root)),
        changes: [],
      };
    },

    commentAttachments(comment: BacklogComment): Attachment[] {
      const attachments: Attachment[] = [];
      for (const change of comment.changeLog) {
        if (change.field !== 'attachment' || change.newValue === null) {
          continue;
        }
        attachments.push(namedAttachment(change.newValue));
      }
      return attachments;
    },

    webhookAttachment(attachment: {
      id: number;
      name: string;
      size: number;
    }): Attachment {
      return {
        type: 'file',
        name: attachment.name,
        size: attachment.size,
        url: pullRequestAttachmentUrl(
          host,
          context.projectId,
          ref.repositoryId,
          ref.number,
          attachment.id
        ),
        fetchData: () => downloadAttachment(attachment.id),
      };
    },

    /**
     * The same file the REST `changeLog` would name, through the same
     * name-resolving builder: a comment posted with `attachmentId[]` arrives
     * as type 20 with `changes[{ field: "attachment", new_value: "<name>" }]`
     * and no `content.attachments` key at all (measured 2026-09-06,
     * `.claude/rules/backlog-pull-request-facts.md`), so the webhook message
     * and the read of the same comment carry the same attachment (§6.6).
     */
    webhookChangeAttachment(change: BacklogChange): Attachment | undefined {
      return change.newValue === null
        ? undefined
        : namedAttachment(change.newValue);
    },

    channelName(_root: SubjectRoot, names: SubjectNames): string | undefined {
      return names.projectKey;
    },

    threadMetadata(
      root: SubjectRoot,
      names: SubjectNames
    ): Record<string, unknown> {
      const pullRequest = pullRequestOf(root);
      const url = webUrl(names);
      return {
        kind: 'pullRequest',
        host,
        projectId: context.projectId,
        repositoryId: ref.repositoryId,
        // Spread rather than assigned: a `repositoryName: undefined` key would
        // read to a consumer as "this pull request has no repository name",
        // while §7.3 says an unresolved name simply omits it.
        ...(names.repositoryName === undefined
          ? {}
          : { repositoryName: names.repositoryName }),
        number: ref.number,
        id: pullRequest.id,
        summary: pullRequest.summary,
        description: pullRequest.description,
        status: pullRequest.status,
        assignee:
          pullRequest.assignee === null
            ? null
            : { id: pullRequest.assignee.id, name: pullRequest.assignee.name },
        base: pullRequest.base,
        branch: pullRequest.branch,
        issue:
          pullRequest.issue === null
            ? null
            : {
                id: pullRequest.issue.id,
                issueKey: pullRequest.issue.issueKey,
              },
        baseCommit: pullRequest.baseCommit,
        branchCommit: pullRequest.branchCommit,
        mergeCommit: pullRequest.mergeCommit,
        closeAt: pullRequest.closeAt,
        mergeAt: pullRequest.mergeAt,
        createdUserId: pullRequest.createdUser.id,
        created: pullRequest.created,
        updated: pullRequest.updated,
        ...(url === undefined ? {} : { url }),
      };
    },

    subjectType: 'pull_request',

    subjectRaw(root: SubjectRoot): unknown {
      return pullRequestOf(root);
    },

    subjectLabels(root: SubjectRoot): string[] {
      const pullRequest = pullRequestOf(root);
      return [
        pullRequest.status.name,
        `${pullRequest.base} ← ${pullRequest.branch}`,
      ];
    },

    webUrl(_root: SubjectRoot, names: SubjectNames): string | undefined {
      return webUrl(names);
    },

    repositoryIdForName: ref.repositoryId,

    notificationCommentId(
      notification: BacklogNotification
    ): number | undefined {
      return notification.pullRequestComment?.id;
    },
  };
}
