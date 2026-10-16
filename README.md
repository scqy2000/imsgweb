# imsgweb

This independently maintained fork lives at
[scqy2000/imsgweb](https://github.com/scqy2000/imsgweb) and targets **imsg 0.17.0**.
Development and releases happen in this repository only; upstream changes are
not synchronized automatically. The original project is
[PeronGH/imsgweb](https://github.com/PeronGH/imsgweb).

## Features in This Fork

- Conversation filtering, unread counts, unread-only view, and loading more chats.
- Global and per-conversation message search with navigation to message context.
- Exact conversation details, participants, read state, statistics, and read-only
  native Send Later messages.
- Replies, editing, unsend, local deletion, Tapbacks, and Notify Anyway.
- Text/file sends, service selection and explicit SMS fallback, rich formatting,
  subjects/effects, link cards, native voice attachments, stickers, multipart
  text, and native polls with vote/unvote.
- Group creation, naming, participants, photo upload/removal, and leaving.
- Explicit Name & Photo sharing and iMessage address availability checks.
- Live capability checks: unavailable operations are disabled and explained.
  Opening a conversation does not mark it read or send typing state. Typing
  indicators are opt-in. Destructive actions and sharing require confirmation.
- Structured delivery errors are preserved. Unknown delivery blocks further
  mutations until the result is checked; sends are never automatically retried.

See [the compatibility and validation notes](docs/imsg-017.md) for boundaries.

A web UI for iMessage on your Mac. Browse chats, read history, get live
messages, and send texts and attachments from the browser — powered by
[imsg](https://github.com/openclaw/imsg) talking to the local Messages
database, wrapped in a single self-contained binary.

## Requirements

- macOS with Messages signed in
- Full Disk Access for the terminal (or binary) that runs imsgweb —
  System Settings → Privacy & Security → Full Disk Access. Required to
  read the Messages database.

## Run

When available, download this fork's `imsgweb` binary from
[releases](https://github.com/scqy2000/imsgweb/releases). Embedded releases have
[imsg](https://github.com/openclaw/imsg) embedded, nothing else to
install. Until a fork release is published, use the source instructions below.
For a downloaded release, in Terminal:

```bash
cd ~/Downloads                          # or wherever you saved it
chmod +x imsgweb                        # downloads aren't executable
xattr -d com.apple.quarantine imsgweb   # let macOS run an unsigned download
./imsgweb                               # serves http://localhost:3000
```

Open http://localhost:3000 in your browser. Use `PORT` to change the
port.

By default it listens on loopback only. To reach it from other devices,
set `HOST=0.0.0.0` — and pair it with `IMSGWEB_PASSWORD`, which gates the
API behind a password (the browser prompts once and keeps a session
cookie for 30 days):

```bash
HOST=0.0.0.0 IMSGWEB_PASSWORD=secret ./imsgweb
```

Or run from source with [Bun](https://bun.sh), which needs imsg on your
PATH:

```bash
brew install steipete/tap/imsg
git clone https://github.com/scqy2000/imsgweb.git
cd imsgweb
bun install
bun run dev          # dev server with HMR on http://localhost:3000
```

## Development

Use `main` in `scqy2000/imsgweb` as the integration branch. Push changes and open
pull requests only against this repository. Do not add an upstream push target
or synchronize the original repository unless the owner explicitly requests it.

```bash
bun run build        # standalone binary at dist/imsgweb
bun test             # unit + route tests (run against a mock imsg)
bun run check        # svelte-check
bun run lint         # eslint
bun run format       # prettier
```

To build a binary that bundles imsg itself (no separate install needed on
the target machine), point `IMSGWEB_EMBED_IMSG` at the real imsg binary —
not the homebrew shim:

```bash
IMSGWEB_EMBED_IMSG="$(brew --prefix imsg)/libexec/imsg" bun run build
```

An embedded build always uses its bundled imsg and refuses
`IMSGWEB_RPC_CMD`.

To develop without the imsg binary or Full Disk Access, point the server
at the bundled mock (`--interval 4000` emits a synthetic incoming message
every 4s):

```bash
IMSGWEB_RPC_CMD="bun server/rpc/mock.ts --interval 4000" bun run dev
```
