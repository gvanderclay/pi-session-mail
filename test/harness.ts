// The fake Pi session the `mailbox` tests drive, and helpers to look at the
// mail folder. Importing this points `PI_CODING_AGENT_DIR` and
// `XDG_STATE_HOME` at a throwaway directory, so every fake session in a test
// file shares one mail root, as sessions on one machine do.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

import { createEventBus, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Value } from "typebox/value";

import register from "../src/index.ts";
import { send } from "../src/store.ts";

export const dir = mkdtempSync(join(tmpdir(), "mailbox-test-"));
process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
process.env.XDG_STATE_HOME = join(dir, "state");
// A test run inside an unattended Pi session (such as a pi-squire delegate)
// inherits PI_UNATTENDED=1, which would make the attended-ask test wait for
// the 10-minute ask timeout. Tests that need it set it themselves.
delete process.env.PI_UNATTENDED;
after(() => rmSync(dir, { recursive: true, force: true }));

/** The mail root under the current `XDG_STATE_HOME`. */
export const stateRoot = () => join(process.env.XDG_STATE_HOME as string, "pi-session-mail");

type Sub = "tmp" | "new" | "cur" | "sent";
export const box = (address: string, sub: Sub) => join(stateRoot(), address, sub);
export const files = (address: string, sub: Sub) =>
	existsSync(box(address, sub)) ? readdirSync(box(address, sub)).sort() : [];
export const envelopes = (address: string, sub: "new" | "cur" | "sent") =>
	files(address, sub).map((name) => JSON.parse(readFileSync(join(box(address, sub), name), "utf8")));
/** The running-session records on disk, by address. */
export const records = () => {
	const running = join(stateRoot(), "running");
	if (!existsSync(running)) return new Map<string, Record<string, unknown>>();
	return new Map(
		readdirSync(running)
			.filter((name) => name.endsWith(".json"))
			.map((name) => [name.slice(0, -".json".length), JSON.parse(readFileSync(join(running, name), "utf8"))]),
	);
};

/** A fresh session id, shaped like the ones Pi makes. The label only reads well in a failure. */
export const newId = (_label?: string) => randomUUID();

export type Sent = {
	message: { customType: string; content: string; display: boolean; details?: unknown };
	options: unknown;
};
type Handler = (event: unknown, ctx: unknown) => unknown;
type ToolResult = { content: { type: string; text: string }[]; details: unknown; structuredContent?: unknown };
type Tool = {
	name: string;
	description: string;
	outputSchema?: ToolDefinition["outputSchema"];
	annotations?: ToolDefinition["annotations"];
	execute: (id: string, params: unknown, signal: unknown, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>;
};

/**
 * The `theme` a fake `custom` hands its factory. Every styling function returns
 * its text unchanged, so rendered lines carry no ANSI escape sequences. A test
 * that needs a `SelectListTheme` builds one from these, never from
 * `getSelectListTheme()`, which reads Pi's global theme while rendering.
 */
export const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	inverse: (text: string) => text,
	strikethrough: (text: string) => text,
};

/** The `TUI` a fake `custom` hands its factory: it has a height to lay out in and never draws. */
type FakeTui = { requestRender: () => void; terminal: { rows: number } };
const tui: FakeTui = { requestRender: () => {}, terminal: { rows: 24 } };

/** The `Theme` a fake `custom` hands its factory: see `theme` above. */
type FakeTheme = typeof theme;

/** What a fake `custom` factory may return: any component, sync or promised. */
type CustomFactory<T> = (
	tui: FakeTui,
	theme: FakeTheme,
	keybindings: unknown,
	done: (result: T) => void,
) => Component | Promise<Component>;

/** One `ctx.ui.custom` call: the live component and what it resolved with. */
export type Dialog = {
	/** Drive it with `handleInput` and read `render(width)`. */
	component: Component;
	/** What the component called `done` with; undefined until it does. */
	result: () => unknown;
	/** Press keys as the terminal would, then let the command handler run a turn. */
	press: (data: string) => Promise<void>;
};

/** One fake Pi session running the extension under `sessionId`. */
export function session(
	sessionId: string,
	opts: { hasUI?: boolean; name?: string; cwd?: string; mode?: "tui" | "print" | "json" | "rpc" } = {},
) {
	const commands: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
	const handlers: Record<string, Handler[]> = {};
	const tools: Record<string, Tool> = {};
	const sent: Sent[] = [];
	const notes: string[] = [];
	const warnings: string[] = [];
	const errors: string[] = [];
	const statuses = new Map<string, string | undefined>();
	const dialogs: Dialog[] = [];
	/** The answers `select`, `input` and `confirm` return, in the order a test scripts them; none left means cancelled. */
	const answers = {
		select: [] as (string | undefined)[],
		input: [] as (string | undefined)[],
		confirm: [] as boolean[],
	};
	const selects: { title: string; options: string[] }[] = [];
	const inputs: { title: string; placeholder?: string }[] = [];
	const confirms: { title: string; message: string }[] = [];
	let statusCalls = 0;
	let name = opts.name;
	let idle = true;
	/** The running agent's abort signal, as `ctx.signal` gives it; undefined when no run is active. */
	let signal: AbortSignal | undefined;
	/** While true, injected messages never enter the conversation, as when an abort drops Pi's follow-up queue. */
	let dropping = false;
	const events = createEventBus();
	const pi = {
		events,
		on: (event: string, handler: Handler) => (handlers[event] ??= []).push(handler),
		registerCommand: (command: string, cmd: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands[command] = cmd.handler;
		},
		registerTool: (tool: Tool) => {
			tools[tool.name] = tool;
		},
		// A sent message enters the conversation at once, reported through message_end like Pi does.
		sendMessage: (message: Sent["message"], options: unknown) => {
			sent.push({ message, options });
			if (dropping) return;
			for (const h of handlers.message_end ?? [])
				void h({ type: "message_end", message: { role: "custom", ...message, timestamp: Date.now() } }, ctx);
		},
	};
	const ctx = {
		cwd: opts.cwd ?? dir,
		hasUI: opts.hasUI ?? true,
		mode: opts.mode,
		isIdle: () => idle,
		get signal() {
			return signal;
		},
		sessionManager: { getSessionId: () => sessionId, getSessionName: () => name },
		ui: {
			notify: (msg: string, type?: string) =>
				(type === "warning" ? warnings : type === "error" ? errors : notes).push(msg),
			setStatus: (key: string, text: string | undefined) => {
				statusCalls++;
				statuses.set(key, text);
			},
			select: async (title: string, options: string[]) => {
				selects.push({ title, options });
				const answer = answers.select.shift();
				assert.ok(
					answer === undefined || options.includes(answer),
					`select ${JSON.stringify(title)} was not offered ${JSON.stringify(answer)}`,
				);
				return answer;
			},
			input: async (title: string, placeholder?: string) => {
				inputs.push({ title, placeholder });
				return answers.input.shift();
			},
			confirm: async (title: string, message: string) => {
				confirms.push({ title, message });
				return answers.confirm.shift() ?? false;
			},
			custom: async <T>(factory: CustomFactory<T>): Promise<T> => {
				const settles = Promise.withResolvers<T>();
				let result: T;
				const component = await factory(tui, theme, {}, (value) => {
					result = value;
					settles.resolve(value);
				});
				dialogs.push({
					component,
					result: () => result,
					press: async (data) => {
						await component.handleInput?.(data);
						await turn();
					},
				});
				return settles.promise;
			},
		},
	};
	register(pi as never);
	let started = false;
	const fire = async (event: string, payload: object = {}) => {
		if (event === "session_start") started = true;
		for (const h of handlers[event] ?? []) await h({ type: event, ...payload }, ctx);
	};
	let calls = 0;
	/** Run a registered command by its full name, colon included (`mailbox`, `mailbox:send`). */
	const command = async (name: string, args = "") => {
		if (!started) await fire("session_start", { reason: "startup" });
		const handler = commands[name];
		if (handler === undefined) throw new Error(`no command named ${name} is registered`);
		return handler(args, ctx);
	};
	return {
		id: sessionId,
		pi,
		events,
		sent,
		notes,
		warnings,
		errors,
		ui: ctx.ui,
		dialogs,
		answers,
		selects,
		inputs,
		confirms,
		command,
		status: () => statuses.get("mailbox"),
		statusCalls: () => statusCalls,
		tools: () => Object.keys(tools).sort(),
		tool: (toolName: string) => tools[toolName],
		/** Call a registered tool; `signal` stands in for the user stopping the run. */
		// Pi passes `structuredContent` on unchecked, so every result a test sees is checked against the tool's `outputSchema` here.
		toolCall: async (toolName: string, params: unknown = {}, signal?: AbortSignal): Promise<ToolResult> => {
			const tool = tools[toolName];
			if (tool === undefined) throw new Error(`no tool named ${toolName} is registered`);
			const result = await tool.execute(`call-${++calls}`, params, signal, undefined, ctx);
			if (tool.outputSchema !== undefined)
				assert.ok(
					Value.Check(tool.outputSchema, result.structuredContent),
					`${toolName} returned structuredContent that does not match its outputSchema: ${JSON.stringify(result.structuredContent)} ${JSON.stringify([...Value.Errors(tool.outputSchema, result.structuredContent)])}`,
				);
			return result;
		},
		/** Hold back injected messages from the conversation (on) or let them in again (off). */
		drop: (on: boolean) => {
			dropping = on;
		},
		/** Run `/mailbox args`; Pi starts a session before any command, so a session not yet started starts first. */
		mailbox: (args: string) => command("mailbox", args),
		/** Send a request as the removed typed `/mailbox <to> <text>` did: `send()`, kind request. */
		request: (to: string, text: string) => send(sessionId, to, text.trim(), { kind: "request" }),
		/** Send an ask through `send()`, as `session_mail_ask` writes one, without waiting for its answer. */
		ask: (to: string, text: string) => send(sessionId, to, text.trim(), { kind: "ask" }),
		/** A reply fixture written straight through `send()`, `done` unless given; a consumer's real reply goes through `message:reply`. */
		reply: (to: string, inReplyTo: string[], body: string, status?: string) =>
			send(sessionId, to, body, { kind: "reply", inReplyTo, ...(status === undefined ? {} : { status }) }),
		/** Rename the session, as `/name` does, and tell the extension. */
		setName: (next: string | undefined) => {
			name = next;
			return fire("session_info_changed", { name: next });
		},
		/** The session is up: run the `session_start` handlers and let the first, deferred scan run. */
		start: async (reason = "startup") => {
			await fire("session_start", { reason });
			await turn();
		},
		/** Run only the `session_start` handlers, to watch what happens inside them. */
		sessionStart: (reason = "startup") => fire("session_start", { reason }),
		shutdown: () => fire("session_shutdown"),
		/** The user typed `text`, or sent it over RPC or through a command (`source`). */
		input: (text: string, source: "interactive" | "rpc" | "extension" = "interactive") =>
			fire("input", { text, source }),
		/** A run starts: the session is busy until it settles. */
		agentStart: () => {
			idle = false;
			return fire("agent_start");
		},
		/** One agent run ending with `text` as the last assistant message, then settling; `aborted` marks a run the user stopped. */
		answer: async (text?: string, options: { aborted?: boolean } = {}) => {
			idle = false;
			await fire("agent_start");
			const messages: { role: string; content: unknown; stopReason?: string }[] = [
				{ role: "user", content: [{ type: "text", text: "q" }] },
			];
			if (text !== undefined || options.aborted)
				messages.push({
					role: "assistant",
					content: text === undefined ? [] : [{ type: "text", text }],
					stopReason: options.aborted ? "aborted" : "stop",
				});
			await fire("agent_end", { messages });
			idle = true;
			await fire("agent_settled");
		},
		/**
		 * One agent run the user stopped (Esc) while a tool ran, then settling, as
		 * Pi 0.99.1 ends it: the tool result says `Command aborted`, the next model
		 * call fails with `stopReason: "error"`, and the run's signal is aborted
		 * until the run finishes. `text` is what the model wrote before the call.
		 */
		stopInToolCall: async (text?: string) => {
			idle = false;
			const run = new AbortController();
			signal = run.signal;
			await fire("agent_start");
			run.abort();
			await fire("agent_end", {
				messages: [
					{ role: "user", content: [{ type: "text", text: "q" }] },
					{
						role: "assistant",
						content: [
							...(text === undefined ? [] : [{ type: "text", text }]),
							{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 3000" } },
						],
						stopReason: "toolUse",
					},
					{
						role: "toolResult",
						toolCallId: "t1",
						toolName: "bash",
						content: [{ type: "text", text: "Command aborted" }],
						isError: true,
					},
					{ role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" },
				],
			});
			signal = undefined;
			idle = true;
			await fire("agent_settled");
		},
		/**
		 * A run that dies on an API error after Pi's retries give up: the last
		 * message has `stopReason: "error"` and the abort signal is never set.
		 * `text`, when given, comes in an earlier message before a tool call.
		 */
		failOnApiError: async (errorMessage: string | undefined, text?: string) => {
			idle = false;
			signal = new AbortController().signal;
			await fire("agent_start");
			await fire("agent_end", {
				messages: [
					{ role: "user", content: [{ type: "text", text: "q" }] },
					...(text === undefined
						? []
						: [
								{
									role: "assistant",
									content: [
										{ type: "text", text },
										{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } },
									],
									stopReason: "toolUse",
								},
								{
									role: "toolResult",
									toolCallId: "t1",
									toolName: "read",
									content: [{ type: "text", text: "x" }],
									isError: false,
								},
							]),
					{
						role: "assistant",
						content: [],
						stopReason: "error",
						...(errorMessage === undefined ? {} : { errorMessage }),
					},
				],
			});
			signal = undefined;
			idle = true;
			await fire("agent_settled");
		},
		agentEnd: (text: string, options: { aborted?: boolean } = {}) =>
			fire("agent_end", {
				messages: [
					{ role: "assistant", content: [{ type: "text", text }], stopReason: options.aborted ? "aborted" : "stop" },
				],
			}),
		settle: () => {
			idle = true;
			return fire("agent_settled");
		},
	};
}

/** Wait until `check` holds, up to a few poll intervals; tests never rely on fs.watch. */
export async function until(check: () => boolean, what: string, ms = 4000) {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

/** The event-loop turn after `session_start`, where `mailbox` claims mail already waiting. */
export const turn = () => new Promise((resolve) => setImmediate(resolve));
