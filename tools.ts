// The model-facing tools of `mailbox`. Internal to the package: tests reach
// them only through the extension's registration function.
//
// `session_mail_list` reports every running Pi session on this machine, in
// every route, and marks the calling one. `session_mail_send` leaves a plain
// message, which wakes or steers its recipient and expects no answer.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { label, listRunning, resolveTo, type RunningRecord } from "./running.ts";
import { send } from "./store.ts";

/** What the tools need from the extension around them. */
export type ToolHooks = {
	/** Called after a tool wrote mail, so the footer can count it. */
	sent: () => void;
};

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

export function registerTools(pi: ExtensionAPI, hooks: ToolHooks): void {
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
			to: Type.String({ description: "The recipient: a running session's name, an id prefix of 8+ characters, or a full session id." }),
			message: Type.String({ description: "The message text. The recipient sees it labelled as coming from this session, not from its user." }),
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
			const envelope = send(me, to, body, { kind: "message", hops: 0 });
			hooks.sent();
			const target = listRunning().find((record) => record.address === to);
			const text =
				target === undefined
					? `Message ${envelope.id} left for ${to}, which is not running: it waits in that session's inbox and is delivered when the session starts or resumes.`
					: `Sent message ${envelope.id} to ${label(target)} (${to}). It expects no answer; any answer arrives as a message.`;
			return toolResult(text, { id: envelope.id, to, running: target !== undefined });
		},
	});
}
