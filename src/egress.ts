import { extractFiles, ValidationError } from '@chat-adapter/shared';
import { isCardElement, parseMarkdown, root, toPlainText } from 'chat';
import { z } from 'zod';

import {
  decodeMessageId,
  decodeThreadId,
  encodeMessageId,
  encodeThreadId,
} from './ids';
import { addressesSameSubject } from './reads';
import { toRawComment, toRawIssue } from './subject/raw';

import type { FallbackFormatConverter } from './format/fallback';
import type { SubjectClient } from './subject/client';
import type {
  AddCommentInput,
  BacklogApi,
  BacklogIssue,
  BacklogIssueType,
  BacklogPriority,
  CreateIssueInput,
} from './client/port';
import type { BacklogRawMessage, BacklogSubjectRef } from './types';
import type {
  AdapterPostableMessage,
  Content,
  FileUpload,
  RawMessage,
  Root,
  StreamChunk,
} from 'chat';

/**
 * The comment `messageId` names inside `threadId`, for any operation that maps
 * to a Backlog comment endpoint (docs/specs/adapter.md §6). Two ids in, one
 * set of coordinates out:
 *
 * - A message id naming another host or another subject is a
 *   `ValidationError`. The two ids are independent inputs from the caller and
 *   nothing outside the caller guarantees they agree, so the disagreement is
 *   reported rather than resolved — `fetchMessage` answers the same question
 *   with `null` (§7.2) through the same predicate.
 * - `:r` (the issue or pull-request body) and `:u:` (a fieldchange update with
 *   no comment) are rejected (§6 "Non-comment message ids", D12). Backlog
 *   *can* edit an issue body through a different endpoint, but "edit what the
 *   bot posted" must never silently rewrite a human's issue.
 *
 * The subject travels out from the **thread**, never from the message id, even
 * though the two are now known to agree: §6's preamble picks the subject
 * client the thread id's `subject` selects, and taking it from the message id
 * is what let `deleteMessage` on a pull-request thread reach the issue
 * endpoints and slip past the D-PR3 guard that lives inside the pull-request
 * subject client. It travels whole rather than as the coordinates of one kind,
 * so the caller reaches its `SubjectClient` without re-deriving what it is
 * holding (D-PR2).
 */
export function requireCommentInThread(
  threadId: string,
  messageId: string,
  action: 'edited' | 'deleted' | 'starred'
): {
  host: string;
  projectId: number;
  subject: BacklogSubjectRef;
  commentId: number;
} {
  const thread = decodeThreadId(threadId);
  const decoded = decodeMessageId(messageId);
  if (
    decoded.host !== thread.host ||
    !addressesSameSubject(thread, decoded.subject)
  ) {
    throw new ValidationError(
      'backlog',
      `${messageId} does not name a message in thread ${threadId} and cannot be ${action}`
    );
  }
  if (decoded.part !== 'comment') {
    throw new ValidationError(
      'backlog',
      `${messageId} is not a comment and cannot be ${action}`
    );
  }
  return {
    host: thread.host,
    projectId: thread.projectId,
    subject: thread.subject,
    commentId: decoded.commentId,
  };
}

/**
 * Validates `notifiedUserId` strictly: a present-but-mistyped extra is a
 * `ValidationError` rather than a value silently dropped
 * (docs/specs/adapter.md §3.4). Membership is deliberately not checked here —
 * Backlog itself drops a non-member or nonexistent id without failing the
 * request (measured 2026-08-18, `.claude/rules/backlog-api-facts.md`
 * "`notifiedUserId[]` fails open"), so pre-validating membership would reject
 * requests Backlog would have accepted.
 */
const notifiedUserIdSchema = z.array(z.number().int().positive());

/**
 * The strict schema `postMessage`/`postChannelMessage` read
 * `BacklogPostableExtras` through (docs/specs/adapter.md §3.4). Only
 * `notifiedUserId` is defined for `postMessage`; `.strip()` would silently
 * drop an unknown key, so `.strict()` is used instead to surface a typo as a
 * `ValidationError` rather than a no-op.
 */
const backlogPostableExtrasSchema = z
  .object({
    notifiedUserId: notifiedUserIdSchema.optional(),
  })
  .strict();

/**
 * The strict schema `postChannelMessage` reads `BacklogChannelPostableExtras`
 * through (docs/specs/adapter.md §3.4, §6.7). `.strict()` for the same reason
 * as `backlogPostableExtrasSchema`: a typo'd extra must surface as a
 * `ValidationError`, not a silently ignored field.
 */
const backlogChannelPostableExtrasSchema = z
  .object({
    notifiedUserId: notifiedUserIdSchema.optional(),
    issueTypeId: z.number().int().positive().optional(),
    priorityId: z.number().int().positive().optional(),
    assigneeId: z.number().int().positive().optional(),
  })
  .strict();

/**
 * Reads `BacklogPostableExtras` off a postable with the strict §3.4 schema: a
 * present-but-mistyped `notifiedUserId` is a `ValidationError`, never a
 * silently dropped value. Non-object postables (`string`, an
 * `AsyncIterable`, a `CardElement`) carry no extras.
 */
export function extractNotifiedUserId(
  message: AdapterPostableMessage
): number[] | undefined {
  if (typeof message !== 'object' || message === null) {
    return undefined;
  }
  if (!('notifiedUserId' in message)) {
    return undefined;
  }
  const result = backlogPostableExtrasSchema.safeParse({
    notifiedUserId: (message as { notifiedUserId?: unknown }).notifiedUserId,
  });
  if (!result.success) {
    throw new ValidationError(
      'backlog',
      `notifiedUserId must be an array of positive integers: ${result.error.message}`
    );
  }
  return result.data.notifiedUserId;
}

/**
 * Reads `BacklogChannelPostableExtras` off a postable with the strict §3.4/§6.7
 * schema: a present-but-mistyped `issueTypeId`/`priorityId`/`assigneeId` is a
 * `ValidationError` rather than a value silently dropped, matching
 * `extractNotifiedUserId`'s treatment of `notifiedUserId`.
 */
export function extractChannelExtras(message: AdapterPostableMessage): {
  notifiedUserId?: number[] | undefined;
  issueTypeId?: number | undefined;
  priorityId?: number | undefined;
  assigneeId?: number | undefined;
} {
  if (typeof message !== 'object' || message === null) {
    return {};
  }
  const candidate = message as unknown as Record<string, unknown>;
  const present: Record<string, unknown> = {};
  for (const key of [
    'notifiedUserId',
    'issueTypeId',
    'priorityId',
    'assigneeId',
  ]) {
    if (key in candidate) {
      present[key] = candidate[key];
    }
  }
  const result = backlogChannelPostableExtrasSchema.safeParse(present);
  if (!result.success) {
    throw new ValidationError(
      'backlog',
      `invalid postChannelMessage extras: ${result.error.message}`
    );
  }
  return result.data;
}

/**
 * Collapses a block's text to one line (docs/specs/adapter.md §6.7 "Summary
 * … whitespace collapsed"): a summary is a single Backlog field, so an mdast
 * soft break or a raw newline inside the first block must not survive into
 * it.
 */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * First non-blank line of a plain-text postable (`string`, `{ raw }`), used
 * as the summary when there is no mdast to split into blocks
 * (docs/specs/adapter.md §6.7).
 */
function firstNonBlankLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '');
  return line === undefined ? '' : collapseWhitespace(line);
}

/**
 * Splits an mdast `Root` into its first block (the summary source) and every
 * remaining block (the description source) — docs/specs/adapter.md §6.7
 * "Summary = plain text of the first mdast block … Description = remaining
 * blocks". An empty `Root` (no blocks at all) yields an empty summary, which
 * `createChannelIssue` turns into a `ValidationError`.
 */
function splitFirstBlock(ast: Root): {
  first: Content | undefined;
  rest: Root;
} {
  const [first, ...rest] = ast.children;
  return { first, rest: root(rest) };
}

/**
 * A card's fallback text split into the two Backlog fields: first line as the
 * summary, the rest as the description (docs/specs/adapter.md §6.7).
 *
 * The first line is a *rendered* line — the card's title carries the
 * project's own bold markup — so it goes back through `extractPlainText`
 * before becoming a summary, which §6.7 requires to be plain text under
 * either formatting rule. Reading `card.title` directly would skip that
 * markup but also skip a caller-supplied `fallbackText`, whose first line is
 * the summary the caller asked for.
 */
function fallbackTextToSummaryAndDescription(
  fallbackText: string,
  converter: FallbackFormatConverter
): {
  summary: string;
  description: string;
} {
  const [firstLine, ...restLines] = fallbackText.split('\n');
  return {
    summary: collapseWhitespace(converter.extractPlainText(firstLine ?? '')),
    description: restLines.join('\n').trim(),
  };
}

/**
 * Summary/description for `postChannelMessage` (docs/specs/adapter.md §6.7).
 * Summary is **always plain text**, regardless of the project's formatting
 * rule — Backlog does not render markup in a summary field — so it is
 * produced with `toPlainText`/line-splitting rather than `converter.fromAst`.
 * Description goes through `converter.fromAst` like every other outbound
 * block of content.
 *
 * A card is rendered by `converter.renderPostable` like every other
 * postable, not by `@chat-adapter/shared`'s `cardToFallbackText` directly:
 * the shared helper's `boldFormat` is typed `"*" | "**"`, so no argument to
 * it can produce Backlog notation's `''` and a `backlog` project got literal
 * asterisks around the card's title (#45). `renderPostable` reaches the
 * project's own converter, which knows the rule, and keeps a
 * caller-supplied `fallbackText` winning over a generated one — the same
 * precedence `postMessage` (§6.1) applies.
 */
export function resolveSummaryAndDescription(
  message: AdapterPostableMessage,
  converter: FallbackFormatConverter
): { summary: string; description: string } {
  if (typeof message === 'string') {
    return { summary: firstNonBlankLine(message), description: message };
  }

  if (isCardElement(message) || 'card' in message) {
    return fallbackTextToSummaryAndDescription(
      converter.renderPostable(message),
      converter
    );
  }

  if ('raw' in message) {
    return {
      summary: firstNonBlankLine(message.raw),
      description: message.raw,
    };
  }

  const ast =
    'markdown' in message
      ? parseMarkdown(message.markdown)
      : 'ast' in message
        ? message.ast
        : // A bare `CardElement` (`type: "card"`) is excluded above, so nothing
          // reaches here — `root([])` keeps this branch total rather than
          // asserting the unreachable case away.
          root([]);
  const { first, rest } = splitFirstBlock(ast);
  const summary =
    first === undefined ? '' : collapseWhitespace(toPlainText(root([first])));
  const description = converter.fromAst(rest);
  return { summary, description };
}

export interface CreateChannelIssueInput {
  host: string;
  projectId: number;
  api: BacklogApi;
  converter: FallbackFormatConverter;
  message: AdapterPostableMessage;
  toBuffer: (file: FileUpload) => Promise<Buffer>;
  /**
   * Cached `issueTypeId`/`priorityId` defaults for this project
   * (docs/specs/adapter.md §6.7, D14-style "cache forever, replace on
   * demand"), owned by the adapter so `fetchChannelInfo`-style invalidation
   * and the per-project keying live in one place rather than duplicated
   * across every call site that creates an issue.
   */
  getCachedDefaults: () =>
    | { issueTypeId: number; priorityId: number }
    | undefined;
  setCachedDefaults: (defaults: {
    issueTypeId: number;
    priorityId: number;
  }) => void;
  clearCachedDefaults: () => void;
}

/**
 * Resolves `issueTypeId`/`priorityId` when the caller did not supply them:
 * first of Get Issue Type List, middle of Get Priority List
 * (docs/specs/adapter.md §6.7 — a space-wide `High, Normal, Low` yields
 * `Normal`). An empty list of either is a `ValidationError` rather than a
 * `NoResourceError` reaching Backlog with an undefined id.
 */
async function resolveDefaults(
  api: BacklogApi,
  projectId: number
): Promise<{ issueTypeId: number; priorityId: number }> {
  const [issueTypes, priorities]: [BacklogIssueType[], BacklogPriority[]] =
    await Promise.all([api.listIssueTypes(projectId), api.listPriorities()]);

  const firstIssueType = issueTypes[0];
  if (firstIssueType === undefined) {
    throw new ValidationError(
      'backlog',
      `project ${projectId} has no issue types; postChannelMessage cannot pick a default`
    );
  }
  const middlePriority = priorities[Math.floor(priorities.length / 2)];
  if (middlePriority === undefined) {
    throw new ValidationError(
      'backlog',
      'no priorities are configured for this space; postChannelMessage cannot pick a default'
    );
  }

  return { issueTypeId: firstIssueType.id, priorityId: middlePriority.id };
}

/**
 * `postChannelMessage` (docs/specs/adapter.md §6.7): creates an issue from a
 * channel-level post. The retry is narrow on purpose — only a `code: 7`
 * (`ValidationError`) response to a create that used **cached** defaults is
 * retried, and only once, after refreshing both caches
 * (docs/specs/adapter.md §6.7, CLAUDE.md "The retry rule is narrow"):
 *
 * - An explicit `issueTypeId`/`priorityId` the caller supplied is never
 *   retried — the cache cannot be stale for a value that was never read from
 *   it, so a second identical request would just repeat the caller's own
 *   mistake.
 * - Any other error (a different validation failure, a permission error, a
 *   network failure) is not a signal that the *cache* is stale, so retrying
 *   would not fix it and would spend a second update-bucket call for nothing.
 */
export async function createChannelIssue(
  input: CreateChannelIssueInput
): Promise<RawMessage<BacklogRawMessage>> {
  const {
    host,
    projectId,
    api,
    converter,
    message,
    toBuffer,
    getCachedDefaults,
    setCachedDefaults,
    clearCachedDefaults,
  } = input;

  const { summary, description } = resolveSummaryAndDescription(
    message,
    converter
  );
  if (summary.length === 0) {
    throw new ValidationError(
      'backlog',
      'postChannelMessage requires a non-empty summary'
    );
  }

  const extras = extractChannelExtras(message);
  const files = extractFiles(message);
  const attachmentId =
    files.length > 0 ? await uploadFiles(api, files, toBuffer) : undefined;

  const explicitIssueTypeId = extras.issueTypeId;
  const explicitPriorityId = extras.priorityId;
  const usedCache =
    explicitIssueTypeId === undefined || explicitPriorityId === undefined;

  let cached = getCachedDefaults();
  if (usedCache && cached === undefined) {
    cached = await resolveDefaults(api, projectId);
    setCachedDefaults(cached);
  }

  const buildInput = (defaults: {
    issueTypeId: number;
    priorityId: number;
  }): CreateIssueInput => {
    const createInput: CreateIssueInput = {
      projectId,
      summary,
      issueTypeId: explicitIssueTypeId ?? defaults.issueTypeId,
      priorityId: explicitPriorityId ?? defaults.priorityId,
    };
    if (description.length > 0) {
      createInput.description = description;
    }
    if (extras.assigneeId !== undefined) {
      createInput.assigneeId = extras.assigneeId;
    }
    if (extras.notifiedUserId !== undefined) {
      createInput.notifiedUserId = extras.notifiedUserId;
    }
    if (attachmentId !== undefined) {
      createInput.attachmentId = attachmentId;
    }
    return createInput;
  };

  // `cached` is defined here whenever `usedCache` is true (resolved above);
  // when `usedCache` is false neither field reads it, so the placeholder
  // value below is never actually used to build the request.
  const defaultsForFirstAttempt = cached ?? { issueTypeId: 0, priorityId: 0 };

  let issue: BacklogIssue;
  try {
    issue = await api.createIssue(buildInput(defaultsForFirstAttempt));
  } catch (cause) {
    if (!usedCache || !(cause instanceof ValidationError)) {
      throw cause;
    }
    clearCachedDefaults();
    const refreshed = await resolveDefaults(api, projectId);
    setCachedDefaults(refreshed);
    issue = await api.createIssue(buildInput(refreshed));
  }

  const subject: BacklogSubjectRef = { kind: 'issue', issueId: issue.id };
  return {
    id: encodeMessageId({ host, subject, part: 'root' }),
    threadId: encodeThreadId({ host, projectId, subject }),
    raw: { kind: 'issue', host, issue: toRawIssue(issue), changes: [] },
  };
}

/**
 * Uploads every `extractFiles(message)` entry (docs/specs/adapter.md §6.1
 * step 1). Each upload is awaited in sequence rather than in parallel: a
 * partial failure must abandon only the uploads that already succeeded
 * (Backlog deletes an unattached upload after an hour) without racing a
 * later one that would otherwise still be in flight.
 */
export async function uploadFiles(
  api: BacklogApi,
  files: FileUpload[],
  toBuffer: (file: FileUpload) => Promise<Buffer>
): Promise<number[]> {
  const attachmentIds: number[] = [];
  for (const file of files) {
    const data = await toBuffer(file);
    const uploaded = await api.uploadAttachment(
      file.filename,
      data,
      file.mimeType
    );
    attachmentIds.push(uploaded.id);
  }
  return attachmentIds;
}

export interface PostCommentInput {
  host: string;
  projectId: number;
  subject: SubjectClient;
  /**
   * Only `POST /space/attachment` is reached through the port here: uploading
   * is space-level and has no per-subject endpoint, while the comment itself
   * goes through `subject` so this function has one code path for both kinds.
   */
  api: BacklogApi;
  converter: FallbackFormatConverter;
  message: AdapterPostableMessage;
  toBuffer: (file: FileUpload) => Promise<Buffer>;
}

/**
 * `postMessage` (docs/specs/adapter.md §6.1): upload, render, comment, in
 * that order, so a render failure never spends the update-bucket call and a
 * comment failure never fabricates a return value. The caller's message
 * object is read, never mutated — `content`/`notifiedUserId`/`attachmentId`
 * are assembled into a fresh `AddCommentInput` rather than written back onto
 * `message`.
 */
export async function postComment(
  input: PostCommentInput
): Promise<RawMessage<BacklogRawMessage>> {
  const { host, projectId, subject, api, converter, message, toBuffer } = input;

  const notifiedUserId = extractNotifiedUserId(message);
  const files = extractFiles(message);
  const attachmentId =
    files.length > 0 ? await uploadFiles(api, files, toBuffer) : undefined;

  const content = converter.renderPostable(message);

  const commentInput: AddCommentInput = { content };
  if (notifiedUserId !== undefined) {
    commentInput.notifiedUserId = notifiedUserId;
  }
  if (attachmentId !== undefined) {
    commentInput.attachmentId = attachmentId;
  }

  const comment = await subject.addComment(commentInput);

  return {
    id: encodeMessageId({
      host,
      subject: subject.ref,
      part: 'comment',
      commentId: comment.id,
    }),
    threadId: encodeThreadId({ host, projectId, subject: subject.ref }),
    raw: {
      kind: 'comment',
      host,
      projectId,
      subject: subject.ref,
      comment: toRawComment(comment),
      changes: [],
    },
  };
}

export interface EditCommentInput {
  host: string;
  projectId: number;
  subject: SubjectClient;
  commentId: number;
  converter: FallbackFormatConverter;
  message: AdapterPostableMessage;
}

/**
 * `editMessage` (docs/specs/adapter.md §6.2): Backlog's Update Comment takes
 * `content` only, so files or extras on the edit are a `ValidationError`
 * rather than a silent drop — an edit that appears to accept a file but never
 * attaches it would be a worse surprise than a loud rejection.
 */
export async function editComment(
  input: EditCommentInput
): Promise<RawMessage<BacklogRawMessage>> {
  const { host, projectId, subject, commentId, converter, message } = input;

  if (extractFiles(message).length > 0) {
    throw new ValidationError(
      'backlog',
      'editMessage cannot attach files: Backlog Update Comment accepts content only'
    );
  }
  if (extractNotifiedUserId(message) !== undefined) {
    throw new ValidationError(
      'backlog',
      'editMessage does not accept notifiedUserId: Backlog Update Comment accepts content only'
    );
  }

  const content = converter.renderPostable(message);
  const comment = await subject.updateComment(commentId, content);

  return {
    id: encodeMessageId({
      host,
      subject: subject.ref,
      part: 'comment',
      commentId: comment.id,
    }),
    threadId: encodeThreadId({ host, projectId, subject: subject.ref }),
    raw: {
      kind: 'comment',
      host,
      projectId,
      subject: subject.ref,
      comment: toRawComment(comment),
      changes: [],
    },
  };
}

export interface AddReactionInput {
  api: BacklogApi;
  subject: SubjectClient;
  commentId: number;
  botUserId: number;
}

/**
 * `addReaction` (docs/specs/adapter.md §6.5): the emoji is ignored (Backlog
 * has one star kind). Reads the comment before starring so a second call is
 * a no-op — Backlog allows unlimited stars per user, so without this read
 * every retry or duplicate reaction would add another star.
 */
export async function addReaction(input: AddReactionInput): Promise<void> {
  const { api, subject, commentId, botUserId } = input;
  const comment = await subject.getComment(commentId);
  const alreadyStarred = comment.stars.some(
    (star) => star.presenter.id === botUserId
  );
  if (alreadyStarred) {
    return;
  }
  await api.addStar(subject.starTarget(commentId));
}

export interface RemoveReactionInput {
  api: BacklogApi;
  subject: SubjectClient;
  commentId: number;
  botUserId: number;
}

/**
 * `removeReaction` (docs/specs/adapter.md §6.5): deletes every star the bot
 * itself presented on the comment, never another user's — the comment is
 * re-read for its current stars rather than trusting a prior snapshot, since
 * `deleteStar` addresses stars individually by id.
 */
export async function removeReaction(
  input: RemoveReactionInput
): Promise<void> {
  const { api, subject, commentId, botUserId } = input;
  const comment = await subject.getComment(commentId);
  const ownStars = comment.stars.filter(
    (star) => star.presenter.id === botUserId
  );
  for (const star of ownStars) {
    await api.deleteStar(star.id);
  }
}

const STREAM_ABORTED = Symbol('stream aborted');

interface AbortRace {
  /** Settles with {@link STREAM_ABORTED} the moment the signal aborts. */
  readonly aborted: Promise<typeof STREAM_ABORTED>;
  dispose: () => void;
}

function raceAbort(signal: AbortSignal | undefined): AbortRace | undefined {
  // No signal, no race: a stand-in promise that never settles would collect
  // one `Promise.race` reaction per chunk for the whole stream, and the
  // signal-less call is the ordinary one.
  if (signal === undefined) {
    return undefined;
  }
  let remove = (): void => undefined;
  const aborted = new Promise<typeof STREAM_ABORTED>((resolve) => {
    const onAbort = (): void => resolve(STREAM_ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    remove = () => {
      signal.removeEventListener('abort', onAbort);
    };
  });
  return { aborted, dispose: () => remove() };
}

/**
 * Buffers a `stream()` textStream into one string (docs/specs/adapter.md
 * §6.4, D4, CLAUDE.md "`stream()` must be overridden"): concatenates `string`
 * chunks and `markdown_text` chunks, ignores `task_update`/`plan_update`.
 * Consumption stops when `signal` aborts, returning whatever was buffered so
 * far — never throwing — because an abort must still produce the "post what
 * we have" behaviour §6.4 requires, not a rejection that skips posting
 * entirely.
 */
export async function bufferStream(
  textStream: AsyncIterable<string | StreamChunk>,
  signal: AbortSignal | undefined
): Promise<string> {
  let buffered = '';
  // Driven by hand rather than with `for await`, whose `break` can only run
  // between iterations: a source that stalls — a model that stopped
  // generating, a socket that hung — never delivers the chunk that would let
  // the loop look at `signal` again, so an abort would never be observed and
  // `stream()` would never resolve.
  const iterator = textStream[Symbol.asyncIterator]();
  const abort = raceAbort(signal);
  let exhausted = false;
  try {
    while (signal?.aborted !== true) {
      const pending = iterator.next();
      const step =
        abort === undefined
          ? await pending
          : await Promise.race([pending, abort.aborted]);
      if (step === STREAM_ABORTED) {
        // The abandoned `next()` can still reject once nobody is reading it,
        // and an unobserved rejection takes the host process down under
        // Node's default `--unhandled-rejections=throw`.
        void pending.catch(() => undefined);
        break;
      }
      if (step.done === true) {
        exhausted = true;
        break;
      }
      const chunk = step.value;
      if (typeof chunk === 'string') {
        buffered += chunk;
      } else if (chunk.type === 'markdown_text') {
        buffered += chunk.text;
      }
      // `task_update` and `plan_update` chunks carry no text (§6.4) and are
      // ignored.
    }
  } finally {
    abort?.dispose();
    if (!exhausted) {
      // Told to clean up, but not waited for: a generator suspended inside an
      // await that never settles returns a `return()` promise that never
      // settles either, which is the stall this function exists to escape.
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
  }
  return buffered;
}
