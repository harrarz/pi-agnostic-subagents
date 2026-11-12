import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Supervisor } from "../src/supervisor.js";
import { parseSupervisorConfig } from "../src/profiles.js";
import { RunStore, isTerminalState } from "../src/run-store.js";
import type { OutputProtocol } from "../src/presentation.js";

async function setup(t: TestContext, outputProtocol: OutputProtocol = "pi-jsonl", maxLogBytes = 1024 * 1024) {
	const root = await mkdtemp(join(tmpdir(), "pi-supervisor-presentation-"));
	const paths = { configDirectory: join(root, "config"), profilesFile: join(root, "config/profiles.json"), runtimeDirectory: join(root, "runtime"), lockDirectory: join(root, "locks") };
	const supervisor = new Supervisor(parseSupervisorConfig({ defaultProfile: "third-party", profiles: { "third-party": {
		executable: process.execPath, args: [resolve("test/fixtures/fake-agent.mjs"), "--", "{task}"], taskTransport: "argument", outputProtocol,
	} } }), { paths, parentCwd: process.cwd(), sessionId: "presentation-e2e", queueRetryMs: 20, maxLogBytes });
	await supervisor.initialize();
	t.after(async () => { await supervisor.shutdown(); await rm(root, { recursive: true, force: true }); });
	return { supervisor, paths };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 8000;
	while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
	assert.ok(predicate(), "condition timed out");
}

test("noisy real child yields clean activity, durable answer and independent diagnostics", async (t) => {
	const { supervisor, paths } = await setup(t);
	let changes = 0;
	const unsubscribe = supervisor.subscribe(() => { changes++; });
	const started = await supervisor.start({ task: JSON.stringify({ mode: "pi-output", ms: 350 }), label: "auth-check" });
	await waitUntil(() => supervisor.inspect(started.id).presentation?.activity === "read · src/auth.ts");
	assert.equal(supervisor.inspect(started.id).presentation?.finalAnswer, undefined);
	assert.equal(supervisor.snapshot()[0].label, "auth-check");
	assert.equal(supervisor.snapshot()[0].sessionId, "presentation-e2e");
	assert.equal("transcript" in supervisor.snapshot()[0].presentation!, false);
	const snapshot = supervisor.snapshot();
	snapshot[0].label = "MUTATED";
	assert.equal(supervisor.inspect(started.id).label, "auth-check");
	await waitUntil(() => isTerminalState(supervisor.inspect(started.id).state));
	const completed = await supervisor.get(started.id);
	assert.equal(completed.state, "exited");
	assert.equal(completed.presentation?.finalAnswer, "Clean final answer 雪");
	assert.doesNotMatch(JSON.stringify(completed.presentation), /HIDDEN REASONING|FORGED STDERR/);
	assert.match(await readFile(completed.stdoutPath!, "utf8"), /HIDDEN REASONING/);
	assert.match(await readFile(completed.stderrPath!, "utf8"), /FORGED STDERR/);
	assert.doesNotMatch(await readFile(completed.stdoutPath!, "utf8"), /FORGED STDERR/);
	assert.equal((await stat(completed.stderrPath!)).mode & 0o777, 0o600);
	const restored = new RunStore(paths, "presentation-e2e");
	await restored.initialize();
	assert.equal(restored.get(started.id)?.presentation?.finalAnswer, "Clean final answer 雪");
	assert.ok(changes >= 3);
	unsubscribe();
	const count = changes;
	await supervisor.start({ task: "no listener" });
	assert.equal(changes, count);
});

test("queue exposes checkout contention, and cancellation never launches queued work", async (t) => {
	const { supervisor } = await setup(t);
	const first = await supervisor.start({ task: JSON.stringify({ mode: "sleep", ms: 60_000 }) });
	await waitUntil(() => supervisor.inspect(first.id).state === "running");
	const second = await supervisor.start({ task: "must remain queued" });
	await waitUntil(() => supervisor.inspect(second.id).queueReason === "Checkout busy");
	assert.equal(supervisor.snapshot().filter((run) => run.state === "queued").length, 1);
	await supervisor.stop(second.id);
	assert.equal(supervisor.inspect(second.id).state, "cancelled");
	assert.equal(supervisor.inspect(second.id).startedAt, undefined);
});

test("all diagnostic channels remain independently bounded during a flood", async (t) => {
	const { supervisor } = await setup(t, "raw", 2048);
	const run = await supervisor.start({ task: JSON.stringify({ mode: "flood", bytes: 30_000 }) });
	await waitUntil(() => isTerminalState(supervisor.inspect(run.id).state));
	const completed = await supervisor.get(run.id);
	for (const path of [completed.logPath, completed.stdoutPath!, completed.stderrPath!]) assert.ok((await stat(path)).size <= 2048);
	assert.equal(completed.presentation?.finalAnswer, undefined);
});

test("shutdown drains in-flight checkout acquisition before returning", async (t) => {
	for (let attempt = 0; attempt < 4; attempt++) {
		const { supervisor, paths } = await setup(t, "raw");
		const run = await supervisor.start({ task: JSON.stringify({ mode: "sleep", ms: 60_000 }) });
		await supervisor.shutdown();
		assert.ok(isTerminalState(supervisor.inspect(run.id).state));
		await rm(paths.lockDirectory, { recursive: true, force: true });
		await new Promise((done) => setTimeout(done, 50));
		await assert.rejects(() => stat(paths.lockDirectory), { code: "ENOENT" });
	}
});

test("invalid labels fail before any run is admitted", async (t) => {
	const { supervisor } = await setup(t);
	for (const label of ["", "x".repeat(81), "bad\x1btitle", "two\nlines"]) {
		await assert.rejects(() => supervisor.start({ task: "task", label }), /label/);
	}
	assert.equal(supervisor.snapshot().length, 0);
});
