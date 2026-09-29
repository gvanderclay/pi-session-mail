# mailbox

A file mailbox between Pi sessions on the same machine. The npm package is
`pi-herald`.

Every session has an address — its session id — and an inbox under
`<agent dir>/mailbox/<address>/{tmp,new,cur,sent}/`. `/mailbox` shows this
session's address, and `/mailbox <address> <text>` sends a request. Mail waits
on disk until a session with that address starts or resumes; a running session
claims it into `cur/` and injects it once as a follow-up labelled as coming
from another Pi session, with the body cut at 32 KiB plus the envelope's path.
A request starts a turn when the session is idle; a reply does not, so it is
shown in an idle session and the agent sees it with the next message. A reply
also quotes each request it answers, capped at 2 KiB each with the `sent/`
copy's path, or the request's id alone when this session has no copy.

When the recipient's agent settles, its last answer goes back to each sender as
one reply listing the requests it answers: `done` normally, or `stopped` when
the user stopped the run, with the partial text. A request the session was
stopped before reading gets a `failed` reply instead. Replies are never
answered. The footer shows `✉ N pending · N read · N awaiting`, non-zero
counts only.

Other extensions integrate through the `pi.events` hooks below. They never
import this package or read its files.

## Install

```bash
pi install <path to this directory>
```

Once it is published, install it by name instead:

```bash
pi install npm:pi-herald
```

The package has no dependencies and no build step. The `pi` manifest loads only
`./index.ts`, and the tests under `test/` are neither loaded by Pi nor included
in the npm tarball.

## Requirements

- Pi, with `pi.events`, `pi.sendMessage`, `pi.on` and `pi.registerCommand`.
- `@earendil-works/pi-coding-agent` for `getAgentDir()`, declared as a peer
  dependency and supplied by Pi.
- A writable agent directory. The mailbox lives under `<agent dir>/mailbox/`
  and is safe to delete while no session is running.

## Configuration

None. `mailbox` reads no settings file and no environment variable of its
own, and it names no model.

## Statuses

A reply's `status` says what the run did. Requests carry no status.

| `status` | Meaning |
| --- | --- |
| `done` | the run settled; the body is its answer |
| `stopped` | the user stopped the run before it settled; the body says so, then the partial text |
| `failed` | the session was stopped before it read the request; nothing was done |
| `needs-input` | the run is waiting on the user; reserved, and nothing in `mailbox` sends it yet |

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
| `requests` | a reply's `in_reply_to` requests found in this session's `sent/`, each as `{ envelope, path }`; empty for a request, and shorter than `in_reply_to` when a copy is missing |
| `handled` | set to `true` by a listener that shows the message itself; `mailbox` then injects nothing |

A listener that sets `handled` owns the display, and chooses whether its own
message starts a turn (`triggerTurn`). A request a listener handled still
arms this session's reply and counts as read, so a takeover never leaves a
sender without an answer. A reply `mailbox` injects itself quotes each request
the same way, capped at 2 KiB with the copy's path.

```js message:inbound
// Take over replies to requests this extension sent; `mailbox` still shows
// requests and any mail the listener ignores.
pi.events.on("message:inbound", (payload) => {
  if (payload.handled) return;
  const { envelope, path, requests } = payload;
  if (envelope.in_reply_to.length === 0) return;
  payload.handled = true;
  const asked = requests.map(({ envelope: request, path: copy }) => `${request.body} (copy at ${copy})`);
  pi.sendMessage(
    {
      customType: "my-extension",
      content: `Reply from ${envelope.from} to ${asked.join("; ")}:\n${envelope.body}\n(claimed at ${path})`,
      display: true,
    },
    { triggerTurn: true, deliverAs: "followUp" },
  );
});
```
