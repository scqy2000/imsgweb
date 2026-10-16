# imsg 0.17 Compatibility

The application targets upstream tag `v0.17.0` (`b4f636c`). The `imsg/`
submodule is a reference; runtime uses the binary on PATH unless embedded.

## Feature Mapping

| Upstream capability                     | Web entry                                           |
| --------------------------------------- | --------------------------------------------------- |
| `status`, `initialize`                  | Service status; live method availability            |
| `chats.list`, unread counts             | Conversation list, unread filter, load more         |
| `chats.get`                             | Conversation details                                |
| `messages.history`, `messages.after`    | History, stable cursor handling, search context     |
| `messages.search`                       | Global/scoped message search                        |
| `messages.stats`                        | Statistics, optionally scoped to a conversation     |
| `messages.scheduled`                    | Read-only native Send Later list                    |
| `watch.subscribe`                       | Live updates with EventSource reconnect             |
| `send`, `message.send_status`           | Composer and delivery state                         |
| `send.rich`, `send.multipart`           | Formatting, subject, effects, link card, text parts |
| `send.attachment`, `send.sticker`       | File chooser, voice-message and sticker modes       |
| `poll.send`, `poll.vote`, `poll.unvote` | Composer poll mode and inline voting                |
| `tapback`, message mutations            | Per-message action menu                             |
| `read`, `chats.markUnread`              | Explicit read-state controls in details             |
| `typing`                                | Opt-in composer control                             |
| `chats.create`, group mutations         | New group and conversation details                  |
| Name & Photo sharing, `handles.check`   | Explicit controls in details                        |

## Runtime Boundaries

Tracked text mode uses `send.tracked` with a browser-generated UUID. After an
uncertain result, its exact message status can be queried without resending.

Keep SIP enabled. Bridge-dependent operations are available only when an
already-running bridge advertises them. The application never runs
`imsg launch`, changes SIP, edits Messages databases, or automatically shares
profiles. Ordinary text/file sending uses Messages automation and may require
macOS Automation authorization. Full Disk Access is needed to read Messages.

Uploading a file accepts a browser-supplied file, not an arbitrary server path.
Uploads are bounded, privately staged, and removed after the request. Multiple
files are rejected explicitly; send each separately. Scheduled messages are
read-only; creating or cancelling native Send Later entries is not exposed by
upstream RPC. Advanced features still follow Apple's service and time limits.

The RPC method set is queried at runtime. `supported_methods` describes compiled
support, not readiness. Updating the binary does not enable a missing bridge.
The status page shows that distinction.

Shared nickname/avatar metadata and chat-background inspection are CLI-only
upstream surfaces, not JSON-RPC methods. They are not proxied through a
subprocess: the shared nickname CLI can enter a bridge launch path. The web UI
exposes Name & Photo sharing eligibility separately, without pretending that it
supplies a correspondent's avatar.

Native RPC search returns at most the newest 100 global matches and accepts no
chat filter or cursor. Web paging/filtering preserves native Unicode and audio
transcript matching within those results; a visible warning marks saturated
queries as incomplete. Narrow the query to improve coverage.

Delivery errors carry `code`, `disposition`, and `retry_safe` where upstream
supplies them. Transport loss during a mutation is treated as uncertain. The
application never resends automatically. An in-flight poisoned mutation lane
requires independently resolving the result and restarting the service.

## Validation

Run `bun install --frozen-lockfile`, `bun run check`, `bun run lint`, `bun test`,
and `bun run build`. Route tests use the bundled in-memory RPC mock. Start a
loopback-only mock with:

```sh
HOST=127.0.0.1 PORT=3100 IMSGWEB_PASSWORD=local-test \
IMSGWEB_RPC_CMD="bun server/rpc/mock.ts --interval 4000" bun run dev
```

Validate login, filters, search/context, history, live updates, sends, file
uploads, rich modes, reactions, polls, group changes, read-state controls,
confirmation dialogs, and unavailable capabilities. Use mock data for writes.
Real integration checks must remain read-only until a person explicitly sends
or confirms the desired operation. No message contents, attachments, passwords,
or database files belong in a commit or public fork.

### Local Acceptance: 2026-10-16

- Installed runtime and upstream latest release both report `0.17.0`.
- `bun test`: 63 passed, 0 failed, 362 assertions across 9 files (including two
  reference-submodule documentation tests).
- Type checking reports zero errors and warnings; ESLint, formatting checks,
  production build, and `git diff --check` pass.
- Browser mock checks cover live messages, search/context navigation, group
  rename confirmation, rich text, tracked text, file upload, poll creation and
  voting, statistics, and scheduled-message inspection.
- An uncertain tracked send preserves the draft, blocks repeat mutations, and
  reports that an absent status result does not prove the message was unsent.
- The real loopback service loads the conversation list and an existing group
  with 50 history messages. Its live indicator is connected, the authenticated
  event stream responds, and no browser warnings or errors were observed.
- Authentication rejects missing credentials and an incorrect password with
  HTTP 401; successful login sets an HttpOnly cookie. The listener is IPv4
  `127.0.0.1`, not a public interface.
- Real integration used read-only operations only. Sending text/files and any
  group or message mutations still require the user's manual acceptance test.
- The current machine reports no ready bridge. Bridge-dependent modes are
  disabled in the real UI; mock acceptance is not proof of native execution.
- Mobile viewport acceptance remains unverified: the in-app browser did not
  apply the requested narrow viewport override.

The development repository is `scqy2000/imsgweb`, maintained independently from
the original project. The initial compatibility implementation is based on
`9d2087e` and is integrated into this repository's `main` branch. There is no
automatic upstream synchronization or upstream push destination. The reference
submodule is pinned to `v0.17.0` (`b4f636c`).
