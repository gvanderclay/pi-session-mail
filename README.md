# pi-session-mail

A file mailbox between Pi sessions on the same machine.

Each Pi session gets an address and an inbox. You send a message to another
running session with `/mailbox:send`, and the model lists, asks, answers and
sends through four `session_mail_*` tools. Mail waits on disk until the
recipient starts or resumes. An ask's answer goes back to its sender
automatically; a request another extension sends through `message:send` gets
no automatic answer, because the extension that consumes it owns its reply and
sends it through `message:reply`.

## Install

Requires Pi 0.80.4 or later; tested with 1.0.0. You also need a writable
state directory. The package has no runtime dependencies and no build step.

Install the package from npm:

```bash
pi install npm:pi-session-mail
```

To follow the latest commit instead, install it from GitHub:

```bash
pi install git:github.com/gvanderclay/pi-session-mail
```

## First use

In a Pi session, open a picker of this session's mail:

```text
/mailbox
```

Its title names the session, its short address and the filter. The picker opens
on unread when there is unread mail, and on all otherwise. Tab cycles the filter
through unread, awaiting, read, sent and all, and Shift+Tab goes back. Each row shows the first line of
the mail, the other session (`from` for mail it received, `to` for mail it
sent), the kind and how long ago it was sent; the all and sent views also show
its status, and an awaiting row says whether its target is still running or
has closed. Enter opens the whole mail: the other session's name and full
address, the kind, the id, the absolute time, what it answers and the full
text. Esc goes back to the list, and Esc there closes the picker. `d` deletes
the selected read or sent item, or drops a request still awaiting a reply,
after a confirmation showing its first line; deleting a read reply also deletes
the `sent/` copies of the requests it answered. The picker reopens on the same
filter with the row that took the deleted one's place selected. `d` is left out
on unread mail. Showing mail never marks it read, so the footer's count stays
until the model sees it.

The session's id is its address. Other sessions see its Pi session name (set it
with `/name`), or the first 8 characters of its id when it has none.

In another session, send a message by picking a running session from a list
and then typing the text:

```text
/mailbox:send
```

The sender sees `Sent <id> to <address>`. A message wakes the recipient's model
and expects no answer. The model sends asks, messages and answers through the
`session_mail_*` tools, and an ask's last answer comes back to the sender as a
reply when that run settles.

The footer shows `📬 N unread` while mail has reached this session but not yet
entered its conversation, such as mail queued behind a busy run; it is hidden
at zero.

## How mail works

Every session has an address, its session id, and an inbox under
`<mail root>/<address>/{tmp,new,cur,sent}/`. The mail root is
`$XDG_STATE_HOME/pi-session-mail/`, or `~/.local/state/pi-session-mail/` when
`XDG_STATE_HOME` is unset or not an absolute path. Mail files are mode `0600`
and folders `0700`, and a session sets the root to `0700` even if it already
existed, so other users cannot read or write mail, while any process running
as you can. A session warns at start if its own address folder is open to
other users; it does not change the folder, so run the `chmod 700` it names.
The root is shared by every Pi agent directory on the machine, so sessions in
different agent directories reach each other. It is safe to delete while no
session is running.

Nothing calls `fsync`, so mail that was written just before a power failure or
an operating-system crash can be lost. The mail root must be on a local
filesystem, not NFS: an NFS `rename` that is retried after a lost reply can
report that the file is missing although it was moved, and watching a folder
for new mail is unreliable on a network filesystem.

Mail waits on disk until a session with that address starts or resumes. A
running session claims it into `cur/` and injects it once, with the body cut at
32 KiB plus the envelope's path (see [Delivery](#delivery)). A reply also
quotes each request it answers, capped at 2 KiB each with the `sent/` copy's
path, or the request's id alone when this session has no copy.

When the recipient's agent settles, its last answer goes back to each sender as
one reply listing that sender's asks not already answered with
`session_mail_reply`. The status is `done` normally, `stopped` when the user
stopped the run (with the partial text), or `failed` when the run ended on an
error (with the error and the partial text). An ask the session was stopped
before reading gets a `failed` reply instead. The answer to an ask its sender
is still waiting on becomes that sender's `session_mail_ask` result.

A request gets no automatic answer: not when its run completes, stops or
fails, not when the session never read it, and not when a `message:inbound`
listener took it over. The extension that consumes it owns its reply, and
sends it with the [`message:reply`](#messagereply) hook. Replies
and messages are never answered.

## Running sessions

At session start each session writes an owner-only record to
`<mail root>/running/<address>.json`. It holds the session's address, Pi
session name (when one is set), working directory, process id, `idle` or `busy`
state, `waitingOn` (the address its waiting ask waits on, or empty), and
`updated`, when the record last changed.

The record is rewritten when the session is renamed (`session_info_changed`),
when a run starts (`busy`) and when it settles (`idle`), and when an ask starts
or stops waiting. It is removed at `session_shutdown`. A record whose process
no longer exists counts as not running, and whoever reads it deletes it, so a
session left behind by a crash is cleaned up too. The record also holds
`started`, an opaque token for the process's start time (from `/proc` on Linux,
`ps` on macOS), so a record whose process id the operating system has reused
for another process is treated as gone too. A record without `started`, or a
platform where the start time cannot be read, is judged by the process id alone.

The model gets four tools:

| Tool | Parameters | What it does |
| --- | --- | --- |
| `session_mail_list` | none | Lists every running session, in every agent directory: its name (or short id, the first 8 characters of its id, when it has no name), full id, working directory, idle or busy state and whom it is waiting on, and marks the calling session. |
| `session_mail_ask` | `to`, `message` | Writes an ask (`kind: "ask"`). In a TUI session without `PI_UNATTENDED=1` it returns at once with outcome `background`, sets no `waitingOn`, and the answer arrives as a message. Everywhere else (print, JSON and RPC modes, and a TUI marked unattended, such as a pi-squire delegate) it waits for the answer, which is the result: its status and body, labelled as not an answer when the status is `stopped` or `failed`. The wait ends when the answer arrives, after 10 minutes ("no answer yet"), when the target's running record disappears ("stopped running"), or when the user stops the run; `waitingOn` is set while it waits and cleared in every case. Refused at once, writing nothing, when another ask of this session is waiting, when the target is not running, when the target is waiting on this session, and when `to` does not resolve, is ambiguous or is this session. |
| `session_mail_reply` | `ask`, `message` | Answers one open ask this session received, at once, with status `done`, without ending the run; the asker's `session_mail_ask` returns with it. The answer at settle then leaves that ask out, while the sender's other asks are still answered. Refused, sending nothing, for an ask already answered (by this tool or at settle), for a request (the extension that consumes it answers it), a message or a reply, for an id that never reached this session, and for an empty text. |
| `session_mail_send` | `to`, `message` | Writes a message (`kind: "message"`) and returns its id. To a running session it is delivered at once; to a closed session, by full id, it waits in that session's inbox and the result says so. Refused when `to` does not resolve, is ambiguous or is this session, and when the text is empty. |

## Addressing

A `to` given to a tool resolves as follows:

1. A running session's address, or any full session id (a UUID), resolves as
   given, so a closed session is still reached by its full id and its mail
   waits for it.
2. Otherwise `to` matches running sessions by exact Pi session name, then by
   an id prefix of at least 8 characters.
3. One match resolves. Several are refused, naming each candidate's name and
   full id; that includes a short id two sessions share. None is refused, with
   a note that a closed session is reached by its full id.
4. A session cannot send mail to itself.

`message:send` does not resolve names: its `to` is an address.

## Delivery

| Kind | Written by | Delivered as | Answered |
| --- | --- | --- | --- |
| `request` | `message:send` | `triggerTurn`, `deliverAs: "steer"` | never automatically; the extension that consumes it replies |
| `ask` | `session_mail_ask` | `triggerTurn`, `deliverAs: "steer"` | yes, with `session_mail_reply` or when the run settles |
| `message` | `session_mail_send`, `/mailbox:send` | `triggerTurn`, `deliverAs: "steer"` | never |
| `reply` | the answering session: `session_mail_reply` or settle for an ask, `message:reply` for a request | `deliverAs: "followUp"`, no turn; see below for answers to asks | never |

Mail for the model wakes an idle session, and reaches a busy one at its next
gap between tool calls rather than after the run. It is never held back while
the user has input queued. A reply starts no turn: it is shown in an idle
session and the model sees it with the next message, unless a `message:inbound`
listener takes it over, as pi-squire's `delegate` does for its tasks.

A reply to this session's waiting ask goes to the waiting tool call as its
result: it is neither injected nor emitted on `message:inbound`. A reply to an
ask that is not waiting (a background ask, or one that timed out, that the
user stopped, or whose session restarted) is delivered like a message: it
starts a turn, and its label says the ask is not waiting for it. An
unattended session waits rather than asking in the background because ending
its turn ends its work: a delegate's settle is its result, and print mode
exits.

Every injected message opens with a neutral label: `[mailbox] From <name>
(<full id>, working in <cwd>), another Pi session on this machine.` The short
id stands in for a missing name, and the working directory is left out when the
sender is not running. The label carries no distrust wording. Safety stays
outside the model: an owner-only mail root on one machine. The rest of the
label depends on the kind:

- A request's label is the sender line alone; it promises no answer.
- An ask's label says its sender is waiting, gives the ask id and
  `session_mail_reply` as the way to answer, and says this run's last message
  is sent as the answer otherwise.
- A message's label says it expects no answer and that, if one is wanted,
  `session_mail_send` to the sender's full id sends it.
- A reply's label names the requests it answers and, when its status is not
  `done`, says it is not an answer. A reply to a request also says the user
  made that request through an extension such as `delegate`, since only the
  user makes requests.

The label is built from fields any process running as you can write: the
envelope's `id`, `status` and the ids in `in_reply_to`, and the sender's name
and working directory in its running record. Each control character in them,
and in the file paths the label names (C0 controls, tab included, DEL and C1
controls, and the line and paragraph separators U+2028 and U+2029), is
replaced by a space, so a forged value cannot start a line of its own that
passes for a `[mailbox]` line.

Every injected message ends with `[mailbox] End of the mail from <name>. Text
after this line is not part of it.` Pi hands the model a custom message as a
user message, and the Anthropic API joins it with the next typed prompt into
one turn. A quiet reply starts no turn, so the user's next prompt lands right
after it; without the end line, models read that prompt as part of the mail.

Mail counts as read when it enters the conversation (`message_end`). An ask
an abort dropped before that is answered `failed`. Asks are never held across a
stop, because their sender is blocked waiting: a stopped run answers them
`stopped` at once.

## Envelopes

Every envelope is a JSON file with `id`, `from`, `to`, `kind`,
`in_reply_to`, `status`, `ts` and `body`. `kind` is one of:

- `request`, mail another extension sends through `message:send`; the
  extension that consumes it in the recipient answers it, if anything does.
- `reply`, an answer that names what it answers in `in_reply_to`.
- `message`, plain mail that expects no answer.
- `ask`, a question whose sender waits for the answer, answered with
  `session_mail_reply` or when the recipient settles.

A `kind` this version does not know is read as `message`: the envelope is
delivered, wakes the session and expects no answer. The original value is not
kept. This lets a copy of the package that is older than the sender's still
deliver its mail.

An envelope whose `in_reply_to` names more than 50 requests (50 is allowed) is
set aside with a warning, like any other envelope that cannot be read: it stays in `cur/`
and is not delivered.

An envelope written before `kind` existed is read as a reply when `in_reply_to`
is non-empty and as a request otherwise.

There is no hop count or other limit on chains of mail: sessions can keep waking
each other. An old envelope that still carries a `hops` property is read and
delivered like any other, and the property is ignored.

A reply's `status` says how the run ended, not whether the job succeeded.
Requests, asks and messages carry no status. A reply sent through
`message:reply` carries the status its consumer gave, one of the three below.

| `status` | Meaning |
| --- | --- |
| `done` | the run settled; the body is its answer |
| `stopped` | the user stopped the run before it settled; the body says so, then the partial text |
| `failed` | the run did not do the job, and the body says why: either the run ended on an error (such as an API error Pi's retries gave up on), and the body gives the error, then the partial text; or the session was stopped before it read the ask, and nothing was done |

## Pruning

Folders of closed sessions would otherwise pile up in the mail root. At session
start, a session removes an address folder when all of these hold:

- it is not this session's, and no running session has that address;
- nothing is waiting in its `new/`, so unread mail is never deleted;
- its last activity, the newest change to the folder or its four boxes, is
  older than `pruneAfterDays` days.

Removing a folder removes everything in it: the read mail in `cur/` and the
copies of sent requests in `sent/` go too, not only the empty `new/`. Only real
folders named like an address are considered; `running/`, symlinks and other
names are left alone. The work runs after `session_start` returns.

To clean up at once, type `/mailbox:prune`. It applies the same rules without
the age limit, so it removes the folder (with its `cur/` and `sent/`) of every
closed session with no unread mail, including one that closed a minute ago. It
reports `Removed <N> mailbox folders of closed sessions`.

## Configuration

`pi-session-mail` names no model. It reads one optional settings file,
`<agent dir>/session-mail.json`, where the agent dir is Pi's
(`PI_CODING_AGENT_DIR`, or `~/.pi/agent`), so each agent directory sets its own:

```json
{ "pruneAfterDays": 30 }
```

| Key | Effect |
| --- | --- |
| `pruneAfterDays` | A positive integer: how many days a closed session's mailbox folder is kept before it is [pruned](#pruning). Default 30. |

The file is read at session start. A missing file, or one
without a key, means that key's default. An unreadable or invalid file, or an
invalid value, also means the default (30 days), with one warning per
session. A key this version does not know, such as the former `hopLimit`, is ignored.

The only environment variable it reads is the standard `XDG_STATE_HOME`, at
every call, to place the mail root (see [How mail works](#how-mail-works)). It
sets no environment variable of its own.

## Hooks

Other extensions integrate through the `pi.events` hooks below. They never
import this package or read its files.

`pi-session-mail` provides all four hooks and consumes none. All four depend
on listeners doing all their work **synchronously**: the emitter reads the
results off the payload the moment `emit` returns, so a listener must finish
before its first `await`.

The `js` blocks below are the contract's worked examples, and
`test/hooks.test.ts` extracts and runs them verbatim, one per block, on a real
`createEventBus`. Their scope is the test harness's: `pi` is the extension
API, `peer` is another session's address, `bareBus` is an event bus with no
`message:send` provider, `peerPi` is the extension API of the session at
`peer` (in the examples that need both ends), and `assert` is
`node:assert/strict`. Write them as
plain JavaScript so they stay runnable; the name after `js` is the test that
runs that block.

### `message:send`

The consumer emits `{ to, body }`. Consumers send on the user's behalf: a
command the user typed, or a tool whose call the user started. A provider
writes a request (`kind: "request"`) from its own session's address and sets
`envelope` on the same object before `emit` returns, or sets `error` instead.
**If neither is set, no provider is installed**, and the consumer should
refuse rather than pretend the message was sent.

| Field | Set by | Meaning |
| --- | --- | --- |
| `to` | consumer | the recipient's address: a session id |
| `body` | consumer | the message text |
| `envelope` | provider | the written request: `id`, `from`, `to`, `kind` (`"request"`), `in_reply_to`, `status`, `ts`, `body` |
| `error` | provider | why nothing was written: no active session, or an invalid `to` or `body` |

The request's `id` is what a reply names in its `in_reply_to`, so a consumer
that wants its answers back should keep it. `pi-session-mail` never answers a
request by itself: the extension that consumes it in the recipient session
sends any reply, through [`message:reply`](#messagereply).

```js message:send
// Send a request from this session and keep the id a reply will name.
const payload = { to: peer, body: "Please run the test suite." };
pi.events.emit("message:send", payload);

assert.equal(payload.error, undefined);
assert.ok(payload.envelope, "a provider sets `envelope` before `emit` returns");
assert.equal(typeof payload.envelope.id, "string");
assert.equal(payload.envelope.kind, "request");
assert.equal("hops" in payload.envelope, false);
```

```js no-provider
// With no `message:send` provider installed, neither field is set.
const probe = { to: peer, body: "hello" };
bareBus.emit("message:send", probe);
assert.equal(probe.envelope, undefined);
assert.equal(probe.error, undefined);
```

### `message:reply`

A consumer that took over a request emits `{ to, inReplyTo, body, status }` to
answer it, whenever its work is done. A provider writes a reply (`kind:
"reply"`) from its own session's address and sets `envelope` on the same
object before `emit` returns, or sets `error` instead and writes nothing.
**If neither is set, no provider is installed**, as with `message:send`.

| Field | Set by | Meaning |
| --- | --- | --- |
| `to` | consumer | the request's sender: a session id, checked as `message:send` checks it |
| `inReplyTo` | consumer | the ids of the requests this answers: a non-empty list of non-empty strings, at most 50 |
| `body` | consumer | the reply text: any string, empty included |
| `status` | consumer | required: `"done"`, `"stopped"` or `"failed"`, with the meanings in [Envelopes](#envelopes) |
| `envelope` | provider | the written reply: `id`, `from`, `to`, `kind` (`"reply"`), `in_reply_to`, `status`, `ts`, `body` |
| `error` | provider | why nothing was written: no active session, an invalid field, or a failed write |

The hook is for answering requests. The reply's `from` is always this
session; a `from` on the payload is ignored. `body` and `status` are written
exactly as given: the reply does not wait for the run to settle, does not use
the model's answer and adds no wording. `inReplyTo` is checked for shape only:
its ids are not looked up in this session's mailbox, so the hook does not
check that they name requests this session received. Nothing stops a second
reply to the same request either: every valid call writes one, and the
consumer makes sure it answers once. An ask is answered with
`session_mail_reply` or at settle, never through this hook, which leaves an
ask's bookkeeping alone.

The reply goes through the mailbox like any other: one the sender is not
running to receive waits in its inbox and is claimed when it starts again.
The sender then gets it through `message:inbound` with its `requests` copies,
and a listener there can take it over.

```js message:reply
// The consumer in the peer session takes over the requests it receives.
const taken = [];
peerPi.events.on("message:inbound", (inbound) => {
  if (inbound.handled || inbound.envelope.kind !== "request") return;
  inbound.handled = true;
  taken.push(inbound.envelope);
});

// This session sends a request, and the peer claims it now.
const request = { to: peer, body: "Please run the test suite." };
pi.events.emit("message:send", request);
peerPi.events.emit("message:scan", {});
assert.equal(taken.length, 1);

// When its work is done, the consumer answers from the peer session.
const reply = { to: taken[0].from, inReplyTo: [taken[0].id], body: "All 42 tests pass.", status: "done" };
peerPi.events.emit("message:reply", reply);
assert.equal(reply.error, undefined);
assert.ok(reply.envelope, "a provider sets `envelope` before `emit` returns");
assert.equal(reply.envelope.kind, "reply");
assert.equal(reply.envelope.from, peer);

// The reply reaches this session through `message:inbound`, unchanged.
const replies = [];
pi.events.on("message:inbound", (inbound) => replies.push(inbound));
pi.events.emit("message:scan", {});
assert.equal(replies.length, 1);
const [{ envelope, requests }] = replies;
assert.deepEqual(envelope.in_reply_to, [request.envelope.id]);
assert.equal(envelope.body, "All 42 tests pass.");
assert.equal(envelope.status, "done");
assert.equal(requests[0].envelope.id, request.envelope.id);

// Invalid input sets `error` and writes nothing.
const unknown = { to: peer, inReplyTo: [request.envelope.id], body: "?", status: "maybe" };
pi.events.emit("message:reply", unknown);
assert.equal(unknown.envelope, undefined);
assert.match(unknown.error, /status/);

// With no provider installed, neither field is set.
const probe = { to: peer, inReplyTo: [request.envelope.id], body: "hello", status: "done" };
bareBus.emit("message:reply", probe);
assert.equal(probe.envelope, undefined);
assert.equal(probe.error, undefined);
```

### `message:inbound`

`pi-session-mail` emits this for every claimed envelope before injecting it,
requests, messages and replies alike.

`pi-session-mail` never emits it from inside a `session_start` handler. Mail
waiting when a session starts is claimed on a later event-loop turn
(`setImmediate`), so a listener that rebuilds its state synchronously in its
own `session_start` sees that mail, whether it loads before or after
`pi-session-mail`. The one exception is an extension loaded between the two
whose `session_start` waits on I/O: the claim can then run before the
listener's handler. The watcher and the poll timer deliver later mail as usual.

| Field | Meaning |
| --- | --- |
| `envelope` | the claimed envelope, with `from`, `kind`, `in_reply_to`, `status`, `body` and the rest; an old envelope without `kind` gets it filled in as described above |
| `path` | the envelope's path in this session's `cur/` |
| `requests` | a reply's `in_reply_to` requests found in this session's `sent/`, each as `{ envelope, path }`; empty for a request, and shorter than `in_reply_to` when a copy is missing |
| `handled` | set to `true` by a listener that shows the message itself; `pi-session-mail` then injects nothing |

A listener that sets `handled` owns the display, and chooses whether its own
message starts a turn (`triggerTurn`). Handled mail counts as read, and an
ask a listener handled is still answered when this session settles. A request
arms no answer, handled or not: the listener that consumes it owns its reply. A
reply `pi-session-mail` injects itself quotes each
request the same way, capped at 2 KiB with the copy's path.

```js message:inbound
// Take over replies to requests this extension sent; `pi-session-mail` still shows
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

### `message:scan`

A consumer emits `{}` to have `pi-session-mail` claim the mail waiting in its
inbox now, instead of at the next watcher event or poll. The listener runs the
inbox scan synchronously, so every waiting envelope has been emitted as
`message:inbound` (and delivered) by the time `emit` returns, and then sets
`scanned` to `true`. **If `scanned` is not set, no provider is installed**,
and the consumer must not conclude that no reply is waiting.

| Field | Set by | Meaning |
| --- | --- | --- |
| `scanned` | provider | `true` once the scan has finished and its `message:inbound` events were emitted |

The `delegate` tool in [pi-squire](https://github.com/gvanderclay/pi-squire)
uses this before checking whether a delegate's window is gone, so a reply
written just before the window closed is claimed first.

```js message:scan
// Claim waiting mail now; a waiting reply reaches `message:inbound` listeners
// before `emit` returns. This example runs with one reply waiting.
const seen = [];
pi.events.on("message:inbound", (inbound) => seen.push(inbound.envelope.id));
const payload = {};
pi.events.emit("message:scan", payload);
assert.equal(payload.scanned, true);
assert.equal(seen.length, 1, "the waiting reply was emitted during emit");

// With no provider installed, `scanned` stays unset.
const probe = {};
bareBus.emit("message:scan", probe);
assert.equal(probe.scanned, undefined);
```

## Compatibility

Sessions running older and newer copies of `pi-session-mail` share one mail
root, and other extensions depend on its hooks, so these are stable:

- The four hooks, `message:send`, `message:reply`, `message:inbound` and
  `message:scan`, and their payloads as [Hooks](#hooks) describes them.
- The `[mailbox] From …` label and the `[mailbox] End of the mail …` line that
  frame injected mail.
- The mail root path, `$XDG_STATE_HOME/pi-session-mail/`, or
  `~/.local/state/pi-session-mail/` when `XDG_STATE_HOME` is unset or not
  absolute.
- The envelope fields (`id`, `from`, `to`, `kind`, `in_reply_to`,
  `status`, `ts`, `body`), the kinds (`request`, `reply`, `message`, `ask`)
  and a reply's statuses (`done`, `stopped`, `failed`); see
  [Envelopes](#envelopes).
- The names of the tools (`session_mail_list`, `session_mail_send`,
  `session_mail_ask`, `session_mail_reply`) and of the `/mailbox`,
  `/mailbox:send` and `/mailbox:prune` commands.
- The keys of `session-mail.json`, today `pruneAfterDays`.

Changing any of them needs a major version from 1.0 on, and a minor version
while the package is at 0.x.

## More

- [CONTRIBUTING.md](https://github.com/gvanderclay/pi-session-mail/blob/main/CONTRIBUTING.md) explains how to set up, test and propose a
  change.
- [CHANGELOG.md](CHANGELOG.md) lists what changed in each release.
- [SECURITY.md](https://github.com/gvanderclay/pi-session-mail/blob/main/SECURITY.md) explains how to report a security problem.

## License

[MIT](LICENSE)
