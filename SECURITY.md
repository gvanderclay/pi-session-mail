# Security

pi-session-mail moves messages between Pi sessions run by one user on one
machine. It is not a boundary between users or between sessions: any process
running as that user can read, write or forge mail. This page says which
problems count as security bugs and how to report them.

## Reporting

Report privately through GitHub:
[open a security advisory](https://github.com/gvanderclay/pi-session-mail/security/advisories/new).
Do not open a public issue. Include what you ran, the mail root's layout, and
the files involved.

## In scope

- Another local user reading or writing mail: the mail root and everything
  under it must stay owner-only (mode `0700`).
- An envelope that makes the extension read or write outside the mail root,
  such as a crafted address, `from`, or file name that escapes its folder.
- An envelope that crashes the extension, or stops delivery for other mail,
  instead of being skipped.

## Out of scope

- Mail forged by a process running as the same user. It can already write to
  the mail root and to the session files directly.
- The hop limit. It stops two models from waking each other forever; it is a
  loop guard, not a security boundary, and a hand-written envelope can claim
  any `hops`.
- What a model does with mail it receives. A message is untrusted input that
  is injected into the session; the session's own permissions decide what the
  model can then do.
