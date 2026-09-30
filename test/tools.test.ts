// Running-session records, `session_mail_list`, and resolving a `to` by name,
// full id or short id. The tests drive the extension only through its
// registration function; each one gets its own mail root, so the list holds
// only the sessions it started.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dir, envelopes, files, newId, records, session, stateRoot, until } from "./harness.ts";

let n = 0;
beforeEach(() => {
	process.env.XDG_STATE_HOME = join(dir, `state-${++n}`);
});

/** A process id that no longer exists. */
function deadPid(): number {
	const pid = spawnSync("true").pid;
	assert.ok(pid !== undefined && pid > 0);
	return pid;
}

/** A running-session record written by hand, as another process would. */
function plantRecord(address: string, fields: Record<string, unknown>) {
	const running = join(stateRoot(), "running");
	mkdirSync(running, { recursive: true });
	const path = join(running, `${address}.json`);
	writeFileSync(path, JSON.stringify({ address, cwd: "/elsewhere", state: "idle", waitingOn: "", updated: "", ...fields }));
	return path;
}

/** Two ids sharing their first 8 characters. */
function twins(): [string, string] {
	const base = newId();
	return [base, `${base.slice(0, 9)}${newId().slice(9)}`];
}

// ---------------------------------------------------------------------------
// Records

test("a session start writes a record, run state updates it, and shutdown removes it", async () => {
	const a = session(newId(), { name: "planner", cwd: "/work/a" });
	await a.start();
	const first = records().get(a.id);
	assert.ok(first, "a record exists after session start");
	assert.equal(first.address, a.id);
	assert.equal(first.name, "planner");
	assert.equal(first.cwd, "/work/a");
	assert.equal(first.pid, process.pid);
	assert.equal(first.state, "idle");
	assert.equal(first.waitingOn, "");
	assert.ok(!Number.isNaN(Date.parse(first.updated as string)));

	await a.agentStart();
	assert.equal(records().get(a.id)?.state, "busy");
	await a.settle();
	assert.equal(records().get(a.id)?.state, "idle");
	await a.setName("reviewer");
	assert.equal(records().get(a.id)?.name, "reviewer");
	await a.setName(undefined);
	assert.equal(records().get(a.id)?.name, undefined);

	await a.shutdown();
	assert.equal(records().has(a.id), false);
});

test("the records directory and each record are owner-only", async () => {
	const a = session(newId());
	await a.start();
	const { statSync } = await import("node:fs");
	assert.equal(statSync(join(stateRoot(), "running")).mode & 0o777, 0o700);
	assert.equal(statSync(join(stateRoot(), "running", `${a.id}.json`)).mode & 0o777, 0o600);
	await a.shutdown();
});

test("shutdown leaves a record another process has taken over", async () => {
	const a = session(newId());
	await a.start();
	const other = process.pid === 1 ? 2 : 1; // pid 1 always exists
	plantRecord(a.id, { pid: other });
	await a.shutdown();
	assert.equal(records().get(a.id)?.pid, other);
});

// ---------------------------------------------------------------------------
// session_mail_list

test("two sessions sharing a mail root list each other, marking the caller, and a name change shows", async () => {
	const a = session(newId(), { name: "alpha", cwd: "/work/a" });
	const b = session(newId(), { cwd: "/work/b" });
	await a.start();
	await b.start();
	assert.deepEqual(a.tools(), ["session_mail_list"]);

	const fromA = (await a.toolCall("session_mail_list")).content[0].text;
	assert.match(fromA, /^2 running sessions:/);
	assert.ok(fromA.includes(`- alpha (this session)\n  id: ${a.id}\n  cwd: /work/a\n  state: idle`), fromA);
	assert.ok(fromA.includes(`- ${b.id.slice(0, 8)}\n  id: ${b.id}\n  cwd: /work/b\n  state: idle`), fromA);

	await b.setName("bravo");
	await b.agentStart();
	const fromB = await b.toolCall("session_mail_list");
	const text = fromB.content[0].text;
	assert.ok(text.includes(`- alpha\n  id: ${a.id}`), text);
	assert.ok(text.includes(`- bravo (this session)\n  id: ${b.id}\n  cwd: /work/b\n  state: busy`), text);
	const sessions = (fromB.details as { sessions: { address: string; self: boolean }[] }).sessions;
	assert.deepEqual(
		sessions.map((s) => [s.address, s.self]),
		[
			[a.id, false],
			[b.id, true],
		],
	);
	await a.shutdown();
	await b.shutdown();
});

test("the list shows whom a session waits on", async () => {
	const a = session(newId(), { name: "alpha" });
	await a.start();
	const waiter = newId();
	plantRecord(waiter, { pid: process.pid, name: "waiter", waitingOn: a.id });
	const text = (await a.toolCall("session_mail_list")).content[0].text;
	assert.ok(text.includes(`- waiter\n  id: ${waiter}\n  cwd: /elsewhere\n  state: idle, waiting on alpha (${a.id})`), text);
	await a.shutdown();
});

test("a record whose process is gone is left out of the list and deleted", async () => {
	const a = session(newId());
	await a.start();
	const ghost = newId();
	const path = plantRecord(ghost, { pid: deadPid(), name: "ghost" });
	const text = (await a.toolCall("session_mail_list")).content[0].text;
	assert.match(text, /^1 running session:/);
	assert.ok(!text.includes("ghost"), text);
	assert.equal(existsSync(path), false);
	await a.shutdown();
});

test("with no records the list says no session is running", async () => {
	const a = session(newId());
	const result = await a.toolCall("session_mail_list");
	assert.equal(result.content[0].text, "No Pi sessions are running with a mailbox.");
});

// ---------------------------------------------------------------------------
// Resolving `to` through /mailbox

test("/mailbox <name> <text> writes a request to that session's address", async () => {
	const a = session(newId());
	const b = session(newId(), { name: "bravo" });
	await a.start();
	await b.start();
	b.drop(true);
	await a.mailbox("bravo please look");
	const [request] = envelopes(a.id, "sent");
	assert.equal(request.to, b.id);
	assert.equal(request.kind, "request");
	assert.equal(request.body, "please look");
	assert.deepEqual(a.errors, []);
	await a.shutdown();
	await b.shutdown();
});

test("a short id of 8 or more characters resolves a running session", async () => {
	const a = session(newId());
	const b = session(newId());
	await a.start();
	await b.start();
	b.drop(true);
	await a.mailbox(`${b.id.slice(0, 8)} short`);
	await a.mailbox(`${b.id.slice(0, 13)} longer`);
	assert.deepEqual(
		envelopes(a.id, "sent").map((e) => [e.to, e.body]),
		[
			[b.id, "short"],
			[b.id, "longer"],
		],
	);
	assert.deepEqual(a.errors, []);
	await a.shutdown();
	await b.shutdown();
});

test("a full id reaches a closed session", async () => {
	const a = session(newId());
	await a.start();
	const closed = newId();
	await a.mailbox(`${closed} for later`);
	assert.equal(files(closed, "new").length, 1);
	assert.deepEqual(a.errors, []);
	await a.shutdown();
});

test("an exact name wins over an id prefix", async () => {
	const a = session(newId());
	const b = session(newId());
	await a.start();
	await b.start();
	const c = session(newId(), { name: b.id.slice(0, 8) });
	await c.start();
	c.drop(true);
	await a.mailbox(`${b.id.slice(0, 8)} which one`);
	assert.equal(envelopes(a.id, "sent")[0].to, c.id);
	await Promise.all([a.shutdown(), b.shutdown(), c.shutdown()]);
});

test("an ambiguous name is refused, naming every candidate, and nothing is sent", async () => {
	const a = session(newId());
	const b = session(newId(), { name: "twin" });
	const c = session(newId(), { name: "twin" });
	await a.start();
	await b.start();
	await c.start();
	await a.mailbox("twin hello");
	assert.equal(a.errors.length, 1);
	assert.match(a.errors[0], /"twin" matches several running sessions/);
	assert.ok(a.errors[0].includes(`twin (${b.id})`), a.errors[0]);
	assert.ok(a.errors[0].includes(`twin (${c.id})`), a.errors[0]);
	assert.deepEqual(files(a.id, "sent"), []);
	await Promise.all([a.shutdown(), b.shutdown(), c.shutdown()]);
});

test("a short id shared by two sessions is refused, naming both", async () => {
	const a = session(newId());
	await a.start();
	const [x, y] = twins();
	plantRecord(x, { pid: process.pid });
	plantRecord(y, { pid: process.pid, name: "why" });
	await a.mailbox(`${x.slice(0, 8)} hello`);
	assert.equal(a.errors.length, 1);
	assert.ok(a.errors[0].includes(`${x.slice(0, 8)} (${x})`), a.errors[0]);
	assert.ok(a.errors[0].includes(`why (${y})`), a.errors[0]);
	assert.deepEqual(files(a.id, "sent"), []);
	await a.shutdown();
});

test("an unknown name is refused with a note that a closed session needs its full id", async () => {
	const a = session(newId());
	await a.start();
	await a.mailbox("nobody hello");
	await a.mailbox("abc hello");
	assert.equal(a.errors.length, 2);
	assert.match(a.errors[0], /no running session is named "nobody".*a closed session is reached by its full id/);
	assert.match(a.errors[1], /at least 8 characters/);
	assert.deepEqual(files(a.id, "sent"), []);
	await a.shutdown();
});

test("a session cannot send to itself by id, short id or name", async () => {
	const a = session(newId(), { name: "me" });
	await a.start();
	for (const to of [a.id, a.id.slice(0, 8), "me"]) await a.mailbox(`${to} hello`);
	assert.equal(a.errors.length, 3);
	for (const error of a.errors) assert.match(error, /cannot send mail to itself/);
	assert.deepEqual(files(a.id, "sent"), []);
	assert.deepEqual(files(a.id, "new"), []);
	await a.shutdown();
});

test("/mailbox with no arguments shows the address and the name, or the short id others see", async () => {
	const a = session(newId(), { name: "planner" });
	await a.mailbox("");
	assert.equal(a.notes.at(-1), `Mailbox address: ${a.id}\nName: planner`);
	const b = session(newId());
	await b.mailbox("");
	assert.equal(b.notes.at(-1), `Mailbox address: ${b.id}\nName: none; other sessions see ${b.id.slice(0, 8)} (set one with /name)`);
});
