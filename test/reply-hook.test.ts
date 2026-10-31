// The `message:reply` hook: a consumer that took over a request answers it with
// the body and status it chooses, whenever it chooses. These tests drive it
// through `pi.events` on fake sessions and look at the mail folder.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { createEventBus } from "@earendil-works/pi-coding-agent";

import { envelopes, files, newId, session, stateRoot } from "./harness.ts";

type Payload = { envelope?: Record<string, unknown>; error?: string; [field: string]: unknown };

/** Emit `message:reply` on `events` and return the payload the provider filled in. */
function emitReply(events: { emit: (channel: string, data: unknown) => void }, fields: Record<string, unknown>) {
	const payload: Payload = { ...fields };
	events.emit("message:reply", payload);
	return payload;
}

test("message:reply writes a reply with the given correlation, body and status, from this session", async () => {
	const a = session(newId());
	const b = session(newId());
	await b.start();
	const ids = ["first", "second"].map((body) => a.request(b.id, body).id);
	for (const status of ["done", "stopped", "failed"]) {
		const payload = emitReply(b.events, {
			to: a.id,
			inReplyTo: ids,
			body: `body for ${status}`,
			status,
			from: "someone-else",
		});
		assert.equal(payload.error, undefined);
		assert.equal(payload.envelope?.kind, "reply");
		assert.equal(payload.envelope?.from, b.id, "from is the active session, whatever the payload says");
		assert.equal(payload.envelope?.status, status);
	}
	const written = envelopes(a.id, "new");
	assert.equal(written.length, 3);
	for (const [i, status] of ["done", "stopped", "failed"].entries()) {
		assert.equal(written[i].from, b.id);
		assert.equal(written[i].to, a.id);
		assert.equal(written[i].kind, "reply");
		assert.deepEqual(written[i].in_reply_to, ids);
		assert.equal(written[i].status, status);
		assert.equal(written[i].body, `body for ${status}`, "the body is written exactly as given");
		assert.equal("hops" in written[i], false);
	}
	assert.deepEqual(files(b.id, "sent"), [], "a reply keeps no sent/ copy");
	await b.shutdown();
});

test("message:reply writes at once, whatever the run is doing, and settle adds nothing", async () => {
	const a = session(newId());
	const b = session(newId());
	const request = a.request(b.id, "run the tests");
	await b.start();
	await b.agentStart();
	const payload = emitReply(b.events, { to: a.id, inReplyTo: [request.id], body: "", status: "done" });
	assert.equal(payload.error, undefined);
	assert.equal(envelopes(a.id, "new").length, 1, "written before the run ends");
	assert.equal(envelopes(a.id, "new")[0].body, "", "an empty body is allowed and kept");
	await b.agentEnd("the model's own answer");
	await b.settle();
	const written = envelopes(a.id, "new");
	assert.equal(written.length, 1, "settle answers no request");
	assert.equal(written[0].body, "");
	await b.shutdown();
});

test("a reply to a sender that is not running waits in its inbox and is claimed, with its request copy, on return", async () => {
	const a = session(newId());
	const b = session(newId());
	await a.start();
	a.events.emit("message:send", { to: b.id, body: "please answer" });
	const [request] = envelopes(a.id, "sent");
	await a.shutdown();
	await b.start();
	const payload = emitReply(b.events, { to: a.id, inReplyTo: [request.id], body: "the answer", status: "failed" });
	assert.equal(payload.error, undefined);
	assert.equal(files(a.id, "new").length, 1, "the reply waits in the closed sender's inbox");

	// The sender comes back under the same address; a listener takes the reply over.
	const back = session(a.id);
	const seen: { envelope: Record<string, unknown>; requests: { envelope: { id: string; body: string } }[] }[] = [];
	back.events.on("message:inbound", (data) => {
		const inbound = data as (typeof seen)[number] & { handled: boolean };
		seen.push(inbound);
		inbound.handled = true;
	});
	await back.start();
	assert.deepEqual(files(a.id, "new"), []);
	assert.equal(files(a.id, "cur").length, 1);
	assert.equal(seen.length, 1);
	assert.equal(seen[0].envelope.body, "the answer");
	assert.equal(seen[0].envelope.status, "failed");
	assert.deepEqual(seen[0].envelope.in_reply_to, [request.id]);
	assert.equal(seen[0].requests.length, 1);
	assert.equal(seen[0].requests[0].envelope.id, request.id);
	assert.equal(seen[0].requests[0].envelope.body, "please answer");
	assert.deepEqual(back.sent, [], "the listener took it over, so mailbox injected nothing");
	await back.shutdown();
	await b.shutdown();
});

test("message:reply refuses invalid input with an error and writes nothing", async () => {
	const a = session(newId());
	const b = session(newId());
	await b.start();
	const valid = { to: a.id, inReplyTo: ["req-1"], body: "x", status: "done" };
	const cases: [string, Record<string, unknown>, RegExp][] = [
		["a to that is no address", { to: "../elsewhere" }, /invalid address/],
		["a missing to", { to: undefined }, /invalid address/],
		["a missing inReplyTo", { inReplyTo: undefined }, /inReplyTo/],
		["an inReplyTo that is a string", { inReplyTo: "req-1" }, /inReplyTo/],
		["an empty inReplyTo", { inReplyTo: [] }, /inReplyTo/],
		["an empty id", { inReplyTo: ["req-1", ""] }, /inReplyTo/],
		["an id that is not a string", { inReplyTo: [7] }, /inReplyTo/],
		["more than 50 ids", { inReplyTo: Array.from({ length: 51 }, (_, i) => `req-${i}`) }, /more than 50/],
		["a body that is not a string", { body: 42 }, /body/],
		["a missing status", { status: undefined }, /status/],
		["an unknown status", { status: "maybe" }, /status/],
		["a status that is not a string", { status: 1 }, /status/],
	];
	for (const [what, change, error] of cases) {
		const payload = emitReply(b.events, { ...valid, ...change });
		assert.equal(payload.envelope, undefined, what);
		assert.match(payload.error ?? "", error, what);
	}
	assert.deepEqual(files(a.id, "new"), []);
	await b.shutdown();
});

test("message:reply accepts 50 ids, does not look them up, and writes every valid call", async () => {
	const a = session(newId());
	const b = session(newId());
	await b.start();
	const fifty = Array.from({ length: 50 }, (_, i) => `never-sent-${i}`);
	for (let i = 0; i < 2; i++) {
		const payload = emitReply(b.events, { to: a.id, inReplyTo: fifty, body: "again", status: "done" });
		assert.equal(payload.error, undefined);
	}
	const written = envelopes(a.id, "new");
	assert.equal(written.length, 2, "no duplicate guard");
	assert.deepEqual(written[0].in_reply_to, fifty);
	await b.shutdown();
});

test("message:reply reports no active session and a failed write as errors", async () => {
	const a = session(newId());
	const b = session(newId());
	const before = emitReply(b.events, { to: a.id, inReplyTo: ["r"], body: "x", status: "done" });
	assert.equal(before.envelope, undefined);
	assert.match(before.error ?? "", /no active session/);
	await b.start();
	await b.shutdown();
	const after = emitReply(b.events, { to: a.id, inReplyTo: ["r"], body: "x", status: "done" });
	assert.match(after.error ?? "", /no active session/);

	// A file where the recipient's folder belongs makes the write fail.
	const c = session(newId());
	await c.start();
	const blocked = newId();
	mkdirSync(stateRoot(), { recursive: true });
	writeFileSync(join(stateRoot(), blocked), "not a folder");
	const failed = emitReply(c.events, { to: blocked, inReplyTo: ["r"], body: "x", status: "done" });
	assert.equal(failed.envelope, undefined);
	assert.equal(typeof failed.error, "string");
	await c.shutdown();
	assert.deepEqual(files(a.id, "new"), []);
});

test("with no provider installed, a message:reply payload gets neither envelope nor error", () => {
	const payload = emitReply(createEventBus(), { to: "someone", inReplyTo: ["r"], body: "x", status: "done" });
	assert.equal(payload.envelope, undefined);
	assert.equal(payload.error, undefined);
});

test("each of several requests is answered by its own reply, and a settle answers none of the rest", async () => {
	const a = session(newId());
	const c = session(newId());
	const b = session(newId());
	const fromA = [a.request(b.id, "one"), a.request(b.id, "two")];
	const fromC = c.request(b.id, "three");
	await b.start();
	await b.answer("unrelated work");
	assert.deepEqual(files(a.id, "new"), []);
	assert.deepEqual(files(c.id, "new"), []);
	emitReply(b.events, { to: a.id, inReplyTo: [fromA[1].id], body: "two done", status: "done" });
	await b.answer("more unrelated work");
	assert.deepEqual(
		envelopes(a.id, "new").map((e) => [e.in_reply_to, e.body]),
		[[[fromA[1].id], "two done"]],
	);
	assert.deepEqual(files(c.id, "new"), [], "c's request stays unanswered");
	emitReply(b.events, { to: c.id, inReplyTo: [fromC.id], body: "three failed", status: "failed" });
	emitReply(b.events, { to: a.id, inReplyTo: [fromA[0].id], body: "one done", status: "done" });
	await b.answer("still more");
	assert.deepEqual(
		envelopes(a.id, "new").map((e) => [e.in_reply_to, e.body]),
		[
			[[fromA[1].id], "two done"],
			[[fromA[0].id], "one done"],
		],
	);
	assert.deepEqual(
		envelopes(c.id, "new").map((e) => [e.in_reply_to, e.status]),
		[[[fromC.id], "failed"]],
	);
	await b.shutdown();
});

test("message:reply naming an ask leaves that ask to be answered at settle", async () => {
	const a = session(newId());
	const b = session(newId());
	const ask = a.ask(b.id, "a question");
	await b.start();
	emitReply(b.events, { to: a.id, inReplyTo: [ask.id], body: "from the hook", status: "done" });
	await b.answer("the model's answer");
	const written = envelopes(a.id, "new");
	assert.deepEqual(
		written.map((e) => e.body),
		["from the hook", "the model's answer"],
		"the hook does not touch the ask's bookkeeping",
	);
	await b.shutdown();
});
