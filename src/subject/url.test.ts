import { describe, expect, it, vi } from 'vitest';

import { REST, fileData, stubClient } from '../test/fixtures/rest';
import {
  issueAttachmentUrl,
  parseAttachmentPath,
  pullRequestAttachmentUrl,
} from './url';

import type { AttachmentDownload } from './url';

const ATTACHMENT_ID = 4242;

function downloadOf(url: string): AttachmentDownload {
  const download = parseAttachmentPath(new URL(url).pathname);
  if (download === null) {
    throw new Error(`expected ${url} to parse as an attachment path`);
  }
  return download;
}

describe('attachment urls', () => {
  it('addresses an issue attachment by the issue id alone', () => {
    expect(issueAttachmentUrl(REST.host, REST.issueId, ATTACHMENT_ID)).toBe(
      'https://example.backlog.com/api/v2/issues/8001/attachments/4242'
    );
  });

  it('addresses a pull request attachment by project, repository and number', () => {
    expect(
      pullRequestAttachmentUrl(
        REST.host,
        REST.projectId,
        REST.repositoryId,
        REST.pullRequestNumber,
        ATTACHMENT_ID
      )
    ).toBe(
      'https://example.backlog.com/api/v2/projects/500/git/repositories/700/pullRequests/12/attachments/4242'
    );
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
  ])('%s is not an attachment path', (_name, pathname) => {
    expect(parseAttachmentPath(pathname)).toBeNull();
  });

  it('an issue attachment url downloads through the issue endpoint', async () => {
    const getIssueAttachment = vi.fn().mockResolvedValue(fileData('issue'));
    const download = downloadOf(
      issueAttachmentUrl(REST.host, REST.issueId, ATTACHMENT_ID)
    );

    const data = await download(stubClient({ getIssueAttachment }));

    expect(getIssueAttachment).toHaveBeenCalledWith(
      REST.issueId,
      ATTACHMENT_ID
    );
    expect(data.toString()).toBe('issue');
  });

  it('a pull request attachment url downloads through the pull request endpoint', async () => {
    const getPullRequestAttachment = vi
      .fn()
      .mockResolvedValue(fileData('pull request'));
    const download = downloadOf(
      pullRequestAttachmentUrl(
        REST.host,
        REST.projectId,
        REST.repositoryId,
        REST.pullRequestNumber,
        ATTACHMENT_ID
      )
    );

    const data = await download(stubClient({ getPullRequestAttachment }));

    expect(getPullRequestAttachment).toHaveBeenCalledWith(
      REST.projectId,
      String(REST.repositoryId),
      REST.pullRequestNumber,
      ATTACHMENT_ID
    );
    expect(data.toString()).toBe('pull request');
  });
});
