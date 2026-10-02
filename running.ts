// Running-session records and `to` resolution. Internal to `pi-session-mail`: tests
// reach it only through the extension's registration function.
//
// Each running session announces itself in `<root>/running/<address>.json`:
// its address, Pi session name, working directory, process id, idle or busy,
// the address it waits on, and when the record last changed. A record whose
// process is gone counts as not running, and the reader that finds it deletes
// it. The root is the mail root, so every agent directory sees every session.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isAddress, mailRoot } from "./store.ts";

export type State = "idle" | "busy";

export type RunningRecord = {
	address: string;
	/** The Pi session name; absent when none is set. */
	name?: string;
	cwd: string;
	pid: number;
	state: State;
	/** The address this session's pending ask waits on; empty when none. */
	waitingOn: string;
	/** When the record last changed, as an ISO timestamp. */
	updated: string;
};

/** How many leading characters of a session id name it in lists and errors. */
export const SHORT_ID = 8;

export const shortId = (address: string) => address.slice(0, SHORT_ID);

/** A record's display label: its session name, or its short id when it has none. */
export const label = (record: Pick<RunningRecord, "address" | "name">) => record.name ?? shortId(record.address);

const runningDir = () => join(mailRoot(), "running");

const recordPath = (address: string) => {
	if (!isAddress(address)) throw new Error(`invalid mailbox address: ${JSON.stringify(address)}`);
	return join(runningDir(), `${address}.json`);
};

/** Write `record` owner-only, through a temporary file so a reader never sees half of it. */
export function writeRecord(record: RunningRecord): void {
	mkdirSync(runningDir(), { recursive: true, mode: 0o700 });
	const path = recordPath(record.address);
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

/** Remove `address`'s record, unless another process has since taken it over. */
export function removeRecord(address: string): void {
	const path = recordPath(address);
	const current = readRecord(path);
	if (current !== undefined && current.pid !== process.pid) return;
	rmSync(path, { force: true });
}

/** Whether a process with this id exists; one we may not signal still exists. */
function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function readRecord(path: string): RunningRecord | undefined {
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<RunningRecord>;
		if (!isAddress(value.address)) return undefined;
		if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return undefined;
		if (typeof value.cwd !== "string") return undefined;
		return {
			address: value.address,
			...(typeof value.name === "string" && value.name !== "" ? { name: value.name } : {}),
			cwd: value.cwd,
			pid: value.pid,
			state: value.state === "busy" ? "busy" : "idle",
			waitingOn: typeof value.waitingOn === "string" ? value.waitingOn : "",
			updated: typeof value.updated === "string" ? value.updated : "",
		};
	} catch {
		return undefined;
	}
}

/** Every running session's record, sorted by label; records of dead processes are deleted. */
export function listRunning(): RunningRecord[] {
	let names: string[];
	try {
		names = readdirSync(runningDir()).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
	const out: RunningRecord[] = [];
	for (const name of names) {
		const path = join(runningDir(), name);
		const record = readRecord(path);
		if (record === undefined || `${record.address}.json` !== name) continue; // not ours to judge or delete
		if (!alive(record.pid)) {
			rmSync(path, { force: true });
			continue;
		}
		out.push(record);
	}
	return out.sort((a, b) => label(a).localeCompare(label(b)) || a.address.localeCompare(b.address));
}

/** A Pi session id as Pi writes it: a UUID. */
const FULL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const candidates = (records: readonly RunningRecord[]) =>
	records.map((record) => `${label(record)} (${record.address})`).join(", ");

/**
 * Resolve a `to` typed by a person or a model to an address.
 *
 * A running session's address, or any full session id, resolves as given, so a
 * closed session is still reached by its full id. Otherwise `to` matches
 * running sessions by exact name, then by an id prefix of at least 8
 * characters. Several matches, no match, and `me` itself are refused with an
 * error that says why.
 */
export function resolveTo(to: string, me: string): string {
	const wanted = to.trim();
	if (wanted === "") throw new Error("no recipient given");
	const running = listRunning();
	let address: string | undefined;
	if (running.some((record) => record.address === wanted) || (FULL_ID.test(wanted) && isAddress(wanted))) {
		address = wanted;
	} else {
		const byName = running.filter((record) => record.name === wanted);
		const byPrefix =
			byName.length === 0 && wanted.length >= SHORT_ID
				? running.filter((record) => record.address.startsWith(wanted))
				: [];
		const matches = byName.length > 0 ? byName : byPrefix;
		if (matches.length > 1)
			throw new Error(
				`${JSON.stringify(wanted)} matches several running sessions: ${candidates(matches)}; use a full id`,
			);
		if (matches.length === 0)
			throw new Error(
				`no running session is named ${JSON.stringify(wanted)} or has an id starting with it${
					wanted.length < SHORT_ID ? ` (an id prefix needs at least ${SHORT_ID} characters)` : ""
				}; a closed session is reached by its full id`,
			);
		address = matches[0].address;
	}
	if (address === me) throw new Error("that is this session; a session cannot send mail to itself");
	return address;
}
