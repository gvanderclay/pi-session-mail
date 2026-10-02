// The mailbox's directories and envelopes on disk. Internal to `pi-session-mail`:
// tests reach it only through the extension's registration function (`settle.ts` is
// the one module tested directly).
//
// Layout: <root>/<address>/{tmp,new,cur,sent}/<ms>-<id>.json, where the root
// is `$XDG_STATE_HOME/pi-session-mail/` (or `~/.local/state/pi-session-mail/`)
// and is shared by every Pi agent directory on this machine.
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** What an envelope is: answered at settle, waited on, plain, or an answer. */
export type Kind = "request" | "ask" | "message" | "reply";
const KINDS: readonly Kind[] = ["request", "ask", "message", "reply"];

export type Envelope = {
	id: string;
	from: string;
	to: string;
	kind: Kind;
	/** How many times this chain of mail has woken or steered a session with no person typing. */
	hops: number;
	/** Request ids this envelope answers; empty for a request. */
	in_reply_to: string[];
	status: string;
	ts: string;
	body: string;
};

type Box = "tmp" | "new" | "cur" | "sent";
const BOXES: Box[] = ["tmp", "new", "cur", "sent"];

const ADDRESS = /^[A-Za-z0-9_-]+$/;

/** The most requests one reply may name; an envelope over this is not read. */
const MAX_REPLY_IDS = 50;

/** An address is a single safe path segment: letters, digits, `-` and `_`. */
export const isAddress = (value: unknown): value is string => typeof value === "string" && ADDRESS.test(value);

/**
 * The mail root, read at call time so a changed `XDG_STATE_HOME` is honoured.
 * A relative `XDG_STATE_HOME` is ignored, as the XDG spec requires.
 */
export function mailRoot(): string {
	const state = process.env.XDG_STATE_HOME;
	const base = state !== undefined && isAbsolute(state) ? state : join(homedir(), ".local", "state");
	return join(base, "pi-session-mail");
}

export function boxPath(address: string, box: Box): string {
	if (!isAddress(address)) throw new Error(`invalid mailbox address: ${JSON.stringify(address)}`);
	return join(mailRoot(), address, box);
}

/** Create the root and `address`'s boxes; the root is made or set owner-only, and so is every directory made here. */
export function ensureBoxes(address: string): void {
	mkdirSync(mailRoot(), { recursive: true, mode: 0o700 });
	// mkdirSync leaves a directory that already exists as it was. A root this
	// user cannot chmod (another owner, a read-only mount) is used as it is.
	try {
		chmodSync(mailRoot(), 0o700);
	} catch {
		// best effort
	}
	for (const box of BOXES) mkdirSync(boxPath(address, box), { recursive: true, mode: 0o700 });
}

// Names sort in send order: a strictly increasing millisecond stamp in this
// process, zero-padded, then the id.
let lastMs = 0;
function stamp(): number {
	lastMs = Math.max(Date.now(), lastMs + 1);
	return lastMs;
}

const fileName = (ms: number, id: string) => `${String(ms).padStart(15, "0")}-${id}.json`;

/** How `send` writes an envelope. A reply names what it answers in `inReplyTo`. */
export type SendOptions = { kind: Kind; hops: number; inReplyTo?: string[]; status?: string };

/**
 * Write an envelope to `to`'s inbox: into its `tmp/`, then renamed into its
 * `new/`. A request is also copied into the sender's `sent/`, first; if any
 * step fails the copy is removed again and the send throws, so a thrown send
 * has delivered nothing. Synchronous,
 * so a `pi.events` caller sees the result as soon as `emit` returns.
 * A reply's `status` is `done` unless given; any other kind's is empty.
 */
export function send(from: string, to: string, body: string, options: SendOptions): Envelope {
	if (!isAddress(from)) throw new Error(`invalid sender address: ${JSON.stringify(from)}`);
	if (!isAddress(to)) throw new Error(`invalid address: ${JSON.stringify(to)} (expected a session id)`);
	if (!KINDS.includes(options.kind)) throw new Error(`invalid kind: ${JSON.stringify(options.kind)}`);
	if (!isHops(options.hops)) throw new Error(`invalid hops: ${JSON.stringify(options.hops)}`);
	const inReplyTo = options.inReplyTo ?? [];
	const ms = stamp();
	const envelope: Envelope = {
		id: randomUUID(),
		from,
		to,
		kind: options.kind,
		hops: options.hops,
		in_reply_to: inReplyTo,
		status: options.kind === "reply" ? (options.status ?? "done") : "",
		ts: new Date(ms).toISOString(),
		body,
	};
	const name = fileName(ms, envelope.id);
	const text = `${JSON.stringify(envelope, null, 2)}\n`;
	ensureBoxes(to);
	const tmp = join(boxPath(to, "tmp"), name);
	// The sender's copy goes first, so a send that throws has delivered nothing:
	// a failure after it removes the copy and the `tmp/` file again.
	let copy: string | undefined;
	try {
		if (options.kind !== "reply") {
			ensureBoxes(from);
			copy = join(boxPath(from, "sent"), name);
			writeFileSync(copy, text, { mode: 0o600 });
		}
		writeFileSync(tmp, text, { mode: 0o600 });
		renameSync(tmp, join(boxPath(to, "new"), name));
	} catch (err) {
		for (const path of [copy, tmp]) if (path !== undefined) rmSync(path, { force: true });
		throw err;
	}
	return envelope;
}

/** A regular file, the only kind of name worth reading; a FIFO, directory or symlink is not. */
function isFile(path: string): boolean {
	try {
		return lstatSync(path).isFile();
	} catch {
		return false;
	}
}

/** `.json` names in `box` that are regular files, in readdir order. */
function jsonFiles(address: string, box: Box): string[] {
	const dir = boxPath(address, box);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names.filter((name) => name.endsWith(".json") && isFile(join(dir, name)));
}

/** Regular `.json` files waiting in `new/`, in send order. */
export function listNew(address: string): string[] {
	return jsonFiles(address, "new").sort();
}

/** Claim a file by renaming it from `new/` into `cur/`; null when another scanner got it first. */
export function claim(address: string, name: string): string | null {
	const target = join(boxPath(address, "cur"), name);
	try {
		renameSync(join(boxPath(address, "new"), name), target);
		return target;
	} catch {
		return null;
	}
}

/** A request's copy in its sender's `sent/`, with its path. */
export type SentCopy = { envelope: Envelope; path: string };

const isHops = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

/**
 * Parse an envelope file; throws when it is not a well-formed envelope from a
 * valid address. An envelope written before `kind` and `hops` existed is read
 * as a reply when it answers something and as a request otherwise, with hops 0.
 */
export function readEnvelope(path: string): Envelope {
	const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Envelope>;
	if (typeof value !== "object" || value === null) throw new Error("not an object");
	if (typeof value.id !== "string" || value.id === "") throw new Error("missing id");
	if (!isAddress(value.from)) throw new Error(`invalid from address ${JSON.stringify(value.from)}`);
	if (!Array.isArray(value.in_reply_to) || !value.in_reply_to.every((id) => typeof id === "string"))
		throw new Error("in_reply_to is not a list of ids");
	if (value.in_reply_to.length > MAX_REPLY_IDS)
		throw new Error(`in_reply_to names more than ${MAX_REPLY_IDS} requests`);
	if (typeof value.body !== "string") throw new Error("missing body");
	if (value.kind === undefined) value.kind = value.in_reply_to.length > 0 ? "reply" : "request";
	else if (!KINDS.includes(value.kind)) throw new Error(`invalid kind ${JSON.stringify(value.kind)}`);
	if (value.hops === undefined) value.hops = 0;
	else if (!isHops(value.hops)) throw new Error(`invalid hops ${JSON.stringify(value.hops)}`);
	return value as Envelope;
}

/**
 * This session's `sent/` copies of the requests with envelope ids `ids`, keyed
 * by id; an id with no readable copy is absent. `sent/` is listed once, because
 * it is never pruned, grows with the address's age and one reply may name many
 * requests. Only names matching an id are read.
 */
export function findSent(address: string, ids: readonly string[]): Map<string, SentCopy> {
	const wanted = new Set(ids);
	const found = new Map<string, SentCopy>();
	if (wanted.size === 0) return found;
	const dir = boxPath(address, "sent");
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return found;
	}
	for (const name of names) {
		const id = ids.find((candidate) => name.endsWith(`-${candidate}.json`));
		if (id === undefined || found.has(id)) continue;
		const path = join(dir, name);
		if (!isFile(path)) continue;
		try {
			const envelope = readEnvelope(path);
			if (envelope.id === id) found.set(id, { envelope, path });
		} catch {
			// an unreadable copy is no copy
		}
	}
	return found;
}

function envelopesIn(address: string, box: Box): Partial<Envelope>[] {
	const dir = boxPath(address, box);
	const out: Partial<Envelope>[] = [];
	for (const name of jsonFiles(address, box)) {
		try {
			out.push(JSON.parse(readFileSync(join(dir, name), "utf8")));
		} catch {
			out.push({});
		}
	}
	return out;
}

/**
 * Counts derived from disk: files still in `new/`, envelopes in `cur/`, and
 * requests (not messages) in `sent/` that no envelope in `cur/` answers.
 */
export function diskCounts(address: string): { unclaimed: number; read: number; awaiting: number } {
	const cur = envelopesIn(address, "cur");
	const answered = new Set(cur.flatMap((e) => (Array.isArray(e.in_reply_to) ? e.in_reply_to : [])));
	// A message expects no answer, so it never counts as awaiting one.
	const awaiting = envelopesIn(address, "sent").filter(
		(e) => typeof e.id === "string" && e.kind !== "message" && !answered.has(e.id),
	).length;
	return { unclaimed: listNew(address).length, read: cur.length, awaiting };
}
