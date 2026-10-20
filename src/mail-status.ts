// What state each piece of a session's mail is in. Pure: it reads no files and
// no clock. The disk reader supplies the files and the command handler the
// in-memory unread set; `picker.ts` shows the statuses.
//
// Unread is what the footer counts: files still in `new/`, plus mail claimed
// into `cur/` that has not entered the conversation. Read is the rest of
// `cur/`. A sent request or ask is awaiting when no reply in `cur/` names it,
// and answered when one does. Sent messages expect no answer.
//
// The counting rules use the raw parsed JSON, not the validated envelope, so
// they stay the same as older copies that shared this mail root. A file that
// is not a valid envelope can still count; the picker shows only valid ones.

/** The boxes a session's mail lives in; `sent/` holds its outgoing copies. */
export type MailBox = "new" | "cur" | "sent";

/** What a status needs from an envelope. */
export type MailEnvelope = {
	id: string;
	kind: string;
	in_reply_to: readonly string[];
};

/** One file in the mailbox; `envelope` is absent when the file is not a valid envelope. */
export type MailFile<E extends MailEnvelope = MailEnvelope> = {
	box: MailBox;
	/** The file's parsed JSON, absent when it cannot be read. */
	parsed?: unknown;
	envelope?: E;
};

/** What a piece of mail means to the person looking at it. */
export type Status = "unread" | "read" | "awaiting" | "answered" | "message";

/** One file with its status; a file that cannot be read has none. */
export type StatusFile<T extends MailFile> = T & { status?: Status };

type Facts = { id?: unknown; kind?: unknown; in_reply_to?: unknown };

const facts = (parsed: unknown): Facts => (typeof parsed === "object" && parsed !== null ? (parsed as Facts) : {});

/** The ids a `cur/` file answers, from its raw `in_reply_to` array when it has one. */
function answers(file: MailFile): readonly unknown[] {
	if (file.box !== "cur") return [];
	const list = facts(file.parsed ?? file.envelope).in_reply_to;
	return Array.isArray(list) ? list : [];
}

function statusOf(file: MailFile, answered: ReadonlySet<unknown>, unread: ReadonlySet<string>): Status | undefined {
	const source = file.parsed ?? file.envelope;
	if (source === undefined) return undefined;
	const { id, kind } = facts(source);
	if (file.box === "new") return "unread";
	if (file.box === "cur") return typeof id === "string" && unread.has(id) ? "unread" : "read";
	if (kind === "message") return "message";
	if (typeof id !== "string") return undefined;
	return answered.has(id) ? "answered" : "awaiting";
}

/**
 * One status per file, in the order given. `unread` holds the ids claimed into
 * `cur/` that the conversation has not seen yet; a file still in `new/` is
 * unread without being in it. A file that cannot be read gets no status.
 */
export function mailStatus<T extends MailFile>(files: readonly T[], unread: ReadonlySet<string>): StatusFile<T>[] {
	const answered = new Set(files.flatMap(answers));
	return files.map((file) => ({ ...file, status: statusOf(file, answered, unread) }));
}
