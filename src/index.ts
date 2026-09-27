export { BacklogAdapter, createBacklogAdapter } from './adapter';
export { decodeMessageId, decodeUserId } from './ids';

export type {
  BacklogAdapterConfig,
  BacklogChange,
  BacklogChangeLog,
  BacklogMessageId,
  BacklogMessagePart,
  BacklogPostableExtras,
  BacklogRawComment,
  BacklogRawIssue,
  BacklogRawMessage,
  BacklogRawPullRequest,
  BacklogStar,
  BacklogSubjectRef,
  BacklogThreadId,
  BacklogUser,
  BacklogUserId,
  BacklogWebhookPayload,
  BacklogWebhookVerifier,
  Resolvable,
} from './types';

export type { Backlog } from 'backlog-js';
