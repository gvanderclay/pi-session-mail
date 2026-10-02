// The FIFO and directory scenarios for the tests in `mailbox.test.ts`, run as
// a child process: reading a FIFO blocks forever, so the parent test bounds the
// whole scenario with `spawnSync`'s timeout. A regression then fails the test
// instead of hanging the suite.
//
// `argv[2]` is the scenario: "cur", "sent" or "dir", the place a planted
// `*.json` name goes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { box, dir, envelopes, newId, session, until } from "./harness.ts";

const kind = process.argv[2];
const a = session(newId("a"));
const b = session(newId("b"));
try {
	await a.start();
	await b.start();
	await a.mailbox(`${b.id} question`);
	const [request] = envelopes(a.id, "sent");
	if (kind === "cur") execFileSync("mkfifo", [join(box(b.id, "cur"), "000000000000001-fifo.json")]);
	if (kind === "sent") execFileSync("mkfifo", [join(box(a.id, "sent"), `000000000000000-${request.id}.json`)]);
	if (kind === "dir") {
		mkdirSync(join(box(b.id, "cur"), "000000000000001-dir.json"), { recursive: true, mode: 0o700 });
		mkdirSync(join(box(a.id, "sent"), `000000000000000-${request.id}.json`), { recursive: true, mode: 0o700 });
	}
	// Delivery: the request reaches B, and the earlier non-file must not count as read.
	await until(() => b.sent.length === 1, "B to receive");
	assert.equal(b.status(), "✉ 1 pending · 1 read");
	// A reply quotes the request from A's sent/, next to the planted name.
	await b.answer("answer");
	await until(() => a.sent.length === 1, "A to receive the reply");
	assert.match(a.sent[0].message.content, /question/);
	assert.equal(a.status(), "✉ 1 pending · 1 read");
	await a.shutdown();
	await b.shutdown();
} finally {
	rmSync(dir, { recursive: true, force: true });
}
