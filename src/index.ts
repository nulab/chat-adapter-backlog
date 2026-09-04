/**
 * Public surface of `@nulab/chat-adapter-backlog` (docs/specs/adapter.md §3.1).
 *
 * Four names exist twice in the codebase, and the split is deliberate rather
 * than an oversight, so the barrel has to choose:
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
 * `BacklogIssue`, `BacklogComment` and `BacklogChange` are exported as the
 * port's domain types, which is what spec §3.1 lists and what a caller
 * reaching for `adapter.api(host)` needs. The raw-message shapes stay
 * reachable through `BacklogRawMessage` itself, where they are structurally
 * inlined, so nothing is hidden — but they are not exported under names that
 * would shadow the domain types.
 *
 * Not exported, per §3.1: the `backlog-js` client wrapper, the zod schemas,
 * the plain-text fallback converter and the fixtures. Nothing from
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
  BacklogPostableExtras,
  BacklogRawMessage,
  BacklogThreadId,
  BacklogUserId,
  BacklogWebhookPayload,
  BacklogWebhookVerifier,
  Resolvable,
  ResolvedInstallation,
} from './types';

export type {
  AddCommentInput,
  BacklogApi,
  BacklogApiErrorDetail,
  BacklogAttachmentInfo,
  BacklogChange,
  BacklogComment,
  BacklogCredentials,
  BacklogDownloadedFile,
  BacklogIssue,
  BacklogIssueType,
  BacklogNotification,
  BacklogPriority,
  BacklogProject,
  BacklogStar,
  BacklogUploadedFile,
  BacklogUserRef,
  CreateIssueInput,
  ListCommentsOptions,
  ListIssuesOptions,
  ListNotificationsOptions,
  ListOrder,
  RateLimitBucket,
  RateLimitSnapshot,
  RateLimitSnapshots,
  RetryOptions,
  TextFormattingRule,
} from './client/port';

export type {
  InMemoryBacklogApi,
  InMemoryBacklogSeed,
  InMemoryBacklogState,
} from './client/in-memory';
