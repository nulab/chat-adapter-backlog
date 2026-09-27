/**
 * Attachment URLs, both directions (docs/specs/adapter.md §6.6). An inbound
 * `Attachment` carries an authenticated API URL as its only serialisable
 * handle, and `rehydrateAttachment` has to read that URL back after a queue
 * round trip, so a builder and the pattern that parses it are declared side by
 * side here: they are one grammar, and a builder that drifted from its pattern
 * would silently cost every rehydrated attachment its `fetchData`.
 *
 * Both pairs live in this file rather than one in each subject module because
 * `parseAttachmentPath` must try them in order and knows no kind — a third
 * kind is one more entry in `ATTACHMENT_PATHS`, not a new branch.
 */

import type { BacklogApi } from '../client/port';

export function issueAttachmentUrl(
  host: string,
  issueId: number,
  attachmentId: number
): string {
  return `https://${host}/api/v2/issues/${issueId}/attachments/${attachmentId}`;
}

export function pullRequestAttachmentUrl(
  host: string,
  projectId: number,
  repositoryId: number,
  number: number,
  attachmentId: number
): string {
  return `https://${host}/api/v2/projects/${projectId}/git/repositories/${repositoryId}/pullRequests/${number}/attachments/${attachmentId}`;
}

/**
 * Built by the entry that recognised the path, rather than derived from a
 * subject afterwards, so rehydration reaches the right endpoint without a
 * second place in `src/` asking what kind a subject is.
 */
export type AttachmentDownload = (api: BacklogApi) => Promise<Buffer>;

interface AttachmentPath {
  pattern: RegExp;
  /** Receives the pattern's captures, in order, as the positive integers it matched. */
  build: (...captures: number[]) => AttachmentDownload;
}

const ATTACHMENT_PATHS: readonly AttachmentPath[] = [
  {
    pattern: /^\/api\/v2\/issues\/([1-9]\d*)\/attachments\/([1-9]\d*)$/,
    build: (issueId: number, attachmentId: number) => async (api) => {
      const file = await api.downloadAttachment(issueId, attachmentId);
      return file.data;
    },
  },
  {
    pattern:
      /^\/api\/v2\/projects\/([1-9]\d*)\/git\/repositories\/([1-9]\d*)\/pullRequests\/([1-9]\d*)\/attachments\/([1-9]\d*)$/,
    build:
      (
        projectId: number,
        repositoryId: number,
        number: number,
        attachmentId: number
      ) =>
      async (api) => {
        const file = await api.downloadPullRequestAttachment(
          { projectId, repositoryId, number },
          attachmentId
        );
        return file.data;
      },
  },
];

/**
 * `null` for any path this adapter did not build, which is what keeps
 * `rehydrateAttachment` from turning an arbitrary URL into an authenticated
 * download.
 */
export function parseAttachmentPath(
  pathname: string
): AttachmentDownload | null {
  for (const { pattern, build } of ATTACHMENT_PATHS) {
    const match = pattern.exec(pathname);
    if (match === null) {
      continue;
    }
    return build(...match.slice(1).map(Number));
  }
  return null;
}
