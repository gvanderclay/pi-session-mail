// Running-session records, `session_mail_list`, and resolving a `to` by name,
// full id or short id. The tests drive the extension only through its
// registration function; each one gets its own mail root, so the list holds
// only the sessions it started.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, test } from "node:test";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

import { diskCounts } from "../src/store.ts";
import { dir, envelopes, files, newId, records, session, stateRoot, turn, until } from "./harness.ts";

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
	writeFileSync(
		path,
		JSON.stringify({ address, cwd: "/elsewhere", state: "idle", waitingOn: "", updated: "", ...fields }),
	);
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

test("a running session's record holds this process's start token", async () => {
	const a = session(newId());
	await a.start();
	assert.equal(typeof (records().get(a.id) as { started?: unknown }).started, "string");
	await a.shutdown();
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
	assert.deepEqual(a.tools(), ["session_mail_ask", "session_mail_list", "session_mail_reply", "session_mail_send"]);

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
	assert.deepEqual(fromB.structuredContent, {
		sessions: [
			{ id: a.id, name: "alpha", cwd: "/work/a", state: "idle", self: false },
			{ id: b.id, name: "bravo", cwd: "/work/b", state: "busy", self: true },
		],
	});
	await a.shutdown();
	await b.shutdown();
});

test("every tool declares an output schema, which the harness checks each result against, and all four hints", () => {
	const a = session(newId());
	const sends = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
	const expected: Record<string, object> = {
		session_mail_list: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		session_mail_send: sends,
		session_mail_ask: sends,
		session_mail_reply: { ...sends, idempotentHint: true },
	};
	for (const name of a.tools()) {
		assert.ok(a.tool(name).outputSchema !== undefined, name);
		assert.deepEqual(a.tool(name).annotations, expected[name], name);
	}
	const ask = a.tool("session_mail_ask").outputSchema as TSchema;
	assert.ok(Value.Check(ask, { id: "x", to: "y", outcome: "timed-out" }));
	assert.ok(!Value.Check(ask, { id: "x", to: "y", outcome: "answered" }), "an answer carries status and body");
	assert.ok(!Value.Check(ask, { id: "x", to: "y", outcome: "gone" }));
	for (const outcome of ["background", "timed-out", "stopped-running", "stopped-by-user"]) {
		assert.ok(Value.Check(ask, { id: "x", to: "y", outcome }), outcome);
		assert.ok(!Value.Check(ask, { to: "y", outcome }), "every outcome requires the ask id");
		assert.ok(!Value.Check(ask, { id: "x", outcome }), "every outcome requires the recipient id");
	}
	assert.ok(Value.Check(ask, { id: "x", to: "y", outcome: "answered", status: "done", body: "yes" }));
	assert.ok(Value.Check(ask, { id: "x", to: "y", outcome: "answered", status: "failed", body: "no answer" }));
	assert.ok(!Value.Check(ask, { id: "x", to: "y", outcome: "answered", status: "done" }));
	assert.ok(!Value.Check(ask, { id: "x", to: "y", outcome: "answered", body: "yes" }));
});

test("the list shows whom a session waits on", async () => {
	const a = session(newId(), { name: "alpha" });
	await a.start();
	const waiter = newId();
	plantRecord(waiter, { pid: process.pid, name: "waiter", waitingOn: a.id });
	const result = await a.toolCall("session_mail_list");
	const text = result.content[0].text;
	assert.deepEqual((result.structuredContent as { sessions: { id: string }[] }).sessions[1], {
		id: waiter,
		name: "waiter",
		cwd: "/elsewhere",
		state: "idle",
		waitingOn: a.id,
		self: false,
	});
	assert.ok(
		text.includes(`- waiter\n  id: ${waiter}\n  cwd: /elsewhere\n  state: idle, waiting on alpha (${a.id})`),
		text,
	);
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

test("a record with this process's pid but another start token is not listed and is deleted", async () => {
	const a = session(newId());
	await a.start();
	const reused = newId();
	const path = plantRecord(reused, { pid: process.pid, name: "reused", started: "not-this-process" });
	const text = (await a.toolCall("session_mail_list")).content[0].text;
	assert.match(text, /^1 running session:/);
	assert.ok(!text.includes("reused"), text);
	assert.equal(existsSync(path), false);
	await a.shutdown();
});

test("a record with no start token is judged by its pid alone", async () => {
	const a = session(newId());
	await a.start();
	const old = newId();
	plantRecord(old, { pid: process.pid, name: "old" });
	const text = (await a.toolCall("session_mail_list")).content[0].text;
	assert.match(text, /^2 running sessions:/);
	assert.ok(text.includes("- old\n"), text);
	await a.shutdown();
});

test("with no records the list says no session is running", async () => {
	const a = session(newId());
	const result = await a.toolCall("session_mail_list");
	assert.equal(result.content[0].text, "No Pi sessions are running with a mailbox.");
	assert.deepEqual(result.structuredContent, { sessions: [] });
});

// ---------------------------------------------------------------------------
// Addressing

test("/mailbox opens the picker titled with the name and short id, or the short id alone", async () => {
	const a = session(newId(), { name: "planner" });
	const opened = a.mailbox("");
	await until(() => a.dialogs.length === 1, "the picker to open");
	const title = a.dialogs[0].component.render(80).join("\n");
	assert.ok(title.includes(`Mailbox · planner · ${a.id.slice(0, 8)} · all`), title);
	await a.dialogs[0].press("\x1b");
	await opened;

	const b = session(newId());
	const other = b.mailbox("");
	await until(() => b.dialogs.length === 1, "the second picker to open");
	const short = b.dialogs[0].component.render(80).join("\n");
	assert.ok(short.includes(`Mailbox · ${b.id.slice(0, 8)} · all`), short);
	await b.dialogs[0].press("\x1b");
	await other;
	await Promise.all([a.shutdown(), b.shutdown()]);
});

// ---------------------------------------------------------------------------
// session_mail_send and delivery

test("a message to an idle session starts a turn by steering, labelled with the sender's name, id and no-answer note", async () => {
	const a = session(newId(), { name: "alpha" });
	const b = session(newId(), { name: "bravo" });
	await a.start();
	await b.start();
	const result = await a.toolCall("session_mail_send", { to: "bravo", message: "  heads up  " });
	const [message] = envelopes(a.id, "sent");
	assert.equal(message.kind, "message");
	assert.equal("hops" in message, false);
	assert.equal(message.to, b.id);
	assert.equal(message.body, "heads up");
	assert.equal(
		result.content[0].text,
		`Sent message ${message.id} to bravo (${b.id}). It expects no answer; any answer arrives as a message.`,
	);
	assert.deepEqual(result.details, { id: message.id, to: b.id, running: true });
	assert.deepEqual(result.structuredContent, result.details);

	await until(() => b.sent.length === 1, "the message to be injected");
	assert.deepEqual(b.sent[0].options, { triggerTurn: true, deliverAs: "steer" });
	const content = b.sent[0].message.content;
	assert.ok(content.startsWith(`[mailbox] From alpha (${a.id}, working in `), content);
	assert.match(
		content,
		/\), another Pi session on this machine\. It expects no answer; if one is wanted, send it with session_mail_send to /,
	);
	assert.ok(!/not from the user|untrusted/.test(content), content);
	assert.match(content, /heads up\n\n\[mailbox\] End of the mail from /);
	await a.shutdown();
	await b.shutdown();
});

test("a message to a busy session is steered in, not queued as a follow-up", async () => {
	const a = session(newId());
	const b = session(newId());
	await a.start();
	await b.start();
	await b.agentStart();
	await a.toolCall("session_mail_send", { to: b.id, message: "change course" });
	await until(() => b.sent.length === 1, "the message to be injected");
	assert.deepEqual(b.sent[0].options, { triggerTurn: true, deliverAs: "steer" });
	assert.ok(
		b.sent[0].message.content.startsWith(`[mailbox] From ${a.id.slice(0, 8)} (${a.id}, `),
		"an unnamed sender shows its short id",
	);
	await a.shutdown();
	await b.shutdown();
});

test("neither a message nor a request gets an answer at settle, and a message never counts as awaiting", async () => {
	const a = session(newId());
	const b = session(newId());
	await a.start();
	await b.start();
	await a.toolCall("session_mail_send", { to: b.id, message: "fyi" });
	await a.request(b.id, "a question");
	await until(() => b.sent.length === 2, "both to be injected");
	assert.equal(diskCounts(a.id).awaiting, 1);
	await b.answer("the answer");
	const answers = envelopes(a.id, "new").concat(envelopes(a.id, "cur"));
	assert.equal(answers.length, 0);
	assert.equal(diskCounts(a.id).awaiting, 1);
	await a.shutdown();
	await b.shutdown();
});

test("diskCounts keeps the older awaiting rule for files the envelope reader rejects or normalises", () => {
	const plant = (address: string, boxName: "cur" | "sent", name: string, value: unknown) => {
		const dir = join(stateRoot(), address, boxName);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		writeFileSync(join(dir, `${name}.json`), JSON.stringify(value));
	};

	// A bare sent object with a string id and a non-message kind: the old rule counts it.
	const bare = newId();
	plant(bare, "sent", "000000000000001-req", { id: "req", kind: "request" });
	assert.deepEqual(diskCounts(bare), { unclaimed: 0, read: 0, awaiting: 1 });

	// A valid envelope with a kind this version normalises to message still counts as the old raw kind did.
	const future = newId();
	plant(future, "sent", "000000000000001-future", {
		id: "future",
		from: newId(),
		to: future,
		kind: "shout",
		hops: 0,
		in_reply_to: [],
		status: "",
		ts: "",
		body: "from the future",
	});
	assert.deepEqual(diskCounts(future), { unclaimed: 0, read: 0, awaiting: 1 });

	// A partial cur object still answers the request its raw in_reply_to names.
	const answered = newId();
	plant(answered, "sent", "000000000000001-req", {
		id: "req",
		from: newId(),
		to: answered,
		kind: "request",
		hops: 0,
		in_reply_to: [],
		status: "",
		ts: "",
		body: "still waiting?",
	});
	plant(answered, "cur", "000000000000002-reply", { id: "reply", in_reply_to: ["req"] });
	assert.deepEqual(diskCounts(answered), { unclaimed: 0, read: 1, awaiting: 0 });
});

test("a message to a closed session's full id waits in its new/, and the result says so", async () => {
	const a = session(newId());
	await a.start();
	const closed = newId();
	const result = await a.toolCall("session_mail_send", { to: closed, message: "when you are back" });
	const [waiting] = envelopes(closed, "new");
	assert.equal(waiting.kind, "message");
	assert.match(
		result.content[0].text,
		new RegExp(`left for ${closed}, which is not running: it waits in that session's inbox`),
	);
	assert.equal((result.details as { running: boolean }).running, false);
	assert.deepEqual(result.structuredContent, result.details);
	await a.shutdown();
});

test("session_mail_send refuses an empty text, an unknown or ambiguous to, and this session, writing nothing", async () => {
	const a = session(newId(), { name: "me" });
	const b = session(newId(), { name: "twin" });
	const c = session(newId(), { name: "twin" });
	await a.start();
	await b.start();
	await c.start();
	await assert.rejects(a.toolCall("session_mail_send", { to: b.id, message: "   " }), /empty/);
	await assert.rejects(
		a.toolCall("session_mail_send", { to: "nobody", message: "hi" }),
		/no running session is named "nobody".*a closed session is reached by its full id/,
	);
	await assert.rejects(a.toolCall("session_mail_send", { to: "abc", message: "hi" }), /at least 8 characters/);
	await assert.rejects(
		a.toolCall("session_mail_send", { to: "twin", message: "hi" }),
		/matches several running sessions/,
	);
	for (const to of [a.id, a.id.slice(0, 8), "me"])
		await assert.rejects(a.toolCall("session_mail_send", { to, message: "hi" }), /cannot send mail to itself/);
	assert.deepEqual(files(a.id, "sent"), []);
	assert.deepEqual(files(b.id, "new"), []);
	await Promise.all([a.shutdown(), b.shutdown(), c.shutdown()]);
});

// ---------------------------------------------------------------------------
// Resolving `to` through session_mail_send

test("session_mail_send resolves a short id of 8 or more characters", async () => {
	const a = session(newId());
	const b = session(newId());
	await a.start();
	await b.start();
	b.drop(true);
	await a.toolCall("session_mail_send", { to: b.id.slice(0, 8), message: "short" });
	await a.toolCall("session_mail_send", { to: b.id.slice(0, 13), message: "longer" });
	assert.deepEqual(
		envelopes(a.id, "sent").map((e) => [e.kind, e.to, e.body]),
		[
			["message", b.id, "short"],
			["message", b.id, "longer"],
		],
	);
	await Promise.all([a.shutdown(), b.shutdown()]);
});

test("session_mail_send resolves an exact name before an id prefix", async () => {
	const a = session(newId());
	const b = session(newId());
	await a.start();
	await b.start();
	const c = session(newId(), { name: b.id.slice(0, 8) });
	await c.start();
	c.drop(true);
	await a.toolCall("session_mail_send", { to: b.id.slice(0, 8), message: "which one" });
	assert.equal(envelopes(a.id, "sent")[0].to, c.id);
	await Promise.all([a.shutdown(), b.shutdown(), c.shutdown()]);
});

test("session_mail_send refuses an ambiguous name, naming every candidate, and nothing is sent", async () => {
	const a = session(newId());
	const b = session(newId(), { name: "twin" });
	const c = session(newId(), { name: "twin" });
	await a.start();
	await b.start();
	await c.start();
	await assert.rejects(a.toolCall("session_mail_send", { to: "twin", message: "hi" }), (err: Error) => {
		assert.match(err.message, /"twin" matches several running sessions/);
		assert.ok(err.message.includes(`twin (${b.id})`), err.message);
		assert.ok(err.message.includes(`twin (${c.id})`), err.message);
		return true;
	});
	assert.deepEqual(files(a.id, "sent"), []);
	await Promise.all([a.shutdown(), b.shutdown(), c.shutdown()]);
});

test("session_mail_send refuses a short id shared by two sessions, naming both", async () => {
	const a = session(newId());
	await a.start();
	const [x, y] = twins();
	plantRecord(x, { pid: process.pid });
	plantRecord(y, { pid: process.pid, name: "why" });
	await assert.rejects(a.toolCall("session_mail_send", { to: x.slice(0, 8), message: "hi" }), (err: Error) => {
		assert.ok(err.message.includes(`${x.slice(0, 8)} (${x})`), err.message);
		assert.ok(err.message.includes(`why (${y})`), err.message);
		return true;
	});
	assert.deepEqual(files(a.id, "sent"), []);
	await a.shutdown();
});

// ---------------------------------------------------------------------------
// No hop limit

let planted = 0;
/** An envelope written by hand into `to`'s new/, as an older copy would write it, with `extra` fields added. */
function plant(to: string, from: string, extra: Record<string, unknown> = {}, kind = "message") {
	mkdirSync(join(stateRoot(), to, "new"), { recursive: true, mode: 0o700 });
	const id = `planted-${++planted}`;
	const name = `${String(planted).padStart(15, "0")}-${id}.json`;
	writeFileSync(
		join(stateRoot(), to, "new", name),
		JSON.stringify({ id, from, to, kind, in_reply_to: [], status: "", ts: "", body: `planted ${planted}`, ...extra }),
	);
	return id;
}

test("messages and asks are never refused, however many the session has received and sent", async () => {
	const { a, b } = await pair();
	await b.agentStart();
	for (let i = 0; i < 12; i++) {
		plant(b.id, a.id);
		await until(() => b.sent.length === i + 1, `message ${i + 1} to be steered in`);
		await b.toolCall("session_mail_send", { to: a.id, message: `back ${i}` });
	}
	const stop = new AbortController();
	const asked = b.toolCall("session_mail_ask", { to: "alpha", message: "still allowed?" }, stop.signal);
	stop.abort();
	await asked;
	assert.equal(envelopes(b.id, "sent").length, 13);
	assert.deepEqual([...a.warnings, ...b.warnings], []);
	await a.shutdown();
	await b.shutdown();
});

test("a message and an ask pass between two sessions again and again", async () => {
	const { a, b } = await pair();
	for (let round = 0; round < 8; round++) {
		await a.toolCall("session_mail_send", { to: "bravo", message: `ping ${round}` });
		await until(() => b.sent.length === round + 1, `ping ${round} to be delivered`);
		await b.toolCall("session_mail_send", { to: "alpha", message: `pong ${round}` });
		await until(() => a.sent.length === round + 1, `pong ${round} to be delivered`);
	}
	for (let round = 0; round < 8; round++) {
		const before = b.sent.length;
		const stop = new AbortController();
		const asked = a.toolCall("session_mail_ask", { to: "bravo", message: `ask ${round}` }, stop.signal);
		await until(() => b.sent.length === before + 1, `ask ${round} to be delivered`);
		const [ask] = envelopes(a.id, "sent").filter((e) => e.body === `ask ${round}`);
		await b.toolCall("session_mail_reply", { ask: ask.id, message: `answer ${round}` });
		await asked;
	}
	await a.shutdown();
	await b.shutdown();
});

test("an envelope with a hops property from an older copy is read, delivered and answered like any other", async () => {
	const b = session(newId());
	const asker = newId();
	await b.start();
	plant(b.id, asker, { hops: 40 }, "ask");
	await until(() => b.sent.length === 1, "the ask to be injected");
	assert.match(b.sent[0].message.content, /planted \d+/);
	await b.answer("answered");
	const [reply] = envelopes(asker, "new");
	assert.equal(reply.kind, "reply");
	assert.equal(reply.body, "answered");
	assert.equal("hops" in reply, false);
	for (const hops of [-1, 2.5, "many", null]) {
		const before = b.sent.length;
		plant(b.id, asker, { hops });
		await until(() => b.sent.length === before + 1, `a message with hops ${JSON.stringify(hops)} to be injected`);
	}
	assert.deepEqual(b.warnings, []);
	await b.shutdown();
});

test("new envelopes carry no hops field, whoever writes them", async () => {
	const { a, b } = await pair();
	await a.toolCall("session_mail_send", { to: "bravo", message: "a message" });
	const stop = new AbortController();
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "an ask" }, stop.signal);
	await until(() => b.sent.length === 2, "both to be delivered");
	const ask = envelopes(a.id, "sent").find((e) => e.kind === "ask");
	await b.toolCall("session_mail_reply", { ask: ask.id, message: "mid-run answer" });
	await asked;
	await a.request(b.id, "a request");
	await until(() => b.sent.length === 3, "the request to be delivered");
	b.reply(a.id, [envelopes(a.id, "sent").find((e) => e.kind === "request").id], "a consumer's answer");
	const all = [
		...envelopes(a.id, "sent"),
		...envelopes(a.id, "new"),
		...envelopes(a.id, "cur"),
		...envelopes(b.id, "new"),
		...envelopes(b.id, "cur"),
	];
	assert.deepEqual(new Set(all.map((e) => e.kind)), new Set(["message", "ask", "request", "reply"]));
	for (const envelope of all) assert.equal("hops" in envelope, false, `${envelope.kind} carries hops`);
	await a.shutdown();
	await b.shutdown();
});

/** Run `body` with `text` as `<agent dir>/session-mail.json` (none when undefined), removing it after. */
async function withConfig(text: string | undefined, body: () => Promise<void>) {
	const agent = process.env.PI_CODING_AGENT_DIR as string;
	const path = join(agent, "session-mail.json");
	rmSync(path, { force: true });
	if (text !== undefined) {
		mkdirSync(agent, { recursive: true });
		writeFileSync(path, text);
	}
	try {
		await body();
	} finally {
		rmSync(path, { force: true });
	}
}

/** A session that has started and received one message. */
async function startedSession() {
	const s = session(newId());
	await s.start();
	await s.agentStart();
	plant(s.id, newId());
	await until(() => s.sent.length === 1, "the message to be injected");
	return s;
}

test("a hopLimit in session-mail.json has no effect and draws no warning", async () => {
	await withConfig(JSON.stringify({ hopLimit: 1, pruneAfterDays: 7 }), async () => {
		const s = await startedSession();
		for (let i = 0; i < 4; i++) {
			plant(s.id, newId());
			await until(() => s.sent.length === i + 2, "another message");
			await s.toolCall("session_mail_send", { to: newId(), message: `send ${i}` });
		}
		assert.deepEqual(s.warnings, []);
		await s.shutdown();
	});
});

test("a session-mail.json that is not an object means 30 days, with exactly one warning", async () => {
	await withConfig("[2]", async () => {
		const s = await startedSession();
		await until(() => s.warnings.length > 0, "the prune at session start to read the settings");
		await s.toolCall("session_mail_send", { to: newId(), message: "first" });
		assert.equal(s.warnings.length, 1);
		assert.match(s.warnings[0], /session-mail\.json[\s\S]*30/);
		assert.doesNotMatch(s.warnings[0], /hop/i);
		await s.shutdown();
	});
});

for (const [what, text] of [
	["not JSON", "{ pruneAfterDays: 2"],
	["a zero pruneAfterDays", JSON.stringify({ pruneAfterDays: 0 })],
	["a fractional pruneAfterDays", JSON.stringify({ pruneAfterDays: 1.5 })],
	["a string pruneAfterDays", JSON.stringify({ pruneAfterDays: "7" })],
] as const) {
	test(`a session-mail.json that is ${what} means 30 days, with exactly one warning across the start and two sends`, async () => {
		await withConfig(text, async () => {
			const s = await startedSession();
			await until(() => s.warnings.length > 0, "the prune at session start to read the settings");
			await s.toolCall("session_mail_send", { to: newId(), message: "first" });
			await s.toolCall("session_mail_send", { to: newId(), message: "second" });
			assert.equal(s.warnings.length, 1);
			assert.match(s.warnings[0], /session-mail\.json[\s\S]*30/);
			await s.shutdown();
		});
	});
}

test("a valid pruneAfterDays gives no warning", async () => {
	await withConfig(JSON.stringify({ pruneAfterDays: 7 }), async () => {
		const s = await startedSession();
		await s.toolCall("session_mail_send", { to: newId(), message: "hi" });
		assert.deepEqual(s.warnings, []);
		await s.shutdown();
	});
});

// ---------------------------------------------------------------------------
// session_mail_ask

type AskDetails = { id: string; to: string; outcome: string; status?: string; body?: string };

test("an ask is answered at the target's settle, and the answer is the tool result", async () => {
	const a = session(newId(), { name: "alpha" });
	const b = session(newId(), { name: "bravo" });
	await a.start();
	await b.start();
	await a.agentStart();
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "what is 6 x 7?" });
	await until(() => b.sent.length === 1, "the ask to be injected");
	const [ask] = envelopes(a.id, "sent");
	assert.equal(ask.kind, "ask");
	assert.equal("hops" in ask, false);
	assert.equal(ask.body, "what is 6 x 7?");
	await b.answer("42");
	const result = await asked;
	assert.deepEqual(result.details, { id: ask.id, to: b.id, outcome: "answered", status: "done", body: "42" });
	assert.deepEqual(result.structuredContent, result.details);
	assert.equal(result.content[0].text, `bravo (${b.id}) answered your ask ${ask.id}:\n\n42`);
	assert.equal(a.sent.length, 0, "the answer is neither injected nor shown");
	await a.shutdown();
	await b.shutdown();
});

/** Two running sessions, alpha and bravo. */
async function pair() {
	const a = session(newId(), { name: "alpha" });
	const b = session(newId(), { name: "bravo" });
	await a.start();
	await b.start();
	return { a, b };
}

test("a stopped answer comes back labelled as not an answer", async () => {
	const { a, b } = await pair();
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "long job" });
	await until(() => b.sent.length === 1, "the ask to be injected");
	await b.answer("half done", { aborted: true });
	const result = await asked;
	const details = result.details as AskDetails;
	assert.equal(details.outcome, "answered");
	assert.equal(details.status, "stopped");
	assert.deepEqual(result.structuredContent, result.details);
	assert.match(result.content[0].text, /status "stopped", not "done": this is not an answer to your ask/);
	assert.match(result.content[0].text, /half done$/);
	await a.shutdown();
	await b.shutdown();
});

test("an ask gives up after 10 minutes, and a later answer arrives as a message that starts a turn", async (t) => {
	const { a, b } = await pair();
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "slow question" });
	t.mock.timers.tick(10 * 60 * 1000 - 1);
	let settled = false;
	void asked.then(() => (settled = true));
	await turn();
	assert.equal(settled, false, "still waiting a moment before 10 minutes");
	t.mock.timers.tick(1);
	const result = await asked;
	t.mock.timers.reset();
	assert.equal((result.details as AskDetails).outcome, "timed-out");
	assert.deepEqual(result.structuredContent, result.details);
	assert.match(result.content[0].text, /^No answer yet: bravo \(.*\) did not answer your ask \S+ within 10 minutes/);
	assert.match(result.content[0].text, /A later answer arrives as a message\.$/);
	assert.equal(records().get(a.id)?.waitingOn, "");

	await until(() => b.sent.length === 1, "the ask to be injected");
	await b.answer("finally, 42");
	await until(() => a.sent.length === 1, "the late answer to be injected");
	assert.deepEqual(a.sent[0].options, { triggerTurn: true, deliverAs: "steer" });
	assert.match(a.sent[0].message.content, /answers an ask of yours that is not waiting for it/);
	assert.match(a.sent[0].message.content, /finally, 42\n\n\[mailbox\] End of the mail from /);
	// The model sent the ask, so its answer is not labelled as the user's request.
	assert.doesNotMatch(a.sent[0].message.content, /The user made that request/);
	await a.shutdown();
	await b.shutdown();
});

// Bug caught: a watched parent's ask holds its turn, so the user cannot talk to it until the child answers.
test("in a TUI session a person watches, an ask returns at once and the answer arrives as a message that starts a turn", async () => {
	const a = session(newId(), { name: "alpha", mode: "tui" });
	const b = session(newId(), { name: "bravo" });
	await a.start();
	await b.start();
	const result = await a.toolCall("session_mail_ask", { to: "bravo", message: "more work" });
	const details = result.details as AskDetails;
	assert.equal(details.outcome, "background");
	assert.deepEqual(result.structuredContent, result.details);
	assert.match(result.content[0].text, /^Sent ask \S+ to bravo \(.*\)\. This session is not waiting/);
	assert.equal(records().get(a.id)?.waitingOn, "");

	await until(() => b.sent.length === 1, "the ask to be injected");
	await b.answer("work done");
	await until(() => a.sent.length === 1, "the answer to be injected");
	assert.deepEqual(a.sent[0].options, { triggerTurn: true, deliverAs: "steer" });
	assert.match(a.sent[0].message.content, /answers an ask of yours that is not waiting for it/);
	assert.ok(a.sent[0].message.content.includes(`reply to your ask ${details.id}.`));
	assert.ok(a.sent[0].message.content.includes(`[mailbox] Your ask ${details.id}, quoted from `));
	assert.match(a.sent[0].message.content, /work done\n\n\[mailbox\] End of the mail from /);
	await a.shutdown();
	await b.shutdown();
});

// Bug caught: a delegate (a TUI marked unattended) that stops waiting ends its turn, and its settle reports the question as its result.
test("in a TUI session marked PI_UNATTENDED=1, an ask still waits for its answer", async (t) => {
	process.env.PI_UNATTENDED = "1";
	t.after(() => {
		delete process.env.PI_UNATTENDED;
	});
	const a = session(newId(), { name: "alpha", mode: "tui" });
	const b = session(newId(), { name: "bravo" });
	await a.start();
	await b.start();
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "which seam?" });
	await until(() => records().get(a.id)?.waitingOn === b.id, "the wait to be recorded");
	await until(() => b.sent.length === 1, "the ask to be injected");
	await b.answer("the public one");
	const result = await asked;
	assert.equal((result.details as AskDetails).outcome, "answered");
	assert.match(result.content[0].text, /the public one$/);
	assert.equal(a.sent.length, 0, "the answer is the result, not a message");
	await a.shutdown();
	await b.shutdown();
});

test("the user stopping the run ends the wait", async () => {
	const { a, b } = await pair();
	const stop = new AbortController();
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "hello?" }, stop.signal);
	await until(() => records().get(a.id)?.waitingOn === b.id, "the wait to be recorded");
	stop.abort();
	const result = await asked;
	assert.equal((result.details as AskDetails).outcome, "stopped-by-user");
	assert.deepEqual(result.structuredContent, result.details);
	assert.match(result.content[0].text, /^The user stopped the wait for your ask/);
	assert.equal(records().get(a.id)?.waitingOn, "");
	await a.shutdown();
	await b.shutdown();
});

test("a target whose record disappears mid-wait is reported as stopped running", async () => {
	const { a, b } = await pair();
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "are you there?" });
	await b.shutdown();
	const result = await asked;
	assert.equal((result.details as AskDetails).outcome, "stopped-running");
	assert.deepEqual(result.structuredContent, result.details);
	assert.match(result.content[0].text, /^bravo \(.*\) stopped running before it answered your ask/);
	await a.shutdown();
});

test("waitingOn shows in the list while an ask waits, and is cleared once it is answered", async () => {
	const { a, b } = await pair();
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "q" });
	await until(() => b.sent.length === 1, "the ask to be injected");
	const text = (await b.toolCall("session_mail_list")).content[0].text;
	assert.ok(text.includes(`- alpha\n  id: ${a.id}\n  cwd: ${dir}\n  state: idle, waiting on bravo (${b.id})`), text);
	await b.answer("a");
	await asked;
	assert.equal(records().get(a.id)?.waitingOn, "");
	assert.ok(!(await b.toolCall("session_mail_list")).content[0].text.includes("waiting on"));
	await a.shutdown();
	await b.shutdown();
});

test("a second ask is refused while one waits, writing nothing", async () => {
	const { a, b } = await pair();
	const c = session(newId(), { name: "charlie" });
	await c.start();
	const stop = new AbortController();
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "first" }, stop.signal);
	await assert.rejects(
		a.toolCall("session_mail_ask", { to: "charlie", message: "second" }),
		/nothing was sent: your ask \S+ to \S+ is still waiting, and only one ask waits at a time/,
	);
	assert.deepEqual(files(c.id, "new").concat(files(c.id, "cur")), []);
	stop.abort();
	await asked;
	await Promise.all([a.shutdown(), b.shutdown(), c.shutdown()]);
});

test("asking a session that waits on this one is refused at once", async () => {
	const { a, b } = await pair();
	const stop = new AbortController();
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "first" }, stop.signal);
	await assert.rejects(
		b.toolCall("session_mail_ask", { to: "alpha", message: "back at you" }),
		/nothing was sent: alpha \(.*\) is waiting on an answer from this session/,
	);
	assert.equal(files(b.id, "sent").length, 0);
	stop.abort();
	await asked;
	await a.shutdown();
	await b.shutdown();
});

test("an ask to a session that is not running is refused, and so are this session, unknown and ambiguous names", async () => {
	const { a, b } = await pair();
	const closed = newId();
	await assert.rejects(
		a.toolCall("session_mail_ask", { to: closed, message: "hi" }),
		/is not running, so it cannot answer/,
	);
	await assert.rejects(a.toolCall("session_mail_ask", { to: "alpha", message: "hi" }), /cannot send mail to itself/);
	await assert.rejects(a.toolCall("session_mail_ask", { to: "nobody", message: "hi" }), /no running session is named/);
	await assert.rejects(a.toolCall("session_mail_ask", { to: "bravo", message: " " }), /empty/);
	assert.deepEqual(files(closed, "new"), []);
	assert.deepEqual(files(a.id, "sent"), []);
	assert.equal(records().get(a.id)?.waitingOn, "");
	await a.shutdown();
	await b.shutdown();
});

test("an ask is written without a hops field", async () => {
	const { a, b } = await pair();
	const stop = new AbortController();
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "q" }, stop.signal);
	assert.equal("hops" in envelopes(a.id, "sent")[0], false);
	stop.abort();
	await asked;
	await a.shutdown();
	await b.shutdown();
});

test("an ask reaches its target labelled as waiting, and arms an automatic answer", async () => {
	const { a, b } = await pair();
	const inbound: string[] = [];
	b.events.on("message:inbound", (p) => void inbound.push((p as { envelope: { kind: string } }).envelope.kind));
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "the question" });
	await until(() => b.sent.length === 1, "the ask to be injected");
	const [ask] = envelopes(a.id, "sent");
	assert.deepEqual(b.sent[0].options, { triggerTurn: true, deliverAs: "steer" });
	const content = b.sent[0].message.content;
	assert.ok(content.startsWith(`[mailbox] From alpha (${a.id}, working in `), content);
	assert.ok(
		content.includes(
			`It is waiting for your answer to its ask ${ask.id}. Answer with session_mail_reply (ask ${ask.id}); otherwise this run's last message is sent as the answer.`,
		),
		content,
	);
	assert.match(content, /the question\n\n\[mailbox\] End of the mail from /);
	assert.deepEqual(inbound, ["ask"]);
	await b.answer("the answer");
	await asked;
	const [answer] = envelopes(a.id, "cur");
	assert.deepEqual(answer.in_reply_to, [ask.id]);
	assert.equal("hops" in answer, false);
	await a.shutdown();
	await b.shutdown();
});

test("the answer to a waiting ask is not emitted on message:inbound", async () => {
	const { a, b } = await pair();
	const inbound: string[] = [];
	a.events.on("message:inbound", (p) => void inbound.push((p as { envelope: { kind: string } }).envelope.kind));
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "q" });
	await until(() => b.sent.length === 1, "the ask to be injected");
	await b.answer("a");
	await asked;
	assert.deepEqual(inbound, []);
	assert.equal(a.sent.length, 0);
	await a.shutdown();
	await b.shutdown();
});

// ---------------------------------------------------------------------------
// session_mail_reply

test("a reply mid-run answers the ask before the answerer settles, and settle sends no second answer", async () => {
	const { a, b } = await pair();
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "quick one" });
	await until(() => b.sent.length === 1, "the ask to be injected");
	const [ask] = envelopes(a.id, "sent");
	await b.agentStart();
	plant(b.id, newId());
	await until(() => b.sent.length === 2, "a message to be steered in");
	const replied = await b.toolCall("session_mail_reply", { ask: ask.id, message: "  right away  " });
	const result = await asked;
	assert.deepEqual(result.details, { id: ask.id, to: b.id, outcome: "answered", status: "done", body: "right away" });
	const [answer] = envelopes(a.id, "cur");
	assert.equal(answer.kind, "reply");
	assert.equal("hops" in answer, false);
	assert.deepEqual(answer.in_reply_to, [ask.id]);
	assert.match(replied.content[0].text, new RegExp(`^Answered ask ${ask.id} from alpha`));
	assert.deepEqual(replied.structuredContent, { id: answer.id, ask: ask.id, to: a.id });
	assert.deepEqual(replied.structuredContent, replied.details);
	await b.agentEnd("the final message");
	await b.settle();
	assert.equal(envelopes(a.id, "new").length + envelopes(a.id, "cur").length, 1, "no second answer");
	await a.shutdown();
	await b.shutdown();
});

test("with a request and an ask from one sender, the reply answers only the ask and settle answers neither", async () => {
	const { a, b } = await pair();
	await a.request(b.id, "a request");
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "an ask" });
	await until(() => b.sent.length === 2, "both to be injected");
	const sent = envelopes(a.id, "sent");
	const ask = sent.find((e) => e.kind === "ask");
	await b.agentStart();
	await b.toolCall("session_mail_reply", { ask: ask.id, message: "the ask's answer" });
	assert.equal((await asked).content[0].text.endsWith("the ask's answer"), true);
	await b.agentEnd("the run's answer");
	await b.settle();
	const answers = envelopes(a.id, "new").concat(envelopes(a.id, "cur"));
	assert.deepEqual(
		answers.map((e) => [e.in_reply_to, e.body]),
		[[[ask.id], "the ask's answer"]],
	);
	await a.shutdown();
	await b.shutdown();
});

test("session_mail_reply refuses a second reply, a request, a message, an unknown id and an empty text, sending nothing", async () => {
	const { a, b } = await pair();
	await a.request(b.id, "a request");
	await a.toolCall("session_mail_send", { to: "bravo", message: "a message" });
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "an ask" });
	await until(() => b.sent.length === 3, "all three to be injected");
	const sent = envelopes(a.id, "sent");
	const id = (kind: string) => sent.find((e) => e.kind === kind).id;
	await b.agentStart();
	await assert.rejects(b.toolCall("session_mail_reply", { ask: id("ask"), message: " " }), /the answer is empty/);
	await b.toolCall("session_mail_reply", { ask: id("ask"), message: "once" });
	await asked;
	const count = () => envelopes(a.id, "new").length + envelopes(a.id, "cur").length;
	assert.equal(count(), 1);
	await assert.rejects(
		b.toolCall("session_mail_reply", { ask: id("ask"), message: "twice" }),
		/is already answered; nothing was sent/,
	);
	await assert.rejects(
		b.toolCall("session_mail_reply", { ask: id("request"), message: "x" }),
		/is a request, not an ask; nothing was sent\. A request is answered by the extension that consumes it, not by this tool/,
	);
	await assert.rejects(
		b.toolCall("session_mail_reply", { ask: id("message"), message: "x" }),
		/is a message, not an ask; nothing was sent\. A message expects no answer/,
	);
	await assert.rejects(
		b.toolCall("session_mail_reply", { ask: "no-such-id", message: "x" }),
		/no mail with id "no-such-id" reached this session/,
	);
	assert.equal(count(), 1);
	await a.shutdown();
	await b.shutdown();
});

test("an ask answered at settle cannot be answered again by session_mail_reply", async () => {
	const { a, b } = await pair();
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "q" });
	await until(() => b.sent.length === 1, "the ask to be injected");
	const [ask] = envelopes(a.id, "sent");
	await b.answer("at settle");
	await asked;
	await assert.rejects(b.toolCall("session_mail_reply", { ask: ask.id, message: "late" }), /is already answered/);
	await a.shutdown();
	await b.shutdown();
});

test("session_mail_reply after shutdown is refused for want of a mailbox address, writing nothing", async () => {
	const { a, b } = await pair();
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "q" });
	await until(() => b.sent.length === 1, "the ask to be injected");
	const [ask] = envelopes(a.id, "sent");
	await b.shutdown();
	await assert.rejects(
		b.toolCall("session_mail_reply", { ask: ask.id, message: "too late" }),
		/^Error: this session has no mailbox address; nothing was sent$/,
	);
	assert.equal(envelopes(a.id, "new").length + envelopes(a.id, "cur").length, 0, "no reply envelope");
	await a.shutdown();
	await asked;
});

test("an ask whose delivery throws before it is armed gets no answer at settle", async () => {
	const { a, b } = await pair();
	// A real bus never lets a listener's throw reach `deliver` (it catches them),
	// so the throw is made at `emit`, but only inside the synchronous scan below.
	const emit = b.events.emit.bind(b.events);
	let scanning = false;
	b.events.emit = (channel: string, data: unknown) => {
		if (channel === "message:scan") {
			scanning = true;
			try {
				return emit(channel, data);
			} finally {
				scanning = false;
			}
		}
		if (channel === "message:inbound" && scanning) throw new Error("listener failed");
		return emit(channel, data);
	};
	const asked = a.toolCall("session_mail_ask", { to: "bravo", message: "q" });
	const originalError = console.error;
	console.error = () => {};
	try {
		b.events.emit("message:scan", {});
	} finally {
		console.error = originalError;
	}
	assert.equal(envelopes(b.id, "cur").length, 1, "the ask was claimed");
	assert.equal(b.sent.length, 0, "the ask was never injected");
	await b.answer("an answer nobody asked for");
	assert.equal(envelopes(a.id, "new").length + envelopes(a.id, "cur").length, 0, "no reply to the ask");
	await a.shutdown();
	await asked;
	await b.shutdown();
});
