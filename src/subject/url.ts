/**
 * A builder and the pattern that parses its URL back sit side by side
 * because they are one grammar: a builder that drifted from its pattern would
 * silently cost every rehydrated attachment its `fetchData`.
 */

import { download } from '../client/responses';

import type { Backlog } from 'backlog-js';

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
export type AttachmentDownload = (client: Backlog) => Promise<Buffer>;

interface AttachmentPath {
  pattern: RegExp;
  /** Receives the pattern's captures, in order, as the positive integers it matched. */
  build: (...captures: number[]) => AttachmentDownload;
}

const ATTACHMENT_PATHS: readonly AttachmentPath[] = [
  {
    pattern: /^\/api\/v2\/issues\/([1-9]\d*)\/attachments\/([1-9]\d*)$/,
    build: (issueId: number, attachmentId: number) => (client) =>
      download(client.getIssueAttachment(issueId, attachmentId)),
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
      (client) =>
        download(
          client.getPullRequestAttachment(
            projectId,
            String(repositoryId),
            number,
            attachmentId
          )
        ),
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
