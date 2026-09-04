# @nulab/chat-adapter-backlog

A [Backlog](https://backlog.com/) adapter for [Chat SDK](https://chat-sdk.dev/).

Chat SDK gives an agent one interface for every messaging platform, and each
platform is plugged in through an adapter. This package is the Backlog side of
that interface: Backlog issues, comments and project notifications become the
conversations an agent reads from and replies to, using the
[Backlog API v2](https://developer.nulab.com/docs/backlog/).

## Status

**Early stage — the adapter is not implemented yet.**

The repository currently contains the toolchain (build, lint, format, type
check, tests, CI, release automation) and a placeholder export. There is no
working adapter to install and no usage example to copy, so nothing here is
ready to run against a Backlog space.

What the finished adapter will do is specified in
[docs/specs/adapter.md](./docs/specs/adapter.md); the order of work is in
[docs/plans/adapter-implementation.md](./docs/plans/adapter-implementation.md).
Roughly:

1. Backlog API client behind a narrow internal port, with typed errors and
   rate-limit-aware retries.
2. The required members of Chat SDK's `Adapter` interface — thread ID codec,
   webhook entry point, message parsing, post/edit/delete, reactions, fetch.
3. Webhook ingestion for issue created / updated / commented activity.
4. Optional members Backlog can support: thread listing, issue creation from
   `channel.post()`, user lookup, read receipts, attachments.
5. First release to npm.

Not yet decided or done: registration in the [Chat SDK adapter
catalog](https://chat-sdk.dev/adapters) and whether this ships as a community
or a [vendor-official](https://chat-sdk.dev/docs/contributing/vendor-official)
adapter. Treat both as open items.

## Installation

Once published:

```sh
pnpm add @nulab/chat-adapter-backlog chat
```

## Package name

Chat SDK's convention for community adapters is the unscoped
`chat-adapter-<platform>`, but `chat-adapter-backlog` on npm is already taken
by an unrelated third-party package, so this one is published under the
`@nulab` scope.

## Links

- [Chat SDK documentation](https://chat-sdk.dev/docs)
- [Building an adapter](https://chat-sdk.dev/docs/contributing/building)
- [Backlog API v2 documentation](https://developer.nulab.com/docs/backlog/)
- [DEVELOPMENT.md](./DEVELOPMENT.md) — contributor setup and workflow

## License

[MIT](./LICENSE) © Nulab Inc.
