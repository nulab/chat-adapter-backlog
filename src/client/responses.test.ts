import {
  AdapterError,
  NetworkError,
  ResourceNotFoundError,
} from '@chat-adapter/shared';
import { describe, expect, it } from 'vite-plus/test';
import { ZodError } from 'zod';

import {
  ALICE,
  comment,
  fileData,
  issue,
  issueComment,
  pullRequest,
  star,
  user,
} from '../test/fixtures/rest';
import {
  download,
  readIssue,
  readIssueComments,
  readPullRequest,
  readPullRequestComment,
  readUser,
} from './responses';

function without<T extends object>(value: T, key: keyof T): unknown {
  const copy: Partial<T> = { ...value };
  delete copy[key];
  return copy;
}

describe('reading a response', () => {
  it('rejects a response violating the schema with AdapterError code SCHEMA, never a ZodError', async () => {
    const error: unknown = await readIssue(
      Promise.resolve({ ...issue(), id: 'not a number' })
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AdapterError);
    expect(error).not.toBeInstanceOf(ZodError);
    expect((error as AdapterError).code).toBe('SCHEMA');
  });

  it('keeps keys the schema does not name', async () => {
    const parsed = await readIssue(
      Promise.resolve({ ...issue(), futureField: 'kept' })
    );

    expect(parsed).toMatchObject({ futureField: 'kept' });
  });

  it('turns a non-JSON 2xx body into NetworkError', async () => {
    await expect(
      readIssue(Promise.reject(new SyntaxError('Unexpected token <')))
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('passes an AdapterError from the request through unchanged', async () => {
    const notFound = new ResourceNotFoundError('backlog', 'resource');

    await expect(readIssue(Promise.reject(notFound))).rejects.toBe(notFound);
  });

  it.each([null, undefined])(
    'reads a %s issue description as an empty string',
    async (description) => {
      const parsed = await readIssue(
        Promise.resolve({ ...issue(), description })
      );

      expect(parsed.description).toBe('');
    }
  );

  it('reads an absent pull request assignee as null', async () => {
    const unassigned = without(pullRequest(), 'assignee');

    const parsed = await readPullRequest(Promise.resolve(unassigned));

    expect(parsed).toMatchObject({ assignee: null });
  });

  it('reads an absent userId as null', async () => {
    const withoutUserId = without(user(), 'userId');

    const parsed = await readUser(Promise.resolve(withoutUserId));

    expect(parsed).toMatchObject({ userId: null });
  });

  it('keeps the null userId of a user who signs in with a Nulab account', async () => {
    const parsed = await readUser(Promise.resolve({ ...user(), userId: null }));

    expect(parsed.userId).toBeNull();
  });

  it('reads an absent mail address as null', async () => {
    const hidden = without(user(), 'mailAddress');

    const parsed = await readUser(Promise.resolve(hidden));

    expect(parsed).toMatchObject({ mailAddress: null });
  });
});

describe('comments', () => {
  it('reads a null changeLog and null stars as empty lists', async () => {
    const parsed = await readPullRequestComment(
      Promise.resolve({ ...comment(), changeLog: null, stars: null })
    );

    expect(parsed.changeLog).toEqual([]);
    expect(parsed.stars).toEqual([]);
  });

  it('reads an absent attachmentInfo on a change as null', async () => {
    const parsed = await readPullRequestComment(
      Promise.resolve({
        ...comment(),
        changeLog: [{ field: 'status', newValue: '2', originalValue: '1' }],
      })
    );

    expect(parsed.changeLog[0]?.attachmentInfo).toBeNull();
  });

  it('keeps a star whose comment is null', async () => {
    const parsed = await readPullRequestComment(
      Promise.resolve({ ...comment(), stars: [star(ALICE)] })
    );

    expect(parsed.stars).toEqual([star(ALICE)]);
    expect(parsed.stars[0]?.comment).toBeNull();
  });
});

describe('reading a list', () => {
  it('rejects a list with one invalid element as a whole', async () => {
    await expect(
      readIssueComments(
        Promise.resolve([issueComment(), { ...issueComment(), content: 7 }])
      )
    ).rejects.toMatchObject({ code: 'SCHEMA' });
  });
});

describe('download', () => {
  it('returns the bytes of the body', async () => {
    const bytes = await download(Promise.resolve(fileData('file bytes')));

    expect(bytes.toString('utf8')).toBe('file bytes');
  });

  it('turns a body-read failure into NetworkError', async () => {
    const failing = new ReadableStream({
      pull(controller) {
        controller.error(new DOMException('Aborted', 'AbortError'));
      },
    });

    await expect(
      download(Promise.resolve({ ...fileData(''), body: failing }))
    ).rejects.toBeInstanceOf(NetworkError);
  });
});
