// The model-facing tools of `pi-session-mail`. Internal to the package: tests reach
// them only through the extension's registration function (`settle.ts` is the
// one module tested directly).
//
// `session_mail_list` reports every running Pi session on this machine, in
// every agent directory, and marks the calling one. `session_mail_send` leaves a plain
// message, which wakes or steers its recipient and expects no answer.
// `session_mail_ask` leaves an ask. In a session a person is watching it
// returns at once and the answer arrives as a message; elsewhere it waits, one
// at a time, for the answer, which comes back as its result. An unattended
// session must wait because ending its turn ends its work: print mode exits,
// and an unattended TUI has no person to read a late answer.
// `session_mail_reply` answers an ask this session received, mid-run; the asks
// this session owes, and the kind of every envelope it has received, are kept
// here for it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { DEFAULT_PRUNE_AFTER_DAYS, parseConfig } from "./config.ts";
import { label, listRunning, type RunningRecord, resolveTo } from "./running.ts";
import { type Envelope, send } from "./store.ts";

/** What the tools need from the extension around them. */
export type ToolHooks = {
	/** The address this session's ask now waits on, or "" when it waits on none; written to its running record. */
	waitingOn: (address: string) => void;
};

/** What the extension needs from the tools: the ask that is waiting, and the asks owed. */
export type Tools = {
	/** Remember the kind of a claimed envelope, so a refused reply can say why; never forgotten. */
	recordKind: (envelope: Envelope) => void;
	/** Arm an answer for an ask: its sender is owed one. Any other kind is ignored. */
	armAsk: (envelope: Envelope) => void;
	/** The session's mailbox address, or undefined when it has none (before a valid start, after shutdown); owed asks are dropped. */
	setAddress: (address: string | undefined) => void;
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

/** Whether a person is watching this session, so an ask need not hold its turn; `PI_UNATTENDED=1` marks a TUI nobody watches. */
function attended(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui" && process.env.PI_UNATTENDED !== "1";
}

/** How an ask's tool call ended: at once in the background, or how its wait ended. */
type AskOutcome =
	| { outcome: "background" }
	| { outcome: "answered"; status: string; body: string }
	| { outcome: "timed-out" }
	| { outcome: "stopped-running" }
	| { outcome: "stopped-by-user" };

type WaitingAsk = { id: string; to: string; finish: (outcome: AskOutcome) => void };

/** The ask tool's result text for an outcome. */
function askText(ask: Envelope, target: string, outcome: AskOutcome): string {
	const later = "A later answer arrives as a message.";
	switch (outcome.outcome) {
		case "background":
			return `Sent ask ${ask.id} to ${target}. This session is not waiting: the answer arrives as a message and starts a turn on its own, so go on with other work or end your turn.`;
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
	request: "A request is answered by the extension that consumes it, not by this tool.",
	message: "A message expects no answer; session_mail_send sends one if it is wanted.",
	reply: "A reply is never answered.",
};

/**
 * The settings from `<agent dir>/session-mail.json`, read at each call; each
 * problem goes to `onProblem`, which the extension shows once per session.
 */
export function readSettings(onProblem: (message: string) => void): { pruneAfterDays: number } {
	const path = join(getAgentDir(), "session-mail.json");
	let text: string | undefined;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT")
			onProblem(
				`could not read ${path} (${(err as Error).message}); using the default, pruning after ${DEFAULT_PRUNE_AFTER_DAYS} days`,
			);
		text = undefined;
	}
	const { problems, ...settings } = parseConfig(text, path);
	for (const problem of problems) onProblem(problem);
	return settings;
}

/**
 * The one result every tool returns. `structuredContent` is what codemode scripts
 * receive; it must match the tool's `outputSchema`, which Pi does not check.
 */
function toolResult<D, S>(text: string, details: D, structuredContent: S) {
	return { content: [{ type: "text" as const, text }], details, structuredContent };
}

/** Hints for a tool that adds mail and never deletes or overwrites any, on this machine only. */
const SENDS_MAIL = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const SessionList = Type.Object({
	sessions: Type.Array(
		Type.Object({
			id: Type.String({ description: "Full session id; usable as `to`" }),
			name: Type.Optional(Type.String()),
			cwd: Type.String(),
			state: Type.Union([Type.Literal("idle"), Type.Literal("busy")]),
			waitingOn: Type.Optional(
				Type.String({ description: "Full session id this session's ask waits on; absent if none" }),
			),
			self: Type.Boolean({ description: "True for the caller" }),
		}),
	),
});

const SendResult = Type.Object({
	id: Type.String({ description: "Message id" }),
	to: Type.String({ description: "Recipient's full session id" }),
	running: Type.Boolean({ description: "False if queued in a closed session's inbox" }),
});

const asked = {
	id: Type.String({ description: "Ask id" }),
	to: Type.String({ description: "Asked session's full id" }),
};

const AskResult = Type.Intersect([
	Type.Object(asked),
	Type.Union([
		Type.Object({
			outcome: Type.Literal("answered"),
			status: Type.String({
				description: '"done" means an answer; otherwise the run ended without an answer and body is not one',
			}),
			body: Type.String(),
		}),
		Type.Object({
			outcome: Type.Union([
				Type.Literal("timed-out"),
				Type.Literal("stopped-running"),
				Type.Literal("stopped-by-user"),
				Type.Literal("background"),
			]),
		}),
	]),
]);

const ReplyResult = Type.Object({
	id: Type.String({ description: "Reply id" }),
	ask: Type.String({ description: "Answered ask id" }),
	to: Type.String({ description: "Asker's full session id" }),
});

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
	/** Ask ids awaiting this session's answer, keyed by sender. */
	let owedAsks = new Map<string, string[]>();
	/** This session's address as the extension last set it; undefined when it has none. */
	let address: string | undefined;

	/** Answer the open ask `id` with `body` at once; throws, sending nothing, when it cannot. */
	function reply(id: string, body: string): Envelope {
		const me = address;
		if (me === undefined) throw new Error("this session has no mailbox address; nothing was sent");
		const kind = receivedKinds.get(id);
		if (kind === undefined)
			throw new Error(`no mail with id ${JSON.stringify(id)} reached this session; nothing was sent`);
		if (kind !== "ask") throw new Error(`${id} is a ${kind}, not an ask; nothing was sent. ${NOT_AN_ASK[kind]}`);
		const from = [...owedAsks].find(([, ids]) => ids.includes(id))?.[0];
		// An answered ask, by this tool or at settle, is no longer owed.
		if (from === undefined) throw new Error(`ask ${id} is already answered; nothing was sent`);
		const answer = send(me, from, body, { kind: "reply", inReplyTo: [id], status: "done" });
		const rest = (owedAsks.get(from) ?? []).filter((owedId) => owedId !== id);
		if (rest.length > 0) owedAsks.set(from, rest);
		else owedAsks.delete(from);
		return answer;
	}

	pi.registerTool({
		name: "session_mail_list",
		label: "Session mail: list",
		description:
			"List running Pi sessions across all agent roots on this machine, with name (short id if unnamed), full id, cwd, idle/busy state and whom each waits on. Marks the caller. Address running sessions by name, full id or 8+ character id prefix.",
		parameters: Type.Object({}),
		outputSchema: SessionList,
		// Listing deletes the records of sessions whose process is gone, which is housekeeping, not a change.
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx: ExtensionContext) {
			const me = ctx.sessionManager.getSessionId();
			const running = listRunning();
			if (running.length === 0)
				return toolResult("No Pi sessions are running with a mailbox.", { sessions: [] }, { sessions: [] });
			const byAddress = new Map(running.map((record) => [record.address, record]));
			const lines = running.map((record) => describe(record, byAddress, me));
			const count = `${running.length} running session${running.length === 1 ? "" : "s"}:`;
			return toolResult(
				[count, ...lines].join("\n"),
				{ sessions: running.map((record) => ({ ...record, self: record.address === me })) },
				{
					sessions: running.map(({ address, name, cwd, state, waitingOn }) => ({
						id: address,
						...(name === undefined ? {} : { name }),
						cwd,
						state,
						...(waitingOn === "" ? {} : { waitingOn }),
						self: address === me,
					})),
				},
			);
		},
	});

	pi.registerTool({
		name: "session_mail_send",
		label: "Session mail: send",
		description:
			"Send mail to a Pi session on this machine. An idle recipient starts a turn; a busy one reads it at the next tool-call gap. No answer is expected or automatic; any answer uses session_mail_send. Address running sessions by name, full id or 8+ character id prefix. Closed sessions require a full id; mail queues until they start. Discover running sessions with session_mail_list.",
		parameters: Type.Object({
			to: Type.String({
				description: "Recipient's name or 8+ character id prefix if running; full session id otherwise.",
			}),
			message: Type.String({
				description: "Message text, labelled as from this session.",
			}),
		}),
		outputSchema: SendResult,
		annotations: SENDS_MAIL,
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
			const envelope = send(me, to, body, { kind: "message" });
			const target = listRunning().find((record) => record.address === to);
			const text =
				target === undefined
					? `Message ${envelope.id} left for ${to}, which is not running: it waits in that session's inbox and is delivered when the session starts or resumes.`
					: `Sent message ${envelope.id} to ${label(target)} (${to}). It expects no answer; any answer arrives as a message.`;
			const result = { id: envelope.id, to, running: target !== undefined };
			return toolResult(text, result, result);
		},
	});

	pi.registerTool({
		name: "session_mail_ask",
		label: "Session mail: ask",
		description:
			"Ask a running Pi session on this machine. Its final message at run settle or an early reply answers. In a watched TUI, returns at once; the later answer starts a turn. Unattended sessions, including delegates, wait up to 10 minutes for the answer as this tool's result. Address by name, full id or 8+ character id prefix; discover with session_mail_list. Use session_mail_send for notes needing no answer.",
		parameters: Type.Object({
			to: Type.String({
				description: "Running recipient's name, full id or 8+ character id prefix.",
			}),
			message: Type.String({
				description: "Question, labelled as from this session.",
			}),
		}),
		outputSchema: AskResult,
		annotations: SENDS_MAIL,
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
			const ask = send(me, to, body, { kind: "ask" });
			const outcome: AskOutcome = attended(ctx)
				? { outcome: "background" }
				: await new Promise<AskOutcome>((resolve) => {
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
			const result = { id: ask.id, to, ...outcome };
			return toolResult(askText(ask, target, outcome), result, result);
		},
	});

	pi.registerTool({
		name: "session_mail_reply",
		label: "Session mail: reply",
		description:
			"Answer a received ask at once without ending this run. Each ask allows one reply, replacing this run's final-settle answer for it. Use the ask id from its label. Only asks qualify; requests are answered by their consuming extension, and messages expect no answer.",
		parameters: Type.Object({
			ask: Type.String({ description: "Ask id from its label." }),
			message: Type.String({ description: "Answer text." }),
		}),
		outputSchema: ReplyResult,
		// A repeated reply to the same ask is refused and sends nothing.
		annotations: { ...SENDS_MAIL, idempotentHint: true },
		async execute(
			_toolCallId: string,
			params: { ask: string; message: string },
			_signal: unknown,
			_onUpdate: unknown,
			_ctx: ExtensionContext,
		) {
			const id = typeof params.ask === "string" ? params.ask.trim() : "";
			const body = typeof params.message === "string" ? params.message.trim() : "";
			if (body === "") throw new Error("the answer is empty; nothing was sent");
			const answer = reply(id, body);
			const sender = listRunning().find((record) => record.address === answer.to);
			const who = sender === undefined ? answer.to : `${label(sender)} (${answer.to})`;
			const result = { id: answer.id, ask: id, to: answer.to };
			return toolResult(
				`Answered ask ${id} from ${who}; this run's last message will not be sent for it.`,
				result,
				result,
			);
		},
	});

	return {
		recordKind(envelope) {
			receivedKinds.set(envelope.id, envelope.kind);
		},
		armAsk(envelope) {
			if (envelope.kind === "ask") owedAsks.set(envelope.from, [...(owedAsks.get(envelope.from) ?? []), envelope.id]);
		},
		setAddress(next) {
			address = next;
			owedAsks = new Map();
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
