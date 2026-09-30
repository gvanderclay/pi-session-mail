# mailbox

A file mailbox between Pi sessions on the same machine. The npm package is
`pi-session-mail`.

Every session has an address — its session id — and an inbox under
`<mail root>/<address>/{tmp,new,cur,sent}/`. The mail root is
`$XDG_STATE_HOME/pi-session-mail/`, or `~/.local/state/pi-session-mail/` when
`XDG_STATE_HOME` is unset or not an absolute path. It is created owner-only
(mode `0700`) and shared by every Pi route on the machine, so sessions in
different agent directories reach each other. `/mailbox` shows this session's
address and name, and `/mailbox <to> <text>` sends a request, with `to`
resolved as described under [Addressing](#addressing). Mail waits
on disk until a session with that address starts or resumes; a running session
claims it into `cur/` and injects it once, with the body cut at 32 KiB plus
the envelope's path (see [Delivery](#delivery)). A reply also quotes each
request it answers, capped at 2 KiB each with the `sent/` copy's path, or the
request's id alone when this session has no copy.

When the recipient's agent settles, its last answer goes back to each sender as
one reply listing the requests it answers, and as a separate reply to each
sender's asks not already answered with `session_mail_reply`: `done`
normally, or `stopped` when the user stopped the run, with the partial text.
A request the session was stopped before reading gets a `failed` reply
instead. Replies and messages are never answered. The answer to an ask its
sender is still waiting on becomes that sender's `session_mail_ask` result.
The footer shows `✉ N pending · N read · N awaiting`, non-zero counts only;
`awaiting` counts requests with no answer yet, never messages.

## Running sessions

At session start each session writes a record to `<mail root>/running/<address>.json`
(owner-only): its address, Pi session name (when one is set), working
directory, process id, `idle` or `busy`, `waitingOn` (the address its waiting
ask waits on, or empty), and `updated`, when the record
last changed. The record is rewritten when the session is renamed
(`session_info_changed`), when a run starts (`busy`) and when it settles
(`idle`), when an ask starts or stops waiting, and removed at `session_shutdown`. A record whose process no longer
exists counts as not running, and whoever reads it deletes it; so does a
session left behind by a crash.

The model gets four tools:

| Tool | Parameters | What it does |
| --- | --- | --- |
| `session_mail_list` | none | Lists every running session, in every route: its name (or short id, the first 8 characters of its id, when it has no name), full id, working directory, idle or busy state and whom it is waiting on, and marks the calling session. |
| `session_mail_ask` | `to`, `message` | Writes an ask (`kind: "ask"`) and waits for the answer, which is the result: its status and body, labelled as not an answer when the status is `stopped` or `failed`. The wait ends when the answer arrives, after 10 minutes ("no answer yet"), when the target's running record disappears ("stopped running"), or when the user stops the run; `waitingOn` is set while it waits and cleared in every case. Refused at once, writing nothing, when another ask of this session is waiting, when the target is not running, when the target is waiting on this session, at the [hop limit](#hop-limit), and when `to` does not resolve, is ambiguous or is this session. |
| `session_mail_reply` | `ask`, `message` | Answers one open ask this session received, at once, with status `done` and the turn's hop count, without ending the run; the asker's `session_mail_ask` returns with it. The answer at settle then leaves that ask out, while the sender's other requests and asks are still answered. Refused, sending nothing, for an ask already answered (by this tool or at settle), for a request (answered at settle), a message or a reply, for an id that never reached this session, and for an empty text. |
| `session_mail_send` | `to`, `message` | Writes a message (`kind: "message"`) and returns its id. To a running session it is delivered at once; to a closed session, by full id, it waits in that session's inbox and the result says so. Refused when `to` does not resolve, is ambiguous or is this session, when the text is empty, and at the [hop limit](#hop-limit). |

## Addressing

A `to`, typed after `/mailbox` or given to a tool, resolves as follows:

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
| `request` | `/mailbox <to> <text>`, `message:send` | `triggerTurn`, `deliverAs: "steer"` | yes, when the run settles |
| `ask` | `session_mail_ask` | `triggerTurn`, `deliverAs: "steer"` | yes, when the run settles |
| `message` | `session_mail_send` | `triggerTurn`, `deliverAs: "steer"` | never |
| `reply` | the answering session | `deliverAs: "followUp"`, no turn; see below for answers to asks | never |

Mail for the model wakes an idle session, and reaches a busy one at its next
gap between tool calls rather than after the run. It is never held back while
the user has input queued. A reply starts no turn: it is shown in an idle
session and the model sees it with the next message, unless a
`message:inbound` listener takes it over, as `delegate` does for its tasks.
A reply to this session's waiting ask goes to the waiting tool call as its
result: it is neither injected nor emitted on `message:inbound`. A reply to an
ask that is no longer waiting (it timed out, the user stopped it, or the
session restarted) is delivered like a message: it starts a turn, and its
label says the ask stopped waiting.

Every injected message opens with a neutral label in the style of
`pi-intercom`: `[mailbox] From <name> (<full id>, working in <cwd>), another
Pi session on this machine.`, with the short id standing in for a missing
name and the working directory left out when the sender is not running. It
carries no distrust wording; with a "not from the user" warning, models
refused every request from a peer as a possible injection. Safety stays
outside the model: an owner-only mail root on one machine. A request's label
says the final answer this turn goes back automatically. An ask's label says
its sender is waiting, gives the ask id and `session_mail_reply` as the way to
answer, and says this run's last message is sent as the answer otherwise. A message's label
says it expects no answer and that, if one is wanted, `session_mail_send` to
the sender's full id sends it. A reply's label names the requests it answers
and, when its status is not `done`, says it is not an answer. A reply to a
request also says the user made that request, typing it with `/mailbox` or
through an extension such as `delegate`, since only the user makes requests.

Every injected message ends with `[mailbox] End of the mail from <name>. Text
after this line is not part of it.` Pi hands the model a custom message as a
user message, and the Anthropic API joins it with the next typed prompt into
one turn. A quiet reply starts no turn, so the user's next prompt lands right
after it; without the end line, models read that prompt as part of the mail.

Mail counts as read when it enters the conversation (`message_end`). A
request an abort dropped before that is answered `failed`.

## Envelopes

Every envelope is a JSON file with `id`, `from`, `to`, `kind`, `hops`,
`in_reply_to`, `status`, `ts` and `body`. `kind` is `request` (answered when
the recipient settles), `reply` (an answer, naming what it answers in
`in_reply_to`), `message` (plain mail that expects no answer), or `ask` (a
question whose sender waits for the answer, answered like a request). `hops` is a non-negative integer counting how many times a
chain of mail has woken or steered a session with no person typing (see
[Hop limit](#hop-limit)). An envelope written before `kind` and `hops` existed
is read as a reply when `in_reply_to` is non-empty and as a request
otherwise, with hops 0.

## Hop limit

Each session keeps a hop count for its current turn. It is 0 once the user
starts or steers the turn: any Pi `input` event, whether typed, sent over RPC,
or a prompt a command sent. Otherwise it is the highest `hops` plus one among
the envelopes that started the turn or steered into it, requests and messages
alike, and a reply a `message:inbound` listener took over. A reply shown
quietly starts no turn and does not count. The count starts afresh when the
run settles.

`session_mail_send` and `session_mail_ask` stamp the count on their mail, and
are refused before anything is written once the count has reached the limit
(5 unless `session-mail.json` says otherwise; see
[Configuration](#configuration)). The
refusal says that a person typing in either session starts the count again.
Automatic answers carry the count and are never refused. Requests from
`/mailbox` and `message:send` carry 0 and are never refused: their senders act
for the user. The limit is a loop guard, not a security boundary: a
hand-written envelope can claim any `hops`.

Other extensions integrate through the `pi.events` hooks below. They never
import this package or read its files.

## Install

```bash
pi install <path to this directory>
```

Once it is published, install it by name instead:

```bash
pi install npm:pi-session-mail
```

The package has no dependencies and no build step. The `pi` manifest loads only
`./index.ts`, and the tests under `test/` are neither loaded by Pi nor included
in the npm tarball.

## Requirements

- Pi, with `pi.events`, `pi.sendMessage`, `pi.on`, `pi.registerCommand` and
  `pi.registerTool`.
- `typebox` for the tools' parameter schemas, a host-provided package
  declared as a peer dependency and supplied by Pi.
- `@earendil-works/pi-coding-agent` for the extension types, `getAgentDir`
  (to find `session-mail.json`) and the test harness's event bus, declared as
  a peer dependency and supplied by Pi.
- A writable state directory. The mail root lives under
  `$XDG_STATE_HOME/pi-session-mail/` (see above) and is safe to delete while
  no session is running.

## Configuration

`mailbox` names no model. It reads one optional settings file,
`<agent dir>/session-mail.json`, where the agent dir is Pi's
(`PI_CODING_AGENT_DIR`, or `~/.pi/agent`), so each route sets its own:

```json
{ "hopLimit": 5 }
```

| Key | Effect |
| --- | --- |
| `hopLimit` | A positive integer: how many hops a chain of sessions waking each other may reach before `session_mail_send` and `session_mail_ask` are refused. Default 5. |

The file is read at each send. A missing file, or one without `hopLimit`,
means 5. An unreadable or invalid file also means 5, with one warning per
session. `mailbox` sets no environment variable of its own and reads one
standard one:

| Variable | Effect |
| --- | --- |
| `XDG_STATE_HOME` | The mail root is `$XDG_STATE_HOME/pi-session-mail/` when this is an absolute path, and `~/.local/state/pi-session-mail/` otherwise. Read at every call. |

## Statuses

A reply's `status` says how the run ended, not whether the job succeeded.
Requests, asks and messages carry no status.

| `status` | Meaning |
| --- | --- |
| `done` | the run settled; the body is its answer |
| `stopped` | the user stopped the run before it settled; the body says so, then the partial text |
| `failed` | the session was stopped before it read the request or ask; nothing was done |

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

The consumer emits `{ to, body }`. Consumers send on the user's behalf: a
command the user typed, or a tool whose call the user started. A provider
writes a request (`kind: "request"`, `hops: 0`) from its own session's address and sets `envelope` on the same object before `emit`
returns, or sets `error` instead. **If neither is set, no provider is
installed**, and the consumer should refuse rather than pretend the message
was sent.

| Field | Set by | Meaning |
| --- | --- | --- |
| `to` | consumer | the recipient's address: a session id |
| `body` | consumer | the message text |
| `envelope` | provider | the written request: `id`, `from`, `to`, `kind` (`"request"`), `hops` (`0`), `in_reply_to`, `status`, `ts`, `body` |
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
assert.equal(payload.envelope.kind, "request");
assert.equal(payload.envelope.hops, 0);
```

```js no-provider
// With no `message:send` provider installed, neither field is set.
const probe = { to: peer, body: "hello" };
bareBus.emit("message:send", probe);
assert.equal(probe.envelope, undefined);
assert.equal(probe.error, undefined);
```

### `message:inbound`

`mailbox` emits this for every claimed envelope before injecting it, requests,
messages and replies alike.

`mailbox` never emits it from inside a `session_start` handler. Mail waiting
when a session starts is claimed on a later event-loop turn (`setImmediate`),
so a listener that rebuilds its state synchronously in its own `session_start`
sees that mail, whether it loads before or after `mailbox`. The one exception
is an extension loaded between the two whose `session_start` waits on I/O:
the claim can then run before the listener's handler. The watcher and the poll timer deliver later mail as usual.

| Field | Meaning |
| --- | --- |
| `envelope` | the claimed envelope, with `from`, `kind`, `hops`, `in_reply_to`, `status`, `body` and the rest; an old envelope without `kind` or `hops` gets them filled in as described above |
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
