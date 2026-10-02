// The pure parsers behind liveness by process start time. The Linux `/proc`
// path cannot run on macOS, so its parsing is pinned here over sample lines.
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseProcStat, parsePsStarts } from "../src/running.ts";

// Fields 3..21 are 19 values, then field 22 (starttime).
const tail = "S 1 1234 1234 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 987654 12345678";

test("parseProcStat reads field 22 of a plain stat line", () => {
	assert.equal(parseProcStat(`4242 (node) ${tail}`), "987654");
});

test("parseProcStat counts from the last parenthesis when the command name holds spaces and parentheses", () => {
	assert.equal(parseProcStat(`4242 (my (odd) cmd) ${tail}`), "987654");
	assert.equal(parseProcStat(`4242 (a) S 1 (b) ${tail}`), "987654");
});

test("parseProcStat returns undefined for a line that is too short or malformed", () => {
	assert.equal(parseProcStat(""), undefined);
	assert.equal(parseProcStat("4242 (node) S 1 2"), undefined);
	assert.equal(parseProcStat("no parentheses here"), undefined);
});

test("parsePsStarts maps each pid to its start text and skips junk lines", () => {
	const out = parsePsStarts("  101 Mon Jan  2 15:04:05 2006\n42 Tue Feb 13 01:02:03 2024\n\nnot a line\n");
	assert.deepEqual(
		[...out],
		[
			[101, "Mon Jan  2 15:04:05 2006"],
			[42, "Tue Feb 13 01:02:03 2024"],
		],
	);
});
