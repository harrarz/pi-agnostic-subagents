import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { parseSupervisorConfig, resolveLaunchRecipe } from "../src/profiles.js";
import { WorkerExtensions, WORKER_ENV } from "../src/worker-extensions.js";
import { parseRunCommandArgs } from "../src/commands.js";
import { RpcTransport } from "../src/rpc-transport.js";
import { executeBrowserRequest } from "../src/ui-actions.js";
import { ModelSettings, openModelSettings } from "../src/model-settings.js";
import type { Supervisor } from "../src/supervisor.js";
import type { PiCommandContext } from "../src/pi-api.js";
import type { PiContext, PiExtensionApi } from "../src/pi-api.js";
import extension from "../src/index.js";

const capability = { none: ["--no-extensions"], load: ["--extension", "{extension}"] };
function config(extra = {}) {
	return parseSupervisorConfig({ defaultProfile: "worker", profiles: {
		worker: { executable: "not-named-pi", args: ["before", "{extensionArgs}", "after", "{task}"], taskTransport: "argument", extensionArgs: capability },
		legacy: { executable: "pi", args: ["--no-extensions"], taskTransport: "stdin" },
	}, ...extra });
}

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-worker-extension-policy-")));
	const agent = join(root, "agent"), project = join(root, "project");
	await mkdir(join(agent, "extensions"), { recursive: true });
	await mkdir(project);
	const first = join(agent, "extensions", "first.ts"), second = join(agent, "extensions", "second.ts");
	for (const file of [first, second]) await writeFile(file, 'throw new Error("Discovery must not execute this factory");\n');
	return { root, agent, project, first, second, settings: new WorkerExtensions(join(agent, "agent-supervisor")), env: { PI_CODING_AGENT_DIR: agent }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("extension capability is declarative, validates whole argv groups, and leaves legacy profiles unchanged", () => {
	assert.deepEqual(resolveLaunchRecipe(config(), { task: "--task" }).args, ["before", "--no-extensions", "after", "--task"]);
	assert.deepEqual(resolveLaunchRecipe(config(), { task: "x", extensions: "custom", extensionSet: "tools" }, undefined, ["/tmp/a b 雪.ts", "builtin:codemode"]).args,
		["before", "--no-extensions", "--extension", "/tmp/a b 雪.ts", "--extension", "builtin:codemode", "after", "x"]);
	assert.deepEqual(resolveLaunchRecipe(config(), { task: "x", profile: "legacy" }).args, ["--no-extensions"]);
	assert.throws(() => resolveLaunchRecipe(config(), { task: "x", profile: "legacy", extensions: "inherit" }), /does not declare/);
	assert.throws(() => resolveLaunchRecipe(config(), { task: "x", extensionSet: "tools" }), /requires explicit custom/);
	const base = { executable: "anything", args: ["{extensionArgs}", "{task}"], taskTransport: "argument", extensionArgs: capability };
	for (const patch of [
		{ args: ["{task}"] }, { args: ["prefix-{extensionArgs}", "{task}"] },
		{ args: ["{extensionArgs}", "{extensionArgs}", "{task}"] },
		{ args: ["--no-extensions", "{extensionArgs}", "{task}"] },
		{ args: ["--extension=unapproved.ts", "{extensionArgs}", "{task}"] },
		{ args: ["-e", "/tmp/unapproved.ts", "{extensionArgs}", "{task}"] },
		{ args: ["-ne", "{extensionArgs}", "{task}"] },
		{ args: ["{modelArgs}", "{extensionArgs}", "{task}"], modelArgs: ["--model", "{model}", "-e", "/tmp/unapproved.ts"] },
		{ extensionArgs: { none: [], load: ["-e", "{extension}"] } },
		{ extensionArgs: { none: ["--no-extensions"], load: ["prefix-{extension}"] } },
		{ extensionArgs: { none: ["--no-extensions"], load: ["{extension}", "{extension}"] } },
		{ extensionArgs: { none: ["$(id)"], load: ["{extension}"] } },
		{ extensions: { mode: "unknown" } }, { extensions: { mode: "custom" } },
		{ extensions: { mode: "inherit", set: "tools" } },
	]) assert.throws(() => parseSupervisorConfig({ defaultProfile: "x", profiles: { x: { ...base, ...patch } } }));
	for (const path of ["npm:anything", "git:github.com/a/b", "./untrusted.ts", "/tmp/bad\nfile.ts"]) assert.throws(() => config({ extensionSets: { tools: [path] } }));
	assert.equal(parseRunCommandArgs("--extensions custom --extension-set tools -- task").options.extensionSet, "tools");
	assert.throws(() => parseRunCommandArgs("--extensions invalid task"), /none, inherit, or custom/);
	assert.throws(() => parseRunCommandArgs("--extensions none --extensions inherit task"), /only be used once/);
});

test("extension defaults and approved sets persist privately; explicit choices and pinned snapshots win", async () => {
	const f = await fixture();
	try {
		const cfg = config({ extensionSets: { original: [f.first] } });
		assert.deepEqual(await f.settings.resolve(cfg, { task: "x" }, f.project, f.env), { mode: "none", paths: [] });
		await assert.rejects(readFile(f.settings.file), { code: "ENOENT" });
		cfg.profiles.worker.extensions = { mode: "custom", set: "original" };
		assert.deepEqual(await f.settings.resolve(cfg, { task: "x" }, f.project, f.env), { mode: "custom", set: "original", paths: [f.first] });
		delete cfg.profiles.worker.extensions;
		await f.settings.set("saved", [f.second]);
		await f.settings.setProfile("worker", { mode: "custom", set: "saved" });
		const selected = await f.settings.resolve(cfg, { task: "x" }, f.project, f.env);
		assert.deepEqual(selected, { mode: "custom", set: "saved", paths: [f.second] });
		assert.equal((await new WorkerExtensions(join(f.agent, "agent-supervisor")).load()).profiles.worker.mode, "custom");
		assert.deepEqual(await f.settings.resolve(cfg, { task: "x", extensions: "none" }, f.project, f.env), { mode: "none", paths: [] });
		assert.deepEqual(await f.settings.resolve(cfg, { task: "x", extensions: "custom", extensionSet: "original" }, f.project, f.env), { mode: "custom", set: "original", paths: [f.first] });
		await f.settings.set("saved", [f.first]);
		assert.deepEqual(await f.settings.resolve(cfg, { task: "x" }, f.project, f.env, selected), selected, "reruns/follow-ups retain the resolved selection, not a renamed set's new contents");
		await rm(f.second);
		await assert.rejects(f.settings.resolve(cfg, { task: "x" }, f.project, f.env, selected), /missing/);
		await assert.rejects(f.settings.resolve(cfg, { task: "x", extensions: "custom", extensionSet: "unknown" }, f.project, f.env), /Unknown worker extension set/);
		await assert.rejects(f.settings.resolve(cfg, { task: "x", profile: "legacy", extensions: "none" }, f.project, f.env), /does not declare/);
		await assert.rejects(f.settings.set("__proto__", [f.first]));
		assert.equal((await stat(f.settings.file)).mode & 0o777, 0o600);
		assert.equal((await stat(join(f.agent, "agent-supervisor"))).mode & 0o777, 0o700);
		await f.settings.setProfile("worker");
		assert.equal((await f.settings.resolve(cfg, { task: "x" }, f.project, f.env))?.mode, "none");
		await writeFile(f.settings.file, '{"profiles":[],"sets":{}}');
		await assert.rejects(f.settings.load(), /Invalid worker extension settings/);
	} finally { await f.cleanup(); }
});

test("inherit uses Pi user resource filters, ignores project extensions, and never executes factories or installs missing packages", async () => {
	const f = await fixture();
	try {
		await mkdir(join(f.project, ".pi", "extensions"), { recursive: true });
		await writeFile(join(f.project, ".pi", "extensions", "untrusted.ts"), 'throw new Error("project code");');
		const packageDir = join(f.root, "package");
		await mkdir(packageDir);
		await writeFile(join(packageDir, "package.json"), JSON.stringify({ name: "local-fixture", pi: { extensions: ["wanted.ts", "hidden.ts"] } }));
		await writeFile(join(packageDir, "wanted.ts"), 'throw new Error("must not execute");');
		await writeFile(join(packageDir, "hidden.ts"), 'throw new Error("must not execute");');
		const settings = JSON.stringify({ extensions: [`-${f.second}`, "-builtin:mcp"], packages: [{ source: packageDir, extensions: ["wanted.ts"] }] });
		await writeFile(join(f.agent, "settings.json"), settings);
		const entries = await f.settings.catalog(f.project, f.env);
		assert.ok(entries.some((entry) => entry.path === f.first && entry.enabled));
		assert.ok(entries.some((entry) => entry.path === f.second && !entry.enabled));
		assert.ok(entries.some((entry) => entry.path === join(packageDir, "wanted.ts") && entry.enabled));
		assert.ok(!entries.some((entry) => entry.path.includes("untrusted") || entry.path.endsWith("hidden.ts") && entry.enabled));
		const inherited = await f.settings.resolve(config(), { task: "x", extensions: "inherit" }, f.project, f.env);
		assert.ok(inherited?.paths.includes(f.first));
		assert.ok(!inherited?.paths.includes(f.second));
		assert.ok(!inherited?.paths.includes("builtin:mcp"));
		assert.equal(await readFile(join(f.agent, "settings.json"), "utf8"), settings, "discovery must not rewrite user configuration");
		await writeFile(join(f.agent, "settings.json"), JSON.stringify({ packages: ["npm:@example/not-installed-for-tests@1.0.0"] }));
		await assert.rejects(f.settings.catalog(f.project, f.env), /unavailable|missing|not installed/i);
	} finally { await f.cleanup(); }
});

test("TUI extension picker saves an approved set and profile mode, cancels cleanly, and stays out of RPC UI", async () => {
	const f = await fixture();
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = f.agent;
	try {
		const answers: Array<string | undefined> = ["Create/edit extension set", "first-file", "Save selection", "worker-row", "Choose mode", "Custom set", "tools", undefined];
		const notices: string[] = [];
		const ctx = { mode: "tui", hasUI: true, cwd: f.project, ui: {
			select: async (_title: string, choices: string[]) => {
				const answer = answers.shift();
				if (answer === "first-file") return choices.find((choice) => choice.includes("first.ts"));
				if (answer === "worker-row") return choices.find((choice) => choice.startsWith("worker ·"));
				assert.ok(answer === undefined || choices.includes(answer), String(answer));
				return answer;
			},
			input: async () => "tools", notify: (message: string) => notices.push(message),
		} } as unknown as PiContext;
		await f.settings.openSettings(ctx, config());
		assert.deepEqual((await f.settings.load()).sets.tools, [f.first]);
		assert.deepEqual((await f.settings.load()).profiles.worker, { mode: "custom", set: "tools" });
		const before = await readFile(f.settings.file, "utf8");
		assert.equal(await f.settings.choose(ctx, config(), "worker"), undefined);
		assert.equal(await readFile(f.settings.file, "utf8"), before);
		await f.settings.openSettings({ ...ctx, mode: "rpc" }, config());
		assert.ok(notices.some((notice) => notice.includes("require TUI")));
	} finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await f.cleanup(); }
});

test("settings link and browser rerun editor expose extension choices without changing other run settings", async () => {
	const f = await fixture();
	try {
		let opened = 0;
		const picks = ["Worker extension settings…", undefined];
		await openModelSettings({ mode: "tui", hasUI: true, ui: { select: async () => picks.shift(), notify() {} } } as unknown as PiContext,
			config(), new ModelSettings(f.root), async () => { opened++; });
		assert.equal(opened, 1);
		const run = { id: "run", profile: "worker", task: "original task", isolation: "shared", timeoutMs: 1234, extensions: { mode: "none", paths: [] } };
		let draft: any;
		let step = 0;
		const ctx = { ui: {
			select: async (_title: string, choices: string[]) => step++ === 0 ? choices.find((choice) => choice.startsWith("Extensions:")) : "Run",
			confirm: async () => true,
		} } as unknown as PiCommandContext;
		const supervisor = { inspect: () => run, rerun: async (_id: string, changes: any) => { draft = changes; return { id: "next" }; } } as unknown as Supervisor;
		const id = await executeBrowserRequest(ctx, supervisor, { id: "run", action: "editRerun" }, async (profile) => { assert.equal(profile, "worker"); return { mode: "inherit" }; });
		assert.equal(id, "next"); assert.equal(draft.extensions, "inherit"); assert.equal(draft.task, run.task); assert.equal(draft.timeoutMs, 1234);
	} finally { await f.cleanup(); }
});

test("worker guard registers neither delegation tools nor supervisor lifecycle hooks", () => {
	const previous = process.env[WORKER_ENV];
	process.env[WORKER_ENV] = "1";
	try {
		const fail = () => { throw new Error("nested supervisor registration"); };
		extension({ registerTool: fail, registerCommand: fail, on: fail } as unknown as PiExtensionApi);
	} finally { if (previous === undefined) delete process.env[WORKER_ENV]; else process.env[WORKER_ENV] = previous; }
});

test("worker RPC reports extension errors and unsupported blocking dialogs instead of silently approving them", () => {
	const failures: string[] = [];
	const input = new Writable({ write(_chunk, _encoding, done) { done(); } });
	const rpc = new RpcTransport(input, () => {}, (error) => failures.push(error.message));
	for (const event of [
		{ type: "extension_error", error: "fixture failure" },
		{ type: "extension_ui_request", method: "confirm", id: "permission" },
		{ type: "extension_ui_request", method: "notify", notifyType: "error" },
		{ type: "extension_ui_request", method: "notify", notifyType: "info" },
	]) rpc.push(Buffer.from(JSON.stringify(event) + "\n"));
	assert.equal(failures.length, 3);
	assert.match(failures[1], /do not answer or auto-approve/);
	rpc.close();
});
