/** How a run ended, and the answer text it left; shared by the request and ask sides. */
type RunEnd = {
	end: { kind: "done" } | { kind: "stopped" } | { kind: "failed"; error: string };
	answer: string | undefined;
};
/** What the request side of a settle decides on: requests owed, the ids seen, and those held across a stop. */
export type SettleRequestsInput = RunEnd & {
	requests: ReadonlyMap<string, string[]>;
	seen: ReadonlySet<string>;
	held: ReadonlySet<string>;
};
/** What the ask side of a settle decides on: the open asks and the ids seen. Asks are never held. */
export type SettleAsksInput = RunEnd & {
	asks: ReadonlyMap<string, string[]>;
	seen: ReadonlySet<string>;
};
export type SettleInput = SettleRequestsInput & SettleAsksInput;
export type Reply = { to: string; ids: string[]; body: string; status: "done" | "stopped" | "failed" };
export type SettleRequestsOutput = { replies: Reply[]; owed: Map<string, string[]>; held: Set<string> };
export type SettleOutput = SettleRequestsOutput;

/** Reply body when the run ended with no assistant text. */
export const NO_ANSWER = "(The session settled with no answer text.)";
/** Reply body of a run the user stopped, with any partial answer text after it. */
export const STOPPED = "(The user stopped this run before it finished; the text that follows, if any, is partial.)";
/** Opening line of the reply body to a request held across a stop, before the answer of the run that completed it. */
export const TOOK_OVER =
	"(The user stopped an earlier run partway and took over; the answer that follows is from the run that completed after that.)";
/** Opening line of the reply body of a run that ended on an error. */
export const ERRORED = (error: string): string =>
	`(The run ended on an error before it finished: ${error}. The text that follows, if any, is partial.)`;
/** Body of a `failed` reply to requests that never entered the conversation. */
export const UNSEEN =
	"(The session was stopped before it read the message. Nothing was done; send it again if it is still needed.)";

/** The body and status of the reply to a run that ended this way: how it ended, then what it had. */
function describeEnd(end: RunEnd["end"], answer: string | undefined): { body: string; status: Reply["status"] } {
	const text = answer ?? NO_ANSWER;
	const withOpening = (opening: string): string => (answer === undefined ? opening : `${opening}\n\n${answer}`);
	if (end.kind === "stopped") return { body: withOpening(STOPPED), status: "stopped" };
	if (end.kind === "failed") return { body: withOpening(ERRORED(end.error)), status: "failed" };
	return { body: text, status: "done" };
}

// Asks. Nothing here reads request state.

/** The replies to the asks: read ones get the run's answer, the rest fail as unseen. */
export function settleAsks(input: SettleAsksInput): Reply[] {
	const { asks, seen, end, answer } = input;
	const run = describeEnd(end, answer);
	const replies: Reply[] = [];
	for (const [to, ids] of asks) {
		const read = ids.filter((id) => seen.has(id));
		const unread = ids.filter((id) => !seen.has(id));
		if (read.length > 0) replies.push({ to, ids: read, ...run });
		if (unread.length > 0) replies.push({ to, ids: unread, body: UNSEEN, status: "failed" });
	}
	return replies;
}

// Requests. Request-only: the owed and held bookkeeping and the "took over" wording.

/**
 * Decide the replies to the requests when a run settles, and which stay owed.
 *
 * A request the user stopped a run on is held: it stays owed, through stops
 * and failed runs alike, until a run completes, and is then answered "took
 * over". A request never read is failed as unseen.
 */
export function settleRequests(input: SettleRequestsInput): SettleRequestsOutput {
	const { end, answer, seen, held: wasHeld } = input;
	const stopped = end.kind === "stopped";
	const failed = end.kind === "failed";
	const { body, status } = describeEnd(end, answer);
	const tookOverBody = `${TOOK_OVER}\n\n${answer ?? NO_ANSWER}`;
	const replies: Reply[] = [];
	const owed = new Map<string, string[]>();
	const held = new Set<string>();
	for (const [to, ids] of input.requests) {
		const unseen = ids.filter((id) => !seen.has(id) && !wasHeld.has(id));
		const keep = ids.filter((id) => !unseen.includes(id) && (stopped || (failed && wasHeld.has(id))));
		const answered = ids.filter((id) => !unseen.includes(id) && !keep.includes(id));
		if (keep.length > 0) owed.set(to, keep);
		for (const id of keep) held.add(id);
		const plain = answered.filter((id) => !wasHeld.has(id));
		const tookOver = answered.filter((id) => wasHeld.has(id));
		if (plain.length > 0) replies.push({ to, ids: plain, body, status });
		if (tookOver.length > 0) replies.push({ to, ids: tookOver, body: tookOverBody, status: "done" });
		if (unseen.length > 0) replies.push({ to, ids: unseen, body: UNSEEN, status: "failed" });
	}
	return { replies, owed, held };
}

/** Both sides at once: the request replies, then the ask replies. The extension calls the two sides apart. */
export function settle(input: SettleInput): SettleOutput {
	const requests = settleRequests(input);
	return { ...requests, replies: [...requests.replies, ...settleAsks(input)] };
}
