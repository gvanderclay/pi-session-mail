# mailbox

A file mailbox between Pi sessions on the same machine.

Every session has an address — its session id — and an inbox under
`<agent dir>/mailbox/<address>/{tmp,new,cur,sent}/`. `/mailbox` shows this
session's address, and `/mailbox <address> <text>` sends a request. Mail waits
on disk until a session with that address starts or resumes; a running session
claims it into `cur/` and injects it once as a follow-up labelled as coming
from another Pi session, with the body cut at 32 KiB plus the envelope's path.
When the recipient's agent settles, its last answer goes back to each sender
as one `done` reply listing the requests it answers, and a request the session
was stopped before reading gets a `failed` reply instead. Replies are never
answered. The footer shows `✉ N pending · N read · N awaiting`, non-zero
counts only.

Other extensions integrate through the `pi.events` hooks below. They never
import this package or read its files.

## Install

```bash
pi install <path to this directory>
```

The package has no dependencies and no build step. Its tests are not part of
an install.

## Requirements

- Pi, with `pi.events`, `pi.sendMessage`, `pi.on` and `pi.registerCommand`.
- `@earendil-works/pi-coding-agent` for `getAgentDir()`, declared as a peer
  dependency and supplied by Pi.
- A writable agent directory. The mailbox lives under `<agent dir>/mailbox/`
  and is safe to delete while no session is running.

## Configuration

None. `mailbox` reads no settings file and no environment variable of its
own, and it names no model.

## Hooks

`mailbox` provides both hooks below and consumes none. Both are `pi.events`
channels, and both depend on listeners doing all their work
**synchronously**: the emitter reads the results off the payload the moment
`emit` returns, so a listener must finish before its first `await`.

The `js` blocks below are the contract's worked examples, and
`test/hooks.test.ts` extracts and runs them verbatim, one per block, on a real
`createEventBus`. Their scope is the test harness's: `pi` is the extension
API, `peer` is another session's address, `bareBus` is an event bus with no
`message:send` provider, and `assert` is `node:assert/strict`. Write them as
plain JavaScript so they stay runnable; the name after `js` is the test that
runs that block.

### `message:send`

The consumer emits `{ to, body }`. A provider writes a request from its own
session's address and sets `envelope` on the same object before `emit`
returns, or sets `error` instead. **If neither is set, no provider is
installed**, and the consumer should refuse rather than pretend the message
was sent.

| Field | Set by | Meaning |
| --- | --- | --- |
| `to` | consumer | the recipient's address: a session id |
| `body` | consumer | the message text |
| `envelope` | provider | the written request: `id`, `from`, `to`, `in_reply_to`, `status`, `ts`, `body` |
| `error` | provider | why nothing was written: no active session, or an invalid `to` or `body` |

The request's `id` is what a reply names in its `in_reply_to`, so a consumer
that wants its answers back should keep it.

```js message:send
// Send a request from this session and keep the id a reply will name.
const payload = { to: peer, body: "Please run the test suite." };
pi.events.emit("message:send", payload);

assert.equal(payload.error, undefined);
assert.ok(payload.envelope, "a provider sets `envelope` before `emit` returns");
assert.equal(typeof payload.envelope.id, "string");
```

```js no-provider
// With no `message:send` provider installed, neither field is set.
const probe = { to: peer, body: "hello" };
bareBus.emit("message:send", probe);
assert.equal(probe.envelope, undefined);
assert.equal(probe.error, undefined);
```

### `message:inbound`

`mailbox` emits this for every claimed envelope before injecting it, requests
and replies alike.

| Field | Meaning |
| --- | --- |
| `envelope` | the claimed envelope, with `from`, `in_reply_to`, `status`, `body` and the rest |
| `path` | the envelope's path in this session's `cur/` |
| `handled` | set to `true` by a listener that shows the message itself; `mailbox` then injects nothing |

A listener that sets `handled` owns the display, and chooses whether its own
message starts a turn (`triggerTurn`). A request a listener handled still
arms this session's reply and counts as read, so a takeover never leaves a
sender without an answer.

```js message:inbound
// Take over replies to requests this extension sent; `mailbox` still shows
// requests and any mail the listener ignores.
pi.events.on("message:inbound", (payload) => {
  if (payload.handled) return;
  const { envelope, path } = payload;
  if (envelope.in_reply_to.length === 0) return;
  payload.handled = true;
  pi.sendMessage(
    { customType: "my-extension", content: `Reply from ${envelope.from} (${path}): ${envelope.body}`, display: true },
    { triggerTurn: true, deliverAs: "followUp" },
  );
});
```
