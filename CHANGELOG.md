# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The README states the minimum Pi version: 0.80.4 or later, tested with 1.0.0.
- Private vulnerability reporting is enabled, so the advisory form linked from
  `SECURITY.md` works.
- A session warns at start when its own address folder grants group or other
  permission, naming the folder and the `chmod 700` that fixes it. The folder
  is not changed.
- A session whose state directory cannot be written warns
  `mailbox: mailbox is off: <reason>` at start and runs without an address,
  watcher or timer, instead of failing with a raw error and starting half-way.

### Changed

- **Contract change:** a `message:send` emitted during a run now carries that
  run's hop count instead of 0, so two models delegating to each other through
  an extension no longer escape the hop limit. Emitted while idle it still
  carries 0. It is never refused at send time; the receiving side refuses
  past the limit as a loop, as before.
- **Contract change:** an envelope with a `kind` this version does not know
  is read as `message`: it is delivered, wakes the session and expects no
  answer. The original value is not kept. Before, it was set aside with a
  warning.
- Envelopes, in `new/` and in `sent/`, are written with mode `0600`; they were
  `0644` under the usual umask.
- A mail root that already existed with looser permissions is set to `0700` at
  session start.
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
