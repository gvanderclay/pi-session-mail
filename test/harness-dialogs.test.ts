// The harness's fake `ctx.ui`: a `custom` call whose live component a test can
// drive and read, scripted `select`/`input`/`confirm` answers, and commands run
// by their full name. These tests use the fakes alone; later tests drive the
// real `/mailbox` commands through them.

import assert from "node:assert/strict";
import { test } from "node:test";

import { SelectList, type SelectListTheme } from "@earendil-works/pi-tui";

import { newId, session, type theme, until } from "./harness.ts";

/** A `SelectList` theme built from the theme the fake `custom` injects, never from `getSelectListTheme()`. */
const listTheme = (t: typeof theme): SelectListTheme => ({
	selectedPrefix: (text) => t.fg("accent", text),
	selectedText: (text) => t.bold(text),
	description: (text) => t.fg("dim", text),
	scrollInfo: (text) => t.fg("dim", text),
	noMatch: (text) => t.fg("dim", text),
});

test("a custom component renders, takes keys and resolves with the value it chooses", async () => {
	const a = session(newId());
	// A throwaway command, registered only here, shaped like the picker's handler.
	a.pi.registerCommand("picker:choose", {
		handler: async () => {
			const chosen = await a.ui.custom<string>((customTui, customTheme, _keybindings, done) => {
				assert.deepEqual(customTui.terminal, { rows: 24 });
				const list = new SelectList(
					[
						{ value: "a", label: "Alpha", description: "first row" },
						{ value: "b", label: "Beta", description: "second row" },
					],
					5,
					listTheme(customTheme),
				);
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done("cancelled");
				return list;
			});
			a.ui.notify(chosen);
		},
	});

	const running = a.command("picker:choose");
	await until(() => a.dialogs.length === 1, "the custom component to open");
	const [dialog] = a.dialogs;
	assert.match(dialog.component.render(80).join("\n"), /→ Alpha/);

	await dialog.press("\x1b[B");
	assert.match(dialog.component.render(80).join("\n"), /→ Beta/);

	await dialog.press("\r");
	await running;
	assert.equal(dialog.result(), "b");
	assert.deepEqual(a.notes, ["b"]);
});

test("select, input and confirm answer what the test scripts and record what they were offered", async () => {
	const a = session(newId());
	a.answers.select.push("bravo");
	a.answers.input.push("hello there");
	a.answers.confirm.push(true);
	assert.equal(await a.ui.select("Send to", ["alpha", "bravo"]), "bravo");
	assert.equal(await a.ui.input("Text", "type a message"), "hello there");
	assert.equal(await a.ui.confirm("Delete?", "first line"), true);
	assert.deepEqual(a.selects, [{ title: "Send to", options: ["alpha", "bravo"] }]);
	assert.deepEqual(a.inputs, [{ title: "Text", placeholder: "type a message" }]);
	assert.deepEqual(a.confirms, [{ title: "Delete?", message: "first line" }]);

	// With nothing left to answer, the user cancelled each dialog.
	assert.equal(await a.ui.select("Send to", ["alpha"]), undefined);
	assert.equal(await a.ui.input("Text"), undefined);
	assert.equal(await a.ui.confirm("Delete?", "first line"), false);
});
