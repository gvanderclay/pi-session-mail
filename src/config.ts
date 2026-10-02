// The settings in `<agent dir>/session-mail.json`, parsed from its text.
// Pure: reading the file is the caller's job, so this module imports nothing.

/** The hop limit when `session-mail.json` is missing or broken. */
export const DEFAULT_HOP_LIMIT = 5;

/** Days a closed session's mailbox folder is kept before it is pruned. */
export const DEFAULT_PRUNE_AFTER_DAYS = 30;

/** The settings, each valid or its default, and what was wrong with the file, if anything. */
export type Config = { hopLimit: number; pruneAfterDays: number; problems: string[] };

const isPositiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 1;

/**
 * The settings in the text of `session-mail.json` at `path`; `undefined` text
 * is a missing file. A key that is absent means its default; an invalid one
 * means its default and a problem. A file that is not a JSON object means
 * every default and one problem.
 */
export function parseConfig(text: string | undefined, path: string): Config {
	const defaults = { hopLimit: DEFAULT_HOP_LIMIT, pruneAfterDays: DEFAULT_PRUNE_AFTER_DAYS };
	if (text === undefined) return { ...defaults, problems: [] };
	const using = `using the hop limit ${DEFAULT_HOP_LIMIT} and pruning after ${DEFAULT_PRUNE_AFTER_DAYS} days`;
	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch (err) {
		return { ...defaults, problems: [`${path} is not valid JSON (${(err as Error).message}); ${using}`] };
	}
	if (typeof config !== "object" || config === null || Array.isArray(config))
		return { ...defaults, problems: [`${path} is not a JSON object; ${using}`] };
	const values = config as { hopLimit?: unknown; pruneAfterDays?: unknown };
	const problems: string[] = [];
	const read = (key: "hopLimit" | "pruneAfterDays"): number => {
		const value = values[key];
		if (value === undefined) return defaults[key];
		if (isPositiveInteger(value)) return value;
		problems.push(`${key} in ${path} must be a positive integer, not ${JSON.stringify(value)}; using ${defaults[key]}`);
		return defaults[key];
	};
	const hopLimit = read("hopLimit");
	const pruneAfterDays = read("pruneAfterDays");
	return { hopLimit, pruneAfterDays, problems };
}
