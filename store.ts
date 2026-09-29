// The mailbox's directories and envelopes on disk. Internal to `mailbox`:
// tests reach it only through the extension's registration function.
//
// Layout: <agent dir>/mailbox/<address>/{tmp,new,cur,sent}/<ms>-<id>.json
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type Envelope = {
	id: string;
	from: string;
	to: string;
	/** Request ids this envelope answers; empty for a request. */
	in_reply_to: string[];
	status: string;
	ts: string;
	body: string;
};

type Box = "tmp" | "new" | "cur" | "sent";
const BOXES: Box[] = ["tmp", "new", "cur", "sent"];

const ADDRESS = /^[A-Za-z0-9_-]+$/;

/** An address is a single safe path segment: letters, digits, `-` and `_`. */
export const isAddress = (value: unknown): value is string => typeof value === "string" && ADDRESS.test(value);

/** Read at call time, so `PI_CODING_AGENT_DIR` is honoured. */
const root = () => join(getAgentDir(), "mailbox");

export function boxPath(address: string, box: Box): string {
	if (!isAddress(address)) throw new Error(`invalid mailbox address: ${JSON.stringify(address)}`);
	return join(root(), address, box);
}

export function ensureBoxes(address: string): void {
	for (const box of BOXES) mkdirSync(boxPath(address, box), { recursive: true });
}

// Names sort in send order: a strictly increasing millisecond stamp in this
// process, zero-padded, then the id.
let lastMs = 0;
function stamp(): number {
	lastMs = Math.max(Date.now(), lastMs + 1);
	return lastMs;
}

const fileName = (ms: number, id: string) => `${String(ms).padStart(15, "0")}-${id}.json`;

/**
 * Write an envelope to `to`'s inbox: into its `tmp/`, then renamed into its
 * `new/`. A request is also copied into the sender's `sent/`. Synchronous,
 * so a `pi.events` caller sees the result as soon as `emit` returns.
 * A reply's `status` is `done` unless given; a request's is empty.
 */
export function send(from: string, to: string, body: string, inReplyTo: string[] = [], status = "done"): Envelope {
	if (!isAddress(from)) throw new Error(`invalid sender address: ${JSON.stringify(from)}`);
	if (!isAddress(to)) throw new Error(`invalid address: ${JSON.stringify(to)} (expected a session id)`);
	const ms = stamp();
	const envelope: Envelope = {
		id: randomUUID(),
		from,
		to,
		in_reply_to: inReplyTo,
		status: inReplyTo.length > 0 ? status : "",
		ts: new Date(ms).toISOString(),
		body,
	};
	const name = fileName(ms, envelope.id);
	const text = `${JSON.stringify(envelope, null, 2)}\n`;
	ensureBoxes(to);
	const tmp = join(boxPath(to, "tmp"), name);
	writeFileSync(tmp, text);
	renameSync(tmp, join(boxPath(to, "new"), name));
	if (inReplyTo.length === 0) {
		ensureBoxes(from);
		writeFileSync(join(boxPath(from, "sent"), name), text);
	}
	return envelope;
}

/** Regular `.json` files waiting in `new/`, in send order. */
export function listNew(address: string): string[] {
	const dir = boxPath(address, "new");
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names
		.filter((name) => name.endsWith(".json"))
		.filter((name) => {
			try {
				return lstatSync(join(dir, name)).isFile();
			} catch {
				return false;
			}
		})
		.sort();
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

/** Parse an envelope file; throws when it is not a well-formed envelope from a valid address. */
export function readEnvelope(path: string): Envelope {
	const value = JSON.parse(readFileSync(path, "utf8")) as Partial<Envelope>;
	if (typeof value !== "object" || value === null) throw new Error("not an object");
	if (typeof value.id !== "string" || value.id === "") throw new Error("missing id");
	if (!isAddress(value.from)) throw new Error(`invalid from address ${JSON.stringify(value.from)}`);
	if (!Array.isArray(value.in_reply_to) || !value.in_reply_to.every((id) => typeof id === "string"))
		throw new Error("in_reply_to is not a list of ids");
	if (typeof value.body !== "string") throw new Error("missing body");
	return value as Envelope;
}

function envelopesIn(address: string, box: Box): Partial<Envelope>[] {
	const dir = boxPath(address, box);
	let names: string[];
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	const out: Partial<Envelope>[] = [];
	for (const name of names) {
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
 * requests in `sent/` that no envelope in `cur/` answers.
 */
export function diskCounts(address: string): { unclaimed: number; read: number; awaiting: number } {
	const cur = envelopesIn(address, "cur");
	const answered = new Set(cur.flatMap((e) => (Array.isArray(e.in_reply_to) ? e.in_reply_to : [])));
	const awaiting = envelopesIn(address, "sent").filter((e) => typeof e.id === "string" && !answered.has(e.id)).length;
	return { unclaimed: listNew(address).length, read: cur.length, awaiting };
}
