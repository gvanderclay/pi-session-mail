// What state each piece of a session's mail is in. Pure: it reads no files and
// no clock. The disk reader supplies the files and the command handler the
// in-memory unread set; `picker.ts` shows the statuses.
//
// Unread is what the footer counts: files still in `new/`, plus mail claimed
// into `cur/` that has not entered the conversation. Read is the rest of
// `cur/`. A sent request or ask is awaiting when no reply in `cur/` names it,
// and answered when one does. Sent messages expect no answer.

/** The boxes a session's mail lives in; `sent/` holds its outgoing copies. */
export type MailBox = "new" | "cur" | "sent";

/** What a status needs from an envelope. */
export type MailEnvelope = {
	id: string;
	kind: string;
	in_reply_to: readonly string[];
};

/** One file in the mailbox; `envelope` is absent when the file cannot be read. */
export type MailFile<E extends MailEnvelope = MailEnvelope> = {
	box: MailBox;
	envelope?: E;
};

/** What a piece of mail means to the person looking at it. */
export type Status = "unread" | "read" | "awaiting" | "answered" | "message";

/** One file with its status; a file that cannot be read has none. */
export type StatusFile<T extends MailFile> = T & { status?: Status };

/** The id a readable `cur/` envelope answers, if any. */
function answers(file: MailFile): readonly string[] {
	return file.box === "cur" && file.envelope !== undefined ? file.envelope.in_reply_to : [];
}

function statusOf(file: MailFile, answered: ReadonlySet<string>, unread: ReadonlySet<string>): Status | undefined {
	const envelope = file.envelope;
	if (envelope === undefined) return undefined;
	if (file.box === "new") return "unread";
	if (file.box === "cur") return unread.has(envelope.id) ? "unread" : "read";
	if (envelope.kind === "message") return "message";
	return answered.has(envelope.id) ? "answered" : "awaiting";
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
