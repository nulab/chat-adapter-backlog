import { describe, expect, it, vi } from 'vitest';

import {
  downloadAttachmentAt,
  issueAttachmentUrl,
  parseAttachmentPath,
  pullRequestAttachmentUrl,
} from './url';

import type { BacklogApi } from '../client/port';
import type { AttachmentLocation } from './url';

const HOST = 'example.backlog.com';
const PROJECT_ID = 500;
const ISSUE_ID = 8001;
const REPOSITORY_ID = 700;
const PULL_REQUEST_NUMBER = 12;
const ATTACHMENT_ID = 4242;

function pathOf(url: string): string {
  return new URL(url).pathname;
}

function locationOf(url: string): AttachmentLocation {
  const location = parseAttachmentPath(pathOf(url));
  if (location === null) {
    throw new Error(`expected ${url} to parse as an attachment location`);
  }
  return location;
}

describe('attachment urls', () => {
  it('addresses an issue attachment by the issue id alone', () => {
    expect(issueAttachmentUrl(HOST, ISSUE_ID, ATTACHMENT_ID)).toBe(
      'https://example.backlog.com/api/v2/issues/8001/attachments/4242'
    );
  });

  it('addresses a pull request attachment by project, repository and number', () => {
    expect(
      pullRequestAttachmentUrl(
        HOST,
        PROJECT_ID,
        REPOSITORY_ID,
        PULL_REQUEST_NUMBER,
        ATTACHMENT_ID
      )
    ).toBe(
      'https://example.backlog.com/api/v2/projects/500/git/repositories/700/pullRequests/12/attachments/4242'
    );
  });

  it('both attachment url shapes parse back to the subject they name', () => {
    expect(
      parseAttachmentPath(
        pathOf(issueAttachmentUrl(HOST, ISSUE_ID, ATTACHMENT_ID))
      )
    ).toMatchObject({
      projectId: undefined,
      subject: { kind: 'issue', issueId: ISSUE_ID },
      attachmentId: ATTACHMENT_ID,
    });

    expect(
      parseAttachmentPath(
        pathOf(
          pullRequestAttachmentUrl(
            HOST,
            PROJECT_ID,
            REPOSITORY_ID,
            PULL_REQUEST_NUMBER,
            ATTACHMENT_ID
          )
        )
      )
    ).toMatchObject({
      projectId: PROJECT_ID,
      subject: {
        kind: 'pullRequest',
        repositoryId: REPOSITORY_ID,
        number: PULL_REQUEST_NUMBER,
      },
      attachmentId: ATTACHMENT_ID,
    });
  });

  it.each([
    ['a path from another product', '/api/v2/wikis/1/attachments/2'],
    ['a zero id', '/api/v2/issues/0/attachments/2'],
    ['a non-numeric id', '/api/v2/issues/PROJECT-42/attachments/2'],
    ['a trailing segment', '/api/v2/issues/8001/attachments/2/data'],
    ['a missing api prefix', '/issues/8001/attachments/2'],
    [
      'a pull request path without its repository',
      '/api/v2/projects/500/git/pullRequests/12/attachments/2',
    ],
  ])('%s is not an attachment location', (_name, pathname) => {
    expect(parseAttachmentPath(pathname)).toBeNull();
  });

  it('an issue location downloads through the issue endpoint', async () => {
    const downloadAttachment = vi.fn().mockResolvedValue({
      filename: 'notes.txt',
      contentType: 'text/plain',
      data: Buffer.from('issue'),
    });
    const location = locationOf(
      issueAttachmentUrl(HOST, ISSUE_ID, ATTACHMENT_ID)
    );

    const data = await downloadAttachmentAt(
      { downloadAttachment } as unknown as BacklogApi,
      location
    );

    expect(downloadAttachment).toHaveBeenCalledWith(ISSUE_ID, ATTACHMENT_ID);
    expect(data.toString()).toBe('issue');
  });

  it('a pull request location downloads through the pull request endpoint', async () => {
    const downloadPullRequestAttachment = vi.fn().mockResolvedValue({
      filename: 'diff.patch',
      contentType: 'text/plain',
      data: Buffer.from('pull request'),
    });
    const location = locationOf(
      pullRequestAttachmentUrl(
        HOST,
        PROJECT_ID,
        REPOSITORY_ID,
        PULL_REQUEST_NUMBER,
        ATTACHMENT_ID
      )
    );

    const data = await downloadAttachmentAt(
      { downloadPullRequestAttachment } as unknown as BacklogApi,
      location
    );

    expect(downloadPullRequestAttachment).toHaveBeenCalledWith(
      {
        projectId: PROJECT_ID,
        repositoryId: REPOSITORY_ID,
        number: PULL_REQUEST_NUMBER,
      },
      ATTACHMENT_ID
    );
    expect(data.toString()).toBe('pull request');
  });
});
