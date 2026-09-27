/**
 * Public surface of `@nulab/chat-adapter-backlog` (docs/specs/adapter.md §3.1).
 *
 * `decodeMessageId` and `decodeUserId` are the only free functions, though
 * the first-party adapters export none: the grammar they read is this
 * adapter's own, and no `Adapter` member reads a message or user id back, so
 * a handler asking which part a message is, or its author's numeric id, has
 * nothing else to ask.
 *
 * `backlog-js` reaches the published types through `client()`, on
 * purpose: handing out the client the adapter speaks through keeps a
 * consumer's extra calls inside the adapter's rate-limit accounting, retry
 * and error mapping, where a second client would spend the same per-user
 * budget uncounted. The cost is that a `backlog-js` major is a major here.
 */

export { BacklogAdapter, createBacklogAdapter } from './adapter';
export { decodeMessageId, decodeUserId } from './ids';

export type {
  BacklogAdapterConfig,
  BacklogChange,
  BacklogMessageId,
  BacklogMessagePart,
  BacklogPostableExtras,
  BacklogRawComment,
  BacklogRawIssue,
  BacklogRawMessage,
  BacklogRawPullRequest,
  BacklogSubjectRef,
  BacklogThreadId,
  BacklogUserId,
  BacklogWebhookPayload,
  BacklogWebhookVerifier,
  Resolvable,
} from './types';

export type { Backlog } from 'backlog-js';
