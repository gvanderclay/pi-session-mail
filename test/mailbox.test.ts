// `mailbox` gives each Pi session an address (its session id) and an inbox on
// disk. These tests drive the extension only through its registration
// function, with a fake `pi` and `ctx`, and observe files, injected messages,
// `pi.events` traffic, statuses and notifications.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventBus } from "@earendil-works/pi-coding-agent";

import register from "../index.ts";

const dir = mkdtempSync(join(tmpdir(), "mailbox-test-"));
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
test.after(() => rmSync(dir, { recursive: true, force: true }));

const root = join(dir, "agent", "mailbox");
const box = (address: string, sub: "tmp" | "new" | "cur" | "sent") => join(root, address, sub);
const files = (address: string, sub: "tmp" | "new" | "cur" | "sent") =>
	existsSync(box(address, sub)) ? readdirSync(box(address, sub)).sort() : [];
const envelopes = (address: string, sub: "new" | "cur" | "sent") =>
	files(address, sub).map((name) => JSON.parse(readFileSync(join(box(address, sub), name), "utf8")));

let counter = 0;
const newId = (label: string) => `${label}-${process.pid}-${++counter}`;

type Sent = { message: { customType: string; content: string; display: boolean; details?: unknown }; options: unknown };
type Handler = (event: unknown, ctx: unknown) => unknown;

/** One fake Pi session running the extension under `sessionId`. */
function session(sessionId: string, opts: { hasUI?: boolean } = {}) {
	const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
	const handlers: Record<string, Handler[]> = {};
	const sent: Sent[] = [];
	const notes: string[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	const statuses = new Map<string, string | undefined>();
	let statusCalls = 0;
	/** While true, injected messages never enter the conversation, as when an abort drops Pi's follow-up queue. */
	let dropping = false;
	const events = createEventBus();
	const pi = {
		events,
		on: (name: string, handler: Handler) => (handlers[name] ??= []).push(handler),
		registerCommand: (name: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands[name] = cmd.handler;
		},
		// A sent message enters the conversation at once, reported through message_end like Pi does.
		sendMessage: (message: Sent["message"], options: unknown) => {
			sent.push({ message, options });
			if (dropping) return;
			for (const h of handlers.message_end ?? [])
				void h({ type: "message_end", message: { role: "custom", ...message, timestamp: Date.now() } }, ctx);
		},
	};
	const ctx = {
		cwd: dir,
		hasUI: opts.hasUI ?? true,
		sessionManager: { getSessionId: () => sessionId },
		ui: {
			notify: (msg: string, type?: string) =>
				(type === "warning" ? warnings : type === "error" ? errors : notes).push(msg),
			setStatus: (key: string, text: string | undefined) => {
				statusCalls++;
				statuses.set(key, text);
			},
		},
	};
	register(pi as never);
	const fire = async (name: string, event: object = {}) => {
		for (const h of handlers[name] ?? []) await h({ type: name, ...event }, ctx);
	};
	return {
		id: sessionId,
		events,
		sent,
		notes,
		warnings,
		errors,
		status: () => statuses.get("mailbox"),
		statusCalls: () => statusCalls,
		/** Hold back injected messages from the conversation (on) or let them in again (off). */
		drop: (on: boolean) => {
			dropping = on;
		},
		mailbox: (args: string) => commands.mailbox(args, ctx),
		start: (reason = "startup") => fire("session_start", { reason }),
		shutdown: () => fire("session_shutdown"),
		/** One agent run ending with `text` as the last assistant message, then settling. */
		answer: async (text?: string) => {
			const messages = [{ role: "user", content: [{ type: "text", text: "q" }] }];
			if (text !== undefined) messages.push({ role: "assistant", content: [{ type: "text", text }] });
			await fire("agent_end", { messages });
			await fire("agent_settled");
		},
		agentEnd: (text: string) =>
			fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text }] }] }),
		settle: () => fire("agent_settled"),
	};
}

/** Wait until `check` holds, up to a few poll intervals; tests never rely on fs.watch. */
async function until(check: () => boolean, what: string, ms = 4000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

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
	assert.equal(env.body, "hello there");
	assert.match(env.id, /^[0-9a-f-]{36}$/);
	assert.ok(!Number.isNaN(Date.parse(env.ts)));
	assert.ok(files(b, "new")[0].endsWith(`${env.id}.json`));
	assert.deepEqual(envelopes(a.id, "sent"), [env]);
	assert.deepEqual(a.errors, []);
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

test("a running session claims a message into cur/ and injects it once as a labelled follow-up", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.start();
	await b.start();
	try {
		await a.mailbox(`${b.id} what is 2 + 2?`);
		await until(() => b.sent.length === 1, "B to receive");
		const [{ message, options }] = b.sent;
		assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" });
		assert.equal(message.customType, "mailbox");
		assert.equal(message.display, true);
		assert.match(message.content, new RegExp(`another Pi session at ${a.id}`));
		assert.match(message.content, /not from the user/);
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
	assert.deepEqual(reply.in_reply_to, [request.id]);
	assert.equal(reply.body, "It is 4.");
	assert.equal(files(b.id, "sent").length, 0);
	await a.start();
	await a.shutdown();
	await b.shutdown();
	assert.equal(a.sent.length, 1);
	assert.match(a.sent[0].message.content, new RegExp(`another Pi session at ${b.id}`));
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
	const a = session(newId("a"));
	const b = session(newId("b"));
	const seenByA: { envelope: { in_reply_to: string[] }; path: string; handled: boolean }[] = [];
	const seenByB: typeof seenByA = [];
	a.events.on("message:inbound", (p) => void seenByA.push(p as never));
	b.events.on("message:inbound", (p) => void seenByB.push(p as never));
	await a.mailbox(`${b.id} ping`);
	const [request] = envelopes(a.id, "sent");
	await b.start();
	await b.answer("pong");
	await a.start();
	await a.shutdown();
	await b.shutdown();
	assert.equal(seenByB.length, 1);
	assert.deepEqual(seenByB[0].envelope.in_reply_to, []);
	assert.equal(seenByB[0].handled, false);
	assert.ok(existsSync(seenByB[0].path));
	assert.ok(seenByB[0].path.startsWith(box(b.id, "cur")));
	assert.equal(seenByA.length, 1);
	assert.deepEqual(seenByA[0].envelope.in_reply_to, [request.id]);
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
