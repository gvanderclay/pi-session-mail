// The `/mailbox` picker, driven the way a user drives it: `/mailbox` through the
// harness, keys through the custom component's `handleInput`, and assertions on
// what `render` shows and on the footer count. The picker reads this session's
// mail folders, so every test builds its own sessions and mail.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { box, envelopes, newId, session, until } from "./harness.ts";

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
