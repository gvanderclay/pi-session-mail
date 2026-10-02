# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/gvanderclay/pi-session-mail/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/gvanderclay/pi-session-mail/releases/tag/v0.1.0
