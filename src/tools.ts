// The model-facing tools of `pi-session-mail`. Internal to the package: tests reach
// them only through the extension's registration function (`settle.ts` is the
// one module tested directly).
//
// `session_mail_list` reports every running Pi session on this machine, in
// every agent directory, and marks the calling one. `session_mail_send` leaves a plain
// message, which wakes or steers its recipient and expects no answer.
// `session_mail_ask` leaves an ask and waits, one at a time, for the answer,
// which comes back as its result rather than as a message.
// `session_mail_reply` answers an ask this session received, mid-run; the asks
// this session owes, and the kind of every envelope it has received, are kept
// here for it. Mail a
// tool sends carries the turn's hop count and is refused once the count
// reaches `hopLimit` from `<agent dir>/session-mail.json`.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { label, listRunning, type RunningRecord, resolveTo } from "./running.ts";
import { type Envelope, isAddress, send } from "./store.ts";

/** What the tools need from the extension around them. */
export type ToolHooks = {
	/** Called after a tool wrote mail, so the footer can count it. */
	sent: () => void;
	/** The current turn's hop count, which mail sent now carries. */
	hops: () => number;
	/** Report a broken `session-mail.json`; the extension shows one warning per session. */
	configProblem: (message: string) => void;
	/** The address this session's ask now waits on, or "" when it waits on none; written to its running record. */
	waitingOn: (address: string) => void;
};

/** What the extension needs from the tools: the ask that is waiting, and the asks owed. */
export type Tools = {
	/** Note a claimed envelope: its kind, and, for an ask, that its sender is owed an answer. */
	received: (envelope: Envelope) => void;
	/** The ask ids still owed an answer, by sender; they are no longer owed afterwards. */
	takeOwedAsks: () => Map<string, string[]>;
	/** Hand a reply to the waiting ask it answers; false when it answers none, so it is delivered as usual. */
	takeAnswer: (envelope: Envelope) => boolean;
	/** Stop waiting, as when the session shuts down. */
	abandonAsk: () => void;
};

/** How long an ask waits for its answer (spec Q13). */
const ASK_TIMEOUT_MS = 10 * 60 * 1000;
/** How often a waiting ask checks that its target still runs. */
const TARGET_CHECK_MS = 1000;

/** How a waiting ask ended. */
type AskOutcome =
	| { outcome: "answered"; status: string; body: string }
	| { outcome: "timed-out" }
	| { outcome: "stopped-running" }
	| { outcome: "stopped-by-user" };

type WaitingAsk = { id: string; to: string; finish: (outcome: AskOutcome) => void };

/** The ask tool's result text for an outcome. */
function askText(ask: Envelope, target: string, outcome: AskOutcome): string {
	const later = "A later answer arrives as a message.";
	switch (outcome.outcome) {
		case "answered":
			return outcome.status === "done"
				? `${target} answered your ask ${ask.id}:\n\n${outcome.body}`
				: `${target} ended its run with status "${outcome.status}", not "done": this is not an answer to your ask ${ask.id}.\n\n${outcome.body}`;
		case "timed-out":
			return `No answer yet: ${target} did not answer your ask ${ask.id} within 10 minutes, so this session stopped waiting. ${later}`;
		case "stopped-running":
			return `${target} stopped running before it answered your ask ${ask.id}, so this session stopped waiting. If it resumes and answers, the answer arrives as a message.`;
		case "stopped-by-user":
			return `The user stopped the wait for your ask ${ask.id} to ${target}. ${later}`;
	}
}

/** Why `session_mail_reply` refuses mail that is not an ask, by the kind of that mail. */
const NOT_AN_ASK: Record<Exclude<Envelope["kind"], "ask">, string> = {
	request: "A request is answered automatically when this run settles.",
	message: "A message expects no answer; session_mail_send sends one if it is wanted.",
	reply: "A reply is never answered.",
};

/** The hop limit when `session-mail.json` is missing or broken (spec Q14). */
const DEFAULT_HOP_LIMIT = 5;

/** What `session-mail.json` says about the hop limit, and the problem to report, if any. */
type HopConfig = { limit: number; problem?: string };

/**
 * The hop limit in the text of `session-mail.json`; `undefined` text is a
 * missing file. A file without `hopLimit` means the default; an invalid one
 * means the default and a problem report.
 */
function parseHopLimit(text: string | undefined, path: string): HopConfig {
	const fallback = (problem: string): HopConfig => ({ limit: DEFAULT_HOP_LIMIT, problem });
	if (text === undefined) return { limit: DEFAULT_HOP_LIMIT };
	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch (err) {
		return fallback(`${path} is not valid JSON (${(err as Error).message}); using the hop limit ${DEFAULT_HOP_LIMIT}`);
	}
	if (typeof config !== "object" || config === null || Array.isArray(config))
		return fallback(`${path} is not a JSON object; using the hop limit ${DEFAULT_HOP_LIMIT}`);
	const limit = (config as { hopLimit?: unknown }).hopLimit;
	if (limit === undefined) return { limit: DEFAULT_HOP_LIMIT };
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)
		return fallback(
			`hopLimit in ${path} must be a positive integer, not ${JSON.stringify(limit)}; using ${DEFAULT_HOP_LIMIT}`,
		);
	return { limit };
}

/** `hopLimit` from `<agent dir>/session-mail.json`, read at each send; problems go to `hooks`. */
function hopLimit(hooks: ToolHooks): number {
	const path = join(getAgentDir(), "session-mail.json");
	let text: string | undefined;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT")
			hooks.configProblem(
				`could not read ${path} (${(err as Error).message}); using the hop limit ${DEFAULT_HOP_LIMIT}`,
			);
		return DEFAULT_HOP_LIMIT;
	}
	const { limit, problem } = parseHopLimit(text, path);
	if (problem !== undefined) hooks.configProblem(problem);
	return limit;
}

/** Refuse, before anything is written, once the turn's hop count has reached the limit. */
function checkHops(hops: number, hooks: ToolHooks): void {
	const limit = hopLimit(hooks);
	if (hops < limit) return;
	throw new Error(
		`nothing was sent: this turn is ${hops} hops into a chain of sessions waking each other with nobody typing, and the hop limit of ${limit} is reached. A person typing in either session starts the count again.`,
	);
}

/** The one result every tool returns. */
function toolResult(text: string, details: unknown = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

/** One running session as the list shows it. */
function describe(record: RunningRecord, byAddress: ReadonlyMap<string, RunningRecord>, me: string): string {
	const waiting = record.waitingOn === "" ? "" : `, waiting on ${waitLabel(record.waitingOn, byAddress)}`;
	const self = record.address === me ? " (this session)" : "";
	return `- ${label(record)}${self}\n  id: ${record.address}\n  cwd: ${record.cwd}\n  state: ${record.state}${waiting}`;
}

function waitLabel(address: string, byAddress: ReadonlyMap<string, RunningRecord>): string {
	const target = byAddress.get(address);
	return target === undefined ? address : `${label(target)} (${address})`;
}

export function registerTools(pi: ExtensionAPI, hooks: ToolHooks): Tools {
	/** The one ask of this session that is waiting for its answer (spec Q20). */
	let waiting: WaitingAsk | undefined;
	/** The kind of each envelope this session has claimed, by id, so a reply can say why it is refused. */
	const receivedKinds = new Map<string, Envelope["kind"]>();
	/** Ask ids awaiting this session's answer, keyed by sender; answered apart from requests. */
	let owedAsks = new Map<string, string[]>();

	/** Answer the open ask `id` with `body` at once; throws, sending nothing, when it cannot. */
	function reply(me: string, id: string, body: string): Envelope {
		if (!isAddress(me)) throw new Error("this session has no mailbox address; nothing was sent");
		const kind = receivedKinds.get(id);
		if (kind === undefined)
			throw new Error(`no mail with id ${JSON.stringify(id)} reached this session; nothing was sent`);
		if (kind !== "ask") throw new Error(`${id} is a ${kind}, not an ask; nothing was sent. ${NOT_AN_ASK[kind]}`);
		const from = [...owedAsks].find(([, ids]) => ids.includes(id))?.[0];
		// An answered ask, by this tool or at settle, is no longer owed.
		if (from === undefined) throw new Error(`ask ${id} is already answered; nothing was sent`);
		// Answers carry the turn's count and are never refused by the hop limit.
		const answer = send(me, from, body, { kind: "reply", hops: hooks.hops(), inReplyTo: [id], status: "done" });
		const rest = (owedAsks.get(from) ?? []).filter((owedId) => owedId !== id);
		if (rest.length > 0) owedAsks.set(from, rest);
		else owedAsks.delete(from);
		return answer;
	}

	pi.registerTool({
		name: "session_mail_list",
		label: "Session mail: list",
		description:
			"List the Pi sessions running on this machine, in every agent root: each one's name (or short id when it has none), full id, working directory, idle or busy state, and whom it is waiting on. The calling session is marked. A session is addressed by its name, its full id, or an id prefix of at least 8 characters.",
		parameters: Type.Object({}),
		async execute(_toolCallId: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
			const me = ctx.sessionManager.getSessionId();
			const running = listRunning();
			if (running.length === 0) return toolResult("No Pi sessions are running with a mailbox.", { sessions: [] });
			const byAddress = new Map(running.map((record) => [record.address, record]));
			const lines = running.map((record) => describe(record, byAddress, me));
			const count = `${running.length} running session${running.length === 1 ? "" : "s"}:`;
			return toolResult([count, ...lines].join("\n"), {
				sessions: running.map((record) => ({ ...record, self: record.address === me })),
			});
		},
	});

	pi.registerTool({
		name: "session_mail_send",
		label: "Session mail: send",
		description:
			"Send a message to another Pi session on this machine. A running recipient that is idle starts a turn on it; a busy one reads it at its next gap between tool calls. The message expects no answer and nothing is sent back automatically; the recipient answers, if at all, with its own session_mail_send. `to` is a running session's name, an id prefix of at least 8 characters, or a full session id; a closed session is reached only by its full id, and the message waits in its inbox until it starts. session_mail_list shows who is running.",
		parameters: Type.Object({
			to: Type.String({
				description: "The recipient: a running session's name, an id prefix of 8+ characters, or a full session id.",
			}),
			message: Type.String({
				description: "The message text. The recipient sees it labelled as coming from this session.",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: { to: string; message: string },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const me = ctx.sessionManager.getSessionId();
			const body = typeof params.message === "string" ? params.message.trim() : "";
			if (body === "") throw new Error("the message is empty; nothing was sent");
			const to = resolveTo(typeof params.to === "string" ? params.to : "", me);
			const hops = hooks.hops();
			checkHops(hops, hooks);
			const envelope = send(me, to, body, { kind: "message", hops });
			hooks.sent();
			const target = listRunning().find((record) => record.address === to);
			const text =
				target === undefined
					? `Message ${envelope.id} left for ${to}, which is not running: it waits in that session's inbox and is delivered when the session starts or resumes.`
					: `Sent message ${envelope.id} to ${label(target)} (${to}). It expects no answer; any answer arrives as a message.`;
			return toolResult(text, { id: envelope.id, to, running: target !== undefined });
		},
	});

	pi.registerTool({
		name: "session_mail_ask",
		label: "Session mail: ask",
		description:
			"Ask another running Pi session on this machine a question and wait for its answer, which comes back as this tool's result. The answer is the other session's final message when its run settles, or an earlier reply it sends. The wait ends after 10 minutes, when the other session stops running, or when the user stops it; a later answer then arrives as a message. Only one ask waits at a time, and a session that is waiting on this one cannot be asked. `to` is a running session's name, an id prefix of at least 8 characters, or a full session id; session_mail_list shows who is running. For a note that needs no answer, use session_mail_send.",
		parameters: Type.Object({
			to: Type.String({
				description: "The running session to ask: its name, an id prefix of 8+ characters, or its full session id.",
			}),
			message: Type.String({
				description:
					"The question. The recipient sees it labelled as coming from this session, with this session waiting.",
			}),
		}),
		async execute(
			_toolCallId: string,
			params: { to: string; message: string },
			signal: AbortSignal | undefined,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const me = ctx.sessionManager.getSessionId();
			if (waiting !== undefined)
				throw new Error(
					`nothing was sent: your ask ${waiting.id} to ${waiting.to} is still waiting, and only one ask waits at a time`,
				);
			const body = typeof params.message === "string" ? params.message.trim() : "";
			if (body === "") throw new Error("the question is empty; nothing was sent");
			const to = resolveTo(typeof params.to === "string" ? params.to : "", me);
			const record = listRunning().find((r) => r.address === to);
			if (record === undefined)
				throw new Error(
					`nothing was sent: ${to} is not running, so it cannot answer; session_mail_send leaves a message that waits for it`,
				);
			const target = `${label(record)} (${to})`;
			if (record.waitingOn === me)
				throw new Error(
					`nothing was sent: ${target} is waiting on an answer from this session, so asking it back would leave both waiting; answer it first`,
				);
			const hops = hooks.hops();
			checkHops(hops, hooks);
			const ask = send(me, to, body, { kind: "ask", hops });
			hooks.sent();
			const outcome = await new Promise<AskOutcome>((resolve) => {
				const finish = (result: AskOutcome) => {
					if (waiting?.id !== ask.id) return;
					waiting = undefined;
					clearTimeout(timer);
					clearInterval(check);
					signal?.removeEventListener("abort", onAbort);
					hooks.waitingOn("");
					resolve(result);
				};
				const onAbort = () => finish({ outcome: "stopped-by-user" });
				const timer = setTimeout(() => finish({ outcome: "timed-out" }), ASK_TIMEOUT_MS);
				const check = setInterval(() => {
					if (!listRunning().some((r) => r.address === to)) finish({ outcome: "stopped-running" });
				}, TARGET_CHECK_MS);
				waiting = { id: ask.id, to, finish };
				hooks.waitingOn(to);
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
			return toolResult(askText(ask, target, outcome), { id: ask.id, to, ...outcome });
		},
	});

	pi.registerTool({
		name: "session_mail_reply",
		label: "Session mail: reply",
		description:
			"Answer an ask another Pi session sent this session, at once, without ending this run. The asker is waiting, and gets the message as the answer to its ask; the answer this run's last message would otherwise send is then skipped for that ask. `ask` is the ask id its label gives. Each ask is answered once; requests are answered automatically when the run settles, and messages expect no answer.",
		parameters: Type.Object({
			ask: Type.String({ description: "The ask id, as given in the ask's label." }),
			message: Type.String({ description: "The answer." }),
		}),
		async execute(
			_toolCallId: string,
			params: { ask: string; message: string },
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const me = ctx.sessionManager.getSessionId();
			const id = typeof params.ask === "string" ? params.ask.trim() : "";
			const body = typeof params.message === "string" ? params.message.trim() : "";
			if (body === "") throw new Error("the answer is empty; nothing was sent");
			const answer = reply(me, id, body);
			hooks.sent();
			const sender = listRunning().find((record) => record.address === answer.to);
			const who = sender === undefined ? answer.to : `${label(sender)} (${answer.to})`;
			return toolResult(`Answered ask ${id} from ${who}; this run's last message will not be sent for it.`, {
				id: answer.id,
				ask: id,
				to: answer.to,
			});
		},
	});

	return {
		received(envelope) {
			receivedKinds.set(envelope.id, envelope.kind);
			if (envelope.kind === "ask") owedAsks.set(envelope.from, [...(owedAsks.get(envelope.from) ?? []), envelope.id]);
		},
		takeOwedAsks() {
			const taken = owedAsks;
			owedAsks = new Map();
			return taken;
		},
		takeAnswer(envelope) {
			if (waiting === undefined || envelope.kind !== "reply" || !envelope.in_reply_to.includes(waiting.id))
				return false;
			waiting.finish({ outcome: "answered", status: envelope.status, body: envelope.body });
			return true;
		},
		abandonAsk() {
			waiting?.finish({ outcome: "stopped-by-user" });
		},
	};
}
