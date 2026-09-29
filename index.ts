// `mailbox`: a file mailbox between Pi sessions on this machine.
//
// Every session has an address (its session id) and an inbox under
// `<agent dir>/mailbox/<address>/`. `/mailbox` shows the address and
// `/mailbox <address> <text>` sends a request. Mail in the inbox is claimed
// into `cur/` and injected as a follow-up that names the sending session.
// When the recipient settles, its last answer goes back to each sender as one
// `done` reply; requests that never entered the conversation (an abort drops
// queued follow-ups) get a `failed` reply instead. Replies are never answered.
// Other extensions use `pi.events` (below).
//
// Spec: .scratch/pi-mailbox/spec.md
import { type FSWatcher, watch } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { boxPath, claim, diskCounts, type Envelope, ensureBoxes, isAddress, listNew, readEnvelope, send } from "./store.ts";

const CUSTOM_TYPE = "mailbox";
const STATUS_KEY = "mailbox";
/** Fallback rescan interval; `fs.watch` on macOS drops and coalesces events. */
const POLL_MS = 1000;
/** Inbound bodies are cut at this many UTF-8 bytes. */
const BODY_CAP = 32 * 1024;
/** Reply body when the run ended with no assistant text. */
const NO_ANSWER = "(The session settled with no answer text.)";
/** Body of a `failed` reply to requests that never entered the conversation. */
const UNSEEN = "(The session was stopped before it read the message. Nothing was done; send it again if it is still needed.)";

/** Cut `body` to at most BODY_CAP bytes on a character boundary; undefined when it fits. */
function cap(body: string): string | undefined {
	const bytes = Buffer.from(body, "utf8");
	if (bytes.length <= BODY_CAP) return undefined;
	let end = BODY_CAP;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // back off a split character
	return bytes.subarray(0, end).toString("utf8");
}

function inboundText(envelope: Envelope, path: string): string {
	const header = [`[mailbox] Message from another Pi session at ${envelope.from}, not from the user.`];
	if (envelope.in_reply_to.length > 0)
		header.push(`It is a reply to your request${envelope.in_reply_to.length > 1 ? "s" : ""} ${envelope.in_reply_to.join(", ")}.`);
	if (envelope.in_reply_to.length > 0 && envelope.status !== "done")
		header.push(`Its status is "${envelope.status}", not "done": it is not an answer.`);
	const cut = cap(envelope.body);
	const body = cut === undefined ? envelope.body : `${cut}\n\n[mailbox] Body cut at 32 KiB; the full envelope is ${path}`;
	return `${header.join(" ")}\n\n${body}`;
}

/**
 * `pi.events` channels. Both rely on Pi's event bus running a listener's
 * synchronous code before `emit` returns; do all work before any `await`.
 *
 * - `mailbox:send`: the caller emits `{ to, body }`; `mailbox` writes a
 *   request and sets `envelope` (or `error`) on the same object. Neither set
 *   means `mailbox` is not installed.
 * - `mailbox:inbound`: emitted for every claimed envelope, requests and
 *   replies alike, before injection; a listener sets `handled` to show it
 *   itself.
 */
const SEND = "mailbox:send";
const INBOUND = "mailbox:inbound";

type SendPayload = { to: unknown; body: unknown; envelope?: Envelope; error?: string };
type InboundPayload = { envelope: Envelope; path: string; handled: boolean };

type Message = { role?: string; content?: unknown };

function lastAssistantText(messages: readonly unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Message;
		if (message?.role !== "assistant") continue;
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
	return undefined;
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

	function stop() {
		watcher?.close();
		watcher = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	function deliver(envelope: Envelope, path: string) {
		delivered.add(envelope.id);
		// Listeners run synchronously inside emit, so `handled` is final when it returns.
		const inbound: InboundPayload = { envelope, path, handled: false };
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
			{ customType: CUSTOM_TYPE, content: inboundText(envelope, path), display: true, details: { id: envelope.id } },
			{ triggerTurn: true, deliverAs: "followUp" },
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
			deliver(envelope, path);
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
		injected = 0;
		const id = context.sessionManager.getSessionId();
		if (!isAddress(id)) {
			address = undefined;
			warn(`session id ${JSON.stringify(id)} is not a usable address; the mailbox is off`);
			return;
		}
		address = id;
		ensureBoxes(id);
		scan();
		updateStatus();
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
		lastAnswer = lastAssistantText(event.messages);
	});

	// Reply only once Pi will not continue on its own: a retry, compaction or
	// queued follow-up after `agent_end` would otherwise get a premature answer.
	pi.on("agent_settled", async () => {
		const me = address;
		const body = lastAnswer ?? NO_ANSWER;
		const replies = owed;
		const read = seen;
		owed = new Map();
		seen = new Set();
		lastAnswer = undefined;
		injected = 0;
		if (me === undefined) return;
		for (const [to, ids] of replies) {
			const done = ids.filter((id) => read.has(id));
			const failed = ids.filter((id) => !read.has(id));
			try {
				if (done.length > 0) send(me, to, body, done);
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
