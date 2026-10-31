// The ask settle decision, called directly: who is answered what when a run
// ends. Expected texts are literals, as the wire sees them. Requests are not
// settled: the extension that consumes one owns its reply.

import assert from "node:assert/strict";
import { test } from "node:test";

import { type SettleAsksInput, settleAsks } from "../src/settle.ts";

const NO_ANSWER = "(The session settled with no answer text.)";
const STOPPED = "(The user stopped this run before it finished; the text that follows, if any, is partial.)";
const ERRORED =
	"(The run ended on an error before it finished: 529 overloaded. The text that follows, if any, is partial.)";
const UNSEEN =
	"(The session was stopped before it read the message. Nothing was done; send it again if it is still needed.)";

/** An input with nothing open or seen, a done run and no answer; each case overrides what it needs. */
function input(over: Partial<SettleAsksInput> = {}): SettleAsksInput {
	return { asks: new Map(), seen: new Set(), end: { kind: "done" }, answer: undefined, ...over };
}

const cases: { name: string; given: SettleAsksInput; replies: unknown[] }[] = [
	{
		name: "a done run answers a seen ask with the answer text",
		given: input({ asks: new Map([["a", ["k1"]]]), seen: new Set(["k1"]), answer: "42" }),
		replies: [{ to: "a", ids: ["k1"], body: "42", status: "done" }],
	},
	{
		name: "asks seen are answered with the run's status, never held",
		given: input({
			asks: new Map([["a", ["k1"]]]),
			seen: new Set(["k1"]),
			end: { kind: "stopped" },
			answer: "partial",
		}),
		replies: [{ to: "a", ids: ["k1"], body: `${STOPPED}\n\npartial`, status: "stopped" }],
	},
	{
		name: "a stopped run fails unseen asks and answers seen ones stopped",
		given: input({
			asks: new Map([["a", ["k1", "k2"]]]),
			seen: new Set(["k1"]),
			end: { kind: "stopped" },
			answer: "partial",
		}),
		replies: [
			{ to: "a", ids: ["k1"], body: `${STOPPED}\n\npartial`, status: "stopped" },
			{ to: "a", ids: ["k2"], body: UNSEEN, status: "failed" },
		],
	},
	{
		name: "asks never seen are failed as unseen",
		given: input({ asks: new Map([["a", ["k1", "k2"]]]), seen: new Set(["k2"]), answer: "42" }),
		replies: [
			{ to: "a", ids: ["k2"], body: "42", status: "done" },
			{ to: "a", ids: ["k1"], body: UNSEEN, status: "failed" },
		],
	},
	{
		name: "a failed run answers seen asks failed, with the error then the partial text",
		given: input({
			asks: new Map([["a", ["k1"]]]),
			seen: new Set(["k1"]),
			end: { kind: "failed", error: "529 overloaded" },
			answer: "partial",
		}),
		replies: [{ to: "a", ids: ["k1"], body: `${ERRORED}\n\npartial`, status: "failed" }],
	},
	{
		name: "an ask in a failed run is answered failed with the error line",
		given: input({
			asks: new Map([["a", ["k1"]]]),
			seen: new Set(["k1"]),
			end: { kind: "failed", error: "529 overloaded" },
		}),
		replies: [{ to: "a", ids: ["k1"], body: ERRORED, status: "failed" }],
	},
	{
		name: "a stopped run with no partial text sends the stop line alone to an ask",
		given: input({ asks: new Map([["a", ["k1"]]]), seen: new Set(["k1"]), end: { kind: "stopped" } }),
		replies: [{ to: "a", ids: ["k1"], body: STOPPED, status: "stopped" }],
	},
	{
		name: "each sender is answered separately, in the order asks arrived",
		given: input({
			asks: new Map([
				["a", ["k1"]],
				["b", ["k2"]],
			]),
			seen: new Set(["k1", "k2"]),
			answer: "ok",
		}),
		replies: [
			{ to: "a", ids: ["k1"], body: "ok", status: "done" },
			{ to: "b", ids: ["k2"], body: "ok", status: "done" },
		],
	},
	{
		name: "an empty run sends nothing",
		given: input(),
		replies: [],
	},
	{
		name: "a done run with no answer text sends the placeholder",
		given: input({ asks: new Map([["a", ["k1"]]]), seen: new Set(["k1"]) }),
		replies: [{ to: "a", ids: ["k1"], body: NO_ANSWER, status: "done" }],
	},
];

for (const c of cases) {
	test(c.name, () => {
		assert.deepEqual(settleAsks(c.given), c.replies);
	});
}
