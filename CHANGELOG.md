# Changelog

All notable changes to this package are recorded here, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The package
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The README states the minimum Pi version: 0.80.4 or later, tested with 1.0.0.
- Private vulnerability reporting is enabled, so the advisory form linked from
  `SECURITY.md` works.

### Changed

- Releases are published by the release workflow, with npm provenance, only
  after lint, typecheck and tests pass on Node 22.19 and 24 and a smoke test
  loads the packed package in Pi 1.0.0.
- The package entry is now `src/index.ts`; the sources moved into `src/`.

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
