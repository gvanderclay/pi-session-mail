/** What a settle decides on: the open asks, the ids seen, how the run ended and the answer text it left. */
export type SettleAsksInput = {
	asks: ReadonlyMap<string, string[]>;
	seen: ReadonlySet<string>;
	end: { kind: "done" } | { kind: "stopped" } | { kind: "failed"; error: string };
	answer: string | undefined;
};
export type Reply = { to: string; ids: string[]; body: string; status: "done" | "stopped" | "failed" };

/** Reply body when the run ended with no assistant text. */
export const NO_ANSWER = "(The session settled with no answer text.)";
/** Reply body of a run the user stopped, with any partial answer text after it. */
export const STOPPED = "(The user stopped this run before it finished; the text that follows, if any, is partial.)";
/** Opening line of the reply body of a run that ended on an error. */
export const ERRORED = (error: string): string =>
	`(The run ended on an error before it finished: ${error}. The text that follows, if any, is partial.)`;
/** Body of a `failed` reply to asks that never entered the conversation. */
export const UNSEEN =
	"(The session was stopped before it read the message. Nothing was done; send it again if it is still needed.)";

/** The body and status of the reply to a run that ended this way: how it ended, then what it had. */
function describeEnd(
	end: SettleAsksInput["end"],
	answer: string | undefined,
): { body: string; status: Reply["status"] } {
	const text = answer ?? NO_ANSWER;
	const withOpening = (opening: string): string => (answer === undefined ? opening : `${opening}\n\n${answer}`);
	if (end.kind === "stopped") return { body: withOpening(STOPPED), status: "stopped" };
	if (end.kind === "failed") return { body: withOpening(ERRORED(end.error)), status: "failed" };
	return { body: text, status: "done" };
}

/**
 * The replies to the open asks when a run settles: read ones get the run's
 * answer, the rest fail as unseen. Asks are never held across a stop, and
 * requests are never answered here; the extension that consumes one owns its reply.
 */
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
