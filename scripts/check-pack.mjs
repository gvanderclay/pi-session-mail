// Checks the file list `npm pack` would publish. There is no build step: Pi
// loads the .ts sources as they are. So every .ts file in src/, the README,
// LICENSE, CHANGELOG and package.json must be in it, nothing from tests or
// tooling may be, and every relative import in a packed .ts file must point at
// another packed file.
// Run from the package root: node scripts/check-pack.mjs
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

// npm 11 prints a list of results, npm 12 an object keyed by package name.
const result = Object.values(
	JSON.parse(
		execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
			encoding: "utf8",
		}),
	),
)[0];
const packed = result.files.map((file) => file.path);
const files = new Set(packed);

const problems = [];

const sources = readdirSync("src")
	.filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
	.map((name) => `src/${name}`);
const REQUIRED = ["package.json", "README.md", "LICENSE", "CHANGELOG.md", ...sources];
for (const path of REQUIRED) {
	if (!files.has(path)) problems.push(`missing: ${path}`);
}

const FORBIDDEN = /^(test|docs|scripts|node_modules|\.github)\/|^\.|\.tgz$|\.test\.ts$/;
for (const path of packed) {
	if (FORBIDDEN.test(path)) problems.push(`should not be packed: ${path}`);
}

const IMPORT = /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
for (const path of packed.filter((p) => p.endsWith(".ts"))) {
	const source = readFileSync(path, "utf8");
	for (const [, target] of source.matchAll(IMPORT)) {
		const resolved = normalize(join(dirname(path), target));
		if (!files.has(resolved)) {
			problems.push(`${path} imports ${target}, which is not packed`);
		}
	}
}

if (problems.length > 0) {
	console.error(`check-pack: ${problems.length} problem(s)`);
	for (const problem of problems) console.error(`  ${problem}`);
	process.exit(1);
}
console.log(`check-pack: ${packed.length} files, all expected`);
