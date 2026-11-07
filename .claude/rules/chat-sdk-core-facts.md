---
paths:
  - 'src/**/*.ts'
---

# Chat SDK core facts (`chat@4.40.0`)

What the `chat` core actually does with an adapter, verified in `vercel/chat`
at tag `chat@4.40.0` (commit `85a37c8`); cites are `path:line` in that clone,
under `packages/chat/src/` unless another package is named. Nothing here is
measured on a Backlog space; where the docs site disagrees with the tag, the tag
wins, so re-verify against the tag before changing code.

## Registration and identity

- Adapters are looked up by the **config key** of `new Chat({ adapters: { key:
  adapter } })`, not by `adapter.name` (`chat.ts:451-455`); `chat.thread(id)`
  and `chat.channel(id)` resolve via `threadId.split(":")[0]` against those
  keys (`chat.ts:2102-2116, 2140-2154`); `Thread.fromJSON` resolves by
  `adapterName` (`thread.ts:1122-1140`). Keep config key == `name` == thread-id
  prefix.
- `initialize(chat)` runs for all adapters in parallel after `state.connect()`,
  lazily on the first webhook or via `chat.initialize()` (`chat.ts:501-520`).
  Tolerate construction long before `initialize`; do not call the API earlier.
- `channelIdFromThreadId` is **required** in 4.40.0 although the docs page
  lists it optional; the core uses it for `createThread` (`chat.ts:3231`), the
  lock key when `lockScope === "channel"` (`chat.ts:2245`), history
  (`chat.ts:2329`) and `thread.channel` (`channel.ts:564`, `thread.ts:299`).
- The core never calls `encodeThreadId`, `decodeThreadId`, `parseMessage` or
  `renderFormatted` (no call site under `packages/chat/src`); they serve the
  adapter and the test kit. `fetchThread` is called only by `chat/ai` tools
  (`ai/tools/threads.ts:144`), never by routing.

## Webhook ingress and routing

- `handleWebhook` convention: 401 on failed verification, 400 on unparseable
  JSON, 200 after _scheduling_ work; irrelevant events also get 200
  (`packages/adapter-github/src/index.ts:623-658, 702`).
- `chat.processMessage(adapter, threadId, messageOrFactory, options)` resolves
  the factory and registers the promise with `options.waitUntil` itself
  (`chat.ts:1029-1056`); the adapter only calls it and returns. Errors are
  logged and swallowed for `waitUntil`, but the returned promise still rejects.
- `routeIncomingMessage` (`chat.ts:2273-2364`): attach adapter for `subject` →
  **skip if `author.isMe`** (`chat.ts:2299-2306`) → dedupe via
  `state.setIfNotExists("dedupe:<adapter.name>:<message.id>", true,
  dedupeTtlMs)` (`chat.ts:2311`; default 10 min, `chat.ts:127`) → history →
  lock. `Message.id` must be unique per platform message.
- Default concurrency `"drop"`: 30 s lock with heartbeat, `LockError` if busy
  (`chat.ts:2452-2499`); `lockScope` defaults to `"thread"` (`chat.ts:2258`).
- Dispatch (`chat.ts:3098-3171`): `setMentionFlags` → `isSubscribed` →
  `createThread` → DM handlers (if `isDM` and any registered) → subscribed
  handlers → mention handlers (if `isMention`) → pattern handlers → debug log.
  With `isDM` true and no DM handler, `isMention` is forced `true`
  (`chat.ts:3113-3115`). An absent `isDM` member means `false`.
- `onSubscribedMessage` does not fire for the subscribing message or for bot
  messages (`types.ts:1984-2011`). `thread.subscribe()` is `state.subscribe`
  plus optional `adapter.onThreadSubscribe` (`thread.ts:436-442`).

## Mention detection

- Up to `chat@4.40.0`: `message.isMention = message.isMention || detectMention(...)`
  (`chat.ts:3180` at that tag). From `chat@4.41.0`: `message.isMention =
  message.isMention ?? detectMention(...)` (vercel/chat#946 "honor
  adapter-reported non-mentions", commit `fcdc1c9`, 2026-09-17; `chat.ts:3279`
  at `chat@4.41.0`, still `??` at `4.44.0`; verified 2026-11-07). So an adapter
  that sets `false` suppresses the core's `@userName` match, and only an unset
  value falls through to it. The core's regex is
  `(?<!\w)@<escaped userName>(?![\w-])`, case-insensitive, with `userName =
  adapter.userName || chat.userName` (`chat.ts:3174-3308, 3271` at 4.40.0); with
  `botUserId` set, `@<botUserId>` and `<@!?<botUserId>>` also match
  (`chat.ts:3272, 3284-3300` at 4.40.0).
- For an adapter that leaves `isMention` unset, `message.text` must contain the bot's mention literally as
  `@<userName>`, and `userName` must equal what users type. Backlog rewrites
  mentions to `@<display name>` (see `backlog-webhook-facts.md`), so `userName`
  is the bot's display name and `(?![\w-])` decides where a multi-word name may
  end. Adapters may pre-set `isMention` when the platform signals it
  (`packages/adapter-slack/src/index.ts:3301-3307`).

## Egress

- `postMessage` call sites: `thread.post` (`thread.ts:512`), PostableObject
  fallback (`postable-object.ts:84`), ephemeral-to-DM fallback
  (`thread.ts:585`), streaming fallback (`thread.ts:963, 1015, 1041`), and
  `channel.post` when `postChannelMessage` is absent (`channel.ts:319, 328`).
- `channel.messages` falls back to `fetchMessages(channelId, ...)` when
  `fetchChannelMessages` is absent (`channel.ts:190`). `postMessage` and
  `fetchMessages` therefore receive **channel ids**; accept them or throw a
  clear `ValidationError` (github throws from `decodeThreadId`).
- `RawMessage.threadId` returned by `postMessage`/`editMessage`/`stream` must be
  the thread the message actually landed in; `createSentMessage` uses it for
  later edits (`thread.ts:519-521, 1167`).
- `stream(threadId, textStream, options)` returning `null` **before consuming a
  chunk** hands over to the core fallback (`thread.ts:797, 813-838`): post a
  placeholder (`"..."`, none when `fallbackStreamingPlaceholderText === null`),
  `editMessage` every `updateIntervalMs` (default 500 ms via
  `ChatConfig.streamingUpdateIntervalMs`), final edit (`thread.ts:950-1065`);
  an empty stream posts `" "` (`thread.ts:1042`).
- `fromFullStream` (`from-full-stream.ts`, read in the published
  `chat@4.40.0` bundle `dist/chunk-BKACWYIW.js:15-48`, which names that source
  file) is what `thread.post(fullStream)` funnels an AI SDK stream through, and
  it forwards **only** four things: bare strings, the three chunk types in
  `STREAM_CHUNK_TYPES` (`markdown_text`, `task_update`, `plan_update`) and
  `text-delta` (reading `text ?? delta ?? textDelta`, inserting `"\n\n"`
  after a `finish-step`). Every other chunk type is dropped by a bare
  `continue` — `error` included. An AI SDK v7 model failure is an
  `{ type: "error" }` chunk rather than a thrown error, so a failed generation
  reaches `stream()` as a stream that yields nothing at all, not as a
  rejection. An adapter cannot distinguish it from a genuinely empty stream;
  only the consumer iterating `fullStream` itself can.
- `startTyping` is required but may be a no-op (github `index.ts:1258-1260`);
  `endTyping` runs after the next post only if defined (`thread.ts:893-901`).
  No `shouldAcknowledge` exists in 4.40.0.

## Degradations when optional members are absent

- `reply` → `NotImplementedError(..., "replies")` (`thread.ts:605-610`);
  `scheduleMessage` → `NotImplementedError(..., "scheduling")`
  (`thread.ts:721-728`); `markAsRead` → `NotImplementedError(...,
  "read-receipts")` (`thread.ts:903-931`).
- `postEphemeral` → `openDM` + `postMessage` with `usedFallback: true` when
  `fallbackToDM` and `openDM` exist, else `null` (`thread.ts:574-592`).
  `openDM`/`getUser` absent → `chat.openDM`/`chat.getUser` throw
  `ChatError("NOT_SUPPORTED")` (`chat.ts:2033-2044, 2062-2073`).
- `openModal` absent → warning "does not support modals", `undefined`
  (`chat.ts:1803-1808`). `postObject` absent → `postMessage(threadId,
  obj.getFallbackText())` (`postable-object.ts:80-84`).
- `fetchSubject` is called lazily by the `Message.subject` getter, errors →
  `null` (`message.ts:182-193`). `rehydrateAttachment` runs after a
  queue/debounce JSON round-trip for attachments lacking `fetchData`
  (`chat.ts:3364-3369`); without it only serializable fields survive.

## Reads and user lookup

- `fetchMessages` pages are **oldest → newest** regardless of direction;
  `backward` (default) returns the N most recent with `nextCursor` pointing
  older, `forward` the oldest with the cursor pointing newer; `nextCursor` is
  `undefined` when exhausted (`types.ts:295-325, 1543-1616`). `thread.messages`
  reverses each page (`thread.ts:334`); `allMessages` walks forward with limit
  100 (`thread.ts:371`); paging stops on `undefined` cursor or an empty page.
- `chat.getUser`/`chat.openDM` infer the adapter from the **user-id format**
  (`chat.ts:2162-2234`): numeric ids belong to discord/telegram/github
  (`AMBIGUOUS_USER_ID` when several are registered); unmatched formats throw
  `UNKNOWN_USER_ID_FORMAT`. Consumers must call `adapter.getUser` directly.

## `@chat-adapter/shared@4.40.0`

- Constructors (`packages/adapter-shared/src/errors.ts:13-158`):
  `AdapterError(message, adapter, code?)`; `AdapterRateLimitError(adapter,
  retryAfterSeconds?)`; `AuthenticationError(adapter, message?)`;
  `ResourceNotFoundError(adapter, resourceType, resourceId?)`;
  `PermissionError(adapter, action, requiredScope?)`; `ValidationError(adapter,
  message)`; `NetworkError(adapter, message?, originalError?)`. Only
  `AdapterError` takes the message first.
- `toBuffer(data, { platform })` requires a `PlatformName` from `"slack" |
  "gchat" | "teams" | "discord"` (`card-utils.ts:18-72`); github and backlog
  are not in the union, so write your own Buffer helper.
- `downloadAttachment(url, { adapter, headers?, hosts?, limit?, redirects?,
  timeoutMs?, transport?, onResponse? })` is the SSRF-safe HTTPS download (25 MB,
  5 redirects, 30 s defaults) throwing `NetworkError` (`download.ts:277-345`).

## `@chat-adapter/tests@4.40.0`

- Peer deps `chat ^4.28.1`, `vitest ^4.0.0`; register matchers with
  `setupFiles: ["@chat-adapter/tests/setup"]`. Matchers (`matchers.ts:334-343`):
  `toHavePosted(threadId, textPattern?)`, `toHaveEdited(threadId, messageId,
  textPattern?)`, `toHaveDeleted`, `toHaveReactedWith(threadId, messageId,
  emojiName)`, `toHaveStartedTyping`, `toHavePostedToChannel`,
  `toHaveDispatched(handler)` on a mock `ChatInstance`, `toBeSubscribedTo`
  (async, on a `StateAdapter`). Text matching reads `string`, `.markdown`,
  `.raw`, `.fallbackText` only (`matchers.ts:55-73`).
- `threadIdContract({ name, encode, decode, cases, isDM? })` asserts every
  encoding starts with `${name}:`, `decode(encode(x))` **deep-equals** `x` (no
  added or normalised fields) and pinned `encoded` strings match exactly
  (`thread-id-contract.ts:56-92`). Wrap methods in arrows to keep `this`.
- `selfMessageContract({ name, setup, makeOtherMessageRequest,
  makeSelfMessageRequest })`: `setup()` returns an initialized adapter with a
  known bot identity plus `createMockChatInstance()`; other-user webhook → 200
  and `toHaveDispatched("processMessage")`, bot-authored → 200 and not
  dispatched (`self-message-contract.ts:40-63`). Drop own messages **before**
  `processMessage`; the core's `isMe` skip does not satisfy this suite.
- `connectWebhookContract({ name, createAdapter({ webhookVerifier }),
  makeWebhookRequest })` needs a `webhookVerifier(request: Request, body:
  string)` option replacing native verification: 200 when truthy, 401 when
  falsy or throwing, verifier wins over a configured secret
  (`connect-contract.ts:68-144`).

## Publishing checklist essentials

- `chat` as **peerDependency** `^4.0.0`, `@chat-adapter/shared` as a
  dependency, platform SDK as a regular dependency (`apps/docs/content/docs/
  contributing/publishing.mdx`, `building.mdx`). First-party packages pin
  exactly only because of fixed versioning; do not copy that.
- The `@chat-adapter/` npm scope is reserved for Vercel; use
  `@your-org/chat-adapter-<name>`. Naming: class `<Name>Adapter implements
  Adapter`, factory `create<Name>Adapter(config)`, `export type
  { <Name>AdapterConfig }` (`.github/CONTRIBUTING.md`, `konsistent.json`).
- README order (`documenting.mdx`): title + badges + one-liner; Installation;
  Quick start; Environment variables table; Configuration reference table;
  Platform setup; Features and limitations; License. A `sample-messages.md`
  with real payloads is expected in the package root.
- Vendor-official qualification (`vendor-official.mdx`): maintained; repo in
  the vendor's GitHub org; covered by the vendor's product docs; announced; no
  private-beta platform APIs; credentials accepted as `string | (() => string
  | Promise<string>)` and **resolved on every outbound call**, not cached.

## `@chat-adapter/github` as the closest analog

- Buffers `stream` into one `postMessage` (`index.ts:1086-1107`); `startTyping`
  no-op; omits `isDM`, `openDM`, `postEphemeral`, `openModal`,
  `scheduleMessage`, `markAsRead`, `reply`, `postChannelMessage`,
  `fetchChannelMessages`; `fetchMessages` always returns `nextCursor:
  undefined` (`index.ts:1340`); drops `sender.id === botUserId` before
  `processMessage` (`index.ts:763-768`); no error mapping.
- Its `AGENTS.md` describes members, events and files that do not exist in the
  4.40.0 source; README, docs page and code agree with each other. Do not trust
  that AGENTS.md.
