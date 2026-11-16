import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test, type TestContext } from "node:test";
import { findOwnedProcesses, isPidAlive, isProcessGroupAlive, terminateOwnedProcessTree } from "../src/process.js";
import { parseSupervisorConfig } from "../src/profiles.js";
import { RunStore, isTerminalState, type StoredRun } from "../src/run-store.js";
import { Supervisor, type SupervisorOptions } from "../src/supervisor.js";

const enabled = process.env.PI_AGENT_SUPERVISOR_STRESS === "1";
const agent = resolve("test/fixtures/stress-agent.mjs");
const config = parseSupervisorConfig({ defaultProfile: "stress", profiles: { stress: {
	executable: process.execPath, args: [agent], taskTransport: "stdin", outputProtocol: "text",
} } });
const task = (input: Record<string, unknown>) => JSON.stringify(input);

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!await predicate() && Date.now() < deadline) await delay(10);
	assert.ok(await predicate(), "stress condition timed out");
}
async function fixture(t: TestContext, options: Partial<SupervisorOptions> = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-supervisor-stress-"));
	const project = join(root, "project");
	await mkdir(project);
	const paths = { configDirectory: join(root, "config"), profilesFile: join(root, "config/profiles.json"), runtimeDirectory: join(root, "runtime") };
	const sessionId = randomUUID();
	const supervisor = new Supervisor(config, { paths, parentCwd: project, sessionId, stopGraceMs: 250, ...options });
	await supervisor.initialize();
	t.after(async () => { await supervisor.shutdown(); await rm(root, { recursive: true, force: true }); });
	const records = async () => { const store = new RunStore(paths, sessionId); await store.initialize(); return store.list(); };
	const completed = async (ids: string[], timeoutMs = 60_000) => {
		await until(() => ids.every((id) => isTerminalState(supervisor.inspect(id).state)), timeoutMs);
		return Promise.all(ids.map((id) => supervisor.get(id)));
	};
	return { root, project, paths, sessionId, supervisor, records, completed };
}
function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Stress Test", "-c", "user.email=stress@example.invalid", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function commit(root: string): void { git(root, "add", "--all"); git(root, "commit", "-qm", "stress artifact"); }

// Opt-in only: these launch actual local processes, never model/provider requests.
test("STRESS all 32 requested agents launch with default options, no queue or count rejection", { skip: !enabled, timeout: 60_000 }, async (t) => {
	const f = await fixture(t);
	const release = join(f.root, "release");
	const runs = await Promise.all(Array.from({ length: 32 }, (_, id) => f.supervisor.start({ task: task({ id: String(id), ready: join(f.root, `ready-${id}`), release, output: join(f.project, `${id}.txt`) }) })));
	assert.ok(runs.every((run) => run.state === "starting"));
	await until(() => runs.every((run) => f.supervisor.inspect(run.id).state === "running"));
	await until(async () => (await readdir(f.root)).filter((file) => /^ready-\d+$/.test(file)).length === 32);
	assert.equal(f.supervisor.snapshot().filter((run) => run.state === "running").length, 32);
	assert.ok(f.supervisor.snapshot().every((run) => run.state !== "queued" && !run.queueReason));
	await Promise.all(runs.slice(0, 5).map((run) => f.supervisor.stop(run.id)));
	assert.ok(runs.slice(5).every((run) => f.supervisor.inspect(run.id).state === "running"));
	const replacements = await Promise.all(Array.from({ length: 5 }, (_, id) => f.supervisor.start({ task: task({ id: `replacement-${id}`, release }) })));
	await until(() => replacements.every((run) => f.supervisor.inspect(run.id).state === "running"));
	assert.equal(f.supervisor.snapshot().filter((run) => run.state === "running").length, 32);
	await writeFile(release, "release");
	const result = await f.completed([...runs, ...replacements].map((run) => run.id));
	assert.equal(result.filter((run) => run.state === "cancelled").length, 5);
	assert.equal(result.filter((run) => run.state === "exited" && run.exitCode === 0).length, 32);
	for (const run of await f.records()) assert.equal(isProcessGroupAlive(run.processPid!), false);
	console.log("STRESS unrestricted admission: all 32 requested agents running with default options; zero queued/rejected; independent stop and five replacement launches verified.");
});

test("STRESS 1,024 shared writers in 64-job test batches preserve stdin, files, append records and durable answers without scheduler limits", { skip: !enabled, timeout: 600_000 }, async (t) => {
	const f = await fixture(t);
	const ledger = join(f.project, "ledger.jsonl");
	const text = "quotes ' \" 雪\nsecond line\u2028third line";
	const startedAt = Date.now();
	const initialRss = process.memoryUsage().rss;
	let peakRss = initialRss;
	let peakActive = 0;
	const queuedStates: string[] = [];
	const dispose = f.supervisor.subscribe(() => {
		const runs = f.supervisor.snapshot();
		const active = runs.filter((run) => ["starting", "running", "stopping"].includes(run.state)).length;
		peakActive = Math.max(peakActive, active);
		peakRss = Math.max(peakRss, process.memoryUsage().rss);
		queuedStates.push(...runs.filter((run) => run.state === "queued").map((run) => run.id));
	});
	t.after(dispose);
	for (let batch = 0; batch < 16; batch++) {
		const ids = Array.from({ length: 64 }, (_, index) => `${batch}-${index}`);
		const release = batch === 0 ? join(f.root, "soak-release") : undefined;
		const runs = await Promise.all(ids.map((id) => f.supervisor.start({ task: task({ id, text, ledger, rows: 8, output: join(f.project, `${id}.txt`), ...(release ? { ready: join(f.root, `ready-${id}`), release } : {}) }) })));
		if (release) {
			await until(async () => (await readdir(f.root)).filter((file) => /^ready-0-\d+$/.test(file)).length === 64);
			assert.equal(f.supervisor.snapshot().filter((run) => run.state === "running").length, 64);
			await writeFile(release, "release");
		}
		const results = await f.completed(runs.map((run) => run.id), 90_000);
		for (const [index, run] of results.entries()) {
			assert.equal(run.state, "exited", run.error?.message ?? "expected normal exit");
			assert.equal(run.exitCode, 0);
			assert.equal(run.presentation?.finalAnswer, `DONE ${ids[index]}`);
			assert.equal(await readFile(join(f.project, `${ids[index]}.txt`), "utf8"), text);
		}
	}
	const rows = (await readFile(ledger, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line) as { id: string; seq: number; text: string });
	assert.equal(rows.length, 8192);
	assert.equal(new Set(rows.map((row) => `${row.id}/${row.seq}`)).size, 8192);
	assert.ok(rows.every((row) => row.text === text));
	const records = await f.records();
	assert.equal(records.length, 1024);
	assert.equal(new Set(records.map((run) => run.id)).size, 1024);
	assert.ok(records.every((run) => run.state === "exited" && run.presentation?.finalAnswer && !isProcessGroupAlive(run.processPid!)));
	assert.deepEqual(queuedStates, []);
	assert.equal(peakActive, 64);
	assert.equal(existsSync(join(f.paths.configDirectory, "locks")), false);
	console.log(JSON.stringify({ stress: "shared-soak", runs: records.length, ledgerRows: rows.length, peakActive, queued: queuedStates.length, elapsedMs: Date.now() - startedAt, initialRssMiB: Math.round(initialRss / 1048576), peakRssMiB: Math.round(peakRss / 1048576) }));
});

test("STRESS colliding read-modify-write really overlaps and demonstrates lost updates, not conflict protection", { skip: !enabled, timeout: 30_000 }, async (t) => {
	const f = await fixture(t);
	const output = join(f.project, "same-file.txt");
	await writeFile(output, "base\n");
	const release = join(f.root, "release");
	const runs = await Promise.all(["A", "B"].map((id) => f.supervisor.start({ task: task({ id, collision: true, output, release, ready: join(f.root, id) }) })));
	await until(() => ["A", "B"].every((id) => existsSync(join(f.root, id))));
	assert.ok(runs.every((run) => f.supervisor.inspect(run.id).state === "running"));
	await writeFile(release, "release");
	assert.ok((await f.completed(runs.map((run) => run.id))).every((run) => run.state === "exited"));
	assert.match(await readFile(output, "utf8"), /^base\n[AB]\n$/);
	console.log("STRESS collision: both writers read the same base before either wrote; one update was lost, as documented for unlocked shared mode.");
});

test("STRESS 16 concurrent worktrees retain isolated edits, merge independent branches and expose real merge conflicts", { skip: !enabled, timeout: 120_000 }, async (t) => {
	const f = await fixture(t);
	git(f.project, "init", "-q", "-b", "main");
	await writeFile(join(f.project, "seed.txt"), "base\n");
	await writeFile(join(f.project, "common.txt"), "base\n");
	commit(f.project);
	const base = git(f.project, "rev-parse", "HEAD");
	await writeFile(join(f.project, "seed.txt"), "parent dirty state\n");
	await writeFile(join(f.project, "untracked.txt"), "not copied");
	const release = join(f.root, "release");
	const runs = await Promise.all(Array.from({ length: 16 }, (_, index) => f.supervisor.start({ isolation: "worktree", task: task({ id: String(index), output: index < 14 ? `artifact-${index}.txt` : "common.txt", text: `${index}\n`, ready: join(f.root, `ready-${index}`), release }) })));
	await until(() => runs.every((_, index) => existsSync(join(f.root, `ready-${index}`))), 60_000);
	assert.ok(runs.every((run) => f.supervisor.inspect(run.id).state === "running"));
	assert.equal(new Set(runs.map((run) => f.supervisor.inspect(run.id).cwd)).size, 16);
	for (const run of runs) {
		const view = f.supervisor.inspect(run.id);
		assert.equal(await readFile(join(view.cwd, "seed.txt"), "utf8"), "base\n");
		assert.equal(existsSync(join(view.cwd, "untracked.txt")), false);
	}
	await writeFile(release, "release");
	const results = await f.completed(runs.map((run) => run.id));
	assert.equal(await readFile(join(f.project, "seed.txt"), "utf8"), "parent dirty state\n");
	assert.equal(git(f.project, "rev-parse", "HEAD"), base);
	for (const [index, run] of results.entries()) {
		assert.equal(run.state, "exited", run.error?.message ?? "expected normal exit");
		assert.equal(run.worktree?.state, "retained");
		assert.equal(await readFile(join(run.cwd, index < 14 ? `artifact-${index}.txt` : "common.txt"), "utf8"), `${index}\n`);
		await assert.rejects(f.supervisor.removeWorktree(run.id), /tracked, untracked or ignored/);
		commit(run.cwd);
	}
	await writeFile(join(f.project, "seed.txt"), "base\n");
	await rm(join(f.project, "untracked.txt"));
	for (const run of results.slice(0, 15)) git(f.project, "merge", "--no-edit", run.worktree!.branch);
	for (let index = 0; index < 14; index++) assert.equal(await readFile(join(f.project, `artifact-${index}.txt`), "utf8"), `${index}\n`);
	assert.throws(() => git(f.project, "merge", "--no-edit", results[15].worktree!.branch));
	assert.equal(git(f.project, "diff", "--name-only", "--diff-filter=U"), "common.txt");
	git(f.project, "merge", "--abort");
	assert.equal(await readFile(join(f.project, "common.txt"), "utf8"), "14\n");
	for (const run of results) {
		await f.supervisor.removeWorktree(run.id);
		assert.equal(existsSync(run.cwd), false);
		assert.ok(git(f.project, "rev-parse", run.worktree!.branch));
	}
	console.log("STRESS worktrees: 16 simultaneously running; dirty parent excluded; 14 independent artifacts merged; overlapping branches conflict; clean cleanup preserves branches.");
});

test("STRESS 16 simultaneous stdout/stderr floods keep independent log caps", { skip: !enabled, timeout: 120_000 }, async (t) => {
	const f = await fixture(t, { maxLogBytes: 32 * 1024, outputTailBytes: 1024 });
	const runs = await Promise.all(Array.from({ length: 16 }, (_, index) => f.supervisor.start({ task: task({ id: String(index), flood: 2 * 1024 * 1024 }) })));
	for (const run of await f.completed(runs.map((run) => run.id))) {
		assert.equal(run.state, "exited", run.error?.message ?? "expected normal exit");
		assert.equal(run.logTruncated, true);
		assert.ok(Buffer.byteLength(run.outputTail) <= 1024);
		for (const path of [run.logPath, run.stdoutPath!, run.stderrPath!]) assert.ok((await stat(path)).size <= 32 * 1024);
	}
	console.log("STRESS output: 64 MiB emitted across 16 children; combined/stdout/stderr each capped at 32 KiB per run.");
});

test("STRESS detached SIGTERM-resistant children that fork during cleanup are removed on exit, stop, timeout and shutdown", { skip: !enabled, timeout: 120_000 }, async (t) => {
	for (const mode of ["exit", "stop", "timeout", "shutdown"] as const) {
		const f = await fixture(t);
		const runs = await Promise.all([0, 1].map((index) => f.supervisor.start({ task: task({ mode: "descendants", id: `${mode}-${index}`, ready: join(f.root, `ready-${index}`), exit: mode === "exit" }), ...(mode === "timeout" ? { timeoutMs: 2000 } : {}) })));
		await until(() => [0, 1].every((index) => existsSync(join(f.root, `ready-${index}`))));
		if (mode === "stop") await Promise.all(runs.map((run) => f.supervisor.stop(run.id)));
		if (mode === "shutdown") await f.supervisor.shutdown();
		const results = await f.completed(runs.map((run) => run.id));
		const expected = mode === "exit" ? "exited" : mode === "timeout" ? "timed_out" : "cancelled";
		assert.ok(results.every((run) => run.state === expected), JSON.stringify(results.map((run) => ({ state: run.state, error: run.error }))));
		for (const record of await f.records()) {
			assert.equal(isProcessGroupAlive(record.processPid!), false);
			assert.deepEqual(await findOwnedProcesses(record.processToken, record.processStartIdentity), []);
		}
		const descendants = (await readdir(f.root)).filter((file) => /^ready-\d\.\d(?:\.fork)?$/.test(file));
		assert.equal(descendants.filter((file) => file.endsWith(".fork")).length, 4, "each detached child must actually fork during SIGTERM cleanup");
		assert.equal(descendants.length, 8);
		for (const file of descendants) assert.equal(isPidAlive(Number(await readFile(join(f.root, file), "utf8"))), false);
	}
	console.log("STRESS cleanup: 8 runs across exit/stop/timeout/shutdown; detached children and SIGTERM-time forks have no surviving token owners.");
});

test("STRESS crash recovery reconciles six valid active runs despite two corrupt records, preserving bad bytes", { skip: !enabled, timeout: 90_000 }, async (t) => {
	const f = await fixture(t);
	const sessionId = randomUUID();
	const driverPath = join(f.root, "driver.mjs");
	const ready = join(f.root, "driver-ready");
	await writeFile(driverPath, `import {Supervisor} from ${JSON.stringify(pathToFileURL(resolve("src/supervisor.ts")).href)};\nimport {existsSync,writeFileSync} from 'node:fs';\nconst s=new Supervisor(${JSON.stringify(config)},${JSON.stringify({ paths: f.paths, parentCwd: f.project, sessionId, stopGraceMs: 250 })});\nawait s.initialize();\nawait Promise.all(Array.from({length:8},(_,i)=>s.start({task:JSON.stringify({id:String(i),ready:${JSON.stringify(f.root)}+'/child-'+i,release:${JSON.stringify(join(f.root, "never-release"))}})})));\nwhile(!Array.from({length:8},(_,i)=>existsSync(${JSON.stringify(f.root)}+'/child-'+i)).every(Boolean)) await new Promise(r=>setTimeout(r,10));\nwriteFileSync(${JSON.stringify(ready)},'ready');\nsetInterval(()=>{},1000);\n`);
	const driver = spawn(process.execPath, ["--import", "tsx", driverPath], { cwd: process.cwd(), stdio: ["ignore", "ignore", "inherit"] });
	const closed = once(driver, "close");
	const store = new RunStore(f.paths, sessionId);
	let original: StoredRun[] = [];
	let recovery: Supervisor | undefined;
	try {
		await until(() => existsSync(ready));
		await store.initialize();
		original = store.list();
		assert.equal(original.length, 8);
		driver.kill("SIGKILL");
		await closed;
		const corrupt = ["{malformed", JSON.stringify({ ...original[1], processToken: "not-an-ownership-token" })];
		for (const [index, bytes] of corrupt.entries()) await writeFile(join(store.directory, `${original[index].id}.json`), bytes);
		recovery = new Supervisor(config, { paths: f.paths, parentCwd: f.project, sessionId, stopGraceMs: 250 });
		await recovery.initialize();
		assert.equal(recovery.recoveryWarnings.length, 2);
		assert.equal(recovery.snapshot().length, 6);
		for (const run of original.slice(2)) {
			assert.equal(recovery.inspect(run.id).state, "interrupted");
			assert.equal(isProcessGroupAlive(run.processPid!), false);
			assert.deepEqual(await findOwnedProcesses(run.processToken, run.processStartIdentity), []);
		}
		for (const [index, bytes] of corrupt.entries()) {
			assert.equal(await readFile(join(store.directory, `${original[index].id}.json`), "utf8"), bytes);
			assert.equal(isPidAlive(original[index].processPid!), true, "invalid metadata must not authorize signalling");
		}
		console.log("STRESS recovery: killed an 8-run supervisor; six valid runs reconciled, two corrupt records untouched and unauthoritative; test-owned originals used for explicit final cleanup.");
	} finally {
		if (driver.exitCode === null && driver.signalCode === null) { driver.kill("SIGKILL"); await closed; }
		await recovery?.shutdown();
		if (!original.length) { await store.initialize(); original = store.list(); }
		for (const run of original) assert.equal(await terminateOwnedProcessTree(run.processPid, run.processStartIdentity, run.processToken, 250), true);
	}
});
