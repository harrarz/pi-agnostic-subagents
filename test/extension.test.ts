import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { PiExtensionApi } from "../src/pi-api.js";
import type { Component } from "@earendil-works/pi-tui";
import { parseRunCommandArgs } from "../src/commands.js";
import { ModelSettings } from "../src/model-settings.js";
import { getSupervisorPaths } from "../src/config.js";
import extension from "../src/index.js";

const fakeAgent = resolve("test/fixtures/fake-agent.mjs");

function configText(): string {
	return JSON.stringify({
		defaultProfile: "fake",
		profiles: {
			fake: {
				outputProtocol: "text",
				executable: process.execPath,
				args: [fakeAgent, "{modelArgs}", "{effortArgs}", "--", "{task}"],
				modelArgs: ["--model", "{model}"],
				effortArgs: ["--reasoning", "{effort}"],
				taskTransport: "argument",
				defaultEffort: "deep",
				models: {
					"fake/model-steady": { efforts: { deep: "max", quick: "low" }, defaultEffort: "deep" },
					"fake/model-swift": { efforts: { deep: "high", quick: "minimal" }, defaultEffort: "quick" },
				},
			},
		},
	});
}

async function setup(): Promise<{
	root: string;
	project: string;
	cleanup(): Promise<void>;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-supervisor-extension-"));
	const agentRoot = join(root, "pi-agent");
	const project = join(root, "project");
	await mkdir(join(agentRoot, "agent-supervisor"), { recursive: true });
	await writeFile(join(agentRoot, "agent-supervisor", "profiles.json"), configText());
	await mkdir(project, { recursive: true });
	execFileSync("git", ["init", "-q", project]);
	const previousConfigDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentRoot;
	return {
		root,
		project,
		async cleanup() {
			if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
			await rm(root, { recursive: true, force: true });
		},
	};
}

function fakePi() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Function[]>();
	const pi = {
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		on(event: string, handler: Function) {
			const registered = handlers.get(event) ?? [];
			registered.push(handler);
			handlers.set(event, registered);
			return () => {};
		},
	};
	return { pi, tools, commands, handlers };
}

function context(project: string, sessionId: string, mode: "tui" | "rpc" | "json" | "print", hasUI: boolean) {
	const notices: Array<{ message: string; type?: string }> = [];
	const selections: string[] = [];
	const choiceLists: string[][] = [];
	let confirmed = true;
	let selectCalls = 0;
	let customCalls = 0;
	const browserLines: string[][] = [];
	const widgets = new Map<string, unknown>();
	const ctx = {
		cwd: project,
		model: { provider: "fake", id: "model-steady" },
		scopedModels: [],
		modelRegistry: { getAvailable: () => [{ provider: "fake", id: "model-steady" }, { provider: "fake", id: "model-swift" }] },
		mode,
		hasUI,
		sessionManager: { getSessionId: () => sessionId, getCwd: () => project },
		ui: {
			setWidget(key: string, value: unknown) { if (value === undefined) widgets.delete(key); else widgets.set(key, value); },
			async custom(factory: Function) {
				customCalls++;
				const component = factory({ requestRender() {}, terminal: { rows: 24 } }, { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text }, { matches: () => false }, () => {}) as Component & { dispose?(): void };
				browserLines.push(component.render(100));
				component.dispose?.();
			},
			notify(message: string, type?: string) { notices.push({ message, type }); },
			async select(_title: string, options: string[]) {
				selectCalls++;
				choiceLists.push(options);
				const selected = selections.shift();
				return selected === "@0" ? options[0] : selected ?? options[0];
			},
			async confirm() { return confirmed; },
		},
	};
	return {
		ctx: ctx as any,
		notices,
		selections,
		choiceLists,
		browserLines,
		widgets,
		get customCalls() { return customCalls; },
		get selectCalls() { return selectCalls; },
		set confirmed(value: boolean) { confirmed = value; },
	};
}

async function waitForRun(getTool: any, ctx: any, id: string, state: string): Promise<any> {
	const deadline = Date.now() + 8000;
	let result: any;
	while (Date.now() < deadline) {
		result = await getTool.execute("get", { id }, undefined, undefined, ctx);
		const parsed = JSON.parse(result.content[0].text);
		if (parsed.state === state) return parsed;
		await new Promise((resolveWait) => setTimeout(resolveWait, 20));
	}
	throw new Error(`Timed out waiting for ${id} to reach ${state}; got ${JSON.stringify(result?.details)}`);
}

test("parses run flags without invoking a shell and preserves the task remainder", () => {
	const parsed = parseRunCommandArgs("--profile fake --model fake/model-swift --effort deep --cwd '/tmp/my checkout' --timeout-ms 250 -- --fix 'quoted' 雪");
	assert.deepEqual(parsed, {
		task: "--fix 'quoted' 雪",
		options: { profile: "fake", model: "fake/model-swift", effort: "deep", cwd: "/tmp/my checkout", timeoutMs: 250 },
	});
	assert.throws(() => parseRunCommandArgs("--unknown x task"), /Unknown run option/);
	assert.throws(() => parseRunCommandArgs("--timeout-ms Infinity task"), /positive integer/);
	assert.throws(() => parseRunCommandArgs("--profile"), /requires a value/);
	assert.equal(parseRunCommandArgs("--isolation=worktree -- task").options.isolation, "worktree");
	assert.throws(() => parseRunCommandArgs("--isolation invented task"), /isolation must/);
	assert.throws(() => parseRunCommandArgs("--isolation worktree --isolation shared task"), /only be used once/);
});

test("registers tools/command, starts and inspects a real child in JSON mode, and notifies once", async () => {
	const { root, project, cleanup } = await setup();
	try {
		const { pi, tools, commands, handlers } = fakePi();
		extension(pi as unknown as PiExtensionApi);
		assert.deepEqual([...tools.keys()].sort(), ["agent_get", "agent_start", "agent_stop"]);
		assert.ok(commands.has("agent"));
		const envContext = context(project, "extension-json-session", "json", true);
		for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, envContext.ctx);

		const started = await tools.get("agent_start").execute("start", {
			task: "hello from extension",
			model: "fake/model-swift",
			effort: "deep",
		}, undefined, undefined, envContext.ctx);
		const { id, state } = JSON.parse(started.content[0].text);
		assert.equal(state, "starting");
		const completed = await waitForRun(tools.get("agent_get"), envContext.ctx, id, "exited");
		assert.equal(completed.exitCode, 0);
		assert.equal(completed.model, "fake/model-swift");
		assert.equal(completed.effort, "high");
		assert.match(completed.finalAnswer, /OUT:hello from extension/);
		assert.equal(completed.outputTail, undefined, "default get must not leak protocol logs");
		assert.equal(completed.outputDisplay, undefined);
		const raw = await tools.get("agent_get").execute("get", { id, format: "raw" }, undefined, undefined, envContext.ctx);
		assert.match(JSON.parse(raw.content[0].text).outputTail, /ERR:hello from extension/);
		const notificationDeadline = Date.now() + 2000;
		while (envContext.notices.length === 0 && Date.now() < notificationDeadline) await new Promise((resolveWait) => setTimeout(resolveWait, 10));
		assert.equal(envContext.notices.length, 1);
		assert.match(envContext.notices[0].message, /does not establish task correctness/);

		const listed = await tools.get("agent_get").execute("list", {}, undefined, undefined, envContext.ctx);
		assert.equal(JSON.parse(listed.content[0].text).runs[0].id, id);
		const stopResponse = await tools.get("agent_stop").execute("stop", { id }, undefined, undefined, envContext.ctx);
		assert.equal(JSON.parse(stopResponse.content[0].text).state, "exited");
		const record = JSON.parse(await readFile(join(root, "pi-agent", "agent-supervisor", "runtime", "runs", createHashSession("extension-json-session"), `${id}.json`), "utf8"));
		assert.ok(record.notifiedAt);
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, envContext.ctx);
	} finally {
		await cleanup();
	}
});

test("extension launches follow parent changes and persisted settings", async () => {
	const { project, cleanup } = await setup();
	const { pi, tools, handlers } = fakePi();
	extension(pi as unknown as PiExtensionApi);
	const ui = context(project, "model-inheritance-session", "print", false);
	try {
		ui.ctx.model.id = "model-swift";
		const start = tools.get("agent_start");
		const first = await start.execute("start", { task: "inherited" }, undefined, undefined, ui.ctx);
		const inherited = await waitForRun(tools.get("agent_get"), ui.ctx, JSON.parse(first.content[0].text).id, "exited");
		assert.equal(inherited.model, "fake/model-swift");
		const preferences = new ModelSettings(getSupervisorPaths().configDirectory);
		await preferences.set("fake", "fake/model-steady");
		const second = await start.execute("start", { task: "saved" }, undefined, undefined, ui.ctx);
		const saved = await waitForRun(tools.get("agent_get"), ui.ctx, JSON.parse(second.content[0].text).id, "exited");
		assert.equal(saved.model, "fake/model-steady");
		const third = await start.execute("start", { task: "explicit", model: "fake/model-swift" }, undefined, undefined, ui.ctx);
		const explicit = await waitForRun(tools.get("agent_get"), ui.ctx, JSON.parse(third.content[0].text).id, "exited");
		assert.equal(explicit.model, "fake/model-swift");
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ui.ctx);
		await cleanup();
	}
});

test("keeps model tools usable without UI and guards the bare picker outside TUI mode", async () => {
	const { project, cleanup } = await setup();
	try {
		const { pi, tools, commands, handlers } = fakePi();
		extension(pi as unknown as PiExtensionApi);
		const envContext = context(project, "extension-print-session", "print", false);
		const started = await tools.get("agent_start").execute("start", { task: "print mode works" }, undefined, undefined, envContext.ctx);
		const { id } = JSON.parse(started.content[0].text);
		const result = await waitForRun(tools.get("agent_get"), envContext.ctx, id, "exited");
		assert.equal(result.exitCode, 0);
		await commands.get("agent").handler("", envContext.ctx);
		assert.equal(envContext.selectCalls, 0);
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, envContext.ctx);
	} finally {
		await cleanup();
	}
});

test("opens the live TUI browser, attaches its widget and confirms manual stop", async () => {
	const { project, cleanup } = await setup();
	try {
		const { pi, tools, commands, handlers } = fakePi();
		extension(pi as unknown as PiExtensionApi);
		const ui = context(project, "extension-tui-session", "tui", true);
		for (const handler of handlers.get("session_start") ?? []) await handler({ type: "session_start", reason: "startup" }, ui.ctx);
		const command = commands.get("agent");
		await command.handler("run --label auth-fix --profile fake --model fake/model-swift --effort deep -- Task from command", ui.ctx);
		const list = await tools.get("agent_get").execute("list", {}, undefined, undefined, ui.ctx);
		const commandRun = JSON.parse(list.content[0].text).runs[0];
		assert.equal(commandRun.label, "auth-fix");
		assert.equal(commandRun.model, "fake/model-swift");
		assert.equal(commandRun.effort, "deep");
		const id = commandRun.id;
		await waitForRun(tools.get("agent_get"), ui.ctx, id, "exited");

		await command.handler("", ui.ctx);
		assert.equal(ui.customCalls, 1);
		assert.equal(ui.selectCalls, 0);
		assert.ok(ui.widgets.has("agent-supervisor"));
		assert.match(ui.browserLines[0].join("\n"), /main.*parent session/);
		assert.match(ui.browserLines[0].join("\n"), /exited/);
		await command.handler(`show ${id}`, ui.ctx);
		assert.equal(ui.customCalls, 2);
		assert.match(ui.browserLines[1].join("\n"), /Final answer/);
		await command.handler("profiles", ui.ctx);
		assert.ok(ui.notices.some((notice) => notice.message.includes("model: user selection / parent session") && notice.message.includes("fake/model-steady") && notice.message.includes("efforts: deep, quick; default deep")));

		await command.handler("run --profile fake -- {\"mode\":\"sleep\",\"ms\":60000}", ui.ctx);
		const currentList = await tools.get("agent_get").execute("list", {}, undefined, undefined, ui.ctx);
		const liveId = JSON.parse(currentList.content[0].text).runs[0].id;
		await waitForRun(tools.get("agent_get"), ui.ctx, liveId, "running");
		ui.confirmed = false;
		await command.handler(`stop ${liveId}`, ui.ctx);
		assert.equal((await tools.get("agent_get").execute("get", { id: liveId }, undefined, undefined, ui.ctx)).details.state, "running");
		ui.confirmed = true;
		await command.handler(`stop ${liveId}`, ui.ctx);
		assert.equal((await tools.get("agent_get").execute("get", { id: liveId }, undefined, undefined, ui.ctx)).details.state, "cancelled");
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" }, ui.ctx);
		assert.equal(ui.widgets.size, 0);
	} finally {
		await cleanup();
	}
});

function createHashSession(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex");
}
