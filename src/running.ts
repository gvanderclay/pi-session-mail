// Running-session records and `to` resolution. Internal to `pi-session-mail`: tests
// reach it through the extension's registration function, apart from the start-token
// probe and its parsers, which `test/start-token.test.ts` tests directly.
//
// Each running session announces itself in `<root>/running/<address>.json`:
// its address, Pi session name, working directory, process id, idle or busy,
// the address it waits on, and when the record last changed. A record whose
// process is gone, or whose pid now belongs to a process that started at
// another time, counts as not running, and the reader that finds it deletes it.
// The root is the mail root, so every agent directory sees every session.
import { execFileSync } from "node:child_process";
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
	/**
	 * An opaque token for the process's start time, so a reused pid is told from the
	 * original process. Absent in records written by 0.1.0 and where no probe works.
	 */
	started?: string;
	state: State;
	/** The address this session's pending ask waits on; empty when none. */
	waitingOn: string;
	/** When the record last changed, as an ISO timestamp. */
	updated: string;
};

/** How many leading characters of a session id name it in lists and errors. */
const SHORT_ID = 8;

const shortId = (address: string) => address.slice(0, SHORT_ID);

/** A record's display label: its session name, or its short id when it has none. */
export function label(record: Pick<RunningRecord, "address" | "name">): string {
	return record.name ?? shortId(record.address);
}

const runningDir = () => join(mailRoot(), "running");

const recordPath = (address: string) => {
	if (!isAddress(address)) throw new Error(`invalid mailbox address: ${JSON.stringify(address)}`);
	return join(runningDir(), `${address}.json`);
};

/**
 * The start-time token in a `/proc/<pid>/stat` line: field 22. The command name
 * (field 2) is in parentheses and may itself hold spaces and parentheses, so
 * the fields are counted from the last `)`.
 */
export function parseProcStat(line: string): string | undefined {
	const rest = line.slice(line.lastIndexOf(")") + 1).trim();
	if (rest === "" || !line.includes(")")) return undefined;
	const token = rest.split(/\s+/)[19]; // field 3 is the first after the name
	return token !== undefined && /^\d+$/.test(token) ? token : undefined;
}

/** Parse `ps -o pid=,lstart=` output into a pid -> start token map; unparseable lines are skipped. */
export function parsePsStarts(output: string): Map<number, string> {
	const out = new Map<number, string>();
	for (const line of output.split("\n")) {
		const match = /^\s*(\d+)\s+(\S.*?)\s*$/.exec(line);
		if (match !== null) out.set(Number(match[1]), match[2]);
	}
	return out;
}

/**
 * The start tokens of `pids`, for those the probe could read. Linux reads
 * `/proc`; macOS runs one `ps` for all of them, in UTC and the C locale so
 * every session renders a start time the same way; elsewhere, or on any error,
 * the result lacks the pid, which callers treat as unknown.
 */
export function startTokens(pids: readonly number[]): Map<number, string> {
	const out = new Map<number, string>();
	if (pids.length === 0) return out;
	if (process.platform === "linux") {
		for (const pid of pids) {
			try {
				const token = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
				if (token !== undefined) out.set(pid, token);
			} catch {}
		}
	} else if (process.platform === "darwin") {
		let stdout = "";
		try {
			stdout = execFileSync("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], {
				encoding: "utf8",
				timeout: 2000,
				stdio: ["ignore", "pipe", "ignore"],
				env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
			});
		} catch (err) {
			// ps exits 1 when some pid is gone but still prints the others.
			const partial = (err as { stdout?: unknown }).stdout;
			if (typeof partial === "string") stdout = partial;
		}
		for (const [pid, token] of parsePsStarts(stdout)) out.set(pid, token);
	}
	return out;
}

let ownToken: { value: string | undefined } | undefined;

/** This process's start token, probed once; undefined when it cannot be read. */
function ownStartToken(): string | undefined {
	ownToken ??= { value: startTokens([process.pid]).get(process.pid) };
	return ownToken.value;
}

/**
 * Write `record` owner-only, through a temporary file so a reader never sees half of it.
 * A record for this process gets this process's start token.
 */
export function writeRecord(given: RunningRecord): void {
	const started = given.pid === process.pid && given.started === undefined ? ownStartToken() : undefined;
	const record = started === undefined ? given : { ...given, started };
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
			...(typeof value.started === "string" && value.started !== "" ? { started: value.started } : {}),
			state: value.state === "busy" ? "busy" : "idle",
			waitingOn: typeof value.waitingOn === "string" ? value.waitingOn : "",
			updated: typeof value.updated === "string" ? value.updated : "",
		};
	} catch {
		return undefined;
	}
}

/**
 * Whether `address` has a live running record, read fresh from its one file. The
 * rules are `listRunning`'s: the pid is alive and, when both tokens are known,
 * the start token matches. A missing or unreadable record is not running; a
 * failed probe falls back to the pid alone. Never throws and deletes nothing.
 */
export function isRunning(address: string): boolean {
	try {
		const record = readRecord(recordPath(address));
		if (record === undefined || record.address !== address || !alive(record.pid)) return false;
		if (record.started === undefined) return true;
		const live = startTokens([record.pid]).get(record.pid);
		return live === undefined || live === record.started;
	} catch {
		return false;
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
	const found: { path: string; record: RunningRecord }[] = [];
	for (const name of names) {
		const path = join(runningDir(), name);
		const record = readRecord(path);
		if (record === undefined || `${record.address}.json` !== name) continue; // not ours to judge or delete
		found.push({ path, record });
	}
	const tokens = startTokens(
		found.filter(({ record }) => record.started !== undefined && alive(record.pid)).map(({ record }) => record.pid),
	);
	const out: RunningRecord[] = [];
	for (const { path, record } of found) {
		const live = tokens.get(record.pid);
		// A token we cannot read is unknown, which falls back to the pid-only check.
		if (!alive(record.pid) || (record.started !== undefined && live !== undefined && live !== record.started)) {
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
