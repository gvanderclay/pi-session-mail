// The settings in `<agent dir>/session-mail.json`, parsed from its text.
// Pure: reading the file is the caller's job, so this module imports nothing.

/** Days a closed session's mailbox folder is kept before it is pruned. */
export const DEFAULT_PRUNE_AFTER_DAYS = 30;

/** The settings, each valid or its default, and what was wrong with the file, if anything. */
export type Config = { pruneAfterDays: number; problems: string[] };

const isPositiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isInteger(value) && value >= 1;

/**
 * The settings in the text of `session-mail.json` at `path`; `undefined` text
 * is a missing file. A key that is absent means its default; an invalid one
 * means its default and a problem. A file that is not a JSON object means
 * every default and one problem.
 */
export function parseConfig(text: string | undefined, path: string): Config {
	const defaults = { pruneAfterDays: DEFAULT_PRUNE_AFTER_DAYS };
	if (text === undefined) return { ...defaults, problems: [] };
	const using = `using the default, pruning after ${DEFAULT_PRUNE_AFTER_DAYS} days`;
	let config: unknown;
	try {
		config = JSON.parse(text);
	} catch (err) {
		return { ...defaults, problems: [`${path} is not valid JSON (${(err as Error).message}); ${using}`] };
	}
	if (typeof config !== "object" || config === null || Array.isArray(config))
		return { ...defaults, problems: [`${path} is not a JSON object; ${using}`] };
	const values = config as { pruneAfterDays?: unknown };
	const problems: string[] = [];
	const value = values.pruneAfterDays;
	let pruneAfterDays = defaults.pruneAfterDays;
	if (value !== undefined) {
		if (isPositiveInteger(value)) pruneAfterDays = value;
		else
			problems.push(
				`pruneAfterDays in ${path} must be a positive integer, not ${JSON.stringify(value)}; using ${defaults.pruneAfterDays}`,
			);
	}
	return { pruneAfterDays, problems };
}
