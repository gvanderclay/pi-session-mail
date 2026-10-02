export type SettleInput = {
	requests: ReadonlyMap<string, string[]>;
	asks: ReadonlyMap<string, string[]>;
	seen: ReadonlySet<string>;
	held: ReadonlySet<string>;
	end: { kind: "done" } | { kind: "stopped" } | { kind: "failed"; error: string };
	answer: string | undefined;
};
export type Reply = { to: string; ids: string[]; body: string; status: "done" | "stopped" | "failed" };
export type SettleOutput = { replies: Reply[]; owed: Map<string, string[]>; held: Set<string> };

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
function describeEnd(end: SettleInput["end"], answer: string | undefined): { body: string; status: Reply["status"] } {
	const text = answer ?? NO_ANSWER;
	const withOpening = (opening: string): string => (answer === undefined ? opening : `${opening}\n\n${answer}`);
	if (end.kind === "stopped") return { body: withOpening(STOPPED), status: "stopped" };
	if (end.kind === "failed") return { body: withOpening(ERRORED(end.error)), status: "failed" };
	return { body: text, status: "done" };
}

/** The replies to the asks: read ones get the run's answer, the rest fail as unseen. */
function askReplies(
	asks: SettleInput["asks"],
	seen: SettleInput["seen"],
	run: Pick<Reply, "body" | "status">,
): Reply[] {
	const replies: Reply[] = [];
	for (const [to, ids] of asks) {
		const read = ids.filter((id) => seen.has(id));
		const unread = ids.filter((id) => !seen.has(id));
		if (read.length > 0) replies.push({ to, ids: read, ...run });
		if (unread.length > 0) replies.push({ to, ids: unread, body: UNSEEN, status: "failed" });
	}
	return replies;
}

/**
 * Decide the replies when a run settles, and which requests stay owed.
 *
 * A request the user stopped a run on is held: it stays owed, through stops
 * and failed runs alike, until a run completes, and is then answered "took
 * over". A request or ask never read is failed as unseen. Asks are never held;
 * their asker is blocked waiting.
 */
export function settle(input: SettleInput): SettleOutput {
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
	replies.push(...askReplies(input.asks, seen, { body, status }));
	return { replies, owed, held };
}
