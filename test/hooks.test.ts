// The `message:send` and `message:inbound` contracts, run from the worked
// examples in `../README.md`. The examples are the documentation: every
// `` ```js <name> `` fence is extracted and executed verbatim on a real
// `createEventBus`, so a field renamed in the README without a matching
// change in the code fails here. The name after the fence's `js` marker
// selects the test below that runs it, and `test("...")` at the end fails
// when a fence has no runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEventBus } from "@earendil-works/pi-coding-agent";

import register from "../index.ts";

const dir = mkdtempSync(join(tmpdir(), "mailbox-hooks-"));
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
test.after(() => rmSync(dir, { recursive: true, force: true }));

const root = join(dir, "agent", "mailbox");
const files = (address: string, sub: "new" | "sent") => {
	try {
		return readdirSync(join(root, address, sub)).sort();
	} catch {
		return [];
	}
};
const envelopes = (address: string, sub: "new" | "sent") =>
	files(address, sub).map((name) => JSON.parse(readFileSync(join(root, address, sub, name), "utf8")));

let counter = 0;
const newId = (label: string) => `${label}-${process.pid}-${++counter}`;

/** Every `` ```js <name> `` block in the README, by name. */
function readmeExamples(): Map<string, string> {
	const text = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	const fence = /^```js(?:[ \t]+(\S+))?[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;
	const out = new Map<string, string>();
	for (const [, name, code] of text.matchAll(fence)) {
		assert.ok(name, "every runnable example fence names the test that runs it: ```js <name>");
		assert.ok(!out.has(name), `README.md has two examples named ${name}`);
		out.set(name, code);
	}
	return out;
}

const examples = readmeExamples();
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
	...args: string[]
) => (...args: unknown[]) => Promise<void>;

/** Run one README example with the names its prose promises: `pi`, `peer`, `bareBus`, `assert`. */
async function runExample(name: string, scope: { pi: unknown; peer: string; bareBus: unknown }) {
	const code = examples.get(name);
	assert.ok(code, `README.md has a \`\`\`js ${name} example`);
	await new AsyncFunction("pi", "peer", "bareBus", "assert", code)(scope.pi, scope.peer, scope.bareBus, assert);
}

type Sent = { message: { customType: string; content: string; display?: boolean }; options: unknown };
type Handler = (event: unknown, ctx: unknown) => unknown;

/** One fake Pi session running the extension under `sessionId`. */
function session(sessionId: string) {
	const handlers: Record<string, Handler[]> = {};
	const sent: Sent[] = [];
	const events = createEventBus();
	let ctx: unknown;
	const pi = {
		events,
		on: (name: string, handler: Handler) => (handlers[name] ??= []).push(handler),
		registerCommand: () => {},
		sendMessage: (message: Sent["message"], options: unknown) => {
			sent.push({ message, options });
			for (const h of handlers.message_end ?? [])
				void h({ type: "message_end", message: { role: "custom", ...message, timestamp: Date.now() } }, ctx);
		},
	};
	ctx = {
		cwd: dir,
		hasUI: false,
		sessionManager: { getSessionId: () => sessionId },
		ui: { notify: () => {}, setStatus: () => {} },
	};
	register(pi as never);
	const fire = async (name: string, event: object = {}) => {
		for (const h of handlers[name] ?? []) await h({ type: name, ...event }, ctx);
	};
	return {
		id: sessionId,
		events,
		pi,
		sent,
		start: () => fire("session_start", { reason: "startup" }),
		shutdown: () => fire("session_shutdown"),
		/** One agent run ending with `text` as the last assistant message, then settling. */
		answer: async (text: string) => {
			await fire("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text }] }] });
			await fire("agent_settled");
		},
	};
}

/** Wait until `check` holds, up to a few poll intervals. */
async function until(check: () => boolean, what: string, ms = 4000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

test("the README's message:send example writes a request the sender keeps a copy of", async () => {
	const a = session(newId("a"));
	const b = session(newId("b"));
	await a.start();
	try {
		await runExample("message:send", { pi: a.pi, peer: b.id, bareBus: createEventBus() });
		const [envelope] = envelopes(b.id, "new");
		assert.equal(envelope.from, a.id);
		assert.equal(envelope.to, b.id);
		assert.equal(envelope.body, "Please run the test suite.");
		assert.deepEqual(envelopes(a.id, "sent"), [envelope]);
	} finally {
		await a.shutdown();
	}
});

test("the README's no-provider example leaves a payload with neither field set", async () => {
	const a = session(newId("a"));
	const peer = newId("b");
	await a.start();
	try {
		await runExample("no-provider", { pi: a.pi, peer, bareBus: createEventBus() });
		assert.deepEqual(files(peer, "new"), []);
	} finally {
		await a.shutdown();
	}
});

test("the README's message:inbound example takes over a reply and leaves a request to mailbox", async () => {
	const s = session(newId("s"));
	const r = session(newId("r"));
	const p = session(newId("p"));
	await s.start();
	await r.start();
	await p.start();
	try {
		await runExample("message:inbound", { pi: s.pi, peer: p.id, bareBus: createEventBus() });

		// A request is not a reply, so the example leaves it to `mailbox`.
		p.events.emit("message:send", { to: s.id, body: "a request" });
		await until(() => s.sent.length === 1, "the request to be injected");
		assert.equal(s.sent[0].message.customType, "mailbox");
		assert.match(s.sent[0].message.content, /a request$/);

		// A reply to a request `s` sent is the example's: it injects its own message.
		s.events.emit("message:send", { to: r.id, body: "please answer" });
		await until(() => r.sent.length === 1, "r to receive the request");
		await r.answer("the answer");
		await until(() => s.sent.length === 2, "the reply to be injected");
		assert.deepEqual(
			s.sent.map((m) => m.message.customType),
			["mailbox", "my-extension"],
		);
		const reply = s.sent[1];
		assert.match(reply.message.content, new RegExp(`Reply from ${r.id}`));
		assert.ok(reply.message.content.includes(join(root, s.id, "cur")), "the example quotes the envelope's path");
		assert.match(reply.message.content, /the answer$/);
		assert.deepEqual(reply.options, { triggerTurn: true, deliverAs: "followUp" });
	} finally {
		await s.shutdown();
		await r.shutdown();
		await p.shutdown();
	}
});

test("every runnable example in the README has a runner above", () => {
	assert.deepEqual([...examples.keys()].sort(), ["message:inbound", "message:send", "no-provider"]);
});
