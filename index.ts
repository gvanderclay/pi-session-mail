// `mailbox`: a file mailbox between Pi sessions on this machine.
//
// Every session has an address (its session id) and an inbox under
// `<agent dir>/mailbox/<address>/`. `/mailbox` shows the address and
// `/mailbox <address> <text>` sends a request. Mail in the inbox is claimed
// into `cur/` and injected as a follow-up that names the sending session; a
// reply quotes each request it answers from this session's `sent/` copy and,
// unlike a request, does not start a turn. When the recipient settles, its
// last answer goes back to each sender as one reply — `done` normally, or
// `stopped` when the user stopped the run, with any partial text. Requests
// that never entered the conversation (an abort drops queued follow-ups) get
// a `failed` reply instead. Replies are never answered. Other extensions use
// `pi.events` (below).
//
// Specs: .scratch/pi-mailbox/spec.md (the mailbox itself) and
// .scratch/pi-delegate/spec.md (the `message:*` hooks and this package's
// shape). The hook contracts live in this package's README.
import { type FSWatcher, watch } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	boxPath,
	claim,
	diskCounts,
	type Envelope,
	ensureBoxes,
	findSent,
	isAddress,
	listNew,
	readEnvelope,
	send,
	type SentCopy,
} from "./store.ts";

const CUSTOM_TYPE = "mailbox";
const STATUS_KEY = "mailbox";
/** Fallback rescan interval; `fs.watch` on macOS drops and coalesces events. */
const POLL_MS = 1000;
/** Inbound bodies are cut at this many UTF-8 bytes. */
const BODY_CAP = 32 * 1024;
/** Each request quoted in a reply is cut at this many UTF-8 bytes. */
const QUOTE_CAP = 2 * 1024;
/** Reply body when the run ended with no assistant text. */
const NO_ANSWER = "(The session settled with no answer text.)";
/** Reply body of a run the user stopped, with any partial answer text after it. */
const STOPPED = "(The user stopped this run before it finished; the text that follows, if any, is partial.)";
/** Body of a `failed` reply to requests that never entered the conversation. */
const UNSEEN = "(The session was stopped before it read the message. Nothing was done; send it again if it is still needed.)";

/** Cut `text` to at most `max` UTF-8 bytes on a character boundary; undefined when it already fits. */
function cap(text: string, max: number): string | undefined {
	const bytes = Buffer.from(text, "utf8");
	if (bytes.length <= max) return undefined;
	let end = max;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // back off a split character
	return bytes.subarray(0, end).toString("utf8");
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
	for (const id of ids) {
		const copy = findSent(me, id);
		if (copy === undefined) {
			quotes.push(`[mailbox] Your request ${id} has no copy in sent/; only its id is known.`);
			continue;
		}
		requests.push(copy);
		quotes.push(quoteRequest(copy));
	}
	return { requests, quotes };
}

/** The injected message: who it is from, the requests it answers, then its capped body. */
function inboundText(envelope: Envelope, path: string, quotes: readonly string[]): string {
	const header = [`[mailbox] Message from another Pi session at ${envelope.from}, not from the user.`];
	if (envelope.in_reply_to.length > 0)
		header.push(`It is a reply to your request${envelope.in_reply_to.length > 1 ? "s" : ""} ${envelope.in_reply_to.join(", ")}.`);
	if (envelope.in_reply_to.length > 0 && envelope.status !== "done")
		header.push(`Its status is "${envelope.status}", not "done": it is not an answer.`);
	const cut = cap(envelope.body, BODY_CAP);
	const body = cut === undefined ? envelope.body : `${cut}\n\n[mailbox] Body cut at 32 KiB; the full envelope is ${path}`;
	return [header.join(" "), ...quotes, body].join("\n\n");
}

/**
 * `pi.events` channels. Both rely on Pi's event bus running a listener's
 * synchronous code before `emit` returns; do all work before any `await`.
 *
 * - `message:send`: the caller emits `{ to, body }`; `mailbox` writes a
 *   request and sets `envelope` (or `error`) on the same object. Neither set
 *   means no provider is installed.
 * - `message:inbound`: emitted for every claimed envelope, requests and
 *   replies alike, before injection; `requests` holds a reply's request
 *   copies from this session's `sent/`, and a listener sets `handled` to show
 *   the message itself.
 */
const SEND = "message:send";
const INBOUND = "message:inbound";

type SendPayload = { to: unknown; body: unknown; envelope?: Envelope; error?: string };
type InboundPayload = { envelope: Envelope; path: string; requests: SentCopy[]; handled: boolean };

type Message = { role?: string; content?: unknown; stopReason?: unknown };

/** The last assistant message in a run's transcript, if any. */
function lastAssistant(messages: readonly unknown[]): Message | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Message;
		if (message?.role === "assistant") return message;
	}
	return undefined;
}

/** The text of an assistant message; undefined when it has none. */
function assistantText(message: Message): string | undefined {
	const content = message.content;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
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
	/** Text of the last assistant message, remembered at `agent_end`. */
	let lastAnswer: string | undefined;
	/** Whether that message's run was aborted (`stopReason: "aborted"`). */
	let lastAborted = false;
	/** Messages injected since the last settle, for the status's pending count. */
	let injected = 0;

	const warn = (message: string) => ctx?.ui.notify(`mailbox: ${message}`, "warning");

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
		const { requests, quotes } = requestQuotes(me, envelope.in_reply_to);
		// Listeners run synchronously inside emit, so `handled` is final when it returns.
		const inbound: InboundPayload = { envelope, path, requests, handled: false };
		pi.events.emit(INBOUND, inbound);
		// Only requests arm a reply, so replies are never answered. A request
		// arms one even when a listener took over its display.
		if (envelope.in_reply_to.length === 0) owed.set(envelope.from, [...(owed.get(envelope.from) ?? []), envelope.id]);
		// `mailbox` cannot observe a listener's own message, so a takeover counts as seen.
		if (inbound.handled) {
			seen.add(envelope.id);
			return;
		}
		injected++;
		pi.sendMessage(
			{ customType: CUSTOM_TYPE, content: inboundText(envelope, path, quotes), display: true, details: { id: envelope.id } },
			// A request starts a turn; a reply only shows itself to an idle session.
			envelope.in_reply_to.length === 0 ? { triggerTurn: true, deliverAs: "followUp" } : { deliverAs: "followUp" },
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
			payload.envelope = send(address, payload.to as string, payload.body);
			updateStatus();
		} catch (err) {
			payload.error = (err as Error).message;
		}
	});

	pi.on("session_start", async (_event, context) => {
		stop();
		ctx = context;
		owed = new Map();
		seen = new Set();
		lastAnswer = undefined;
		lastAborted = false;
		injected = 0;
		const id = context.sessionManager.getSessionId();
		if (!isAddress(id)) {
			address = undefined;
			warn(`session id ${JSON.stringify(id)} is not a usable address; the mailbox is off`);
			return;
		}
		address = id;
		ensureBoxes(id);
		updateStatus();
		// Mail already waiting is claimed on the next event-loop turn. The
		// runner awaits each `session_start` handler in load order, so every
		// later handler that does not wait on I/O runs first, and a listener
		// that rebuilds its state there sees the mail. The watcher and poll timer keep delivering
		// later mail. A microtask would still run before the next handler.
		pendingScan = setImmediate(() => {
			pendingScan = undefined;
			scan();
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

	pi.on("agent_end", async (event) => {
		const last = lastAssistant(event.messages);
		lastAnswer = last === undefined ? undefined : assistantText(last);
		lastAborted = last?.stopReason === "aborted";
	});

	// Reply only once Pi will not continue on its own: a retry, compaction or
	// queued follow-up after `agent_end` would otherwise get a premature answer.
	pi.on("agent_settled", async () => {
		const me = address;
		// A stopped run answers `stopped`, notes the stop, then gives what it had.
		const body = lastAborted
			? lastAnswer === undefined
				? STOPPED
				: `${STOPPED}\n\n${lastAnswer}`
			: (lastAnswer ?? NO_ANSWER);
		const status = lastAborted ? "stopped" : "done";
		const replies = owed;
		const read = seen;
		owed = new Map();
		seen = new Set();
		lastAnswer = undefined;
		lastAborted = false;
		injected = 0;
		if (me === undefined) return;
		for (const [to, ids] of replies) {
			const done = ids.filter((id) => read.has(id));
			const failed = ids.filter((id) => !read.has(id));
			try {
				if (done.length > 0) send(me, to, body, done, status);
				if (failed.length > 0) send(me, to, UNSEEN, failed, "failed");
			} catch (err) {
				warn(`could not reply to ${to}: ${(err as Error).message}`);
			}
		}
		updateStatus();
	});

	pi.on("session_shutdown", async () => {
		stop();
		address = undefined;
	});

	pi.registerCommand("mailbox", {
		description: "Show this session's mailbox address, or send a message: /mailbox <address> <text>",
		handler: async (args, context) => {
			const me = context.sessionManager.getSessionId();
			const trimmed = args.trim();
			if (trimmed === "") {
				context.ui.notify(`Mailbox address: ${me}`, "info");
				return;
			}
			const match = /^(\S+)\s+([\s\S]+)$/.exec(trimmed);
			if (!match) {
				context.ui.notify("Usage: /mailbox <address> <text>", "error");
				return;
			}
			try {
				const envelope = send(me, match[1], match[2].trim());
				context.ui.notify(`Sent ${envelope.id} to ${envelope.to}`, "info");
				updateStatus();
			} catch (err) {
				context.ui.notify(`mailbox: ${(err as Error).message}`, "error");
			}
		},
	});
}
