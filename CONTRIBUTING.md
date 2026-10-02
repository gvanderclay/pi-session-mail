# Contributing

Bug reports and pull requests are welcome. Report a security problem
privately, as [SECURITY.md](SECURITY.md) explains, not in an issue.

## Setup

Node 22.19 or later and pnpm:

```sh
pnpm install
pnpm check   # lint, typecheck and tests, as CI runs them
```

One test file: `node --test test/hooks.test.ts`. To try a change in Pi, load
your checkout: `pi -e <path to this checkout>`.

## Pull requests

Every change reaches `main` through a pull request, and CI must pass before it
merges. Pull requests are squashed, so the title becomes the commit message:
say what changes for someone using pi-session-mail.

- Add a user-visible change under `## [Unreleased]` in `CHANGELOG.md`. Leave
  `version` alone; releases set it.
- The tests pin current behaviour. If your change makes one fail on purpose,
  update the test and say so in the pull request and in `CHANGELOG.md`.
- The hook examples in `README.md` are the hook contract:
  `test/hooks.test.ts` runs them. Changing one changes the contract that
  other extensions rely on, so say so in the pull request.
