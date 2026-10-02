// Loads the packed package in the `pi` on PATH and sends one message through
// the `/mailbox` command. It needs no API key and no model: an extension
// command runs without a model call, and Pi answers "handled".
//
// Steps: `npm pack`, unpack the tarball, `pi install` the unpacked folder as a
// local path (a .tgz is not a Pi package source), run `pi --mode rpc` with one
// `/mailbox <uuid> <text>` prompt, then check for a `Sent` notification, a
// "handled" response and one envelope in the recipient's `new/`.
// HOME, the agent folder and XDG_STATE_HOME are fresh temporary folders, so the
// real mail root is never touched.
// Run from the package root: node scripts/smoke.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RECIPIENT = "0b2f6c1e-5d3a-4f7e-9a41-7c8d2e6b1a90";
/** How long the RPC run, and each command before it, may take. */
const TIMEOUT_MS = 60_000;

const root = mkdtempSync(join(tmpdir(), "pi-session-mail-smoke-"));
const home = join(root, "home");
const agentDir = join(root, "agent");
const stateHome = join(root, "state");
const unpacked = join(root, "unpacked");
for (const dir of [home, agentDir, stateHome, unpacked]) mkdirSync(dir);
writeFileSync(join(agentDir, "auth.json"), "{}");

// Only what Pi needs to run; no API keys or Pi variables from the caller.
const env = {
	PATH: process.env.PATH,
	HOME: home,
	PI_CODING_AGENT_DIR: agentDir,
	XDG_STATE_HOME: stateHome,
	PI_OFFLINE: "1",
	PI_SKIP_VERSION_CHECK: "1",
};

function fail(reason) {
	console.error(`smoke test failed: ${reason}`);
	rmSync(root, { recursive: true, force: true });
	process.exit(1);
}

function run(command, args, options = {}) {
	try {
		return execFileSync(command, args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: TIMEOUT_MS,
			killSignal: "SIGKILL",
			...options,
		});
	} catch (error) {
		const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
		return fail(`\`${command} ${args.join(" ")}\` failed: ${output || error.message}`);
	}
}

const packed = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", root]));
const tarball = join(root, Object.values(packed)[0].filename);
run("tar", ["-xzf", tarball, "-C", unpacked, "--strip-components=1"]);
console.log(`packed ${tarball} and unpacked it to ${unpacked}`);

run("pi", ["install", unpacked], { env, cwd: root });
console.log(`pi ${run("pi", ["--version"], { env }).trim()}: installed the unpacked package`);

const child = spawn("pi", ["--mode", "rpc", "--no-session"], { env, cwd: root, stdio: ["pipe", "pipe", "pipe"] });
const records = [];
let stderr = "";
let buffered = "";
let closed = false;
function parse(line) {
	try {
		records.push(JSON.parse(line));
	} catch {
		// not a record
	}
}
child.on("error", (error) => fail(`could not run pi: ${error.message}`));
child.stdin.on("error", () => {
	// Pi exited before reading the prompt; its output says why.
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
	stderr += chunk;
});
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffered += chunk;
	const lines = buffered.split("\n");
	buffered = lines.pop();
	for (const line of lines) parse(line);
});
// "close" comes after stdout is drained, unlike "exit"; a last line may lack its newline.
child.on("close", () => {
	if (buffered) parse(buffered);
	buffered = "";
	closed = true;
});

const prompt = { id: "smoke-1", type: "prompt", message: `/mailbox ${RECIPIENT} smoke test` };
child.stdin.write(`${JSON.stringify(prompt)}\n`);

const deadline = Date.now() + TIMEOUT_MS;
const response = () => records.find((record) => record.type === "response" && record.id === prompt.id);
const sent = () =>
	records.find((record) => record.type === "extension_ui_request" && /^Sent /.test(record.message ?? ""));
while (!(response() && sent()) && !closed && Date.now() < deadline) {
	await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!closed) {
	child.kill("SIGKILL");
	await new Promise((resolve) => child.once("close", resolve));
}

if (!response()) fail(`no response to the prompt (pi stderr: ${stderr.trim() || "empty"})`);
if (!response().success) fail(`the prompt was rejected, so Pi did not run /mailbox as a command; the extension probably did not load: ${JSON.stringify(response())}`);
if (response().data?.disposition !== "handled") fail(`expected "disposition":"handled", got ${JSON.stringify(response())}`);
if (!sent()) {
	const notes = records.filter((record) => record.method === "notify").map((record) => record.message);
	fail(`no "Sent" notification; the extension did not load or the command failed (notifications: ${JSON.stringify(notes)})`);
}

const inbox = join(stateHome, "pi-session-mail", RECIPIENT, "new");
let envelopes;
try {
	envelopes = readdirSync(inbox);
} catch {
	envelopes = [];
}
if (envelopes.length !== 1) fail(`expected one envelope in ${inbox}, found ${envelopes.length}`);

rmSync(root, { recursive: true, force: true });
console.log(`smoke test passed: ${sent().message}`);
