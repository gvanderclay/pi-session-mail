// The `/mailbox` picker: one list of this session's mail, the filter Tab
// (Shift+Tab backwards) cycles, and a detail screen for the selected item. It reads no files,
// running records or clock and imports none of them: the command handler
// passes the items, a lookup from address to label and running state, the
// current time, the title and the starting view. It resolves on Esc, or on `d`
// with the selected item for the handler to delete after a confirmation; the
// handler reopens it where the user was.

import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeybindingsManager,
	matchesKey,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	stripTerminalSequences,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import type { Status } from "./mail-status.ts";

/** The filters Tab cycles, in order. */
export type PickerFilter = "unread" | "awaiting" | "read" | "sent" | "all";
const FILTERS: readonly PickerFilter[] = ["unread", "awaiting", "read", "sent", "all"];

/** The most rows shown at once; `SelectList` scrolls the rest. */
const ROW_MAX = 10;

/** Room for a row's status prefix and its first line before the description column. */
const ROW_LAYOUT = { minPrimaryColumnWidth: 32, maxPrimaryColumnWidth: 50 };

const EMPTY: Record<PickerFilter, string> = {
	unread: "No unread mail",
	awaiting: "Nothing is waiting for a reply",
	read: "No read mail",
	sent: "Nothing sent",
	all: "No mail",
};

/** What the picker shows for one item; plain values, no envelope or file path. */
export type PickerItem = {
	id: string;
	/** `sent/` is mail this session sent; `new/` and `cur/` are mail it received. */
	box: "new" | "cur" | "sent";
	from: string;
	to: string;
	kind: string;
	inReplyTo: readonly string[];
	ts: string;
	body: string;
	status: Status;
};

/** What the picker knows about an address: how to name it and whether it runs. */
export type Peer = { label: string; running: boolean };

/** Everything the picker needs, all known before it opens. */
export type PickerOptions = {
	items: readonly PickerItem[];
	/** The label and running state of each address, snapshotted before the picker opens. */
	peers: ReadonlyMap<string, Peer>;
	/** The session's name (or short id) and short address; the filter is shown after it. */
	title: string;
	/** The current time in ms, for relative times. */
	now: number;
	filter?: PickerFilter;
	/** The item to select; when it is gone, `selectedIndex` decides instead. */
	selectedId?: string;
	selectedIndex?: number;
};

/** What the picker resolved: it closed, or the user chose to delete the selected item. */
export type PickResult =
	| { action: "close" }
	| {
			action: "delete";
			/** The selected item's id and box, so the handler finds its file. */
			id: string;
			box: PickerItem["box"];
			/** The first line of its body, for the confirmation. */
			firstLine: string;
			/** Where the list was, so the handler reopens it where the user was. */
			filter: PickerFilter;
			index: number;
	  };

function listTheme(theme: Theme): SelectListTheme {
	return {
		selectedPrefix: (text: string): string => theme.fg("accent", text),
		selectedText: (text: string): string => theme.bold(text),
		description: (text: string): string => theme.fg("dim", text),
		scrollInfo: (text: string): string => theme.fg("dim", text),
		noMatch: (text: string): string => theme.fg("dim", text),
	};
}

/** Untrusted text with terminal escape sequences gone and line endings made `\n`. */
const clean = (text: string): string => stripTerminalSequences(text).replace(/\r\n?/g, "\n");

/** One display line from untrusted text, without newlines or other control characters. */
const oneLine = (text: string): string =>
	clean(text)
		.split("\n")[0]
		.replace(/[\p{Cc}\u2028\u2029]/gu, " ")
		.trim();

/** A body for the detail screen: escape sequences and control characters gone, line breaks kept. */
const bodyText = (text: string): string => clean(text).replace(/[^\P{Cc}\n\t]/gu, " ");

const firstLine = (body: string): string => oneLine(body) || "(no text)";

/** How long ago `ts` was, as `now`, `5m ago`, `3h ago` or `2d ago`. */
function ago(ts: string, now: number): string {
	const at = Date.parse(ts);
	if (!Number.isFinite(at)) return "unknown time";
	const minutes = Math.floor(Math.max(0, now - at) / 60_000);
	if (minutes < 1) return "now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	if (days < 30) return `${Math.floor(days / 7)}w ago`;
	if (days < 365) return `${Math.floor(days / 30)}mo ago`;
	return `${Math.floor(days / 365)}y ago`;
}

function shows(filter: PickerFilter, status: Status): boolean {
	if (filter === "all") return true;
	if (filter === "sent") return status === "awaiting" || status === "answered" || status === "message";
	return status === filter;
}

/** `d` deletes read and sent mail; unread mail is refused, since deleting its file would not take it back from the model. */
const deletable = (item: PickerItem): boolean => item.box !== "new" && item.status !== "unread";

const newestFirst = (a: PickerItem, b: PickerItem): number => b.ts.localeCompare(a.ts) || a.id.localeCompare(b.id);

/** A peer from the snapshot; an address the handler did not resolve is named by its short id. */
const peerOf = (peers: ReadonlyMap<string, Peer>, address: string): Peer =>
	peers.get(address) ?? { label: address.slice(0, 8), running: false };

function row(item: PickerItem, peers: ReadonlyMap<string, Peer>, now: number, filter: PickerFilter): SelectItem {
	const sent = item.box === "sent";
	const other = peerOf(peers, sent ? item.to : item.from);
	// SelectList drops descriptions at narrow widths, so required markers go in the label too.
	const markers: string[] = [];
	if (filter === "all" || filter === "sent") markers.push(item.status);
	if (item.status === "awaiting") markers.push(other.running ? "running" : "closed");
	const parts = [`${sent ? "to" : "from"} ${oneLine(other.label)}`, item.kind, ago(item.ts, now), ...markers];
	const prefix = markers.length > 0 ? `[${markers.join(" ")}] ` : "";
	return { value: item.id, label: `${prefix}${firstLine(item.body)}`, description: parts.join(" · ") };
}

/** The detail screen: the other session, the kind, id, absolute time, what it answers and the whole body. */
function detailText(item: PickerItem, peers: ReadonlyMap<string, Peer>): string {
	const sent = item.box === "sent";
	const address = sent ? item.to : item.from;
	const lines = [
		`${sent ? "To" : "From"} ${oneLine(peerOf(peers, address).label)} <${address}>`,
		`Kind ${oneLine(item.kind)}`,
		`Id ${oneLine(item.id)}`,
		`Sent ${new Date(item.ts).toLocaleString()}`,
	];
	if (item.inReplyTo.length > 0) lines.push(`In reply to ${item.inReplyTo.map(oneLine).join(", ")}`);
	lines.push("", bodyText(item.body));
	return lines.join("\n");
}

/** A `ctx.ui.custom` factory: the list and detail screens, till Esc closes the list. */
export function picker(options: PickerOptions) {
	return (tui: TUI, theme: Theme, _keybindings: KeybindingsManager, done: (result: PickResult) => void): Component => {
		const border = new DynamicBorder((text) => theme.fg("accent", text));
		let filter = options.filter ?? "all";
		let screen: "list" | "detail" = "list";
		let shown: PickerItem[] = [];
		let detailItem: PickerItem | undefined;
		let list: SelectList;

		const build = (selectedId: string | undefined, selectedIndex: number): void => {
			shown = rowsFor(options.items, filter);
			list = buildList(options, theme, filter, shown, selectedId, selectedIndex);
			list.onSelect = (item: SelectItem): void => {
				detailItem = shown.find((candidate) => candidate.id === item.value);
				if (detailItem !== undefined) screen = "detail";
			};
			list.onCancel = (): void => done({ action: "close" });
		};
		build(options.selectedId, options.selectedIndex ?? 0);

		const handleListInput = (data: string): void => {
			const next = nextFilter(filter, data);
			if (next !== undefined) {
				filter = next;
				build(undefined, 0);
				return;
			}
			const result = data === "d" ? deletion(shown, list, filter) : undefined;
			if (result !== undefined) done(result);
			else if (data !== "d") list.handleInput(data);
		};

		return {
			render(width: number): string[] {
				const title = oneLine(`${options.title} · ${filter}`);
				// The all and sent views mix statuses, so the hint follows the selected row, not the filter.
				const selected = shown.find((item) => item.id === list.getSelectedItem()?.value);
				const deletableNow = selected !== undefined && deletable(selected);
				const hint =
					screen === "detail" ? "esc back" : `tab filter · enter open${deletableNow ? " · d delete" : ""} · esc close`;
				return [
					...border.render(width),
					...new Text(theme.fg("accent", theme.bold(title)), 0, 0).render(width),
					...(screen === "detail" && detailItem !== undefined
						? new Text(detailText(detailItem, options.peers), 0, 0).render(width)
						: listLines(width, shown, list, filter, theme)),
					...new Text(theme.fg("dim", hint), 0, 0).render(width),
					...border.render(width),
				];
			},
			invalidate(): void {
				list.invalidate();
			},
			handleInput(data: string): void {
				if (screen === "detail") {
					if (matchesKey(data, "escape")) screen = "list";
				} else handleListInput(data);
				tui.requestRender();
			},
		};
	};
}

/** The filter Tab or Shift+Tab moves to from `filter`; undefined for any other key. */
function nextFilter(filter: PickerFilter, data: string): PickerFilter | undefined {
	let step = 0;
	if (matchesKey(data, "tab")) step = 1;
	else if (matchesKey(data, "shift+tab")) step = -1;
	else return undefined;
	return FILTERS[(FILTERS.indexOf(filter) + step + FILTERS.length) % FILTERS.length];
}

/** The items `filter` shows, newest first. */
const rowsFor = (items: readonly PickerItem[], filter: PickerFilter): PickerItem[] =>
	items.filter((item) => shows(filter, item.status)).sort(newestFirst);

/** A list of `items`, with the selection restored by id when it is there and by index otherwise. */
function buildList(
	options: PickerOptions,
	theme: Theme,
	filter: PickerFilter,
	items: PickerItem[],
	selectedId: string | undefined,
	selectedIndex: number,
): SelectList {
	const list = new SelectList(
		items.map((item) => row(item, options.peers, options.now, filter)),
		ROW_MAX,
		listTheme(theme),
		ROW_LAYOUT,
	);
	const found = selectedId === undefined ? -1 : items.findIndex((item) => item.id === selectedId);
	list.setSelectedIndex(found >= 0 ? found : Math.max(0, selectedIndex));
	return list;
}

/** The list, or the note that the filter is empty. */
function listLines(
	width: number,
	shown: readonly PickerItem[],
	list: SelectList,
	filter: PickerFilter,
	theme: Theme,
): string[] {
	return shown.length > 0 ? list.render(width) : new Text(theme.fg("muted", `  ${EMPTY[filter]}`), 0, 0).render(width);
}

/** What `d` resolves with: the selected item when it may be deleted, otherwise undefined. */
function deletion(shown: readonly PickerItem[], list: SelectList, filter: PickerFilter): PickResult | undefined {
	const index = shown.findIndex((item) => item.id === list.getSelectedItem()?.value);
	const item = shown[index];
	if (item === undefined || !deletable(item)) return undefined;
	return { action: "delete", id: item.id, box: item.box, firstLine: firstLine(item.body), filter, index };
}
