// The model-facing tools of `mailbox`. Internal to the package: tests reach
// them only through the extension's registration function.
//
// `session_mail_list` reports every running Pi session on this machine, in
// every route, and marks the calling one.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { label, listRunning, type RunningRecord } from "./running.ts";

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

export function registerTools(pi: ExtensionAPI): void {
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

}
