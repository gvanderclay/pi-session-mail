# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- The label on the answer to an ask now calls it an ask: "It is a reply to your
  ask …" and "[mailbox] Your ask …, quoted from …" (and "Ask cut at 2 KiB").
  It said "request" before, which now names a different kind of mail. A reply
  to a request, or to an id with no copy in `sent/`, keeps the request wording.
  The test that pinned the old wording for an ask's answer is updated.

## [0.6.0] - 2026-10-31

### Added

- The `message:reply` hook: an extension that took over a request answers it
  by emitting `{ to, inReplyTo, body, status }`. `pi-session-mail` writes a
  reply from the current session (the caller cannot set `from`) with that
  body and status exactly as given, at once, without waiting for the run to
  settle or using the model's answer, and sets `envelope` or `error` on the
  payload before `emit` returns, as `message:send` does. `status` is
  required and is `done`, `stopped` or `failed`; `inReplyTo` is a non-empty
  list of at most 50 non-empty ids, checked for shape only and not looked up
  in the mailbox; `body` is any string; `to` is checked as `message:send`
  checks it. There is no duplicate guard: every valid call writes a reply.
  With no provider installed, neither field is set. The reply travels like any
  other: it waits in a closed sender's inbox, and the sender gets it through
  `message:inbound` with its request copies. Asks are still answered with
  `session_mail_reply` or at settle. The README documents the hook with a
  runnable request-to-reply example. It is how an extension answers a request
  now that requests get no automatic answer (see the second **Breaking** entry
  under Removed).

### Removed

- **Breaking:** the hop limit is gone entirely. There is no per-turn hop
  count, `hops` is no longer written to new envelopes or part of the
  supported envelope, `session_mail_send` and `session_mail_ask` are never
  refused because of hops, and the `hopLimit` setting in `session-mail.json`
  has no effect (no migration; `pruneAfterDays` is unchanged). No other loop
  guard replaces it: sessions can keep waking each other, which is accepted.
  An old stored envelope with a `hops` property is still read and delivered;
  the property is ignored. The test that pinned the old behaviour changed with
  it.
- **Breaking:** a request (mail another extension sends through
  `message:send`) no longer gets an automatic answer. The receiving session
  sends no reply when the run settles, whether a `message:inbound` listener
  took the request over or not, and whether the run completed, stopped or
  failed or never read the request; a request is no longer held across a stop
  and answered "took over" later. The extension that consumes a request now
  owns its reply. A request is still stored, delivered and woken on as before,
  keeps its `sent/` copy and shows in `/mailbox`. Its label no longer says the
  final answer goes back automatically, and `session_mail_reply` now refuses a
  request saying the extension that consumes it answers it. Asks are
  unchanged. pi-squire's `delegate` relied on the automatic answer, so this
  release and pi-squire must be upgraded together: the matching pi-squire
  release sends its replies with `message:reply`. There is no version check,
  capability negotiation or fallback answering, and mixing this release with
  another pi-squire release is unsupported, with no particular failure
  promised. The tests that pinned automatic request answers
  changed with it: they now pin that no answer is sent, and the reply-delivery
  tests write their replies directly.

## [0.5.0] - 2026-10-23

### Changed

- `session_mail_ask` no longer holds the turn of a session a person is
  watching (a TUI without `PI_UNATTENDED=1`): it returns at once with outcome
  `background`, and the answer arrives as a message that starts a turn, so the
  user can keep talking to the asker. Unattended sessions, such as delegates,
  still wait for the answer. The label on an answer to an ask that is not
  waiting now reads "is not waiting for it" instead of "has stopped waiting",
  and the test pinning it changed with it.

## [0.4.0] - 2026-10-20

### Added

- Bare `/mailbox` opens a picker of this session's mail. Its title carries the
  session's name (or short id) and short address, Tab cycles unread, awaiting,
  read, sent and all (Shift+Tab goes back), and each row shows the first line, the other session, the
  kind and a relative time, with the status in the all and sent views and the
  running or closed marker on awaiting rows. Enter opens the whole mail and Esc
  goes back, then closes. It opens on unread when there is unread mail, and
  showing mail never marks it read.
- In the `/mailbox` picker, `d` deletes the selected read or sent item, or
  drops a request still awaiting a reply, after a confirmation showing its
  first line. Deleting a read reply also deletes the `sent/` copies of the
  requests it answered, so they do not reappear as awaiting. The picker reopens
  on the same filter with the next row selected, or the same row when the
  confirmation was cancelled. Unread mail cannot be deleted, and the hint line
  leaves `d` out there.
- `/mailbox:send` lists the other running sessions, asks for the text and
  sends it as a message, which expects no answer.
- `/mailbox:prune` removes closed sessions' mailbox folders without the age
  limit.

### Changed

- Bare `/mailbox` no longer prints the address and name notice; the picker's
  title carries them. Its tests now open the picker and assert the title.
- The footer shows only `📬 N unread`: mail that reached this session but has
  not entered its conversation yet. It clears as each message enters, not when
  the run settles. The `read` and `awaiting` counts are gone from it, because
  `read` only grew and `awaiting` stayed up for requests a stopped session
  still held. The status tests now pin the new footer.

### Removed

- The typed `/mailbox <to> <text>` and `/mailbox prune` forms (breaking).
  `/mailbox:send` and `/mailbox:prune` replace them, and any argument to
  `/mailbox` now shows a usage notice naming the two new commands. The tests
  of the typed send changed deliberately: delivery tests now use a harness
  helper that sends a request with hops 0 through `send()`, and tests of name
  and id resolution moved to `session_mail_send`.

## [0.3.0] - 2026-10-19

### Added

- `session_mail_list`, `session_mail_send`, `session_mail_ask` and
  `session_mail_reply` declare an `outputSchema` and return matching
  `structuredContent`, so a codemode script gets objects instead of text:
  `{ sessions: [{ id, name?, cwd, state, waitingOn?, self }] }` from the list,
  `{ id, to, running }` from a send, `{ id, to, outcome, status?, body? }`
  from an ask (one variant per `outcome`: `answered`, `timed-out`,
  `stopped-running`, `stopped-by-user`) and `{ id, ask, to }` from a reply.
  The text the model sees is unchanged.
- The four tools declare all four MCP tool annotations: the list is read-only
  and idempotent; send, ask and reply are not read-only and not destructive;
  reply is idempotent, since a repeat is refused; none reaches an open world.

## [0.2.2] - 2026-10-02

### Fixed

- The README links `CONTRIBUTING.md` and `SECURITY.md` on GitHub, since
  neither is in the npm package and their relative links 404 on pi.dev.

## [0.2.1] - 2026-10-02

### Fixed

- `/mailbox` refuses with `mailbox: this session has no mailbox address; the
  mailbox is off` when this session's mailbox is off (an unusable session id,
  or a mail root it cannot create). Before, it showed the session id as the
  address, failed a send with a raw error, and still pruned.

## [0.2.0] - 2026-10-02

### Added

- Mailbox folders of closed sessions are pruned. At session start, a folder is
  removed when its session is not running, nothing is waiting in its `new/`
  and its last activity (the newest change to the folder or its boxes) is
  older than `pruneAfterDays` days, 30 unless `session-mail.json` sets it. An
  invalid `pruneAfterDays` means 30, with a warning like `hopLimit`'s.
  Pruning a folder removes its read mail (`cur/`) and its sent copies
  (`sent/`) as well. Unread mail, a running session's folder, this session's
  folder and `running/` are never removed, nor is anything that is not a real
  folder named like an address. A folder is moved aside before it is removed,
  so mail that arrives at that moment is put back, not lost.
- `/mailbox prune` removes every such folder at once, whatever its age, so a
  closed session with no unread mail loses its folder, `cur/` and `sent/`
  included, even if it closed a minute ago. It says
  `Removed <N> mailbox folders of closed sessions`. `/mailbox prune <text>` is
  still a message to a session named `prune`.
- A running record holds `started`, a token for its process's start time. A
  record whose process id now belongs to a process that started at another
  time counts as not running, so a crashed session no longer stays listed once
  the operating system reuses its process id. Records without `started`
  (written by 0.1.0), and platforms where the start time cannot be read, are
  still judged by process id alone.
- The README states the minimum Pi version: 0.80.4 or later, tested with 1.0.0.
- The README says that mail can be lost on a power failure (nothing calls
  `fsync`), that the mail root must be on a local filesystem, not NFS, and
  that `awaiting` counts requests and asks.
- The README has a Compatibility section naming the stable contracts: the
  hooks and their payloads, the `[mailbox]` lines, the mail root path, the
  envelope fields, kinds and statuses, the tool and command names, and the
  `session-mail.json` keys. Changing any of them needs a minor version while
  the package is at 0.x and a major version from 1.0 on.
- Private vulnerability reporting is enabled, so the advisory form linked from
  `SECURITY.md` works.
- A session warns at start when its own address folder grants group or other
  permission, naming the folder and the `chmod 700` that fixes it. The folder
  is not changed.
- A session whose state directory cannot be written warns
  `mailbox: mailbox is off: <reason>` at start and runs without an address,
  watcher or timer, instead of failing with a raw error and starting half-way.

### Changed

- Settings warnings (`session-mail.json`) are shown once per distinct problem
  per session, not once per session: a file with both keys invalid gives two
  warnings, and a file edited to a different problem warns again. The warning
  for an unreadable, invalid or non-object file now also names the pruning
  fallback (30 days). A broken file now warns at session start, not at the
  first send.
- **Contract change:** a `message:send` emitted during a run now carries that
  run's hop count instead of 0, so two models delegating to each other through
  an extension no longer escape the hop limit. Emitted while idle it still
  carries 0. It is never refused at send time; the receiving side refuses
  past the limit as a loop, as before.
- **Contract change:** an envelope with a `kind` this version does not know
  is read as `message`: it is delivered, wakes the session and expects no
  answer. The original value is not kept. Before, it was set aside with a
  warning; the test that pinned that now covers only a bad hop count.
- Envelopes, in `new/` and in `sent/`, are written with mode `0600`; they were
  `0644` under the usual umask.
- A mail root that already existed with looser permissions is set to `0700` at
  session start, when this user can change it; a root this user cannot change
  is still used as it is.
- Releases are published by the release workflow, with npm provenance, only
  after lint, typecheck and tests pass on Node 22.19 and 24 and a smoke test
  loads the packed package in Pi 1.0.0.
- The package entry is now `src/index.ts`; the sources moved into `src/`.
- A send writes the sender's `sent/` copy first and removes it when delivery
  fails, so a thrown error means nothing was delivered; a failed delivery also
  no longer leaves a file in the recipient's `tmp/`.
- A `*.json` name in `cur/` or `sent/` that is not a regular file is skipped
  instead of read, so a planted FIFO or directory cannot hang a session.
- An envelope naming more than 50 requests in `in_reply_to` is set aside with a
  warning.
- A reply quotes its requests from one listing of `sent/`, not one listing per
  id.
- The `[mailbox]` label replaces control characters (C0 with tab included,
  DEL, C1, and the separators U+2028 and U+2029) with spaces in the envelope id, the ids it
  answers, its status, the sender's name and working directory, and the paths
  it names, so a forged value cannot start a line that passes for a
  `[mailbox]` line. The label text is otherwise unchanged.

## [0.1.0] - 2026-10-02

The first public release. Before this repository the package lived in its
author's dotfiles; the changes below are against that copy.

### Added

- Published to npm as `pi-session-mail`.
- MIT license and package metadata, including `engines` (Node 22.19 or later).
- CI on Node 22.19 and 24: lint, typecheck, tests, and a check of the
  published file list.

[Unreleased]: https://github.com/gvanderclay/pi-session-mail/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/gvanderclay/pi-session-mail/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/gvanderclay/pi-session-mail/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/gvanderclay/pi-session-mail/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/gvanderclay/pi-session-mail/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/gvanderclay/pi-session-mail/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/gvanderclay/pi-session-mail/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/gvanderclay/pi-session-mail/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gvanderclay/pi-session-mail/releases/tag/v0.1.0
