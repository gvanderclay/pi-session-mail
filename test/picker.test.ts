// The `/mailbox` picker, driven the way a user drives it: `/mailbox` through the
// harness, keys through the custom component's `handleInput`, and assertions on
// what `render` shows and on the footer count. The picker reads this session's
// mail folders, so every test builds its own sessions and mail.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { deleteMail } from "../src/store.ts";
import { box, envelopes, files, newId, session, until } from "./harness.ts";

type Session = ReturnType<typeof session>;

/** A running peer, a peer that closes, and this session with one item in every status the picker shows. */
async function mailInEveryState() {
	const me = session(newId(), { name: "me" });
	const open = session(newId(), { name: "open" });
	const gone = session(newId(), { name: "gone" });
	await Promise.all([me.start(), open.start(), gone.start()]);
	// A read message: delivered while `me` is listening, so it enters the conversation.
	await open.toolCall("session_mail_send", { to: me.id, message: "seen before" });
	await until(() => me.sent.some((sent) => sent.message.content.includes("seen before")), "the read message");
	// An unread message: held back from the conversation, so the footer counts it.
	me.drop(true);
	await open.toolCall("session_mail_send", { to: me.id, message: "fresh mail" });
	await until(() => me.status() === "📬 1 unread", "the footer to count the unread message");
	// An answered request: `open` answers it at settle, and the reply arrives read.
	me.request(open.id, "answered request");
	await until(() => open.sent.length === 1, "the answered request to arrive");
	await open.answer("the answer");
	await until(() => me.sent.length === 2, "the answer to arrive");
	// An awaiting request to a session still running, one to a session that then closes.
	me.request(open.id, "running request");
	await until(() => open.sent.length === 2, "the running request to arrive");
	me.request(gone.id, "closed request");
	await until(() => gone.sent.length === 1, "the closed request to arrive");
	await gone.shutdown();
	// A sent message, which expects no answer.
	await me.toolCall("session_mail_send", { to: open.id, message: "sent message" });
	return { me, open, gone };
}

/** Open the picker as bare `/mailbox` does; the returned command resolves when the picker closes. */
async function openPicker(s: Session): Promise<{ dialog: Session["dialogs"][number]; closed: Promise<void> }> {
	const count = s.dialogs.length;
	const closed = s.mailbox("");
	await until(() => s.dialogs.length > count, "the picker to open");
	return { dialog: s.dialogs[count], closed };
}

const render = (dialog: Session["dialogs"][number], width = 100): string => dialog.component.render(width).join("\n");

/** The rendered line showing `text`, so an assertion can say what a row contains. */
const shown = (dialog: Session["dialogs"][number], text: string, width = 100): string => {
	const line = dialog.component.render(width).find((candidate) => candidate.includes(text));
	assert.ok(line, `no rendered row shows ${JSON.stringify(text)}`);
	return line;
};

/** A message `from` sends to `me` while `me` listens, so it arrives read. */
async function readMessage(me: Session, from: Session, text: string) {
	const before = me.sent.length;
	await from.toolCall("session_mail_send", { to: me.id, message: text });
	await until(() => me.sent.length > before, `the read message ${text}`);
}

/** The picker the handler reopened after a confirm; the open command stays pending through its loop. */
async function reopened(s: Session, before: number): Promise<Session["dialogs"][number]> {
	await until(() => s.dialogs.length > before, "the picker to reopen");
	return s.dialogs[before];
}

/** Press `d` on `dialog`, answer its confirm with `yes`, and return the picker it reopened. */
async function deleteSelected(
	s: Session,
	dialog: Session["dialogs"][number],
	yes: boolean,
): Promise<Session["dialogs"][number]> {
	const before = s.dialogs.length;
	s.answers.confirm.push(yes);
	await dialog.press("d");
	return reopened(s, before);
}

test("s cycles five filters, each showing its own rows and statuses, newest first", async () => {
	const { me, open, gone } = await mailInEveryState();
	const { dialog, closed } = await openPicker(me);
	const title = (filter: string) => `Mailbox · me · ${me.id.slice(0, 8)} · ${filter}`;
	try {
		assert.ok(render(dialog).includes(title("unread")), "opens on unread: it is the filter with mail");
		assert.ok(render(dialog).includes("fresh mail"));
		assert.ok(!render(dialog).includes("seen before"));

		await dialog.press("s");
		assert.ok(render(dialog).includes(title("awaiting")));
		assert.ok(render(dialog).includes("running request"));
		assert.ok(render(dialog).includes("closed request"));
		assert.ok(render(dialog).includes("· running"));
		assert.ok(render(dialog).includes("· closed"));
		assert.ok(!render(dialog).includes("sent message"));
		assert.match(shown(dialog, "running request", 40), /running/, "the marker survives width 40");
		assert.match(shown(dialog, "closed request", 40), /closed/, "the marker survives width 40");

		await dialog.press("s");
		assert.ok(render(dialog).includes(title("read")));
		assert.ok(render(dialog).includes("seen before"));
		assert.ok(render(dialog).includes("the answer"));
		assert.ok(!render(dialog).includes("fresh mail"));

		await dialog.press("s");
		assert.ok(render(dialog).includes(title("sent")));
		for (const status of ["awaiting", "answered", "message"]) assert.ok(render(dialog).includes(`· ${status}`));
		assert.ok(render(dialog).includes("· awaiting · running"));
		assert.ok(render(dialog).includes("· awaiting · closed"));
		assert.ok(!render(dialog).includes("fresh mail"));
		assert.match(shown(dialog, "running request", 40), /awaiting.*running/, "status survives width 40");
		assert.match(shown(dialog, "answered request", 40), /answered/, "status survives width 40");
		assert.match(shown(dialog, "sent message", 40), /message/, "status survives width 40");

		await dialog.press("s");
		assert.ok(render(dialog).includes(title("all")));
		for (const label of [
			"seen before",
			"fresh mail",
			"the answer",
			"answered request",
			"running request",
			"closed request",
			"sent message",
		])
			assert.ok(render(dialog).includes(label), label);
		// An awaiting request appears in all once, not twice for being sent and awaiting.
		assert.equal(render(dialog).split("running request").length - 1, 1);
		// Newest first: the sent message came last, the read message first.
		assert.ok(render(dialog).indexOf("sent message") < render(dialog).indexOf("seen before"));
		// Every row carries its other party, kind, relative time and status, all once.
		const time = "(now|\\d+[mhdw] ago)";
		assert.match(shown(dialog, "seen before"), new RegExp(`from open · message · ${time} · read`));
		assert.match(shown(dialog, "fresh mail"), new RegExp(`from open · message · ${time} · unread`));
		assert.match(shown(dialog, "the answer"), new RegExp(`from open · reply · ${time} · read`));
		assert.match(shown(dialog, "answered request"), new RegExp(`to open · request · ${time} · answered`));
		assert.match(shown(dialog, "running request"), new RegExp(`to open · request · ${time} · awaiting · running`));
		assert.match(
			shown(dialog, "closed request"),
			new RegExp(`to ${gone.id.slice(0, 8)} · request · ${time} · awaiting · closed`),
		);
		assert.match(shown(dialog, "sent message"), new RegExp(`to open · message · ${time} · message`));
		// The same required statuses and markers stay in the label at width 40, where descriptions go.
		assert.match(shown(dialog, "seen before", 40), /read/);
		assert.match(shown(dialog, "fresh mail", 40), /unread/);
		assert.match(shown(dialog, "the answer", 40), /read/);
		assert.match(shown(dialog, "answered request", 40), /answered/);
		assert.match(shown(dialog, "running request", 40), /awaiting.*running/);
		assert.match(shown(dialog, "closed request", 40), /awaiting.*closed/);
		assert.match(shown(dialog, "sent message", 40), /message/);

		await dialog.press("s");
		assert.ok(render(dialog).includes(title("unread")));
	} finally {
		await dialog.press("\x1b");
		await closed;
		await Promise.all([me.shutdown(), open.shutdown(), gone.shutdown()]);
	}
});

test("the unread view is exactly what the footer counts, and opening it marks nothing read", async () => {
	const { me, open, gone } = await mailInEveryState();
	const { dialog, closed } = await openPicker(me);
	try {
		assert.equal(me.status(), "📬 1 unread");
		assert.equal(render(dialog).split("fresh mail").length - 1, 1);
		assert.ok(!render(dialog).includes("seen before"));
	} finally {
		await dialog.press("\x1b");
		await closed;
		assert.equal(me.status(), "📬 1 unread");
		await Promise.all([me.shutdown(), open.shutdown(), gone.shutdown()]);
	}
});

test("Enter opens the detail screen, and Esc returns to the same row and filter", async () => {
	const me = session(newId(), { name: "me" });
	const peer = session(newId(), { name: "peer" });
	await Promise.all([me.start(), peer.start()]);
	me.request(peer.id, "the question");
	await until(() => peer.sent.length === 1, "the request to arrive");
	await peer.answer("the answer");
	await until(() => me.sent.length === 1, "the reply to arrive");
	const [request] = envelopes(me.id, "sent");
	const [reply] = envelopes(me.id, "cur");
	const { dialog, closed } = await openPicker(me);
	try {
		assert.ok(render(dialog).includes(`Mailbox · me · ${me.id.slice(0, 8)} · all`), "opens on all");
		assert.ok(shown(dialog, "the answer"), "the newest item is listed");

		await dialog.press("\r");
		const replyDetail = render(dialog);
		assert.ok(replyDetail.includes(`From peer <${peer.id}>`), replyDetail);
		assert.ok(replyDetail.includes("Kind reply"));
		assert.ok(replyDetail.includes(`Id ${reply.id}`));
		assert.ok(replyDetail.includes(`Sent ${new Date(reply.ts).toLocaleString()}`));
		assert.ok(replyDetail.includes(`In reply to ${request.id}`));
		assert.ok(replyDetail.includes("the answer"));
		assert.ok(replyDetail.includes("esc back"));
		await dialog.press("\x1b");

		// Move to the request, open it, go back, and open it again: the same row is still selected.
		await dialog.press("\x1b[B");
		await dialog.press("\r");
		const detail = render(dialog);
		assert.ok(detail.includes(`To peer <${peer.id}>`), detail);
		assert.ok(detail.includes("Kind request"));
		assert.ok(detail.includes(`Id ${request.id}`));
		assert.ok(detail.includes(`Sent ${new Date(request.ts).toLocaleString()}`));
		assert.ok(detail.includes("the question"));
		assert.ok(detail.includes("esc back"));

		await dialog.press("\x1b");
		assert.ok(render(dialog).includes("· all"), "the filter is unchanged");
		assert.ok(shown(dialog, "the question"), "the selected row is still listed");
		await dialog.press("\r");
		assert.ok(render(dialog).includes(`Id ${request.id}`), "Enter after Esc opens the same row's detail");
		await dialog.press("\x1b");
	} finally {
		await dialog.press("\x1b");
		await closed;
		await Promise.all([me.shutdown(), peer.shutdown()]);
	}
});

test("an empty filter says there is nothing there, and s and esc still work", async () => {
	const me = session(newId());
	const { dialog, closed } = await openPicker(me);
	try {
		assert.ok(render(dialog).includes("No mail"), "opens on all when nothing is unread");
		for (const [empty, filter] of [
			["No unread mail", "unread"],
			["Nothing is waiting for a reply", "awaiting"],
			["No read mail", "read"],
			["Nothing sent", "sent"],
			["No mail", "all"],
		]) {
			await dialog.press("s");
			assert.ok(render(dialog).includes(empty), filter);
			assert.ok(render(dialog).includes(`· ${filter}`), filter);
		}
	} finally {
		await dialog.press("\x1b");
		await closed;
		await me.shutdown();
	}
});

test("a control sequence in a body never reaches the list or the detail screen", async () => {
	const me = session(newId(), { name: "me" });
	const peer = session(newId(), { name: "peer" });
	await Promise.all([me.start(), peer.start()]);
	me.drop(true);
	await peer.toolCall("session_mail_send", {
		to: me.id,
		message: "\x1b]0;owned\x07\x1b[31mred alert\x1b[0m\nsecond line",
	});
	await until(() => me.status() === "📬 1 unread", "the message to arrive");
	const { dialog, closed } = await openPicker(me);
	try {
		const list = render(dialog);
		assert.ok(!list.includes("\x1b"), JSON.stringify(list));
		assert.ok(list.includes("red alert"), list);
		await dialog.press("\r");
		const detail = render(dialog);
		assert.ok(!detail.includes("\x1b"), JSON.stringify(detail));
		assert.ok(detail.includes("red alert"), detail);
		assert.ok(detail.includes("second line"), detail);
	} finally {
		await dialog.press("\x1b");
		await dialog.press("\x1b");
		await closed;
		await Promise.all([me.shutdown(), peer.shutdown()]);
	}
});

test("a control sequence in this session's name never reaches the title", async () => {
	const me = session(newId(), { name: "bad\x1b]0;owned\x07\x1b[31mname\x1b[0m" });
	await me.start();
	const { dialog, closed } = await openPicker(me);
	try {
		const title = shown(dialog, "Mailbox ·");
		assert.ok(!title.includes("\x1b"), JSON.stringify(title));
		assert.ok(title.includes("badname"), title);
	} finally {
		await dialog.press("\x1b");
		await closed;
		await me.shutdown();
	}
});

test("damaged mail notifies and leaves the readable mail in the picker", async () => {
	const me = session(newId(), { name: "me" });
	const peer = session(newId(), { name: "peer" });
	await Promise.all([me.start(), peer.start()]);
	me.request(peer.id, "still readable");
	await until(() => peer.sent.length === 1, "the request to arrive");
	const [request] = envelopes(me.id, "sent");
	mkdirSync(box(me.id, "cur"), { recursive: true, mode: 0o700 });
	writeFileSync(join(box(me.id, "cur"), "000000000000001-bad.json"), "{ not json");
	writeFileSync(
		join(box(me.id, "sent"), "000000000000999-missing-ts.json"),
		JSON.stringify({ ...request, id: "missing-ts", ts: undefined }),
	);
	const { dialog, closed } = await openPicker(me);
	try {
		assert.ok(me.warnings.includes("mailbox: 2 files could not be read"), JSON.stringify(me.warnings));
		assert.ok(render(dialog).includes("still readable"), "the readable mail is still shown");
	} finally {
		await dialog.press("\x1b");
		await closed;
		await Promise.all([me.shutdown(), peer.shutdown()]);
	}
});

test("peer labels and running state are a snapshot taken before the picker opens", async () => {
	const me = session(newId(), { name: "me" });
	const peer = session(newId(), { name: "peer" });
	await Promise.all([me.start(), peer.start()]);
	me.request(peer.id, "snapshot request");
	await until(() => peer.sent.length === 1, "the request to arrive");
	const { dialog, closed } = await openPicker(me);
	let stopped = false;
	try {
		assert.match(shown(dialog, "snapshot request", 40), /running/);
		await peer.shutdown();
		stopped = true;
		await dialog.press("s");
		await dialog.press("s");
		assert.match(shown(dialog, "snapshot request", 40), /running/, "the open picker keeps its snapshot");
	} finally {
		await dialog.press("\x1b");
		await closed;
		await me.shutdown();
		if (!stopped) await peer.shutdown();
	}
});

// --- Deleting and dropping ---

test("d deletes a read message after a confirm, and the next row is selected", async () => {
	const me = session(newId(), { name: "me" });
	const peer = session(newId(), { name: "peer" });
	await Promise.all([me.start(), peer.start()]);
	await readMessage(me, peer, "first");
	await readMessage(me, peer, "second");
	await readMessage(me, peer, "third");
	const idOf = (text: string) => envelopes(me.id, "cur").find((envelope) => envelope.body === text)?.id;
	const { dialog, closed } = await openPicker(me);
	let open = dialog;
	try {
		assert.ok(render(dialog).includes("· all"), "no unread mail, so the picker opens on all");
		open = await deleteSelected(me, dialog, true);
		assert.deepEqual(
			me.confirms.map((confirm) => confirm.message),
			["third"],
			"the confirmation shows the selected item's first line",
		);
		assert.deepEqual(
			envelopes(me.id, "cur").map((envelope) => envelope.body),
			["first", "second"],
			"only the deleted file is gone",
		);
		await open.press("\r");
		assert.ok(render(open).includes(`Id ${idOf("second")}`), "the row that took the deleted one's place is selected");
		await open.press("\x1b");
	} finally {
		await open.press("\x1b");
		await closed;
		await Promise.all([me.shutdown(), peer.shutdown()]);
	}
});

test("deleting the last row caps the selection at the new last row", async () => {
	const me = session(newId(), { name: "me" });
	const peer = session(newId(), { name: "peer" });
	await Promise.all([me.start(), peer.start()]);
	await readMessage(me, peer, "first");
	await readMessage(me, peer, "second");
	await readMessage(me, peer, "third");
	const idOf = (text: string) => envelopes(me.id, "cur").find((envelope) => envelope.body === text)?.id;
	const { dialog, closed } = await openPicker(me);
	let open = dialog;
	try {
		await open.press("\x1b[B");
		await open.press("\x1b[B");
		open = await deleteSelected(me, open, true);
		assert.deepEqual(
			me.confirms.map((confirm) => confirm.message),
			["first"],
			"the last row was selected",
		);
		assert.deepEqual(
			envelopes(me.id, "cur").map((envelope) => envelope.body),
			["second", "third"],
		);
		await open.press("\r");
		assert.ok(render(open).includes(`Id ${idOf("second")}`), "the selection caps at the new last row");
		await open.press("\x1b");
	} finally {
		await open.press("\x1b");
		await closed;
		await Promise.all([me.shutdown(), peer.shutdown()]);
	}
});

test("a cancelled delete keeps the same row selected even after new mail arrives", async () => {
	const me = session(newId(), { name: "me" });
	const peer = session(newId(), { name: "peer" });
	await Promise.all([me.start(), peer.start()]);
	await readMessage(me, peer, "first");
	await readMessage(me, peer, "second");
	await readMessage(me, peer, "third");
	const idOf = (text: string) => envelopes(me.id, "cur").find((envelope) => envelope.body === text)?.id;
	const { dialog, closed } = await openPicker(me);
	let open = dialog;
	try {
		await open.press("\x1b[B");
		// Mail that arrives after the list was taken moves every row down one.
		me.drop(true);
		await peer.toolCall("session_mail_send", { to: me.id, message: "arrived later" });
		await until(() => me.status() === "📬 1 unread", "the new mail to arrive");
		open = await deleteSelected(me, open, false);
		assert.deepEqual(
			me.confirms.map((confirm) => confirm.message),
			["second"],
			"the second row was selected",
		);
		assert.ok(render(open).includes("arrived later"), "the reopened list has the new mail");
		await open.press("\r");
		assert.ok(render(open).includes(`Id ${idOf("second")}`), "the cancelled item is still selected");
		await open.press("\x1b");
	} finally {
		await open.press("\x1b");
		await closed;
		await Promise.all([me.shutdown(), peer.shutdown()]);
	}
});

test("d does nothing on unread mail and the hint stops offering it", async () => {
	const me = session(newId(), { name: "me" });
	const peer = session(newId(), { name: "peer" });
	await Promise.all([me.start(), peer.start()]);
	await readMessage(me, peer, "read already");
	me.drop(true);
	await peer.toolCall("session_mail_send", { to: me.id, message: "not read yet" });
	await until(() => me.status() === "📬 1 unread", "the unread message");
	const hint = (dialog: Session["dialogs"][number]): string =>
		dialog.component.render(100).find((line) => line.includes("s filter")) ?? "";
	const { dialog, closed } = await openPicker(me);
	try {
		assert.ok(render(dialog).includes("· unread"));
		assert.ok(!hint(dialog).includes("d delete"), "the unread row is not offered d");
		await dialog.press("d");
		assert.equal(me.confirms.length, 0, "no confirmation was asked");
		assert.equal(dialog.result(), undefined, "the picker did not resolve");
		assert.equal(me.status(), "📬 1 unread", "the mail is still on disk");
		// The all view mixes statuses, so the hint follows the selected row, not the filter.
		for (let i = 0; i < 4; i++) await dialog.press("s");
		assert.ok(render(dialog).includes("· all"));
		assert.ok(!hint(dialog).includes("d delete"), "the unread row is selected first");
		await dialog.press("\x1b[B");
		assert.ok(hint(dialog).includes("d delete"), "the read row is offered d");
		await dialog.press("\x1b[A");
		assert.ok(!hint(dialog).includes("d delete"), "back on the unread row");
	} finally {
		await dialog.press("\x1b");
		await closed;
		await Promise.all([me.shutdown(), peer.shutdown()]);
	}
});

test("d drops an awaiting request after a confirm", async () => {
	const me = session(newId(), { name: "me" });
	const peer = session(newId(), { name: "peer" });
	await Promise.all([me.start(), peer.start()]);
	me.request(peer.id, "never answered");
	await until(() => peer.sent.length === 1, "the request to arrive");
	const { dialog, closed } = await openPicker(me);
	let open = dialog;
	try {
		assert.ok(render(dialog).includes("· all"), "nothing is unread, so the picker opens on all");
		assert.match(shown(dialog, "never answered"), /awaiting/);
		open = await deleteSelected(me, dialog, true);
		assert.deepEqual(
			me.confirms.map((confirm) => confirm.message),
			["never answered"],
		);
		assert.deepEqual(envelopes(me.id, "sent"), [], "the sent copy is gone");
		for (let i = 0; i < 2; i++) await open.press("s");
		assert.ok(render(open).includes("Nothing is waiting for a reply"), render(open));
	} finally {
		await open.press("\x1b");
		await closed;
		await Promise.all([me.shutdown(), peer.shutdown()]);
	}
});

test("deleting a read reply also deletes the sent copy of the request it answered", async () => {
	const me = session(newId(), { name: "me" });
	const peer = session(newId(), { name: "peer" });
	await Promise.all([me.start(), peer.start()]);
	me.request(peer.id, "the question");
	await until(() => peer.sent.length === 1, "the request to arrive");
	await peer.answer("the answer");
	await until(() => me.sent.length === 1, "the reply to arrive");
	assert.equal(envelopes(me.id, "sent").length, 1);
	const { dialog, closed } = await openPicker(me);
	let open = dialog;
	try {
		assert.match(shown(dialog, "the answer"), /read/);
		open = await deleteSelected(me, dialog, true);
		assert.deepEqual(
			me.confirms.map((confirm) => confirm.message),
			["the answer"],
		);
		assert.deepEqual(envelopes(me.id, "cur"), [], "the reply is gone");
		assert.deepEqual(envelopes(me.id, "sent"), [], "the answered request's copy went with it");
		for (let i = 0; i < 2; i++) await open.press("s");
		assert.ok(render(open).includes("Nothing is waiting for a reply"), render(open));
	} finally {
		await open.press("\x1b");
		await closed;
		await Promise.all([me.shutdown(), peer.shutdown()]);
	}
});

test("d deletes a sent message and an answered request", async () => {
	const me = session(newId(), { name: "me" });
	const peer = session(newId(), { name: "peer" });
	await Promise.all([me.start(), peer.start()]);
	await me.toolCall("session_mail_send", { to: peer.id, message: "a message" });
	me.request(peer.id, "the request");
	await until(() => peer.sent.length === 2, "the request to arrive");
	await peer.answer("the answer");
	await until(() => me.sent.length === 1, "the reply to arrive");
	assert.equal(envelopes(me.id, "sent").length, 2, "sent/ holds the message and the request");
	const { dialog, closed } = await openPicker(me);
	let open = dialog;
	try {
		for (let i = 0; i < 4; i++) await open.press("s");
		assert.ok(render(open).includes("· sent"));
		assert.match(shown(open, "the request"), /answered/);
		assert.match(shown(open, "a message"), /message/);
		open = await deleteSelected(me, open, true);
		assert.deepEqual(
			me.confirms.map((confirm) => confirm.message),
			["the request"],
		);
		assert.deepEqual(
			envelopes(me.id, "sent").map((envelope) => envelope.body),
			["a message"],
		);
		assert.equal(envelopes(me.id, "cur").length, 1, "the reply that answered it stays");
		open = await deleteSelected(me, open, true);
		assert.deepEqual(
			me.confirms.map((confirm) => confirm.message),
			["the request", "a message"],
		);
		assert.deepEqual(envelopes(me.id, "sent"), []);
		assert.ok(render(open).includes("Nothing sent"), render(open));
	} finally {
		await open.press("\x1b");
		await closed;
		await Promise.all([me.shutdown(), peer.shutdown()]);
	}
});

test("a reply to a dropped request is still delivered, quoting the id alone", async () => {
	const me = session(newId(), { name: "me" });
	const peer = session(newId(), { name: "peer" });
	await Promise.all([me.start(), peer.start()]);
	me.request(peer.id, "drop me");
	await until(() => peer.sent.length === 1, "the request to arrive");
	const [request] = envelopes(me.id, "sent");
	const { dialog, closed } = await openPicker(me);
	let open = dialog;
	try {
		for (let i = 0; i < 2; i++) await open.press("s");
		assert.ok(render(open).includes("· awaiting"));
		assert.ok(render(open).includes("drop me"));
		open = await deleteSelected(me, open, true);
		assert.deepEqual(envelopes(me.id, "sent"), [], "the sent copy is gone");
		// The peer still owes the request, and its answer comes back after the copy is gone.
		await peer.answer("after the drop");
		await until(() => me.sent.some((sent) => sent.message.content.includes("after the drop")), "the late reply");
		const text = me.sent.find((sent) => sent.message.content.includes("after the drop"))?.message.content ?? "";
		assert.ok(text.includes(`Your request ${request.id} has no copy in sent/; only its id is known.`), text);
	} finally {
		await open.press("\x1b");
		await closed;
		await Promise.all([me.shutdown(), peer.shutdown()]);
	}
});

test("a symlinked cur/ pointing at another session's new/ deletes nothing there and notifies", async () => {
	const me = session(newId(), { name: "me" });
	const other = newId();
	await me.start();
	// Another session's unread folder, wearing this session's cur/ as a link to it.
	mkdirSync(box(other, "new"), { recursive: true, mode: 0o700 });
	const foreign = join(box(other, "new"), "000000000000001-foreign.json");
	writeFileSync(
		foreign,
		JSON.stringify({
			id: "foreign",
			from: other,
			to: other,
			kind: "message",
			hops: 0,
			in_reply_to: [],
			status: "",
			ts: new Date().toISOString(),
			body: "not yours",
		}),
	);
	rmSync(box(me.id, "cur"), { recursive: true });
	symlinkSync(box(other, "new"), box(me.id, "cur"));
	const { dialog, closed } = await openPicker(me);
	let open = dialog;
	try {
		assert.ok(render(dialog).includes("not yours"), "cur/ is listed through the link, as before the fix");
		open = await deleteSelected(me, open, true);
		assert.equal(me.confirms.length, 1, "the delete was confirmed");
		assert.ok(existsSync(foreign), "the other folder's mail is still there");
		assert.equal(files(other, "new").length, 1);
		assert.match(me.errors.join("\n"), /not a real directory/);
	} finally {
		await open.press("\x1b");
		await closed;
		await me.shutdown();
	}
});

test("an unreadable sent/ keeps a reply and its request copy and notifies", {
	skip: process.getuid?.() === 0,
}, async () => {
	const me = session(newId(), { name: "me" });
	const peer = session(newId(), { name: "peer" });
	await Promise.all([me.start(), peer.start()]);
	me.request(peer.id, "the question");
	await until(() => peer.sent.length === 1, "the request to arrive");
	await peer.answer("the answer");
	await until(() => me.sent.length === 1, "the reply to arrive");
	const sentBox = box(me.id, "sent");
	const { dialog, closed } = await openPicker(me);
	let open = dialog;
	try {
		assert.match(shown(dialog, "the answer"), /read/);
		// sent/ goes unreadable while the confirmation is up.
		chmodSync(sentBox, 0o000);
		open = await deleteSelected(me, open, true);
		assert.deepEqual(
			envelopes(me.id, "cur").map((envelope) => envelope.body),
			["the answer"],
			"the reply stays",
		);
		assert.match(me.errors.join("\n"), /EACCES/);
	} finally {
		chmodSync(sentBox, 0o700);
		await open.press("\x1b");
		await closed;
	}
	assert.deepEqual(
		envelopes(me.id, "sent").map((envelope) => envelope.body),
		["the question"],
		"the request copy stays, so it is still answered rather than awaiting",
	);
	await Promise.all([me.shutdown(), peer.shutdown()]);
});

// The picker refuses `d` on unread mail, so the store's guard is called directly:
// it is the acceptance test that a file in `new/` is refused and left in place.
test("the delete function refuses a file in new/ and leaves it in place", () => {
	const address = newId();
	mkdirSync(box(address, "new"), { recursive: true, mode: 0o700 });
	const path = join(box(address, "new"), "000000000000001-waiting.json");
	writeFileSync(
		path,
		JSON.stringify({
			id: "waiting",
			from: "peer",
			to: address,
			kind: "message",
			hops: 0,
			in_reply_to: [],
			status: "",
			ts: new Date().toISOString(),
			body: "unread",
		}),
	);
	assert.throws(() => deleteMail(address, path), /outside cur\/ or sent\//);
	assert.ok(existsSync(path), "the refused file is still there");
	assert.equal(files(address, "new").length, 1);
});
