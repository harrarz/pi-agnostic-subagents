import assert from "node:assert/strict";
import { test } from "node:test";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { AgentBrowser, attachRunWidget, watchRuns, widgetLines } from "../src/ui.js";
import { browserActions, executeBrowserRequest, type BrowserRequest } from "../src/ui-actions.js";
import type { PiCommandContext } from "../src/pi-api.js";
import { safeText } from "../src/display.js";
import { registerAgentTools, renderAgentResult } from "../src/tools.js";
import type { RunSummary } from "../src/run-store.js";
import type { Supervisor } from "../src/supervisor.js";
import type { PiContext, PiExtensionApi } from "../src/pi-api.js";

const theme = { fg: (_name: string, text: string) => text, bg: (_name: string, text: string) => text } as Theme;
const keys = { matches: (data: string, action: string) => data === ({ "tui.select.cancel": "escape", "tui.select.confirm": "enter", "tui.select.up": "up", "tui.select.down": "down" } as Record<string, string>)[action] } as KeybindingsManager;

function run(index: number, state: RunSummary["state"] = "running"): RunSummary {
	return {
		id: `${String(index).padStart(8, "0")}-0000-0000-0000-000000000000`,
		label: `agent-${index} 雪`, sessionId: "parent-session", profile: "pi", model: "provider/model", effortAlias: "high",
		task: `Task ${index}`, cwd: "/repo", state, createdAt: new Date(Date.now() - 5000).toISOString(),
		logPath: "/private/combined.log", logTruncated: false,
		presentation: { activity: "read · auth.ts" },
	};
}
class FakeSupervisor {
	runs: RunSummary[] = [run(1), run(2, "queued")];
	listeners = new Set<() => void>();
	stops: string[] = [];
	gets = 0;
	subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	snapshot() { return structuredClone(this.runs); }
	inspect(id: string) {
		const record = this.runs.find((item) => item.id === id)!;
		return { ...structuredClone(record), presentation: { ...record.presentation, transcript: Array.from({ length: 30 }, (_, i) => ({ kind: "assistant" as const, text: `transcript-${i} 雪 ${"long ".repeat(10)}` })) } };
	}
	async get(id: string) { this.gets++; return { ...this.inspect(id), outputTail: "RAW DIAGNOSTIC\x1b[31m\x1b]0;malicious-title\x07", logTruncated: true }; }
	async stop(id: string) { this.stops.push(id); this.runs.find((item) => item.id === id)!.state = "cancelled"; this.emit(); return this.inspect(id); }
	emit() { for (const listener of this.listeners) listener(); }
	asSupervisor() { return this as unknown as Supervisor; }
}
const delay = (ms = 120) => new Promise((done) => setTimeout(done, ms));

function browser(fake = new FakeSupervisor(), height = 24) {
	let renders = 0;
	let closed = false;
	const dimensions = { rows: height };
	const view = new AgentBrowser(fake.asSupervisor(), theme, keys, () => { renders++; }, () => dimensions.rows, () => { closed = true; });
	return { fake, view, dimensions, get renders() { return renders; }, get closed() { return closed; } };
}

test("browser renders parentage and status without reading diagnostic logs", () => {
	const { fake, view } = browser();
	try {
		const lines = view.render(100).join("\n");
		assert.match(lines, /main · parent session parent-s/);
		assert.match(lines, /agent-1.*running/);
		assert.match(lines, /agent-2.*queued/);
		assert.equal(fake.gets, 0);
	} finally { view.dispose(); }
	assert.equal(fake.listeners.size, 0);
});

test("selection stays on the same identity as new runs arrive", async () => {
	const { fake, view } = browser();
	try {
		view.handleInput("down");
		fake.runs.unshift(run(3));
		fake.emit();
		await delay();
		const selected = view.render(100).find((line) => line.includes("›"));
		assert.match(selected!, /agent-2/);
		assert.equal(fake.gets, 0);
	} finally { view.dispose(); }
});

test("answer and transcript are separate, scrollable views; diagnostics are opt-in", async () => {
	const { fake, view } = browser();
	try {
		view.handleInput("enter");
		assert.match(view.render(100).join("\n"), /Final answer/);
		assert.doesNotMatch(view.render(100).join("\n"), /RAW DIAGNOSTIC|transcript-0/);
		view.handleInput("t");
		assert.match(view.render(100).join("\n"), /transcript-0/);
		for (let i = 0; i < 8; i++) view.handleInput("down");
		assert.doesNotMatch(view.render(100).join("\n"), /Parent: main/);
		view.handleInput("d");
		await delay(0);
		const diagnostics = view.render(100).join("\n");
		assert.equal(fake.gets, 1);
		assert.match(diagnostics, /RAW DIAGNOSTIC/);
		assert.doesNotMatch(diagnostics, /\x1b\[31m|malicious-title/);
		view.handleInput("escape");
		assert.match(view.render(100).join("\n"), /list/);
	} finally { view.dispose(); }
});

test("stop needs confirmation, and Escape cancels without touching the process", async () => {
	const { fake, view } = browser();
	try {
		view.handleInput("s");
		assert.match(view.render(100).join("\n"), /terminate its process tree/);
		assert.equal(fake.stops.length, 0);
		view.handleInput("escape");
		assert.equal(fake.stops.length, 0);
		view.handleInput("s");
		view.handleInput("y");
		await delay(0);
		assert.deepEqual(fake.stops, [fake.runs[0].id]);
		assert.match(view.render(100).join("\n"), /cancelled/);
	} finally { view.dispose(); }
});

test("height, resize and Unicode width are bounded in every browser view", () => {
	const fake = new FakeSupervisor();
	fake.runs = Array.from({ length: 50 }, (_, i) => run(i));
	const { view, dimensions } = browser(fake);
	try {
		for (const mode of ["enter", "t", "escape"]) {
			view.handleInput(mode);
			for (const height of [7, 12, 24, 50]) {
				dimensions.rows = height;
				for (const width of [1, 8, 25, 60, 120]) {
					const lines = view.render(width);
					assert.ok(lines.length <= Math.max(3, height - 4), `${mode} height ${height}`);
					assert.ok(lines.every((line) => visibleWidth(line) <= width), `${mode} width ${width}`);
				}
			}
		}
		view.invalidate();
	} finally { view.dispose(); }
});

test("long lists scroll the selection into view", () => {
	const fake = new FakeSupervisor();
	fake.runs = Array.from({ length: 50 }, (_, i) => run(i));
	const { view } = browser(fake, 12);
	try {
		for (let i = 0; i < 40; i++) view.handleInput("down");
		const lines = view.render(100);
		assert.match(lines.find((line) => line.includes("›"))!, /agent-40/);
		assert.ok(lines.length <= 8);
	} finally { view.dispose(); }
});

test("inline actions depend on state/capabilities and left/right select without launching", () => {
	const fake = new FakeSupervisor();
	fake.runs[0].capabilities = { steer: true, followUp: false };
	const requests: BrowserRequest[] = [];
	const view = new AgentBrowser(fake.asSupervisor(), theme, keys, () => {}, () => 24, (request) => { if (request) requests.push(request); });
	try {
		assert.match(view.render(110).join("\n"), /\[Inspect\].*Steer.*Stop/);
		view.handleInput("\x1b[C");
		assert.equal(requests.length, 0);
		assert.match(view.render(110).join("\n"), /\[Steer\]/);
		view.handleInput("enter");
		assert.deepEqual(requests, [{ id: fake.runs[0].id, action: "steer" }]);
		view.handleInput("down");
		view.handleInput("\x1b[C");
		assert.match(view.render(110).join("\n"), /\[Cancel\]/);
		view.handleInput("enter");
		assert.equal(fake.stops.length, 0);
		assert.match(view.render(110).join("\n"), /process tree/);
	} finally { view.dispose(); }
	assert.deepEqual(browserActions(run(3, "running")), ["inspect", "stop"]);
	assert.deepEqual(browserActions(run(3, "exited")), ["inspect", "rerun", "editRerun"]);
	assert.deepEqual(browserActions(run(3, "stopping")), ["inspect"]);
});

test("browser paints a complete fixed-size rectangle, including blank cells, after view changes", () => {
	const { view } = browser();
	try {
		for (const key of ["enter", "escape", "t", "escape"]) {
			view.handleInput(key);
			const lines = view.render(80);
			assert.equal(lines.length, 20);
			assert.ok(lines.every((line) => visibleWidth(line) === 80));
			assert.match(lines[0], /^╭─+╮$/);
			assert.match(lines.at(-1)!, /^╰─+╯$/);
			assert.ok(lines.slice(1, -1).every((line) => line.startsWith("│") && line.endsWith("│")));
		}
	} finally { view.dispose(); }
});

test("rerun editing preserves choices, can clear a timeout, and requires final confirmation", async () => {
	const record = { ...run(3, "timed_out"), timeoutMs: 300000 };
	const choices = ["Timeout", "Isolation", "worktree", "Run"];
	let changes: Record<string, unknown> | undefined;
	const supervisor = { inspect: () => record, async rerun(_id: string, input: Record<string, unknown>) { changes = input; return { id: "fresh" }; } } as unknown as Supervisor;
	const ctx = { ui: {
		async select(_title: string, options: string[]) { const prefix = choices.shift()!; return options.find((option) => option.startsWith(prefix)); },
		async editor() { return ""; }, async confirm() { return true; }, notify() {},
	} } as unknown as PiCommandContext;
	assert.equal(await executeBrowserRequest(ctx, supervisor, { id: record.id, action: "editRerun" }), "fresh");
	assert.equal(changes!.timeoutMs, undefined);
	assert.equal(Object.hasOwn(changes!, "timeoutMs"), true);
	assert.equal(changes!.model, record.model);
	assert.equal(changes!.isolation, "worktree");
	changes = undefined;
	ctx.ui.confirm = async () => false;
	await executeBrowserRequest(ctx, supervisor, { id: record.id, action: "rerun" });
	assert.equal(changes, undefined);
});

test("late steering fails without silently following up or starting another run", async () => {
	const record = run(3, "running");
	const calls: string[] = [];
	const supervisor = { inspect: () => record, async steer() { calls.push("steer"); throw new Error("already settled"); }, async followUp() { calls.push("followUp"); }, async start() { calls.push("start"); } } as unknown as Supervisor;
	const ctx = { ui: { async editor() { return "redirect"; } } } as unknown as PiCommandContext;
	await assert.rejects(executeBrowserRequest(ctx, supervisor, { id: record.id, action: "steer" }), /already settled/);
	assert.deepEqual(calls, ["steer"]);
});

test("widget bounds its rows and names overflow instead of filling the terminal", () => {
	const runs = Array.from({ length: 10 }, (_, i) => run(i));
	for (const width of [1, 15, 50, 120]) {
		const lines = widgetLines(runs, width, 24, theme);
		assert.ok(lines.length <= 7);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	assert.match(widgetLines(runs, 120, 24, theme).join("\n"), /more/);
	assert.deepEqual(widgetLines([], 80, 24, theme), []);
});

test("event coalescing and disposal cancel pending renders and unsubscribe", async () => {
	const fake = new FakeSupervisor();
	let renders = 0;
	const dispose = watchRuns(fake.asSupervisor(), () => { renders++; });
	fake.emit(); fake.emit(); fake.emit();
	await delay();
	assert.equal(renders, 1);
	fake.emit();
	dispose(); dispose();
	await delay();
	assert.equal(renders, 1);
	assert.equal(fake.listeners.size, 0);
});

test("closing browser stops live updates, and theme invalidation rebuilds styled lines", async () => {
	const fixture = browser();
	fixture.view.handleInput("escape");
	assert.equal(fixture.closed, true);
	fixture.view.dispose();
	fixture.fake.emit();
	await delay();
	assert.equal(fixture.renders, 0);
	assert.equal(fixture.fake.listeners.size, 0);
	const original = theme.fg;
	try {
		theme.fg = (_color, text) => `THEME ${text}`;
		fixture.view.invalidate();
		assert.match(fixture.view.render(100).join("\n"), /THEME/);
	} finally { theme.fg = original; }
});

test("TUI widget factory is not called in JSON, RPC or print modes", () => {
	for (const mode of ["json", "rpc", "print"] as const) {
		let called = false;
		const dispose = attachRunWidget({ mode, ui: { setWidget() { called = true; } } } as unknown as PiContext, new FakeSupervisor().asSupervisor());
		dispose();
		assert.equal(called, false);
	}
});

test("tool response bounds apply after JSON escaping, not just to source characters", async () => {
	const fake = new FakeSupervisor();
	const inspect = fake.inspect.bind(fake);
	fake.inspect = (id) => {
		const record = inspect(id);
		record.presentation.transcript = [{ kind: "assistant", text: "\x00".repeat(24 * 1024) }];
		return record;
	};
	const tools = new Map<string, { execute: Function }>();
	registerAgentTools({ registerTool: (tool: { name: string; execute: Function }) => tools.set(tool.name, tool) } as unknown as PiExtensionApi, async () => fake.asSupervisor());
	const result = await tools.get("agent_get")!.execute("get", { id: fake.runs[0].id, format: "transcript" }, undefined, undefined, {});
	const text = result.content[0].text;
	assert.ok(Buffer.byteLength(text) < 50 * 1024);
	assert.ok(text.split("\n").length < 2000);
	assert.match(text, /Response truncated/);
	assert.match(text, /combined.log/);
});

test("compact tool rendering does not dump raw JSON, and strips terminal controls", () => {
	const result = { content: [{ type: "text", text: "{\"outputTail\":\"SECRET RAW\"}" }], details: { summary: "auth-check · running\nReading auth.ts\x1b[31m" } };
	const compact = renderAgentResult(result, { expanded: false, isPartial: false }, theme).render(100).join("\n");
	assert.match(compact, /auth-check/);
	assert.doesNotMatch(compact, /SECRET RAW|\x1b/);
	assert.equal(safeText("\x1b]0;title\x07hello\x1b[31m"), "hello");
});
