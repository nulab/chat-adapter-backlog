/**
 * Public surface of `@nulab/chat-adapter-backlog` (docs/specs/adapter.md §3.1).
 *
 * Two modules describe the same Backlog objects, and the split is deliberate
 * rather than an oversight, so the barrel has to choose between them:
 *
 * - `src/client/port.ts` owns the **API domain** types. They carry `Date`
 *   objects and the full `BacklogUserRef`, because that is what the port
 *   returns after validating a response.
 * - `src/types.ts` owns the **raw-message** types reachable from
 *   `message.raw`. They carry ISO strings, because a `Message` is serialised
 *   into the state adapter for the queue and debounce strategies and has to
 *   survive the round trip — a `Date` would come back as a string and a
 *   consumer reading `raw` would get a type that lies.
 *
 * The root and comment shapes say which side they are on in their own names —
 * `BacklogRawIssue`, `BacklogRawComment`, `BacklogRawPullRequest` — so two
 * names are declared in both modules: `BacklogChange` and
 * `TextFormattingRule`. The port's `BacklogChange` additionally carries the
 * `attachmentInfo` a REST changelog has; `TextFormattingRule` is the same
 * union written twice. Both are exported from the port, which is the pair a
 * caller reaching for `adapter.api(host)` needs; the raw shapes stay
 * reachable through `BacklogRawMessage` itself, where they are structurally
 * inlined.
 *
 * Not exported: the internal subject layer (`SubjectClient`,
 * `subjectClientFor`), which selects the issue or pull-request endpoint
 * family for a thread. It is a seam egress, reads and the webhook path are
 * written against — an internal one like the zod schemas, not a consumer
 * surface; a consumer addresses a subject through `BacklogSubjectRef` and the
 * id codec instead.
 *
 * Also not exported, per §3.1: the `backlog-js` client wrapper, the zod
 * schemas, the plain-text fallback converter and the fixtures. Nothing from
 * `backlog-js` or `zod` appears in an exported type.
 */

export { BacklogAdapter, createBacklogAdapter } from './adapter';
export {
  channelIdFromThreadId,
  decodeChannelId,
  decodeMessageId,
  decodeThreadId,
  decodeUserId,
  encodeChannelId,
  encodeMessageId,
  encodeThreadId,
  encodeUserId,
  MENTION_PROJECT_MEMBERS,
  mentionPattern,
  mentionTeam,
  mentionUser,
} from './ids';
export { createInMemoryBacklogApi } from './client/in-memory';
export { BacklogMarkdownConverter } from './format/markdown';
export { BacklogNotationConverter } from './format/notation';

export type {
  BacklogAdapterConfig,
  BacklogChannelId,
  BacklogChannelPostableExtras,
  BacklogInstallation,
  BacklogMessageId,
  BacklogMessagePart,
  BacklogPostableExtras,
  BacklogRawMessage,
  BacklogSubjectRef,
  BacklogThreadId,
  BacklogUserId,
  BacklogWebhookPayload,
  BacklogWebhookVerifier,
  Resolvable,
  ResolvedInstallation,
} from './types';

export type {
  AddCommentInput,
  AddPullRequestCommentInput,
  BacklogApi,
  BacklogApiErrorDetail,
  BacklogAttachmentInfo,
  BacklogChange,
  BacklogComment,
  BacklogCredentials,
  BacklogDownloadedFile,
  BacklogGitRepository,
  BacklogIssue,
  BacklogIssueComment,
  BacklogIssueType,
  BacklogNotification,
  BacklogPriority,
  BacklogProject,
  BacklogPullRequest,
  BacklogPullRequestAttachment,
  BacklogStar,
  BacklogUploadedFile,
  BacklogUserRef,
  CreateIssueInput,
  ListCommentsOptions,
  ListIssuesOptions,
  ListNotificationsOptions,
  ListOrder,
  ListPullRequestsOptions,
  PullRequestRef,
  RateLimitBucket,
  RateLimitSnapshot,
  RateLimitSnapshots,
  RetryOptions,
  StarTarget,
  TextFormattingRule,
} from './client/port';

export type {
  InMemoryBacklogApi,
  InMemoryBacklogSeed,
  InMemoryBacklogState,
} from './client/in-memory';
