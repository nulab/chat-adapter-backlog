import {
  cardToFallbackText,
  extractFiles,
  ValidationError,
} from '@chat-adapter/shared';
import { parseMarkdown, root, toPlainText } from 'chat';

import { decodeMessageId, encodeMessageId } from './ids';
import { toRawIssue } from './reads';
import {
  backlogChannelPostableExtrasSchema,
  backlogPostableExtrasSchema,
} from './types';

import type { FallbackFormatConverter } from './format/fallback';
import type {
  AddCommentInput,
  BacklogApi,
  BacklogComment,
  BacklogIssue,
  BacklogIssueType,
  BacklogPriority,
  CreateIssueInput,
} from './client/port';
import type { BacklogRawMessage } from './types';
import type {
  AdapterPostableMessage,
  Content,
  FileUpload,
  RawMessage,
  Root,
  StreamChunk,
} from 'chat';

/**
 * Rejects `:i` (the issue body) and `:u:` (a fieldchange update with no
 * comment) for any operation that maps to a Backlog comment endpoint
 * (docs/specs/adapter.md §6 "Non-comment message ids", D12). Backlog *can*
 * edit an issue body through a different endpoint, but "edit what the bot
 * posted" must never silently rewrite a human's issue.
 */
export function requireCommentId(
  messageId: string,
  action: 'edited' | 'deleted' | 'starred'
): { host: string; issueId: number; commentId: number } {
  const decoded = decodeMessageId(messageId);
  if (decoded.kind !== 'comment') {
    throw new ValidationError(
      'backlog',
      `${messageId} is not a comment and cannot be ${action}`
    );
  }
  return {
    host: decoded.host,
    issueId: decoded.issueId,
    commentId: decoded.commentId,
  };
}

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

/** Fallback text's first line as the summary, the rest as the description — shared by both `CardElement` and `PostableCard` (docs/specs/adapter.md §6.7). */
function fallbackTextToSummaryAndDescription(fallbackText: string): {
  summary: string;
  description: string;
} {
  const [firstLine, ...restLines] = fallbackText.split('\n');
  return {
    summary: collapseWhitespace(firstLine ?? ''),
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
 * `cardToFallbackText`'s `platform: PlatformName` has no `"backlog"` member
 * (`@chat-adapter/shared@4.39.0`); `"slack"` only selects error wording, not
 * an actual Slack-shaped output, so it is passed with `boldFormat: '**'` set
 * explicitly rather than relying on a platform default that has no Backlog
 * entry (see `egress.ts`'s `toFileBuffer`/`toBuffer` comment in
 * `adapter.ts` for the same trade-off on `toBuffer`).
 */
export function resolveSummaryAndDescription(
  message: AdapterPostableMessage,
  converter: FallbackFormatConverter
): { summary: string; description: string } {
  if (typeof message === 'string') {
    return { summary: firstNonBlankLine(message), description: message };
  }

  if ('type' in message && message.type === 'card') {
    return fallbackTextToSummaryAndDescription(
      cardToFallbackText(message, { platform: 'slack', boldFormat: '**' })
    );
  }
  if ('card' in message) {
    const fallbackText =
      message.fallbackText ??
      cardToFallbackText(message.card, { platform: 'slack', boldFormat: '**' });
    return fallbackTextToSummaryAndDescription(fallbackText);
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

  return {
    id: encodeMessageId({ kind: 'issue', host, issueId: issue.id }),
    threadId: `backlog:${host}:${projectId}:${issue.id}`,
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

function toRawComment(
  projectId: number,
  host: string,
  comment: BacklogComment
): BacklogRawMessage {
  return {
    kind: 'comment',
    host,
    projectId,
    comment: {
      id: comment.id,
      issueId: comment.issueId,
      content: comment.content,
      createdUser: {
        id: comment.createdUser.id,
        name: comment.createdUser.name,
        userId: comment.createdUser.userId,
      },
      created: comment.created.toISOString(),
      updated: comment.updated.toISOString(),
      changeLog: comment.changeLog.map((change) => ({
        field: change.field,
        newValue: change.newValue,
        oldValue: change.oldValue,
      })),
      stars: comment.stars.map((star) => ({
        id: star.id,
        presenter: { id: star.presenter.id },
      })),
    },
    changes: [],
  };
}

export interface PostCommentInput {
  host: string;
  projectId: number;
  issueId: number;
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
  const { host, projectId, issueId, api, converter, message, toBuffer } = input;

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

  const comment = await api.addComment(issueId, commentInput);

  return {
    id: encodeMessageId({
      kind: 'comment',
      host,
      issueId,
      commentId: comment.id,
    }),
    threadId: `backlog:${host}:${projectId}:${issueId}`,
    raw: toRawComment(projectId, host, comment),
  };
}

export interface EditCommentInput {
  host: string;
  projectId: number;
  issueId: number;
  commentId: number;
  api: BacklogApi;
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
  const { host, projectId, issueId, commentId, api, converter, message } =
    input;

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
  const comment = await api.updateComment(issueId, commentId, content);

  return {
    id: encodeMessageId({
      kind: 'comment',
      host,
      issueId,
      commentId: comment.id,
    }),
    threadId: `backlog:${host}:${projectId}:${issueId}`,
    raw: toRawComment(projectId, host, comment),
  };
}

export interface AddReactionInput {
  issueId: number;
  commentId: number;
  api: BacklogApi;
  botUserId: number;
}

/**
 * `addReaction` (docs/specs/adapter.md §6.5): the emoji is ignored (Backlog
 * has one star kind). Reads the comment before starring so a second call is
 * a no-op — Backlog allows unlimited stars per user, so without this read
 * every retry or duplicate reaction would add another star.
 */
export async function addReaction(input: AddReactionInput): Promise<void> {
  const { issueId, commentId, api, botUserId } = input;
  const comment = await api.getComment(issueId, commentId);
  const alreadyStarred = comment.stars.some(
    (star) => star.presenter.id === botUserId
  );
  if (alreadyStarred) {
    return;
  }
  await api.addStar(commentId);
}

export interface RemoveReactionInput {
  issueId: number;
  commentId: number;
  api: BacklogApi;
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
  const { issueId, commentId, api, botUserId } = input;
  const comment = await api.getComment(issueId, commentId);
  const ownStars = comment.stars.filter(
    (star) => star.presenter.id === botUserId
  );
  for (const star of ownStars) {
    await api.deleteStar(star.id);
  }
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
  for await (const chunk of textStream) {
    if (signal?.aborted === true) {
      break;
    }
    if (typeof chunk === 'string') {
      buffered += chunk;
    } else if (chunk.type === 'markdown_text') {
      buffered += chunk.text;
    }
    // `task_update` and `plan_update` chunks carry no text (§6.4) and are
    // ignored.
  }
  return buffered;
}
