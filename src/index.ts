// pi-session-mail: a file mailbox between Pi sessions on this machine.
//
// Every session has an address (its session id) and an inbox under
// `<mail root>/<address>/`, where the mail root
// (`$XDG_STATE_HOME/pi-session-mail/`, or `~/.local/state/pi-session-mail/`)
// is shared by every agent directory, so sessions in different ones reach each other.
// Each running session also announces its name, working directory and idle or
// busy state in `<mail root>/running/<address>.json` (`running.ts`), which
// `session_mail_list` reports (`tools.ts`) and which lets a `to` name a
// session by its Pi session name or short id. `/mailbox` shows the address and
// name, and `/mailbox <to> <text>` sends a request; `session_mail_send` sends
// a message, which expects no answer. Mail in the inbox is claimed into `cur/`
// and injected with a label naming the sending session. Requests and messages
// wake an idle session and steer into a busy one; a reply quotes each request
// it answers from this session's `sent/` copy and starts no turn. When the recipient settles, its
// last answer goes back to each sender as one reply — `done` normally, or
// `stopped` when the user stopped the run, with any partial text, or `failed`
// when the run ended on an error, with the error and any partial text. A
// request is never answered `stopped`: a run the user stopped holds it, owed,
// until a run completes, and that answer says the user took over. Requests
// that never entered the conversation (an abort drops queued follow-ups) get
// a `failed` reply instead. Replies and messages are never answered. Other extensions use
// `pi.events` (below).
//
// The hook contracts live in this package's README.
import { type FSWatcher, statSync, watch } from "node:fs";
import { dirname } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isRunning,
	label,
	listRunning,
	type RunningRecord,
	removeRecord,
	resolveTo,
	type State,
	writeRecord,
} from "./running.ts";
import { type SettleInput, settle } from "./settle.ts";
import {
	boxPath,
	claim,
	diskCounts,
	type Envelope,
	ensureBoxes,
	findSent,
	isAddress,
	listNew,
	pruneClosed,
	readEnvelope,
	type SentCopy,
	send,
} from "./store.ts";
import { readSettings, registerTools, type Tools } from "./tools.ts";

const CUSTOM_TYPE = "mailbox";
const STATUS_KEY = "mailbox";
const DAY_MS = 24 * 60 * 60 * 1000;
/** Fallback rescan interval; `fs.watch` on macOS drops and coalesces events. */
const POLL_MS = 1000;
/** Inbound bodies are cut at this many UTF-8 bytes. */
const BODY_CAP = 32 * 1024;
/** Each request quoted in a reply is cut at this many UTF-8 bytes. */
const QUOTE_CAP = 2 * 1024;
/** Cut `text` to at most `max` UTF-8 bytes on a character boundary; undefined when it already fits. */
function cap(text: string, max: number): string | undefined {
	// `encodeInto` stops before a character that does not fit, so the cut is on a boundary.
	const { read } = new TextEncoder().encodeInto(text, new Uint8Array(max));
	return read === text.length ? undefined : text.slice(0, read);
}

/** A reply quotes each request it answers: the id, the copy's path, then the capped body. */
function quoteRequest(request: SentCopy): string {
	const cut = cap(request.envelope.body, QUOTE_CAP);
	const body =
		cut === undefined
			? request.envelope.body
			: `${cut}\n[mailbox] Request cut at 2 KiB; the full copy is ${request.path}`;
	return `[mailbox] Your request ${request.envelope.id}, quoted from ${request.path}:\n${body
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n")}`;
}

/**
 * The request copies this session holds for `ids`, and one quoted block per id
 * in order; an id with no copy is named by id alone.
 */
function requestQuotes(me: string, ids: readonly string[]): { requests: SentCopy[]; quotes: string[] } {
	const requests: SentCopy[] = [];
	const quotes: string[] = [];
	const copies = findSent(me, ids);
	for (const id of ids) {
		const copy = copies.get(id);
		if (copy === undefined) {
			quotes.push(`[mailbox] Your request ${id} has no copy in sent/; only its id is known.`);
			continue;
		}
		requests.push(copy);
		quotes.push(quoteRequest(copy));
	}
	return { requests, quotes };
}

/**
 * The sender's line, in the neutral style of `pi-intercom`'s `**From <name>** (<cwd>)`:
 * its session name (or short id), full id and, while it runs, its working
 * directory. No distrust wording: with it, models refused every peer request
 * as a possible injection (spec Q37). Safety lives outside the model.
 */
function senderLine(address: string, record: RunningRecord | undefined): { line: string; name: string } {
	const where = record === undefined ? "" : `, working in ${record.cwd}`;
	const name = label(record ?? { address });
	return { line: `[mailbox] From ${name} (${address}${where}), another Pi session on this machine.`, name };
}

/**
 * The last line of injected mail. Pi hands a custom message to the model as a
 * user message, and the Anthropic API joins it with the user's next typed
 * prompt into one turn, so without this line that prompt reads as the mail's.
 */
const endLine = (name: string) => `[mailbox] End of the mail from ${name}. Text after this line is not part of it.`;

/**
 * The injected message: who it is from, how to answer it, the requests it
 * answers, its capped body, then a line ending it. `byUser` marks a reply to a
 * request, which only the user makes (with `/mailbox` or through an extension).
 */
function inboundText(
	envelope: Envelope,
	path: string,
	quotes: readonly string[],
	opts: { lateAnswer: boolean; byUser: boolean },
): string {
	const { lateAnswer, byUser } = opts;
	const sender = senderLine(
		envelope.from,
		listRunning().find((r) => r.address === envelope.from),
	);
	const header = [sender.line];
	if (envelope.kind === "request") header.push("Your final answer this turn goes back to it automatically.");
	if (envelope.kind === "ask")
		header.push(
			`It is waiting for your answer to its ask ${envelope.id}. Answer with session_mail_reply (ask ${envelope.id}); otherwise this run's last message is sent as the answer.`,
		);
	if (lateAnswer) header.push("It answers an ask of yours that has stopped waiting, so it arrives as a message.");
	if (envelope.kind === "message")
		header.push(`It expects no answer; if one is wanted, send it with session_mail_send to ${envelope.from}.`);
	if (envelope.in_reply_to.length > 0)
		header.push(
			`It is a reply to your request${envelope.in_reply_to.length > 1 ? "s" : ""} ${envelope.in_reply_to.join(", ")}.`,
		);
	if (byUser)
		header.push("The user made that request, typing it with /mailbox or through an extension such as delegate.");
	if (envelope.in_reply_to.length > 0 && envelope.status !== "done")
		header.push(`Its status is "${envelope.status}", not "done": it is not an answer.`);
	const cut = cap(envelope.body, BODY_CAP);
	const body =
		cut === undefined ? envelope.body : `${cut}\n\n[mailbox] Body cut at 32 KiB; the full envelope is ${path}`;
	return [header.join(" "), ...quotes, body, endLine(sender.name)].join("\n\n");
}

/**
 * `pi.events` channels. Both rely on Pi's event bus running a listener's
 * synchronous code before `emit` returns; do all work before any `await`.
 *
 * - `message:send`: the caller emits `{ to, body }`; `pi-session-mail` writes a
 *   request, stamped with the run's hop count during a run and 0 when idle,
 *   and sets `envelope` (or `error`) on the same object. Neither set means no
 *   provider is installed.
 * - `message:inbound`: emitted for every claimed envelope, requests and
 *   replies alike, before injection; `requests` holds a reply's request
 *   copies from this session's `sent/`, and a listener sets `handled` to show
 *   the message itself.
 */
const SEND = "message:send";
const INBOUND = "message:inbound";
/** A consumer's request to claim waiting mail now; see the README's `message:scan`. */
const SCAN = "message:scan";

type SendPayload = { to: unknown; body: unknown; envelope?: Envelope; error?: string };
type InboundPayload = { envelope: Envelope; path: string; requests: SentCopy[]; handled: boolean };

type Message = { role?: string; content?: unknown; stopReason?: unknown; errorMessage?: unknown };

/** The last assistant message in a run's transcript, if any. */
function lastAssistant(messages: readonly unknown[]): Message | undefined {
	return (messages as Message[]).findLast((message) => message?.role === "assistant");
}

/** The text of the last assistant message that has any; undefined when none has. */
function lastAssistantText(messages: readonly unknown[]): string | undefined {
	const message = (messages as Message[]).findLast(
		(candidate) => candidate?.role === "assistant" && assistantText(candidate) !== undefined,
	);
	return message === undefined ? undefined : assistantText(message);
}

/** The text of an assistant message; undefined when it has none. */
function assistantText(message: Message): string | undefined {
	const content = message.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter(
							(part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string",
						)
						.map((part) => part.text)
						.join("\n")
				: "";
	return text.trim() === "" ? undefined : text;
}

export default function mailbox(pi: ExtensionAPI) {
	let address: string | undefined;
	let ctx: ExtensionContext | undefined;
	let watcher: FSWatcher | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	/** Envelope ids already handed to Pi in this process. */
	const delivered = new Set<string>();
	/** Request ids awaiting this session's reply, keyed by sender. In memory only. */
	let owed = new Map<string, string[]>();
	/** Owed request ids whose message entered the conversation (or a listener took over). */
	let seen = new Set<string>();
	/**
	 * Request ids held across a stop: the user stopped a run while they were
	 * owed, so they wait, still owed, for the next run that completes.
	 */
	let held = new Set<string>();
	/** Text of the last assistant message, remembered at `agent_end`. */
	let lastAnswer: string | undefined;
	/** Whether the user stopped that run, whatever its last message's `stopReason`. */
	let lastAborted = false;
	/** The error that ended that run when the user did not stop it; undefined when none did. */
	let lastError: string | undefined;
	/** Messages injected since the last settle, for the status's pending count. */
	let injected = 0;
	/**
	 * The hop count of the current turn: 0 once the user starts or steers it,
	 * otherwise the highest `hops` + 1 among the envelopes that started or
	 * steered into it. Mail sent from the turn carries it.
	 */
	let hops = 0;
	/** The problems with `session-mail.json` this session has already warned about. */
	let configWarned = new Set<string>();
	/** What this session's running-session record says. */
	let name: string | undefined;
	let cwd = "";
	let state: State = "idle";
	/** The address this session's ask waits on; empty when none. */
	let waitingOn = "";
	/** The model-facing tools, registered below; they hold the waiting ask. */
	let tools: Tools | undefined;

	/** Write this session's running-session record from the fields above. */
	function announce() {
		if (address === undefined) return;
		try {
			writeRecord({
				address,
				...(name === undefined ? {} : { name }),
				cwd,
				pid: process.pid,
				state,
				waitingOn,
				updated: new Date().toISOString(),
			});
		} catch (err) {
			warn(`could not write this session's running record: ${(err as Error).message}`);
		}
	}

	const warn = (message: string) => ctx?.ui.notify(`mailbox: ${message}`, "warning");

	/** The address folder is left as found; tell the user how to tighten it. */
	function warnIfLoose(me: string) {
		const folder = dirname(boxPath(me, "new"));
		let mode: number;
		try {
			mode = statSync(folder).mode & 0o777;
		} catch {
			return;
		}
		if ((mode & 0o077) === 0) return;
		warn(`${folder} is mode ${mode.toString(8)}, open to other users; run: chmod 700 ${folder}`);
	}

	/** Footer entry `✉ N pending · N read · N awaiting`, non-zero parts only; hidden when all are zero. */
	function updateStatus() {
		if (!ctx?.hasUI || address === undefined) return;
		const counts = diskCounts(address);
		const parts = [
			[counts.unclaimed + injected, "pending"],
			[counts.read, "read"],
			[counts.awaiting, "awaiting"],
		]
			.filter(([n]) => n !== 0)
			.map(([n, label]) => `${n} ${label}`);
		ctx.ui.setStatus(STATUS_KEY, parts.length > 0 ? `✉ ${parts.join(" · ")}` : undefined);
	}

	/** A first scan deferred to the next event-loop turn; see `session_start`. */
	let pendingScan: ReturnType<typeof setImmediate> | undefined;

	function stop() {
		watcher?.close();
		watcher = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		if (pendingScan !== undefined) {
			clearImmediate(pendingScan);
			pendingScan = undefined;
		}
	}

	function deliver(me: string, envelope: Envelope, path: string) {
		delivered.add(envelope.id);
		tools?.recordKind(envelope);
		// The answer to a waiting ask is that tool call's result, and nothing else.
		if (tools?.takeAnswer(envelope)) return;
		const { requests, quotes } = requestQuotes(me, envelope.in_reply_to);
		// An answer to an ask that stopped waiting is delivered like a message.
		const lateAnswer = envelope.kind === "reply" && requests.some((copy) => copy.envelope.kind === "ask");
		const wakes = envelope.kind !== "reply" || lateAnswer;
		const byUser = envelope.kind === "reply" && requests.some((copy) => copy.envelope.kind === "request");
		// Listeners run synchronously inside emit, so `handled` is final when it returns.
		const inbound: InboundPayload = { envelope, path, requests, handled: false };
		pi.events.emit(INBOUND, inbound);
		// Only requests arm an answer: replies are never answered, and messages
		// expect none. A request arms one even when a listener took over its display.
		if (envelope.kind === "request") owed.set(envelope.from, [...(owed.get(envelope.from) ?? []), envelope.id]);
		tools?.armAsk(envelope);
		// Mail that wakes or steers the session raises its count; a reply shown
		// quietly starts no turn, but one a listener took over may.
		if (wakes || inbound.handled) hops = Math.max(hops, envelope.hops + 1);
		// `pi-session-mail` cannot observe a listener's own message, so a takeover counts as seen.
		if (inbound.handled) {
			seen.add(envelope.id);
			return;
		}
		injected++;
		pi.sendMessage(
			{
				customType: CUSTOM_TYPE,
				content: inboundText(envelope, path, quotes, { lateAnswer, byUser }),
				display: true,
				details: { id: envelope.id },
			},
			// Mail for the model wakes an idle session and steers into a busy one at
			// its next gap between tool calls, queued user input or not; a reply only
			// shows itself, and starts no turn.
			wakes ? { triggerTurn: true, deliverAs: "steer" } : { deliverAs: "followUp" },
		);
	}

	/** Claim and deliver everything in `new/`, in name order. Synchronous, so scans never overlap. */
	function scan() {
		const me = address;
		if (me === undefined) return;
		const names = listNew(me);
		for (const name of names) {
			const path = claim(me, name);
			if (path === null) continue; // another scanner claimed it
			let envelope: Envelope;
			try {
				envelope = readEnvelope(path);
			} catch (err) {
				warn(`set aside malformed envelope ${path}: ${(err as Error).message}`);
				continue;
			}
			if (delivered.has(envelope.id)) continue;
			deliver(me, envelope, path);
		}
		if (names.length > 0) updateStatus();
	}

	// Synchronous on purpose: the caller reads the result on the payload as
	// soon as `emit` returns, so nothing here may wait on an `await`.
	pi.events.on(SEND, (data) => {
		const payload = data as SendPayload;
		if (typeof payload !== "object" || payload === null) return;
		try {
			if (address === undefined) throw new Error("no active session has a mailbox address");
			if (typeof payload.body !== "string") throw new Error("body must be a string");
			// During a run the caller is the model acting through an extension, so the
			// request continues the run's chain; idle, it acts for the user and starts a
			// fresh one. It is never refused here: the receiving side enforces the limit.
			const hopsNow = state === "busy" ? hops : 0;
			payload.envelope = send(address, payload.to as string, payload.body, { kind: "request", hops: hopsNow });
			updateStatus();
		} catch (err) {
			payload.error = (err as Error).message;
		}
	});

	// Synchronous on purpose: replies are emitted as `message:inbound` before
	// `emit` returns, and only then is the payload marked scanned.
	pi.events.on(SCAN, (data) => {
		const payload = data as { scanned?: boolean };
		if (typeof payload !== "object" || payload === null) return;
		scan();
		payload.scanned = true;
	});

	/** Warn about a problem with `session-mail.json`, once per session. */
	function configProblem(message: string) {
		if (configWarned.has(message)) return;
		configWarned.add(message);
		warn(message);
	}

	/** Remove closed sessions' folders that are older than `pruneAfterDays`; a failure warns and never throws. */
	function pruneOld(me: string) {
		try {
			const { pruneAfterDays } = readSettings(configProblem);
			pruneClosed({ own: me, isRunning, cutoffMs: Date.now() - pruneAfterDays * DAY_MS });
		} catch (err) {
			warn(`could not prune old mailbox folders: ${(err as Error).message}`);
		}
	}

	pi.on("session_start", async (_event, context) => {
		stop();
		ctx = context;
		owed = new Map();
		seen = new Set();
		held = new Set();
		lastAnswer = undefined;
		lastAborted = false;
		lastError = undefined;
		injected = 0;
		hops = 0;
		tools?.abandonAsk();
		waitingOn = "";
		configWarned = new Set();
		const id = context.sessionManager.getSessionId();
		if (!isAddress(id)) {
			address = undefined;
			tools?.setAddress(undefined);
			warn(`session id ${JSON.stringify(id)} is not a usable address; the mailbox is off`);
			return;
		}
		try {
			ensureBoxes(id);
		} catch (err) {
			address = undefined;
			tools?.setAddress(undefined);
			warn(`mailbox is off: ${(err as Error).message}`);
			return;
		}
		address = id;
		tools?.setAddress(id);
		warnIfLoose(id);
		name = context.sessionManager.getSessionName?.() || undefined;
		cwd = context.cwd;
		state = context.isIdle?.() === false ? "busy" : "idle";
		announce();
		updateStatus();
		// Mail already waiting is claimed on the next event-loop turn. The
		// runner awaits each `session_start` handler in load order, so every
		// later handler that does not wait on I/O runs first, and a listener
		// that rebuilds its state there sees the mail. The watcher and poll timer keep delivering
		// later mail. A microtask would still run before the next handler.
		pendingScan = setImmediate(() => {
			pendingScan = undefined;
			scan();
			pruneOld(id);
		});
		pendingScan.unref?.();
		try {
			watcher = watch(boxPath(id, "new"), () => scan());
			watcher.on("error", () => {});
			watcher.unref?.();
		} catch {
			// polling alone still delivers
		}
		timer = setInterval(scan, POLL_MS);
		timer.unref?.();
	});

	// An injected message counts as seen only once it enters the conversation;
	// stopping a run drops queued follow-ups without a trace.
	pi.on("message_end", async (event) => {
		const message = event.message as { role?: string; customType?: string; details?: { id?: unknown } };
		if (message?.role !== "custom" || message.customType !== CUSTOM_TYPE) return;
		if (typeof message.details?.id === "string") seen.add(message.details.id);
	});

	// Typed text, RPC input and a prompt a command sends all come from the
	// user, so each starts the chain again.
	pi.on("input", async () => {
		hops = 0;
	});

	pi.on("session_info_changed", async (event) => {
		name = event.name || undefined;
		announce();
	});

	pi.on("agent_start", async () => {
		state = "busy";
		announce();
	});

	// Esc aborts the run's signal. Stopped mid-text, the last message says
	// `aborted`; stopped during a tool call, Pi 0.99.1 ends the run with an empty
	// `error` message instead, so the signal is what tells a stop apart. The
	// partial answer is then the last text the model wrote before the stop.
	// An `error` message without an aborted signal is a real error (an API
	// failure Pi's retries gave up on); its partial answer is found the same way.
	pi.on("agent_end", async (event, context) => {
		const last = lastAssistant(event.messages);
		lastAborted = last?.stopReason === "aborted" || context.signal?.aborted === true;
		lastError =
			!lastAborted && last?.stopReason === "error"
				? typeof last.errorMessage === "string" && last.errorMessage.trim() !== ""
					? last.errorMessage.trim().replace(/\.+$/, "")
					: "unknown error"
				: undefined;
		lastAnswer =
			lastAborted || lastError !== undefined
				? lastAssistantText(event.messages)
				: last === undefined
					? undefined
					: assistantText(last);
	});

	// Reply only once Pi will not continue on its own: a retry, compaction or
	// queued follow-up after `agent_end` would otherwise get a premature answer.
	pi.on("agent_settled", async () => {
		const me = address;
		// Answers carry the settled turn's count; the next turn counts afresh.
		const answerHops = hops;
		hops = 0;
		const end: SettleInput["end"] = lastAborted
			? { kind: "stopped" }
			: lastError !== undefined
				? { kind: "failed", error: lastError }
				: { kind: "done" };
		const decision = settle({
			requests: owed,
			asks: tools?.takeOwedAsks() ?? new Map(),
			seen,
			held,
			end,
			answer: lastAnswer,
		});
		owed = decision.owed;
		held = decision.held;
		seen = new Set();
		lastAnswer = undefined;
		lastAborted = false;
		lastError = undefined;
		injected = 0;
		state = "idle";
		announce();
		if (me === undefined) return;
		for (const reply of decision.replies) {
			const { to } = reply;
			try {
				// Answers are never refused by the hop limit.
				send(me, to, reply.body, { kind: "reply", hops: answerHops, inReplyTo: reply.ids, status: reply.status });
			} catch (err) {
				warn(`could not reply to ${to}: ${(err as Error).message}`);
			}
		}
		updateStatus();
	});

	pi.on("session_shutdown", async () => {
		stop();
		tools?.abandonAsk();
		if (address !== undefined) {
			try {
				removeRecord(address);
			} catch {
				// a record left behind is dropped by the next reader once this process is gone
			}
		}
		address = undefined;
		tools?.setAddress(undefined);
	});

	tools = registerTools(pi, {
		sent: () => updateStatus(),
		waitingOn: (to) => {
			waitingOn = to;
			announce();
		},
		hops: () => hops,
		configProblem,
	});

	pi.registerCommand("mailbox", {
		description:
			"Show this session's mailbox address and name, send a request: /mailbox <name or id> <text>, or remove closed sessions' empty mailbox folders: /mailbox prune",
		handler: async (args, context) => {
			const me = context.sessionManager.getSessionId();
			const trimmed = args.trim();
			if (trimmed === "") {
				const current = context.sessionManager.getSessionName?.() || undefined;
				context.ui.notify(
					`Mailbox address: ${me}\nName: ${current === undefined ? `none; other sessions see ${label({ address: me })} (set one with /name)` : current}`,
					"info",
				);
				return;
			}
			if (trimmed === "prune") {
				try {
					const removed = pruneClosed({ own: me, isRunning });
					context.ui.notify(`Removed ${removed} mailbox folders of closed sessions`, "info");
				} catch (err) {
					context.ui.notify(`mailbox: ${(err as Error).message}`, "error");
				}
				return;
			}
			const match = /^(\S+)\s+([\s\S]+)$/.exec(trimmed);
			if (!match) {
				context.ui.notify("Usage: /mailbox <name or id> <text>", "error");
				return;
			}
			try {
				const to = resolveTo(match[1], me);
				const envelope = send(me, to, match[2].trim(), { kind: "request", hops: 0 });
				context.ui.notify(`Sent ${envelope.id} to ${envelope.to}`, "info");
				updateStatus();
			} catch (err) {
				context.ui.notify(`mailbox: ${(err as Error).message}`, "error");
			}
		},
	});
}
