// `mailbox` gives each Pi session an address (its session id) and an inbox on
// disk. These tests drive the extension only through its registration
// function, with a fake `pi` and `ctx`, and observe files, injected messages,
// `pi.events` traffic, statuses and notifications.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventBus } from "@earendil-works/pi-coding-agent";

import { box, dir, envelopes, files, newId, session, stateRoot, turn, until } from "./harness.ts";

const root = stateRoot();

// ---------------------------------------------------------------------------
// Addressing and sending (ticket 01)

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
// Receiving (ticket 02)

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
		assert.match(message.content, new RegExp(`^\\[mailbox\\] From \\S+ \\(${a.id}, working in [^)]+\\), another Pi session on this machine\\.`));
		assert.match(message.content, /final answer this turn goes back to it automatically/);
		assert.ok(!/not from the user|untrusted|injection/.test(message.content), message.content);
		assert.match(message.content, /what is 2 \+ 2\?$/);
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
		b.sent.map((s) => s.message.content.split("\n").at(-1)),
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
	assert.match(b.sent[0].message.content, /waiting$/);
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
	assert.ok(b.sent[0].message.content.endsWith(small));
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
	mkdirSync(box(b.id, "new"), { recursive: true });
	writeFileSync(join(box(b.id, "new"), "000000000000001-bad.json"), "{ not json");
	writeFileSync(join(box(b.id, "new"), "000000000000002-evil.json"), JSON.stringify({ id: "x", from: "../up", to: b.id, in_reply_to: [], status: "", ts: "", body: "hi" }));
	writeFileSync(join(box(b.id, "new"), "000000000000003-ignored.txt"), "not an envelope");
	mkdirSync(join(box(b.id, "new"), "000000000000004-dir.json"));
	await a.mailbox(`${b.id} still works`);
	await b.start();
	await b.shutdown();
	assert.equal(b.sent.length, 1);
	assert.match(b.sent[0].message.content, /still works$/);
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
	assert.match(resumed.sent[0].message.content, /while closed$/);
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
// Replying (ticket 03)

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
	assert.equal(reply.hops, 0);
	assert.deepEqual(reply.in_reply_to, [request.id]);
	assert.equal(reply.body, "It is 4.");
	assert.equal(files(b.id, "sent").length, 0);
	await a.start();
	await a.shutdown();
	await b.shutdown();
	assert.equal(a.sent.length, 1);
	assert.match(a.sent[0].message.content, new RegExp(`^\\[mailbox\\] From \\S+ \\(${b.id}[,)]`));
	assert.match(a.sent[0].message.content, new RegExp(`reply to your request ${request.id}`));
	assert.match(a.sent[0].message.content, /It is 4\.$/);
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
	mkdirSync(box(b.id, "new"), { recursive: true });
	const old = (id: string, inReplyTo: string[]) =>
		JSON.stringify({ id, from: a, to: b.id, in_reply_to: inReplyTo, status: inReplyTo.length > 0 ? "done" : "", ts: "", body: "old" });
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

test("an envelope with an unknown kind or a bad hop count is set aside with a warning", async () => {
	const b = session(newId("b"));
	const a = newId("a");
	mkdirSync(box(b.id, "new"), { recursive: true });
	const bad = (id: string, extra: object) =>
		JSON.stringify({ id, from: a, to: b.id, in_reply_to: [], status: "", ts: "", body: "x", ...extra });
	writeFileSync(join(box(b.id, "new"), "000000000000001-k.json"), bad("k", { kind: "shout", hops: 0 }));
	writeFileSync(join(box(b.id, "new"), "000000000000002-h.json"), bad("h", { kind: "request", hops: -1 }));
	await b.start();
	await b.shutdown();
	assert.equal(b.sent.length, 0);
	assert.equal(b.warnings.length, 2);
	assert.match(b.warnings[0], /invalid kind "shout"/);
	assert.match(b.warnings[1], /invalid hops -1/);
});

test("an envelope with an invalid from gets no reply", async () => {
	const b = session(newId("b"));
	mkdirSync(box(b.id, "new"), { recursive: true });
	writeFileSync(join(box(b.id, "new"), "000000000000001-x.json"), JSON.stringify({ id: "x", from: "../../up", to: b.id, in_reply_to: [], status: "", ts: "", body: "hi" }));
	await b.start();
	await b.answer("answer");
	await b.shutdown();
	assert.ok(!existsSync(join(root, "..", "..", "up")));
	assert.ok(!existsSync(join(root, "up")));
	assert.equal(b.sent.length, 0);
});

// ---------------------------------------------------------------------------
// Unseen requests (ticket 07)

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
// Stopped runs, quoted requests, quiet replies (delegate ticket 02)

test("a run the user stopped replies stopped, noting the stop and the partial text", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} do the thing`);
	const [request] = envelopes(a.id, "sent");
	await b.start();
	await b.answer("half of the answer", { aborted: true });
	const [reply] = envelopes(a.id, "new");
	assert.equal(reply.status, "stopped");
	assert.deepEqual(reply.in_reply_to, [request.id]);
	assert.match(reply.body, /^\(The user stopped this run/);
	assert.ok(reply.body.includes("half of the answer"), reply.body);
	await a.start();
	await a.shutdown();
	await b.shutdown();
	assert.equal(a.sent.length, 1);
	assert.match(a.sent[0].message.content, /"stopped", not "done"/);
});

test("a stopped run with no partial text still says the user stopped it", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.mailbox(`${b.id} do the thing`);
	await b.start();
	await b.answer(undefined, { aborted: true });
	const [reply] = envelopes(a.id, "new");
	assert.equal(reply.status, "stopped");
	assert.match(reply.body, /^\(The user stopped this run/);
	assert.doesNotMatch(reply.body, /no answer/i);
});

test("a stopped run's unseen requests still get a failed reply", async () => {
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
	const stopped = replies.find((r) => r.status === "stopped");
	const failed = replies.find((r) => r.status === "failed");
	assert.deepEqual(stopped?.in_reply_to, [readId]);
	assert.deepEqual(failed?.in_reply_to, [droppedId]);
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
	assert.match(text, /both answered$/);
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
	assert.match(text, /short$/);
});

test("a reply to a request with no sent/ copy names the id and still delivers", async () => {
	const b = session(newId("b"));
	mkdirSync(box(b.id, "new"), { recursive: true });
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
	assert.match(b.sent[0].message.content, /the answer$/);
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
// pi.events interface (ticket 04)

type SendPayload = { to: unknown; body: unknown; envelope?: { id: string; to: string; from: string }; error?: string };

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
// Statusline (ticket 05)

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
