// `mailbox` gives each Pi session an address (its session id) and an inbox on
// disk. These tests drive the extension only through its registration
// function, with a fake `pi` and `ctx`, and observe files, injected messages,
// `pi.events` traffic, statuses and notifications. The prune race and
// crash-leftover tests call `pruneClosed` directly, because those windows cannot
// be reached through the registration function.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createEventBus } from "@earendil-works/pi-coding-agent";

import { pruneClosed } from "../src/store.ts";
import { box, dir, envelopes, files, newId, records, session, stateRoot, turn, until } from "./harness.ts";

const root = stateRoot();

// ---------------------------------------------------------------------------
// Addressing and sending

test("/mailbox with no arguments shows the session's address", async () => {
	const a = session(newId("a"));
	await a.mailbox("");
	assert.equal(a.notes.length, 1);
	assert.match(a.notes[0], new RegExp(a.id));
});

test("/mailbox <address> <text> writes a request to the recipient's new/ and the sender's sent/", async () => {
	const a = session(newId("a"));
	const b = newId("b");
	await a.mailbox(`${b}   hello there `);
	assert.equal(files(b, "new").length, 1);
	assert.deepEqual(files(b, "tmp"), []);
	assert.equal(files(a.id, "sent").length, 1);
	const [env] = envelopes(b, "new");
	assert.equal(env.from, a.id);
	assert.equal(env.to, b);
	assert.deepEqual(env.in_reply_to, []);
	assert.equal(env.kind, "request");
	assert.equal(env.hops, 0);
	assert.equal(env.status, "");
	assert.equal(env.body, "hello there");
	assert.match(env.id, /^[0-9a-f-]{36}$/);
	assert.ok(!Number.isNaN(Date.parse(env.ts)));
	assert.ok(files(b, "new")[0].endsWith(`${env.id}.json`));
	assert.deepEqual(envelopes(a.id, "sent"), [env]);
	assert.deepEqual(a.errors, []);
});

test("mail lands under $XDG_STATE_HOME/pi-session-mail/<address>/, a root created owner-only, and nothing under the agent dir", async () => {
	const a = session(newId("a"));
	const b = newId("b");
	await a.mailbox(`${b} hello`);
	assert.equal(readdirSync(join(dir, "state", "pi-session-mail", b, "new")).length, 1);
	assert.equal(statSync(root).mode & 0o777, 0o700);
	for (const sub of ["tmp", "new", "cur", "sent"]) assert.equal(statSync(box(b, sub as "new")).mode & 0o777, 0o700);
	assert.ok(!existsSync(join(dir, "agent", "mailbox")));
});

test("a delivered envelope and its sent/ copy are owner-only (0600) even under umask 0022", async () => {
	const a = session(newId("a"));
	const b = newId("b");
	const saved = process.umask(0o022);
	try {
		await a.mailbox(`${b} private`);
	} finally {
		process.umask(saved);
	}
	assert.equal(statSync(join(box(b, "new"), files(b, "new")[0])).mode & 0o777, 0o600);
	assert.equal(statSync(join(box(a.id, "sent"), files(a.id, "sent")[0])).mode & 0o777, 0o600);
});

test("a mail root that already exists at 0755 is tightened to 0700 at session start", async () => {
	const saved = process.env.XDG_STATE_HOME;
	try {
		process.env.XDG_STATE_HOME = join(dir, "loose-state");
		mkdirSync(stateRoot(), { recursive: true });
		chmodSync(stateRoot(), 0o755);
		assert.equal(statSync(stateRoot()).mode & 0o777, 0o755);
		await session(newId("a")).start();
		assert.equal(statSync(stateRoot()).mode & 0o777, 0o700);
	} finally {
		process.env.XDG_STATE_HOME = saved;
	}
});

// A root this user cannot chmod (here a link to the root-owned, world-writable
// /tmp) is used as it is, as before the tightening existed.
test("a mail root that cannot be tightened still starts the mailbox", {
	skip: process.getuid?.() === 0 || statSync("/tmp").uid === process.getuid?.(),
}, async () => {
	const saved = process.env.XDG_STATE_HOME;
	const a = session(newId("a"));
	const hadRunning = existsSync("/tmp/running");
	try {
		process.env.XDG_STATE_HOME = join(dir, "foreign-state");
		mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
		symlinkSync("/tmp", stateRoot());
		await a.start();
		assert.ok(existsSync(join("/tmp", a.id, "new")));
		assert.ok(existsSync(join("/tmp", "running", `${a.id}.json`)));
	} finally {
		await a.shutdown();
		process.env.XDG_STATE_HOME = saved;
		rmSync(join("/tmp", a.id), { recursive: true, force: true });
		if (!hadRunning) rmSync("/tmp/running", { recursive: true, force: true });
	}
});

test("a session whose address folder grants group or other access warns once, naming the folder and the fix, and leaves it alone", async () => {
	const a = session(newId("a"));
	const folder = join(stateRoot(), a.id);
	mkdirSync(folder, { recursive: true });
	chmodSync(folder, 0o750);
	await a.start();
	assert.equal(a.warnings.length, 1);
	assert.ok(a.warnings[0].includes(folder));
	assert.ok(a.warnings[0].includes(`chmod 700 ${folder}`));
	assert.equal(statSync(folder).mode & 0o777, 0o750);
	const tight = session(newId("t"));
	await tight.start();
	assert.deepEqual(tight.warnings, []);
});

test("the root is read at call time and ignores a relative XDG_STATE_HOME", async () => {
	const saved = process.env.XDG_STATE_HOME;
	const other = join(dir, "other-state");
	const home = process.env.HOME;
	const fakeHome = join(dir, "home");
	try {
		process.env.XDG_STATE_HOME = other;
		const a = session(newId("a"));
		const b = newId("b");
		await a.mailbox(`${b} moved`);
		assert.equal(readdirSync(join(other, "pi-session-mail", b, "new")).length, 1);

		process.env.XDG_STATE_HOME = "relative/state";
		process.env.HOME = fakeHome;
		const c = newId("c");
		await a.mailbox(`${c} fallback`);
		assert.equal(readdirSync(join(fakeHome, ".local", "state", "pi-session-mail", c, "new")).length, 1);
		assert.ok(!existsSync(join("relative", "state")));
	} finally {
		process.env.XDG_STATE_HOME = saved;
		process.env.HOME = home;
	}
});

test("file names sort in send order", async () => {
	const a = session(newId("a"));
	const b = newId("b");
	for (const n of ["one", "two", "three", "four", "five"]) await a.mailbox(`${b} ${n}`);
	assert.deepEqual(
		envelopes(b, "new").map((e) => e.body),
		["one", "two", "three", "four", "five"],
	);
});

test("an invalid address is rejected before any path is built", async () => {
	const a = session(newId("a"));
	for (const bad of ["../evil hi", "a/b hi", ". hi", "x.y hi", "evil"]) await a.mailbox(bad);
	assert.equal(a.errors.length, 5);
	assert.ok(!existsSync(join(dir, "agent", "evil")));
	assert.ok(!existsSync(join(root, "a")));
	assert.ok(!existsSync(join(root, "x.y")));
	assert.deepEqual(files(a.id, "sent"), []);
});

// ---------------------------------------------------------------------------
// Receiving

test("a running session claims a message into cur/ and injects it once as labelled steered mail that starts a turn", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.start();
	await b.start();
	try {
		await a.mailbox(`${b.id} what is 2 + 2?`);
		await until(() => b.sent.length === 1, "B to receive");
		const [{ message, options }] = b.sent;
		assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
		assert.equal(message.customType, "mailbox");
		assert.equal(message.display, true);
		assert.match(
			message.content,
			new RegExp(`^\\[mailbox\\] From \\S+ \\(${a.id}, working in [^)]+\\), another Pi session on this machine\\.`),
		);
		assert.match(message.content, /final answer this turn goes back to it automatically/);
		assert.ok(!/not from the user|untrusted|injection/.test(message.content), message.content);
		assert.match(message.content, /what is 2 \+ 2\?\n\n\[mailbox\] End of the mail from /);
		assert.deepEqual(files(b.id, "new"), []);
		assert.equal(files(b.id, "cur").length, 1);
		await new Promise((r) => setTimeout(r, 1300)); // a further poll finds nothing new
		assert.equal(b.sent.length, 1);
	} finally {
		await a.shutdown();
		await b.shutdown();
	}
});

test("messages are delivered in send order", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	for (const n of ["first", "second", "third"]) await a.mailbox(`${b.id} ${n}`);
	await b.start();
	await b.shutdown();
	assert.deepEqual(
		b.sent.map((s) => s.message.content.split("\n").at(-3)),
		["first", "second", "third"],
	);
});

test("mail waiting at session start is claimed after a turn, never inside session_start", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} waiting`);
	const seen: unknown[] = [];
	b.events.on("message:inbound", (payload) => void seen.push(payload));
	await b.sessionStart();
	assert.deepEqual(seen, [], "nothing is emitted inside session_start");
	assert.equal(b.sent.length, 0, "nothing is injected inside session_start");
	await turn();
	assert.equal(seen.length, 1);
	assert.equal(b.sent.length, 1);
	assert.match(b.sent[0].message.content, /waiting\n\n\[mailbox\] End of the mail from /);
	await b.shutdown();
});

test("a listener that rebuilds state in a later extension's session_start sees waiting mail", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} waiting`);
	let restored = false;
	const seen: unknown[] = [];
	// Registered after `mailbox`'s own handler, as a later extension's would be.
	b.pi.on("session_start", () => {
		restored = true;
	});
	b.events.on("message:inbound", (payload) => {
		if (restored) seen.push(payload);
	});
	await b.sessionStart();
	await turn();
	assert.equal(seen.length, 1, "the listener had already rebuilt its state");
	await b.shutdown();
});

test("shutdown cancels a scan deferred to the next turn", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} too late`);
	await b.sessionStart();
	await b.shutdown();
	await turn();
	assert.deepEqual(b.sent, [], "the deferred scan never runs");
	assert.equal(files(b.id, "new").length, 1, "the mail stays on disk");
});

test("a body over 32 KiB is cut, with the envelope's cur/ path; a smaller one passes whole", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	const small = "é".repeat(100);
	const big = `${"x".repeat(32 * 1024 - 1)}é${"y".repeat(5000)}`;
	await a.mailbox(`${b.id} ${small}`);
	await a.mailbox(`${b.id} ${big}`);
	await b.start();
	await b.shutdown();
	assert.equal(b.sent.length, 2);
	assert.ok(b.sent[0].message.content.includes(`\n\n${small}\n\n[mailbox] End of the mail from `));
	const cut = b.sent[1].message.content;
	// the two-byte é straddles the 32 KiB mark, so the cut backs off to before it
	assert.ok(cut.includes(`\n\n${"x".repeat(32 * 1024 - 1)}\n\n`));
	assert.ok(!cut.includes("xé"));
	const bigFile = files(b.id, "cur")[1];
	assert.ok(cut.includes(join(box(b.id, "cur"), bigFile)));
	assert.match(cut, /32 KiB/);
});

test("the same envelope id is never injected twice", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} once`);
	const [name] = files(b.id, "new");
	const copy = readFileSync(join(box(b.id, "new"), name), "utf8");
	await b.start();
	writeFileSync(join(box(b.id, "new"), `999999999999999-${name}`), copy); // a duplicate of the same id
	await b.start("reload");
	await b.shutdown();
	assert.equal(b.sent.length, 1);
});

test("a malformed envelope is set aside in cur/ with one warning and does not block later mail", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	mkdirSync(box(b.id, "new"), { recursive: true, mode: 0o700 });
	writeFileSync(join(box(b.id, "new"), "000000000000001-bad.json"), "{ not json");
	writeFileSync(
		join(box(b.id, "new"), "000000000000002-evil.json"),
		JSON.stringify({ id: "x", from: "../up", to: b.id, in_reply_to: [], status: "", ts: "", body: "hi" }),
	);
	writeFileSync(join(box(b.id, "new"), "000000000000003-ignored.txt"), "not an envelope");
	mkdirSync(join(box(b.id, "new"), "000000000000004-dir.json"));
	await a.mailbox(`${b.id} still works`);
	await b.start();
	await b.shutdown();
	assert.equal(b.sent.length, 1);
	assert.match(b.sent[0].message.content, /still works\n\n\[mailbox\] End of the mail from /);
	assert.equal(b.warnings.length, 2);
	assert.ok(files(b.id, "cur").includes("000000000000001-bad.json"));
	assert.ok(files(b.id, "cur").includes("000000000000002-evil.json"));
	assert.ok(files(b.id, "new").includes("000000000000003-ignored.txt"));
});

test("mail sent before a session starts is delivered at its start, and a resumed session gets what arrived while closed", async () => {
	const a = session(newId("a"));
	const bId = newId("b");
	await a.mailbox(`${bId} task before launch`);
	const b = session(bId);
	await b.start();
	assert.equal(b.sent.length, 1);
	await b.shutdown();
	await a.mailbox(`${bId} while closed`);
	const resumed = session(bId);
	await resumed.start("resume");
	await resumed.shutdown();
	assert.equal(resumed.sent.length, 1);
	assert.match(resumed.sent[0].message.content, /while closed\n\n\[mailbox\] End of the mail from /);
});

test("after session_shutdown nothing more is delivered", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await b.start();
	await b.shutdown();
	await b.shutdown(); // idempotent
	await a.mailbox(`${b.id} too late`);
	await new Promise((r) => setTimeout(r, 1300));
	assert.equal(b.sent.length, 0);
	assert.equal(files(b.id, "new").length, 1);
});

// ---------------------------------------------------------------------------
// Replying

test("a request is answered once the recipient settles, not at agent_end, and the reply reaches the sender", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} what is 2 + 2?`);
	const [request] = envelopes(a.id, "sent");
	await b.start();
	await b.agentEnd("It is 4.");
	assert.deepEqual(files(a.id, "new"), []);
	await b.settle();
	const [reply] = envelopes(a.id, "new");
	assert.equal(reply.from, b.id);
	assert.equal(reply.to, a.id);
	assert.equal(reply.status, "done");
	assert.equal(reply.kind, "reply");
	assert.equal(reply.hops, 1); // the request (hop 0) started this turn
	assert.deepEqual(reply.in_reply_to, [request.id]);
	assert.equal(reply.body, "It is 4.");
	assert.equal(files(b.id, "sent").length, 0);
	await a.start();
	await a.shutdown();
	await b.shutdown();
	assert.equal(a.sent.length, 1);
	assert.match(a.sent[0].message.content, new RegExp(`^\\[mailbox\\] From \\S+ \\(${b.id}[,)]`));
	assert.match(a.sent[0].message.content, new RegExp(`reply to your request ${request.id}`));
	assert.match(a.sent[0].message.content, /It is 4\.\n\n\[mailbox\] End of the mail from /);
});

test("one reply per sender per settle lists every request it answers", async () => {
	const a = session(newId("a"));
	const c = session(newId("c"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} one`);
	await a.mailbox(`${b.id} two`);
	await c.mailbox(`${b.id} three`);
	const aIds = envelopes(a.id, "sent").map((e) => e.id);
	const cIds = envelopes(c.id, "sent").map((e) => e.id);
	await b.start();
	await b.answer("all done");
	await b.shutdown();
	const toA = envelopes(a.id, "new");
	const toC = envelopes(c.id, "new");
	assert.equal(toA.length, 1);
	assert.deepEqual(toA[0].in_reply_to, aIds);
	assert.equal(toC.length, 1);
	assert.deepEqual(toC[0].in_reply_to, cIds);
});

test("a settle without an assistant answer still replies, with a placeholder", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} hello`);
	await b.start();
	await b.answer();
	await b.shutdown();
	const [reply] = envelopes(a.id, "new");
	assert.match(reply.body, /no answer/i);
});

test("replies are never answered, and a settle with nothing pending sends nothing", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} ping`);
	await b.start();
	await b.answer("pong");
	await a.start();
	assert.equal(a.sent.length, 1); // the reply
	await a.answer("thanks");
	await b.answer("user-typed turn");
	await a.shutdown();
	await b.shutdown();
	assert.deepEqual(files(b.id, "new"), []);
	assert.equal(files(a.id, "cur").length, 1);
	assert.equal(files(a.id, "new").length, 0);
});

test("an envelope written before kind and hops is read as a request or a reply by in_reply_to, with hops 0", async () => {
	type Inbound = { envelope: { kind: string; hops: number; in_reply_to: string[] } };
	const b = session(newId("b"));
	const seen: Inbound[] = [];
	b.events.on("message:inbound", (p) => void seen.push(p as Inbound));
	const a = newId("a");
	mkdirSync(box(b.id, "new"), { recursive: true, mode: 0o700 });
	const old = (id: string, inReplyTo: string[]) =>
		JSON.stringify({
			id,
			from: a,
			to: b.id,
			in_reply_to: inReplyTo,
			status: inReplyTo.length > 0 ? "done" : "",
			ts: "",
			body: "old",
		});
	writeFileSync(join(box(b.id, "new"), "000000000000001-old-request.json"), old("old-request", []));
	writeFileSync(join(box(b.id, "new"), "000000000000002-old-reply.json"), old("old-reply", ["some-request"]));
	await b.start();
	await b.answer("answered");
	await b.shutdown();
	assert.deepEqual(
		seen.map((p) => [p.envelope.kind, p.envelope.hops]),
		[
			["request", 0],
			["reply", 0],
		],
	);
	const [reply] = envelopes(a, "new");
	assert.deepEqual(reply.in_reply_to, ["old-request"]);
	assert.equal(reply.kind, "reply");
	assert.deepEqual(b.warnings, []);
});

test("an envelope with a bad hop count is set aside with a warning", async () => {
	const b = session(newId("b"));
	const a = newId("a");
	mkdirSync(box(b.id, "new"), { recursive: true, mode: 0o700 });
	const bad = (id: string, extra: object) =>
		JSON.stringify({ id, from: a, to: b.id, in_reply_to: [], status: "", ts: "", body: "x", ...extra });
	writeFileSync(join(box(b.id, "new"), "000000000000002-h.json"), bad("h", { kind: "request", hops: -1 }));
	await b.start();
	await b.shutdown();
	assert.equal(b.sent.length, 0);
	assert.equal(b.warnings.length, 1);
	assert.match(b.warnings[0], /invalid hops -1/);
});

test("an envelope with an unknown kind is delivered as a message, waking the session and expecting no answer", async () => {
	const b = session(newId("b"));
	const a = newId("a");
	mkdirSync(box(b.id, "new"), { recursive: true, mode: 0o700 });
	writeFileSync(
		join(box(b.id, "new"), "000000000000001-k.json"),
		JSON.stringify({
			id: "k",
			from: a,
			to: b.id,
			in_reply_to: [],
			status: "",
			ts: "",
			body: "from the future",
			kind: "shout",
			hops: 0,
		}),
	);
	const seen: { envelope: { kind: string } }[] = [];
	b.events.on("message:inbound", (p) => void seen.push(p as (typeof seen)[number]));
	await b.start();
	assert.equal(b.sent.length, 1);
	assert.match(b.sent[0].message.content, /from the future/);
	assert.match(b.sent[0].message.content, /expects no answer/);
	assert.deepEqual(
		seen.map((p) => p.envelope.kind),
		["message"],
	);
	await b.answer("done");
	await b.shutdown();
	assert.deepEqual(files(a, "new"), []);
	assert.deepEqual(b.warnings, []);
});

test("a message:send emitted during a run carries the run's hops and is refused past the limit as a loop", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.start();
	await a.agentStart();
	mkdirSync(box(a.id, "new"), { recursive: true, mode: 0o700 });
	writeFileSync(
		join(box(a.id, "new"), "000000000000001-p.json"),
		JSON.stringify({
			id: "p",
			from: newId(),
			to: a.id,
			in_reply_to: [],
			status: "",
			ts: "",
			body: "hop 4",
			kind: "message",
			hops: 4,
		}),
	);
	await until(() => a.sent.length === 1, "the message to be injected");
	const payload: SendPayload = { to: b.id, body: "continue the chain" };
	a.events.emit("message:send", payload);
	assert.equal(payload.error, undefined);
	assert.equal(payload.envelope?.hops, 5);
	assert.equal(payload.envelope?.kind, "request");
	await b.start();
	await b.agentStart();
	await until(() => b.sent.length === 1, "the request to be injected");
	await assert.rejects(b.toolCall("session_mail_send", { to: newId(), message: "again" }), /hop limit of 5/);
	await a.shutdown();
	await b.shutdown();
});

test("a message:send emitted while idle carries hops 0 even when mail raised the count", async () => {
	const a = session(newId("a"));
	const b = newId("b");
	mkdirSync(box(a.id, "new"), { recursive: true, mode: 0o700 });
	writeFileSync(
		join(box(a.id, "new"), "000000000000001-p.json"),
		JSON.stringify({
			id: "p",
			from: newId(),
			to: a.id,
			in_reply_to: [],
			status: "",
			ts: "",
			body: "hop 3",
			kind: "message",
			hops: 3,
		}),
	);
	await a.start();
	assert.equal(a.sent.length, 1); // woke the idle session, which has not started its run yet
	const payload: SendPayload = { to: b, body: "from the user" };
	a.events.emit("message:send", payload);
	assert.equal(payload.envelope?.hops, 0);
	await a.shutdown();
});

test("an envelope with an invalid from gets no reply", async () => {
	const b = session(newId("b"));
	mkdirSync(box(b.id, "new"), { recursive: true, mode: 0o700 });
	writeFileSync(
		join(box(b.id, "new"), "000000000000001-x.json"),
		JSON.stringify({ id: "x", from: "../../up", to: b.id, in_reply_to: [], status: "", ts: "", body: "hi" }),
	);
	await b.start();
	await b.answer("answer");
	await b.shutdown();
	assert.ok(!existsSync(join(root, "..", "..", "up")));
	assert.ok(!existsSync(join(root, "up")));
	assert.equal(b.sent.length, 0);
});

// ---------------------------------------------------------------------------
// Unseen requests

test("a request dropped before it entered the conversation is answered failed, not done", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} never read`);
	const [request] = envelopes(a.id, "sent");
	b.drop(true);
	await b.start();
	assert.equal(b.sent.length, 1);
	await b.answer();
	await b.shutdown();
	const replies = envelopes(a.id, "new");
	assert.equal(replies.length, 1);
	assert.equal(replies[0].status, "failed");
	assert.deepEqual(replies[0].in_reply_to, [request.id]);
	assert.match(replies[0].body, /stopped before it read the message/);
});

test("one sender with a seen and an unseen request in one settle gets a done reply and a failed reply", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} read this`);
	await b.start();
	await a.mailbox(`${b.id} dropped`);
	const [readId, droppedId] = envelopes(a.id, "sent").map((e) => e.id);
	b.drop(true);
	await until(() => b.sent.length === 2, "B to receive the second request");
	await b.answer("answered the first");
	await b.shutdown();
	const replies = envelopes(a.id, "new");
	assert.equal(replies.length, 2);
	const done = replies.find((r) => r.status === "done");
	const failed = replies.find((r) => r.status === "failed");
	assert.deepEqual(done?.in_reply_to, [readId]);
	assert.equal(done?.body, "answered the first");
	assert.deepEqual(failed?.in_reply_to, [droppedId]);
});

test("a failed reply is injected with a header saying the request failed", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} never read`);
	const [request] = envelopes(a.id, "sent");
	b.drop(true);
	await b.start();
	await b.answer();
	await b.shutdown();
	await a.start();
	await a.shutdown();
	assert.equal(a.sent.length, 1);
	const header = a.sent[0].message.content.split("\n")[0];
	assert.match(header, new RegExp(`reply to your request ${request.id}`));
	assert.match(header, /\bfailed\b/);
});

// ---------------------------------------------------------------------------
// Stopped runs, quoted requests, quiet replies

test("a run the user stopped holds the request, and the next completed run answers it done, saying the user took over", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} do the thing`);
	const [request] = envelopes(a.id, "sent");
	await b.start();
	await b.answer("half of the answer", { aborted: true });
	assert.deepEqual(envelopes(a.id, "new"), []);
	await b.input("do it this way instead");
	await b.answer("the steered answer");
	const [reply] = envelopes(a.id, "new");
	assert.equal(reply.status, "done");
	assert.deepEqual(reply.in_reply_to, [request.id]);
	assert.match(reply.body, /^\(The user stopped an earlier run partway and took over/);
	assert.ok(reply.body.includes("the steered answer"), reply.body);
	assert.ok(!reply.body.includes("half of the answer"), reply.body);
	await a.start();
	await a.shutdown();
	await b.shutdown();
	assert.equal(a.sent.length, 1);
	assert.doesNotMatch(a.sent[0].message.content, /not "done"/);
});

test("a held request answered by a run with no text says the user took over and that there is no answer text", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} do the thing`);
	await b.start();
	await b.answer(undefined, { aborted: true });
	assert.deepEqual(envelopes(a.id, "new"), []);
	await b.answer(undefined);
	const [reply] = envelopes(a.id, "new");
	assert.equal(reply.status, "done");
	assert.match(reply.body, /^\(The user stopped an earlier run partway and took over/);
	assert.match(reply.body, /no answer text/);
});

test("a run the user stopped during a tool call holds the request, and the next completed run answers it", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} do the thing`);
	await b.start();
	await b.stopInToolCall("Sleeping first.");
	assert.deepEqual(envelopes(a.id, "new"), []);
	await b.answer("done after all");
	const [reply] = envelopes(a.id, "new");
	assert.equal(reply.status, "done");
	assert.match(reply.body, /^\(The user stopped an earlier run partway and took over/);
	assert.ok(reply.body.includes("done after all"), reply.body);
	assert.ok(!reply.body.includes("Sleeping first."), reply.body);
});

test("a request stays held through a second stop and a failed run, then gets one done reply", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} do the thing`);
	const [request] = envelopes(a.id, "sent");
	await b.start();
	await b.answer("first try", { aborted: true });
	await b.stopInToolCall("second try");
	await b.failOnApiError("529 overloaded_error", "third try");
	assert.deepEqual(envelopes(a.id, "new"), []);
	await b.answer("finally");
	const replies = envelopes(a.id, "new");
	assert.equal(replies.length, 1);
	assert.equal(replies[0].status, "done");
	assert.deepEqual(replies[0].in_reply_to, [request.id]);
	assert.match(replies[0].body, /^\(The user stopped an earlier run partway and took over/);
	assert.ok(replies[0].body.includes("finally"), replies[0].body);
	await b.answer("a later run");
	assert.equal(envelopes(a.id, "new").length, 1, "a held request is answered once");
});

test("a failed run with no stop before it still replies failed", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} do the thing`);
	await b.start();
	await b.failOnApiError("529 overloaded_error");
	const [reply] = envelopes(a.id, "new");
	assert.equal(reply.status, "failed");
	assert.doesNotMatch(reply.body, /took over/);
});

test("a run that ends on an API error replies failed with the error and the text before it", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} do the thing`);
	await b.start();
	await b.failOnApiError("529 overloaded_error", "Reading first.");
	const [reply] = envelopes(a.id, "new");
	assert.equal(reply.status, "failed");
	assert.match(reply.body, /^\(The run ended on an error before it finished: 529 overloaded_error\./);
	assert.ok(reply.body.includes("Reading first."), reply.body);
	assert.doesNotMatch(reply.body, /no answer|stopped/i);
});

test("a run that ends on an API error with no message or text still replies failed", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} do the thing`);
	await b.start();
	await b.failOnApiError(undefined);
	const [reply] = envelopes(a.id, "new");
	assert.equal(reply.status, "failed");
	assert.match(reply.body, /^\(The run ended on an error before it finished: unknown error\./);
	assert.doesNotMatch(reply.body, /no answer/i);
});

test("a stopped run's unseen requests still get a failed reply, and its read ones are held", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} read this`);
	await b.start();
	await a.mailbox(`${b.id} dropped`);
	const [readId, droppedId] = envelopes(a.id, "sent").map((e) => e.id);
	b.drop(true);
	await until(() => b.sent.length === 2, "B to receive the second request");
	await b.answer("partial", { aborted: true });
	await b.shutdown();
	const replies = envelopes(a.id, "new");
	assert.equal(replies.length, 1);
	assert.equal(replies[0].status, "failed");
	assert.deepEqual(replies[0].in_reply_to, [droppedId]);
	assert.ok(!replies.some((r) => r.in_reply_to.includes(readId)), "the read request is held");
});

test("an injected reply quotes every request it answers with its sent/ copy's path", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} first request`);
	await a.mailbox(`${b.id} second request`);
	const ids = envelopes(a.id, "sent").map((e) => e.id);
	const copies = files(a.id, "sent");
	await b.start();
	await b.answer("both answered");
	await a.start();
	await a.shutdown();
	await b.shutdown();
	assert.equal(a.sent.length, 1);
	const text = a.sent[0].message.content;
	assert.ok(text.includes("> first request"), text);
	assert.ok(text.includes("> second request"), text);
	assert.ok(text.includes(join(box(a.id, "sent"), copies[0])), text);
	assert.ok(text.includes(join(box(a.id, "sent"), copies[1])), text);
	assert.ok(text.includes(ids[0]) && text.includes(ids[1]), text);
	assert.match(text, /both answered\n\n\[mailbox\] End of the mail from /);
});

test("a request over 2 KiB is quoted cut on a character boundary, naming its copy", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	const long = `${"x".repeat(2 * 1024 - 1)}é${"y".repeat(500)}`;
	await a.mailbox(`${b.id} ${long}`);
	const [copy] = files(a.id, "sent");
	await b.start();
	await b.answer("short");
	await a.start();
	await a.shutdown();
	await b.shutdown();
	const text = a.sent[0].message.content;
	// the two-byte é straddles the 2 KiB mark, so the cut backs off to before it
	assert.ok(text.includes(`> ${"x".repeat(2 * 1024 - 1)}\n`), text.slice(0, 200));
	assert.ok(!text.includes("xé"), text);
	assert.match(text, /Request cut at 2 KiB/);
	assert.ok(text.includes(join(box(a.id, "sent"), copy)), text);
	assert.match(text, /short\n\n\[mailbox\] End of the mail from /);
});

test("a reply to a request with no sent/ copy names the id and still delivers", async () => {
	const b = session(newId("b"));
	mkdirSync(box(b.id, "new"), { recursive: true, mode: 0o700 });
	const reply = {
		id: "22222222-2222-4222-8222-222222222222",
		from: "someone",
		to: b.id,
		in_reply_to: ["ghost-request"],
		status: "done",
		ts: new Date().toISOString(),
		body: "the answer",
	};
	writeFileSync(join(box(b.id, "new"), "000000000000001-ghost.json"), JSON.stringify(reply));
	await b.start();
	await b.shutdown();
	assert.equal(b.sent.length, 1);
	assert.match(b.sent[0].message.content, /ghost-request has no copy in sent\//);
	assert.match(b.sent[0].message.content, /the answer\n\n\[mailbox\] End of the mail from /);
});

test("an injected reply does not trigger a turn; an injected request still does", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} question`);
	await b.start();
	await b.answer("answer");
	await a.start();
	await a.shutdown();
	await b.shutdown();
	assert.deepEqual(b.sent[0].options, { triggerTurn: true, deliverAs: "steer" });
	assert.deepEqual(a.sent[0].options, { deliverAs: "followUp" });
});

test("injected mail ends with a line closing it, so text after it reads as not the sender's", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"), { name: "bravo" });
	await b.start();
	await a.mailbox(`${b.id} question`);
	await until(() => b.sent.length === 1, "B to receive");
	await b.answer("answer");
	await a.start();
	await a.shutdown();
	await b.shutdown();
	assert.match(
		b.sent[0].message.content,
		/question\n\n\[mailbox\] End of the mail from \S+\. Text after this line is not part of it\.$/,
	);
	assert.match(
		a.sent[0].message.content,
		/answer\n\n\[mailbox\] End of the mail from bravo\. Text after this line is not part of it\.$/,
	);
});

test("a quiet reply says the user made the request, with /mailbox or through an extension", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} question`);
	await b.start();
	await b.answer("answer");
	await a.start();
	await a.shutdown();
	await b.shutdown();
	const header = a.sent[0].message.content.split("\n")[0];
	assert.match(
		header,
		/The user made that request, typing it with \/mailbox or through an extension such as delegate\./,
	);
	assert.ok(!/not from the user|untrusted|injection/.test(a.sent[0].message.content), a.sent[0].message.content);
});

test("a sent/ file whose name matches but whose envelope id differs is not quoted", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} the real request`);
	const [request] = envelopes(a.id, "sent");
	const [copy] = files(a.id, "sent");
	// An old file can end in the same `-<id>.json`, so the parsed id still decides.
	const decoy = { ...request, id: "33333333-3333-4333-8333-333333333333", body: "the decoy" };
	writeFileSync(join(box(a.id, "sent"), `000000000000000-${request.id}.json`), JSON.stringify(decoy));
	await b.start();
	await b.answer("answer");
	await a.start();
	await a.shutdown();
	await b.shutdown();
	const text = a.sent[0].message.content;
	assert.ok(text.includes(join(box(a.id, "sent"), copy)), text);
	assert.ok(!text.includes("the decoy"), text);
});

// ---------------------------------------------------------------------------
// pi.events interface

type SendPayload = {
	to: unknown;
	body: unknown;
	envelope?: { id: string; to: string; from: string; kind: string; hops: number };
	error?: string;
};

test("message:send leaves the written envelope on the payload by the time emit returns", async () => {
	const a = session(newId("a"));
	const b = newId("b");
	await a.start();
	try {
		const payload: SendPayload = { to: b, body: "from another extension" };
		a.events.emit("message:send", payload);
		assert.equal(payload.error, undefined);
		assert.equal(payload.envelope?.from, a.id);
		assert.equal(payload.envelope?.to, b);
		const [env] = envelopes(b, "new");
		assert.equal(env.id, payload.envelope?.id);
		assert.equal(env.body, "from another extension");
		assert.equal(files(a.id, "sent").length, 1);
	} finally {
		await a.shutdown();
	}
});

test("message:send with an invalid address leaves an error and writes nothing", async () => {
	const a = session(newId("a"));
	await a.start();
	try {
		for (const to of ["../evil", 42, ""]) {
			const payload: SendPayload = { to, body: "x" };
			a.events.emit("message:send", payload);
			assert.equal(payload.envelope, undefined);
			assert.match(payload.error ?? "", /address/);
		}
		const noBody: SendPayload = { to: newId("b"), body: undefined };
		a.events.emit("message:send", noBody);
		assert.match(noBody.error ?? "", /body/);
		assert.ok(!existsSync(join(dir, "agent", "evil")));
		assert.deepEqual(files(a.id, "sent"), []);
	} finally {
		await a.shutdown();
	}
});

test("without a provider installed, a message:send payload comes back with neither envelope nor error", () => {
	const bus = createEventBus();
	const payload: SendPayload = { to: "someone", body: "x" };
	bus.emit("message:send", payload);
	assert.equal(payload.envelope, undefined);
	assert.equal(payload.error, undefined);
});

test("message:inbound sees every delivered envelope, replies with their in_reply_to, and its cur/ path", async () => {
	type Inbound = {
		envelope: { in_reply_to: string[] };
		path: string;
		requests: { envelope: { id: string; body: string }; path: string }[];
		handled: boolean;
	};
	const a = session(newId("a"));
	const b = session(newId("b"));
	const seenByA: Inbound[] = [];
	const seenByB: Inbound[] = [];
	a.events.on("message:inbound", (p) => void seenByA.push(p as Inbound));
	b.events.on("message:inbound", (p) => void seenByB.push(p as Inbound));
	await a.mailbox(`${b.id} ping`);
	const [request] = envelopes(a.id, "sent");
	const [requestCopy] = files(a.id, "sent");
	await b.start();
	await b.answer("pong");
	await a.start();
	await a.shutdown();
	await b.shutdown();
	assert.equal(seenByB.length, 1);
	assert.deepEqual(seenByB[0].envelope.in_reply_to, []);
	assert.deepEqual(seenByB[0].requests, []);
	assert.equal(seenByB[0].handled, false);
	assert.ok(existsSync(seenByB[0].path));
	assert.ok(seenByB[0].path.startsWith(box(b.id, "cur")));
	assert.equal(seenByA.length, 1);
	assert.deepEqual(seenByA[0].envelope.in_reply_to, [request.id]);
	assert.equal(seenByA[0].requests.length, 1);
	assert.equal(seenByA[0].requests[0].envelope.id, request.id);
	assert.equal(seenByA[0].requests[0].envelope.body, "ping");
	assert.equal(seenByA[0].requests[0].path, join(box(a.id, "sent"), requestCopy));
	assert.equal(a.sent.length, 1);
});

test("a listener that sets handled stops the injection, but a request still gets its reply", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	b.events.on("message:inbound", (p) => {
		(p as { handled: boolean }).handled = true;
	});
	await a.mailbox(`${b.id} handled elsewhere`);
	await b.start();
	assert.equal(b.sent.length, 0);
	await b.answer("still answered");
	await b.shutdown();
	const [reply] = envelopes(a.id, "new");
	assert.equal(reply.status, "done"); // no message_end is needed for a takeover
	assert.equal(reply.body, "still answered");
});

// ---------------------------------------------------------------------------
// Statusline

test("a session with an empty mailbox shows no mailbox status", async () => {
	const a = session(newId("a"));
	await a.start();
	await a.answer("nothing to do");
	await a.shutdown();
	assert.equal(a.status(), undefined);
});

test("the status counts awaiting, pending and read, and hides parts that are zero", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.start();
	await b.start();
	try {
		await a.mailbox(`${b.id} question`);
		assert.equal(a.status(), "✉ 1 awaiting");
		await until(() => b.sent.length === 1, "B to receive");
		assert.equal(b.status(), "✉ 1 pending · 1 read");
		await b.answer("answer");
		assert.equal(b.status(), "✉ 1 read");
		await until(() => a.sent.length === 1, "A to receive the reply");
		assert.equal(a.status(), "✉ 1 pending · 1 read");
		await a.answer("thanks");
		assert.equal(a.status(), "✉ 1 read");
	} finally {
		await a.shutdown();
		await b.shutdown();
	}
});

test("the awaiting count survives a resume", async () => {
	const aId = newId("a");
	const a = session(aId);
	await a.start();
	await a.mailbox(`${newId("b")} one`);
	await a.mailbox(`${newId("b")} two`);
	await a.shutdown();
	const resumed = session(aId);
	await resumed.start("resume");
	await resumed.shutdown();
	assert.equal(resumed.status(), "✉ 2 awaiting");
});

test("without a UI there is no status, and delivery still works", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"), { hasUI: false });
	await a.mailbox(`${b.id} headless`);
	await b.start();
	await b.answer("ok");
	await b.shutdown();
	assert.equal(b.sent.length, 1);
	assert.equal(b.statusCalls(), 0);
	assert.equal(envelopes(a.id, "new").length, 1);
});

// ---------------------------------------------------------------------------
// All-or-nothing sends and planted files

const root0 = process.getuid?.() === 0;

test("a reply quoting several requests still quotes each copy, in order", async () => {
	const a = session(newId("a"));
	const b = newId("b");
	await a.start();
	for (const body of ["first", "second", "third"]) await a.mailbox(`${b} ${body}`);
	const ids = envelopes(a.id, "sent").map((e) => e.id);
	assert.equal(ids.length, 3);
	writeFileSync(
		join(box(a.id, "new"), "000000000000001-reply.json"),
		JSON.stringify({ id: "reply", from: b, to: a.id, in_reply_to: ids, status: "done", ts: "", body: "answer" }),
	);
	await until(() => a.sent.length === 1, "A to receive the reply");
	const content = a.sent[0].message.content;
	assert.ok(content.includes("first") && content.includes("second") && content.includes("third"), content);
	assert.ok(content.indexOf("first") < content.indexOf("second"), content);
	assert.ok(content.indexOf("second") < content.indexOf("third"), content);
	await a.shutdown();
});

test("an envelope naming more than 50 requests in in_reply_to is set aside with a warning, and one naming 50 is delivered", async () => {
	const bId = newId("b");
	const from = newId("a");
	mkdirSync(box(bId, "new"), { recursive: true, mode: 0o700 });
	const write = (name: string, id: string, count: number, body: string) =>
		writeFileSync(
			join(box(bId, "new"), name),
			JSON.stringify({
				id,
				from,
				to: bId,
				in_reply_to: Array.from({ length: count }, (_, i) => `request-${i}`),
				status: "",
				ts: "",
				body,
			}),
		);
	write("000000000000001-many.json", "many", 51, "oversized");
	write("000000000000002-cap.json", "cap", 50, "at-the-cap");
	const b = session(bId);
	await b.start();
	await b.shutdown();
	assert.equal(b.warnings.length, 1);
	assert.match(b.warnings[0], /in_reply_to/);
	assert.equal(b.sent.length, 1);
	assert.ok(b.sent[0].message.content.includes("at-the-cap"));
	assert.ok(!b.sent[0].message.content.includes("oversized"));
	assert.equal((b.sent[0].message.content.match(/has no copy in sent\//g) ?? []).length, 50);
	assert.ok(files(bId, "cur").includes("000000000000001-many.json"));
});

/**
 * Run the FIFO or directory scenario (`test/fifo-scenario.ts`) in a child
 * process. Reading a FIFO blocks forever, so the bounded `spawnSync` timeout,
 * not the suite, is what a regression hits.
 */
function plantedScenario(kind: "cur" | "sent" | "dir") {
	const run = spawnSync(process.execPath, [join(import.meta.dirname, "fifo-scenario.ts"), kind], {
		encoding: "utf8",
		timeout: 20_000,
		// The child loads Pi, which listens for SIGTERM, so only SIGKILL stops it.
		killSignal: "SIGKILL",
	});
	assert.equal(run.status, 0, `scenario ${kind} failed (${run.signal ?? run.status})\n${run.stdout}${run.stderr}`);
}

test("a FIFO named *.json in cur/ does not hang delivery or the status count", () => plantedScenario("cur"));

test("a FIFO named *.json in sent/ does not hang a reply's quote", () => plantedScenario("sent"));

test("a directory named *.json in cur/ and sent/ is skipped", () => plantedScenario("dir"));

test("a send whose sender sent/ is read-only throws and leaves nothing in the recipient's new/ or tmp/", {
	skip: root0,
}, async () => {
	const a = session(newId("a"));
	const b = newId("b");
	await a.start();
	const sent = box(a.id, "sent");
	chmodSync(sent, 0o500);
	try {
		const payload: SendPayload = { to: b, body: "never delivered" };
		a.events.emit("message:send", payload);
		assert.match(payload.error ?? "", /EACCES/);
		assert.equal(payload.envelope, undefined);
		assert.deepEqual(files(b, "new"), []);
		assert.deepEqual(files(b, "tmp"), []);
		assert.deepEqual(files(a.id, "sent"), []);
	} finally {
		chmodSync(sent, 0o700);
		await a.shutdown();
	}
});

test("a delivery that fails after the sender's sent/ copy is written removes the copy", { skip: root0 }, async () => {
	const a = session(newId("a"));
	const b = newId("b");
	mkdirSync(box(b, "new"), { recursive: true, mode: 0o700 });
	await a.start();
	const newBox = box(b, "new");
	chmodSync(newBox, 0o500);
	try {
		const payload: SendPayload = { to: b, body: "never delivered" };
		a.events.emit("message:send", payload);
		assert.match(payload.error ?? "", /EACCES/);
		assert.equal(payload.envelope, undefined);
		assert.deepEqual(files(b, "new"), []);
		assert.deepEqual(files(b, "tmp"), []);
		assert.deepEqual(files(a.id, "sent"), []);
	} finally {
		chmodSync(newBox, 0o700);
		await a.shutdown();
	}
});

// ---------------------------------------------------------------------------
// Failing filesystems

test("a session whose state directory is unwritable warns that the mailbox is off and gets no address", {
	skip: root0,
}, async () => {
	const saved = process.env.XDG_STATE_HOME;
	const readOnly = join(dir, "read-only-state");
	mkdirSync(readOnly, { recursive: true });
	chmodSync(readOnly, 0o500);
	const a = session(newId("a"));
	try {
		process.env.XDG_STATE_HOME = readOnly;
		await a.start();
		assert.equal(a.warnings.length, 1);
		assert.match(a.warnings[0], /^mailbox: mailbox is off: .*EACCES/);
		assert.equal(a.status(), undefined);
		assert.deepEqual(records().get(a.id), undefined);
		assert.deepEqual(readdirSync(readOnly), []);
	} finally {
		process.env.XDG_STATE_HOME = saved;
		chmodSync(readOnly, 0o700);
		await a.shutdown();
	}
});

test("two scanners claiming one envelope deliver it exactly once", async () => {
	const id = newId("a");
	const first = session(id);
	const second = session(id);
	await first.start();
	await second.start();
	const from = newId("b");
	const plant = (name: string, body: string) =>
		writeFileSync(
			join(box(id, "new"), name),
			JSON.stringify({ id: name, from, to: id, in_reply_to: [], status: "", ts: "", body, kind: "message", hops: 0 }),
		);
	plant("000000000000001-one.json", "body-alpha");
	plant("000000000000002-two.json", "body-beta");
	// While `first` delivers body-alpha, `second` scans and claims body-beta from under it.
	const deliver = first.pi.sendMessage;
	first.pi.sendMessage = (message, options) => {
		deliver(message, options);
		first.pi.sendMessage = deliver;
		second.events.emit("message:scan", {});
	};
	first.events.emit("message:scan", {});
	const bodies = [...first.sent, ...second.sent].map((m) => m.message.content);
	assert.equal(bodies.length, 2);
	assert.equal(bodies.filter((b) => b.includes("body-alpha")).length, 1);
	assert.equal(bodies.filter((b) => b.includes("body-beta")).length, 1);
	assert.equal(first.sent.length, 1);
	assert.equal(second.sent.length, 1);
	assert.deepEqual(files(id, "new"), []);
	assert.equal(files(id, "cur").length, 2);
	await first.shutdown();
	await second.shutdown();
});

test("a reply that fails at settle warns, naming the recipient", { skip: root0 }, async () => {
	const a = session(newId("a"));
	const b = newId("b");
	await a.start();
	mkdirSync(box(b, "new"), { recursive: true, mode: 0o700 });
	writeFileSync(
		join(box(a.id, "new"), "000000000000001-req.json"),
		JSON.stringify({
			id: "req",
			from: b,
			to: a.id,
			in_reply_to: [],
			status: "",
			ts: "",
			body: "q",
			kind: "request",
			hops: 0,
		}),
	);
	await until(() => a.sent.length === 1, "A to receive the request");
	const newBox = box(b, "new");
	chmodSync(newBox, 0o500);
	try {
		await a.answer("the answer");
		assert.equal(a.warnings.length, 1);
		assert.match(a.warnings[0], new RegExp(`^mailbox: could not reply to ${b}: .*EACCES`));
		assert.deepEqual(files(b, "new"), []);
	} finally {
		chmodSync(newBox, 0o700);
		await a.shutdown();
	}
});

test("a running record that cannot be written warns", { skip: root0 }, async () => {
	const saved = process.env.XDG_STATE_HOME;
	const state = join(dir, "record-state");
	const running = join(state, "pi-session-mail", "running");
	mkdirSync(running, { recursive: true, mode: 0o700 });
	chmodSync(running, 0o500);
	const a = session(newId("a"));
	try {
		process.env.XDG_STATE_HOME = state;
		await a.start();
		assert.ok(a.warnings.length > 0);
		assert.match(a.warnings[0], /^mailbox: could not write this session's running record: .*EACCES/);
		assert.ok(existsSync(box(a.id, "new")));
	} finally {
		chmodSync(running, 0o700);
		await a.shutdown();
		process.env.XDG_STATE_HOME = saved;
	}
});

// ---------------------------------------------------------------------------
// Pruning

const DAY_S = 24 * 60 * 60;
const BOX_NAMES = ["tmp", "new", "cur", "sent"] as const;

/** Set the modification time of `path` to `days` days ago. */
function age(path: string, days: number) {
	const when = Date.now() / 1000 - days * DAY_S;
	utimesSync(path, when, when);
}

/** Run `body` against an empty mail root of its own, so a direct prune sees only what the test made. */
function withFreshRoot(body: () => void) {
	const saved = process.env.XDG_STATE_HOME;
	process.env.XDG_STATE_HOME = mkdtempSync(join(dir, "fresh-"));
	try {
		body();
	} finally {
		process.env.XDG_STATE_HOME = saved;
	}
}

/** An address folder with its four boxes, every one last touched `days` days ago; `unread` leaves a file in new/. */
function folder(address: string, days: number, unread = false) {
	for (const sub of BOX_NAMES) mkdirSync(box(address, sub), { recursive: true, mode: 0o700 });
	if (unread) writeFileSync(join(box(address, "new"), "000000000000001-x.json"), "{}");
	for (const sub of BOX_NAMES) age(box(address, sub), days);
	age(join(stateRoot(), address), days);
	return join(stateRoot(), address);
}

test("only the address folder's own mtime being recent keeps an otherwise old folder", () =>
	withFreshRoot(() => {
		const path = folder(newId(), 90);
		age(path, 1);
		assert.equal(pruneClosed({ isRunning: () => false, cutoffMs: Date.now() - 30 * DAY_S * 1000 }), 0);
		assert.ok(existsSync(path));
		rmSync(path, { recursive: true });
	}));

test("a session start prunes closed sessions' folders idle for over 30 days and keeps the rest", async () => {
	const old = folder(newId(), 40);
	const recent = folder(newId(), 5);
	const unread = folder(newId(), 40, true);
	const mixed = folder(newId(), 40);
	age(join(mixed, "cur"), 2); // one recently touched box keeps the folder
	const live = session(newId(), { name: "alive" });
	await live.start();
	const liveFolder = join(root, live.id);
	for (const sub of BOX_NAMES) age(join(liveFolder, sub), 40);
	age(liveFolder, 40);
	const own = session(newId());
	const ownFolder = join(root, own.id);
	const runningDir = join(root, "running");
	age(runningDir, 400);
	await own.sessionStart();
	for (const sub of BOX_NAMES) age(join(ownFolder, sub), 40);
	age(ownFolder, 40);
	await turn();
	await turn();
	assert.ok(!existsSync(old), "an old closed folder is pruned");
	assert.ok(existsSync(recent), "a recent one stays");
	assert.ok(existsSync(unread), "unread mail keeps an old folder");
	assert.ok(existsSync(mixed), "the newest box decides the folder's age");
	assert.ok(existsSync(liveFolder), "a running session's folder stays");
	assert.ok(existsSync(ownFolder), "this session's own folder stays");
	assert.ok(existsSync(runningDir), "running/ is never pruned");
	assert.deepEqual(own.warnings, []);
	await own.shutdown();
	await live.shutdown();
});

test("pruning never follows a symlink or touches a name that is no address", async () => {
	const outside = join(dir, "outside");
	mkdirSync(join(outside, "new"), { recursive: true });
	age(join(outside, "new"), 400);
	age(outside, 400);
	const link = join(root, newId());
	symlinkSync(outside, link);
	const file = join(root, newId());
	writeFileSync(file, "x");
	age(file, 400);
	const odd = join(root, "not.an.address");
	mkdirSync(odd, { recursive: true });
	age(odd, 400);
	const a = session(newId());
	await a.mailbox("prune");
	assert.ok(existsSync(join(outside, "new")), "the symlink's target is untouched");
	assert.ok(existsSync(link));
	assert.ok(existsSync(file));
	assert.ok(existsSync(odd));
	rmSync(link);
	rmSync(file);
	rmSync(odd, { recursive: true });
});

test("/mailbox prune removes closed sessions' folders of any age, keeps unread mail, and says how many", async () => {
	const fresh = folder(newId(), 0);
	const old = folder(newId(), 90);
	const unread = folder(newId(), 90, true);
	const live = session(newId());
	await live.start();
	const a = session(newId());
	await a.start();
	await a.mailbox("prune");
	assert.ok(a.notes.at(-1)?.startsWith("Removed "));
	assert.ok(!existsSync(fresh) && !existsSync(old));
	assert.ok(existsSync(unread));
	assert.ok(existsSync(join(root, live.id)), "a running session's folder stays");
	assert.ok(existsSync(join(root, a.id)), "its own folder stays");
	assert.ok(existsSync(join(root, "running")));
	rmSync(unread, { recursive: true });
	const one = folder(newId(), 1);
	const two = folder(newId(), 1);
	await a.mailbox("prune");
	assert.equal(a.notes.at(-1), "Removed 2 mailbox folders of closed sessions");
	assert.ok(!existsSync(one) && !existsSync(two));
	await a.shutdown();
	await live.shutdown();
});

test("/mailbox prune <text> is still a send to a session named or prefixed prune", async () => {
	const target = session(newId(), { name: "prune" });
	await target.start();
	const a = session(newId());
	await a.mailbox("prune hello there");
	assert.equal(envelopes(target.id, "new").length + envelopes(target.id, "cur").length, 1);
	assert.equal(a.notes.at(-1)?.startsWith("Sent "), true);
	await target.shutdown();
});

test("pruning puts back mail that reaches new/ between the check and the removal, and keeps the folder", () =>
	withFreshRoot(() => {
		const address = newId();
		const path = folder(address, 90);
		let planted = "";
		const removed = pruneClosed({
			isRunning: () => false,
			cutoffMs: Date.now(),
			beforeRemove: (name) => {
				if (name !== address) return;
				planted = join(box(address, "new"), "000000000000002-late.json");
				writeFileSync(planted, "{}"); // a sender's rename landing in the window
			},
		});
		assert.equal(removed, 0);
		assert.ok(existsSync(planted), "the late mail is in the address's new/");
		assert.ok(existsSync(join(path, "cur")), "the boxes exist again");
		assert.deepEqual(
			readdirSync(stateRoot()).filter((name) => name.startsWith(".")),
			[],
			"no folder is left aside",
		);
		rmSync(path, { recursive: true });
	}));

test("pruning keeps a folder whose session becomes live after the first check, with its cur/ and sent/", () =>
	withFreshRoot(() => {
		const address = newId();
		const path = folder(address, 90);
		writeFileSync(join(box(address, "cur"), "000000000000004-read.json"), "{}");
		writeFileSync(join(box(address, "sent"), "000000000000005-sent.json"), "{}");
		let live = false;
		const removed = pruneClosed({
			isRunning: () => live,
			cutoffMs: Date.now(),
			beforeRemove: () => {
				live = true; // a running record appearing after the first check
			},
		});
		assert.equal(removed, 0);
		assert.deepEqual(files(address, "cur"), ["000000000000004-read.json"]);
		assert.deepEqual(files(address, "sent"), ["000000000000005-sent.json"]);
		rmSync(path, { recursive: true });
	}));

test("one folder that fails does not stop the pass", () =>
	withFreshRoot(() => {
		const bad = newId();
		const good = newId();
		folder(bad, 90);
		folder(good, 90);
		const removed = pruneClosed({
			isRunning: (address) => {
				if (address === bad) throw new Error("boom");
				return false;
			},
			cutoffMs: Date.now(),
		});
		assert.equal(removed, 1);
		assert.ok(existsSync(join(stateRoot(), bad)));
		assert.ok(!existsSync(join(stateRoot(), good)));
		rmSync(join(stateRoot(), bad), { recursive: true });
	}));

test("a symlinked box in a leftover folder is not listed into the mail boxes", () =>
	withFreshRoot(() => {
		const address = newId();
		const outside = mkdtempSync(join(dir, "outside-"));
		writeFileSync(join(outside, "secret.json"), "{}");
		const aside = join(stateRoot(), `.pruning.${address}.${newId()}`);
		mkdirSync(join(aside, "new"), { recursive: true });
		writeFileSync(join(aside, "new", "000000000000006-kept.json"), "{}");
		symlinkSync(outside, join(aside, "cur"));
		assert.equal(pruneClosed({ isRunning: () => false }), 0);
		assert.deepEqual(files(address, "new"), ["000000000000006-kept.json"]);
		assert.deepEqual(files(address, "cur"), []);
		assert.ok(existsSync(join(outside, "secret.json")));
		rmSync(join(stateRoot(), address), { recursive: true });
	}));

test("a folder left aside by a crash is removed when its new/ is empty and restored when it is not", () =>
	withFreshRoot(() => {
		const empty = newId();
		const full = newId();
		const leftover = (address: string) => join(stateRoot(), `.pruning.${address}.${newId()}`);
		const emptyAside = leftover(empty);
		const fullAside = leftover(full);
		mkdirSync(join(emptyAside, "new"), { recursive: true });
		mkdirSync(join(fullAside, "new"), { recursive: true });
		writeFileSync(join(fullAside, "new", "000000000000003-kept.json"), "{}");
		assert.equal(pruneClosed({ isRunning: () => false, cutoffMs: 0 }), 1);
		assert.ok(!existsSync(emptyAside));
		assert.ok(!existsSync(fullAside));
		assert.deepEqual(files(full, "new"), ["000000000000003-kept.json"]);
		rmSync(join(stateRoot(), full), { recursive: true });
	}));
