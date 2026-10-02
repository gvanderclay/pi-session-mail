// The settle decision, called directly: who is answered what when a run ends,
// and which requests stay owed. Expected texts are literals, as the wire sees them.

import assert from "node:assert/strict";
import { test } from "node:test";

import { type SettleInput, settle } from "../src/settle.ts";

const NO_ANSWER = "(The session settled with no answer text.)";
const STOPPED = "(The user stopped this run before it finished; the text that follows, if any, is partial.)";
const TOOK_OVER =
	"(The user stopped an earlier run partway and took over; the answer that follows is from the run that completed after that.)";
const ERRORED =
	"(The run ended on an error before it finished: 529 overloaded. The text that follows, if any, is partial.)";
const UNSEEN =
	"(The session was stopped before it read the message. Nothing was done; send it again if it is still needed.)";

/** An input with nothing owed, seen or held, a done run and no answer; each case overrides what it needs. */
function input(over: Partial<SettleInput> = {}): SettleInput {
	return {
		requests: new Map(),
		asks: new Map(),
		seen: new Set(),
		held: new Set(),
		end: { kind: "done" },
		answer: undefined,
		...over,
	};
}

const cases: { name: string; given: SettleInput; replies: unknown[]; owed: [string, string[]][]; held: string[] }[] = [
	{
		name: "a done run answers a seen request with the answer text",
		given: input({ requests: new Map([["a", ["r1"]]]), seen: new Set(["r1"]), answer: "42" }),
		replies: [{ to: "a", ids: ["r1"], body: "42", status: "done" }],
		owed: [],
		held: [],
	},
	{
		name: "a stopped run keeps seen requests owed and held, and fails unseen ones",
		given: input({
			requests: new Map([["a", ["r1", "r2"]]]),
			seen: new Set(["r1"]),
			end: { kind: "stopped" },
			answer: "partial",
		}),
		replies: [{ to: "a", ids: ["r2"], body: UNSEEN, status: "failed" }],
		owed: [["a", ["r1"]]],
		held: ["r1"],
	},
	{
		name: "a stopped run owing only unseen requests holds nothing",
		given: input({ requests: new Map([["a", ["r1"]]]), end: { kind: "stopped" } }),
		replies: [{ to: "a", ids: ["r1"], body: UNSEEN, status: "failed" }],
		owed: [],
		held: [],
	},
	{
		name: "a failed run answers seen requests failed, with the error then the partial text",
		given: input({
			requests: new Map([["a", ["r1"]]]),
			seen: new Set(["r1"]),
			end: { kind: "failed", error: "529 overloaded" },
			answer: "partial",
		}),
		replies: [{ to: "a", ids: ["r1"], body: `${ERRORED}\n\npartial`, status: "failed" }],
		owed: [],
		held: [],
	},
	{
		name: "a failed run with no partial text sends the error line alone",
		given: input({
			requests: new Map([["a", ["r1"]]]),
			seen: new Set(["r1"]),
			end: { kind: "failed", error: "529 overloaded" },
		}),
		replies: [{ to: "a", ids: ["r1"], body: ERRORED, status: "failed" }],
		owed: [],
		held: [],
	},
	{
		name: "a failed run keeps a held request owed and held, and answers the others",
		given: input({
			requests: new Map([["a", ["r1", "r2"]]]),
			seen: new Set(["r2"]),
			held: new Set(["r1"]),
			end: { kind: "failed", error: "529 overloaded" },
		}),
		replies: [{ to: "a", ids: ["r2"], body: ERRORED, status: "failed" }],
		owed: [["a", ["r1"]]],
		held: ["r1"],
	},
	{
		name: "a held request is answered 'took over' by a done run, even though it is not seen again",
		given: input({
			requests: new Map([["a", ["r1", "r2"]]]),
			seen: new Set(["r2"]),
			held: new Set(["r1"]),
			answer: "42",
		}),
		replies: [
			{ to: "a", ids: ["r2"], body: "42", status: "done" },
			{ to: "a", ids: ["r1"], body: `${TOOK_OVER}\n\n42`, status: "done" },
		],
		owed: [],
		held: [],
	},
	{
		name: "a held request answered by a run with no answer text says so after 'took over'",
		given: input({ requests: new Map([["a", ["r1"]]]), held: new Set(["r1"]) }),
		replies: [{ to: "a", ids: ["r1"], body: `${TOOK_OVER}\n\n${NO_ANSWER}`, status: "done" }],
		owed: [],
		held: [],
	},
	{
		name: "a second stop keeps a held request held",
		given: input({ requests: new Map([["a", ["r1"]]]), held: new Set(["r1"]), end: { kind: "stopped" } }),
		replies: [],
		owed: [["a", ["r1"]]],
		held: ["r1"],
	},
	{
		name: "each sender is answered separately, in the order requests arrived",
		given: input({
			requests: new Map([
				["a", ["r1"]],
				["b", ["r2"]],
			]),
			seen: new Set(["r1", "r2"]),
			answer: "ok",
		}),
		replies: [
			{ to: "a", ids: ["r1"], body: "ok", status: "done" },
			{ to: "b", ids: ["r2"], body: "ok", status: "done" },
		],
		owed: [],
		held: [],
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
		owed: [],
		held: [],
	},
	{
		name: "asks never seen are failed as unseen",
		given: input({ asks: new Map([["a", ["k1", "k2"]]]), seen: new Set(["k2"]), answer: "42" }),
		replies: [
			{ to: "a", ids: ["k2"], body: "42", status: "done" },
			{ to: "a", ids: ["k1"], body: UNSEEN, status: "failed" },
		],
		owed: [],
		held: [],
	},
	{
		name: "an ask in a failed run is answered failed with the error line",
		given: input({
			asks: new Map([["a", ["k1"]]]),
			seen: new Set(["k1"]),
			end: { kind: "failed", error: "529 overloaded" },
		}),
		replies: [{ to: "a", ids: ["k1"], body: ERRORED, status: "failed" }],
		owed: [],
		held: [],
	},
	{
		name: "a stopped run with no partial text sends the stop line alone to an ask",
		given: input({ asks: new Map([["a", ["k1"]]]), seen: new Set(["k1"]), end: { kind: "stopped" } }),
		replies: [{ to: "a", ids: ["k1"], body: STOPPED, status: "stopped" }],
		owed: [],
		held: [],
	},
	{
		name: "an empty run sends nothing",
		given: input(),
		replies: [],
		owed: [],
		held: [],
	},
	{
		name: "a done run with no answer text sends the placeholder",
		given: input({ requests: new Map([["a", ["r1"]]]), seen: new Set(["r1"]) }),
		replies: [{ to: "a", ids: ["r1"], body: NO_ANSWER, status: "done" }],
		owed: [],
		held: [],
	},
];

for (const c of cases) {
	test(c.name, () => {
		const out = settle(c.given);
		assert.deepEqual(out.replies, c.replies);
		assert.deepEqual([...out.owed], c.owed);
		assert.deepEqual([...out.held], c.held);
	});
}
