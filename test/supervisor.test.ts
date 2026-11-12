import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { checkoutLockPath, CheckoutLockManager } from "../src/checkout-lock.js";
import { getProcessStartIdentity, isProcessGroupAlive, processTokenEnvironment, terminateVerifiedProcessGroup } from "../src/process.js";
import { parseSupervisorConfig, type SupervisorConfig } from "../src/profiles.js";
import { RunStore } from "../src/run-store.js";
import { Supervisor, SupervisorError } from "../src/supervisor.js";
import type { SupervisorPaths } from "../src/config.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const fakeAgent = resolve(fixtureDir, "fixtures/fake-agent.mjs");

function fakeConfig(transport: "argument" | "stdin" = "argument", executable = process.execPath): SupervisorConfig {
	return parseSupervisorConfig({
		defaultProfile: "fake",
		profiles: {
			fake: {
				executable,
				args: transport === "argument" ? [fakeAgent, "--", "{task}"] : [fakeAgent, "--stdin"],
				taskTransport: transport,
			},
		},
	});
}

async function fixture(t: TestContext, options: { maxConcurrent?: number; maxQueued?: number; maxLogBytes?: number; outputTailBytes?: number; stopGraceMs?: number; onRunTerminal?: () => void } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-supervisor-e2e-"));
	const sessionId = `test-session-${Math.random()}`;
	const paths: SupervisorPaths = {
		configDirectory: join(root, "config"),
		profilesFile: join(root, "config", "profiles.json"),
		runtimeDirectory: join(root, "runtime"),
		lockDirectory: join(root, "locks"),
	};
	const supervisor = new Supervisor(fakeConfig(), {
		paths,
		sessionId,
		parentCwd: process.cwd(),
		queueRetryMs: 25,
		stopGraceMs: 100,
		...options,
	});
	await supervisor.initialize();
	t.after(async () => {
		await supervisor.shutdown();
		await rm(root, { recursive: true, force: true });
	});
	return { root, paths, sessionId, supervisor };
}

async function waitForState(supervisor: Supervisor, id: string, predicate: (state: string) => boolean, timeoutMs = 8000) {
	const deadline = Date.now() + timeoutMs;
	let latest = await supervisor.get(id);
	while (!predicate(latest.state) && Date.now() < deadline) {
		await new Promise((resolveWait) => setTimeout(resolveWait, 20));
		latest = await supervisor.get(id);
	}
	assert.ok(predicate(latest.state), `Timed out waiting for run ${id}; last state=${latest.state}`);
	return latest;
}

async function waitForFile(path: string, timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			await stat(path);
			return true;
		} catch {
			await new Promise((resolveWait) => setTimeout(resolveWait, 20));
		}
	}
	return false;
}

function owner(runId: string, pid = process.pid, startIdentity = "dead-process") {
	return { runId, supervisorToken: `supervisor-${runId}`, supervisorPid: pid, supervisorStartIdentity: startIdentity };
}

function jsonLineReader(child: ReturnType<typeof spawn>) {
	const lines = createInterface({ input: child.stdout! });
	const pending: Array<(value: Record<string, unknown>) => void> = [];
	const buffered: Record<string, unknown>[] = [];
	lines.on("line", (line) => {
		const value = JSON.parse(line) as Record<string, unknown>;
		const resolveNext = pending.shift();
		if (resolveNext) resolveNext(value);
		else buffered.push(value);
	});
	return {
		lines,
		next(timeoutMs = 8000): Promise<Record<string, unknown>> {
			const immediate = buffered.shift();
			if (immediate) return Promise.resolve(immediate);
			return new Promise((resolveNext, reject) => {
				const timeout = setTimeout(() => {
					const index = pending.indexOf(resolveNext);
					if (index >= 0) pending.splice(index, 1);
					reject(new Error("Timed out waiting for child supervisor output"));
				}, timeoutMs);
				timeout.unref();
				pending.push((value) => {
					clearTimeout(timeout);
					resolveNext(value);
				});
			});
		},
	};
}

async function waitForMessage(reader: ReturnType<typeof jsonLineReader>, predicate: (value: Record<string, unknown>) => boolean) {
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		const message = await reader.next(Math.max(1, deadline - Date.now()));
		if (predicate(message)) return message;
	}
	throw new Error("Timed out waiting for matching child supervisor message");
}

test("publishes terminal notification only after releasing the checkout writer lock", async (t) => {
	let lockPath = "";
	let lockPresentAtTerminal: boolean | undefined;
	const { supervisor, paths } = await fixture(t, {
		onRunTerminal: () => { lockPresentAtTerminal = existsSync(lockPath); },
	});
	lockPath = checkoutLockPath(paths, await realpath(process.cwd()));
	const run = await supervisor.start({ task: "terminal cleanup ordering" });
	const completed = await waitForState(supervisor, run.id, (state) => state === "exited");
	assert.equal(completed.exitCode, 0);
	assert.equal(lockPresentAtTerminal, false);
});

test("runs a real fake CLI through spawn, stdin/argv, bounded output, and durable exit status", async (t) => {
	const { supervisor, paths } = await fixture(t, { maxLogBytes: 4096, outputTailBytes: 512 });
	const task = "  echo 'quotes' 雪  ";
	const started = await supervisor.start({ task });
	assert.equal(started.state, "queued");
	const completed = await waitForState(supervisor, started.id, (state) => ["exited", "launch_failed", "interrupted"].includes(state));
	assert.equal(completed.state, "exited");
	assert.equal(completed.exitCode, 0);
	assert.match(completed.outputTail, /OUT:  echo 'quotes' 雪  /);
	assert.match(completed.outputTail, /ERR:  echo 'quotes' 雪  /);

	const stdinConfig = fakeConfig("stdin");
	const stdinSupervisor = new Supervisor(stdinConfig, {
		paths,
		sessionId: "stdin-test-session",
		parentCwd: process.cwd(),
		queueRetryMs: 25,
		stopGraceMs: 100,
	});
	await stdinSupervisor.initialize();
	t.after(() => stdinSupervisor.shutdown());
	const stdinTask = "stdin task --with quotes ' and unicode 雪";
	const stdinRun = await stdinSupervisor.start({ task: stdinTask });
	const stdinCompleted = await waitForState(stdinSupervisor, stdinRun.id, (state) => state === "exited");
	assert.ok(stdinCompleted.outputTail.includes(`OUT:${stdinTask}`));
});

test("allows a normal run to write into its checkout without a read-only sandbox", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-supervisor-writable-checkout-"));
	const project = join(root, "checkout");
	await mkdir(project);
	execFileSync("git", ["init", "-q", project]);
	const paths: SupervisorPaths = {
		configDirectory: join(root, "config"),
		profilesFile: join(root, "config", "profiles.json"),
		runtimeDirectory: join(root, "runtime"),
		lockDirectory: join(root, "locks"),
	};
	const supervisor = new Supervisor(fakeConfig(), { paths, sessionId: "writable-checkout", parentCwd: project });
	await supervisor.initialize();
	t.after(async () => {
		await supervisor.shutdown();
		await rm(root, { recursive: true, force: true });
	});
	const marker = join(project, "agent-created-file.txt");
	const started = await supervisor.start({ task: JSON.stringify({ mode: "mark", path: marker }) });
	const completed = await waitForState(supervisor, started.id, (state) => state === "exited");
	assert.equal(completed.exitCode, 0);
	assert.match(await readFile(marker, "utf8"), /^started:/);
});

test("reports nonzero exits as process facts and rejects unavailable executables before admission", async (t) => {
	const { supervisor, paths } = await fixture(t);
	const run = await supervisor.start({ task: JSON.stringify({ mode: "exit", code: 9 }) });
	const result = await waitForState(supervisor, run.id, (state) => state === "exited");
	assert.equal(result.exitCode, 9);
	assert.equal(result.error?.code, "PROCESS_EXIT");

	const missing = new Supervisor(fakeConfig("argument", "no-such-agent-executable-30284"), {
		paths,
		sessionId: "missing-executable-test",
		parentCwd: process.cwd(),
	});
	await missing.initialize();
	await assert.rejects(missing.start({ task: "x" }), (error: unknown) => error instanceof SupervisorError && error.code === "EXECUTABLE_NOT_FOUND");
	await missing.shutdown();
});

test("enforces finite queue capacity, positive timeouts, and cwd checkout boundaries", async (t) => {
	const { supervisor } = await fixture(t, { maxConcurrent: 1, maxQueued: 0 });
	const running = await supervisor.start({ task: JSON.stringify({ mode: "sleep", ms: 500 }) });
	await waitForState(supervisor, running.id, (state) => state === "running");
	await assert.rejects(
		supervisor.start({ task: "overflow" }),
		(error: unknown) => error instanceof SupervisorError && error.code === "CAPACITY_FULL",
	);
	await assert.rejects(
		supervisor.start({ task: "zero timeout", timeoutMs: 0 }),
		(error: unknown) => error instanceof SupervisorError && error.code === "INVALID_TIMEOUT",
	);
	await assert.rejects(
		supervisor.start({ task: "outside cwd", cwd: tmpdir() }),
		(error: unknown) => error instanceof SupervisorError && error.code === "CWD_OUTSIDE_CHECKOUT",
	);
	await supervisor.stop(running.id);
});

test("transitions a queued run to cancelled without ever spawning it", async (t) => {
	const { supervisor, root } = await fixture(t, { maxConcurrent: 1, maxQueued: 2 });
	const marker = join(root, "must-not-exist");
	const running = await supervisor.start({ task: JSON.stringify({ mode: "sleep", ms: 450 }) });
	await waitForState(supervisor, running.id, (state) => state === "running");
	const queued = await supervisor.start({ task: JSON.stringify({ mode: "mark", path: marker }) });
	assert.equal((await supervisor.get(queued.id)).state, "queued");
	const cancelled = await supervisor.stop(queued.id);
	assert.equal(cancelled.state, "cancelled");
	await waitForState(supervisor, running.id, (state) => state === "exited");
	assert.equal(await waitForFile(marker, 150), false);
});

test("stops a running process tree and waits until cleanup is observed", async (t) => {
	const { supervisor, paths, sessionId } = await fixture(t, { maxConcurrent: 1, maxQueued: 1, stopGraceMs: 80 });
	const run = await supervisor.start({ task: JSON.stringify({ mode: "spawn-child", ms: 60_000, ignoreTerm: true }) });
	await waitForState(supervisor, run.id, (state) => state === "running");
	let running = await supervisor.get(run.id);
	const outputDeadline = Date.now() + 2000;
	while (!running.outputTail.includes("DESCENDANT:") && Date.now() < outputDeadline) {
		await new Promise((resolveWait) => setTimeout(resolveWait, 20));
		running = await supervisor.get(run.id);
	}
	const store = new RunStore(paths, sessionId);
	const processMetadata = JSON.parse(await readFile(join(store.directory, `${run.id}.json`), "utf8"));
	assert.ok(running.outputTail.includes("DESCENDANT:"));
	const stopped = await supervisor.stop(run.id);
	assert.equal(stopped.state, "cancelled");
	assert.equal(isProcessGroupAlive(processMetadata.processPid), false);
});

test("cleans up descendants when the direct CLI exits normally", async (t) => {
	const { supervisor, paths, sessionId } = await fixture(t, { stopGraceMs: 80 });
	const run = await supervisor.start({ task: JSON.stringify({ mode: "spawn-child", exitImmediately: true }) });
	const completed = await waitForState(supervisor, run.id, (state) => state === "exited");
	assert.equal(completed.exitCode, 0);
	const store = new RunStore(paths, sessionId);
	await store.initialize();
	const processMetadata = store.get(run.id)!;
	assert.equal(isProcessGroupAlive(processMetadata.processPid!), false);
});

test("times out a child only after process-tree cleanup", async (t) => {
	const { supervisor } = await fixture(t, { stopGraceMs: 80 });
	const run = await supervisor.start({ task: JSON.stringify({ mode: "sleep", ms: 60_000 }), timeoutMs: 150 });
	const timedOut = await waitForState(supervisor, run.id, (state) => state === "timed_out");
	assert.equal(timedOut.error?.code, "TIMEOUT");
	assert.ok(timedOut.endedAt);
});

test("keeps disk logs and model-facing tails within separate configured bounds under output flood", async (t) => {
	const { supervisor, paths, sessionId } = await fixture(t, { maxLogBytes: 512, outputTailBytes: 128 });
	const run = await supervisor.start({ task: JSON.stringify({ mode: "flood", bytes: 100_000 }) });
	const completed = await waitForState(supervisor, run.id, (state) => state === "exited");
	assert.equal(completed.logTruncated, true);
	assert.ok(Buffer.byteLength(completed.outputTail, "utf8") <= 130);
	const store = new RunStore(paths, sessionId);
	await store.initialize();
	const record = store.get(run.id);
	assert.ok(record);
	assert.equal((await stat(completed.logPath)).size, 512);
	assert.equal((await store.tail(record, 512)).length <= 512, true);
});

test("serializes writers across supervisor instances sharing the global checkout lock", async (t) => {
	const { supervisor: first, paths, root } = await fixture(t, { maxConcurrent: 1, maxQueued: 2 });
	const second = new Supervisor(fakeConfig(), {
		paths,
		sessionId: "separate-supervisor-session",
		parentCwd: process.cwd(),
		maxConcurrent: 1,
		maxQueued: 2,
		queueRetryMs: 25,
		stopGraceMs: 100,
	});
	await second.initialize();
	t.after(() => second.shutdown());
	const marker = join(root, "second-writer-started");
	const firstRun = await first.start({ task: JSON.stringify({ mode: "sleep", ms: 350 }) });
	await waitForState(first, firstRun.id, (state) => state === "running");
	const secondRun = await second.start({ task: JSON.stringify({ mode: "mark", path: marker }) });
	assert.equal((await second.get(secondRun.id)).state, "queued");
	assert.equal(await waitForFile(marker, 120), false);
	await waitForState(first, firstRun.id, (state) => state === "exited");
	await waitForState(second, secondRun.id, (state) => state === "exited");
	assert.equal(await waitForFile(marker), true);
});

test("allows writers in separate checkouts to run concurrently", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-supervisor-separate-checkouts-"));
	const lockDirectory = join(root, "global-locks");
	const supervisors: Supervisor[] = [];
	const started: Array<{ supervisor: Supervisor; id: string }> = [];
	for (const [index, name] of ["first", "second"].entries()) {
		const project = join(root, `${name}-checkout`);
		await mkdir(project, { recursive: true });
		execFileSync("git", ["init", "-q", project]);
		const paths: SupervisorPaths = {
			configDirectory: join(root, `config-${index}`),
			profilesFile: join(root, `config-${index}`, "profiles.json"),
			runtimeDirectory: join(root, `runtime-${index}`),
			lockDirectory,
		};
		const supervisor = new Supervisor(fakeConfig(), { paths, sessionId: `separate-checkout-${index}`, parentCwd: project, maxConcurrent: 1, maxQueued: 1 });
		await supervisor.initialize();
		supervisors.push(supervisor);
	}
	t.after(async () => {
		await Promise.all(supervisors.map((supervisor) => supervisor.shutdown()));
		await rm(root, { recursive: true, force: true });
	});
	for (const supervisor of supervisors) started.push({ supervisor, id: (await supervisor.start({ task: JSON.stringify({ mode: "sleep", ms: 30_000 }) })).id });
	const states = await Promise.all(started.map(({ supervisor, id }) => waitForState(supervisor, id, (state) => state === "running")));
	assert.deepEqual(states.map((run) => run.state), ["running", "running"]);
});

test("serializes writers launched by separate OS processes in one checkout", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-supervisor-cross-process-"));
	const paths: SupervisorPaths = {
		configDirectory: join(root, "config"),
		profilesFile: join(root, "config", "profiles.json"),
		runtimeDirectory: join(root, "runtime"),
		lockDirectory: join(root, "locks"),
	};
	const driver = resolve(fixtureDir, "fixtures/writer-driver.mjs");
	const first = spawn(process.execPath, ["--import", "tsx", driver, JSON.stringify(paths), process.cwd(), "os-writer-one", JSON.stringify({ mode: "sleep", ms: 500 })], {
		stdio: ["ignore", "pipe", "inherit"], cwd: process.cwd(),
	});
	const firstReader = jsonLineReader(first);
	let second: ReturnType<typeof spawn> | undefined;
	let secondReader: ReturnType<typeof jsonLineReader> | undefined;
	try {
		await waitForMessage(firstReader, (message) => message.event === "state" && message.state === "running");
		const marker = join(root, "separate-process-writer-marker");
		second = spawn(process.execPath, ["--import", "tsx", driver, JSON.stringify(paths), process.cwd(), "os-writer-two", JSON.stringify({ mode: "mark", path: marker })], {
			stdio: ["ignore", "pipe", "inherit"], cwd: process.cwd(),
		});
		secondReader = jsonLineReader(second);
		const admitted = await waitForMessage(secondReader, (message) => message.event === "admitted");
		assert.equal(admitted.state, "queued");
		assert.equal(await waitForFile(marker, 120), false);
		await waitForMessage(firstReader, (message) => message.event === "state" && message.state === "exited");
		await waitForMessage(secondReader, (message) => message.event === "state" && message.state === "exited");
		assert.equal(await waitForFile(marker), true);
	} finally {
		firstReader.lines.close();
		secondReader?.lines.close();
		if (first.pid && first.exitCode === null) first.kill("SIGKILL");
		if (second?.pid && second.exitCode === null) second.kill("SIGKILL");
		await rm(root, { recursive: true, force: true });
	}
});

test("reclaims stale PID locks but never steals a lock held by a live verified child", async (t) => {
	const { paths } = await fixture(t);
	const checkoutRoot = await realpath(process.cwd());
	const manager = new CheckoutLockManager(paths, 0);
	const stalePath = checkoutLockPath(paths, checkoutRoot);
	await writeFile(stalePath, JSON.stringify({
		...owner("dead-owner", 2_147_000_000, "old"),
		version: 1,
		checkoutRoot,
		createdAt: new Date(0).toISOString(),
		lockToken: "stale-token",
	}));
	const currentIdentity = await getProcessStartIdentity(process.pid);
	assert.ok(currentIdentity);
	const reclaimed = await manager.tryAcquire(checkoutRoot, owner("new-owner", process.pid, currentIdentity));
	assert.ok(reclaimed);
	await reclaimed.release();

	await writeFile(stalePath, JSON.stringify({
		...owner("reused-pid", process.pid, "different-process-start"),
		version: 1,
		checkoutRoot,
		createdAt: new Date(0).toISOString(),
		lockToken: "reused-pid-token",
	}));
	const afterPidReuse = await manager.tryAcquire(checkoutRoot, owner("after-pid-reuse", process.pid, currentIdentity));
	assert.ok(afterPidReuse);
	await afterPidReuse.release();

	const token = `lock-child-${Date.now()}`;
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
		stdio: "ignore",
		detached: process.platform !== "win32",
		env: { ...process.env, ...processTokenEnvironment(token) },
	});
	await once(child, "spawn");
	const childPid = child.pid!;
	const childIdentity = await getProcessStartIdentity(childPid);
	assert.ok(childIdentity);
	await writeFile(stalePath, JSON.stringify({
		...owner("dead-owner", 2_147_000_000, "old"),
		version: 1,
		checkoutRoot,
		createdAt: new Date(0).toISOString(),
		lockToken: "stale-with-live-child",
		childPid,
		childStartIdentity: childIdentity,
		childToken: token,
	}));
	assert.equal(await manager.tryAcquire(checkoutRoot, owner("must-wait")), undefined);
	assert.equal(await terminateVerifiedProcessGroup(childPid, childIdentity, token, 100), true);
	child.kill();
});

test("reconciles durable active runs after a supervisor crash without restarting them", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-supervisor-restart-"));
	const paths: SupervisorPaths = {
		configDirectory: join(root, "config"),
		profilesFile: join(root, "config", "profiles.json"),
		runtimeDirectory: join(root, "runtime"),
		lockDirectory: join(root, "locks"),
	};
	const sessionId = "crash-reconciliation-session";
	const driver = resolve(fixtureDir, "fixtures/restart-driver.mjs");
	const processUnderTest = spawn(process.execPath, [
		"--import", "tsx", driver, JSON.stringify(paths), process.cwd(), sessionId,
	], { stdio: ["ignore", "pipe", "inherit"], cwd: process.cwd() });
	const lines = createInterface({ input: processUnderTest.stdout! });
	let id: string;
	let reportTimeout: NodeJS.Timeout | undefined;
	try {
		const [line] = await Promise.race([
			once(lines, "line").then((values) => values as [string]),
			new Promise<never>((_, reject) => {
				reportTimeout = setTimeout(() => reject(new Error("restart driver did not report a run ID")), 12_000);
				reportTimeout.unref();
			}),
		]);
		if (reportTimeout) clearTimeout(reportTimeout);
		id = (JSON.parse(line) as { id: string }).id;
		const previousStore = new RunStore(paths, sessionId);
		await previousStore.initialize();
		const metadata = JSON.parse(await readFile(join(previousStore.directory, `${id}.json`), "utf8"));
		assert.ok(metadata.processPid);
		processUnderTest.kill("SIGKILL");
		await once(processUnderTest, "close");

		const recovery = new Supervisor(fakeConfig(), { paths, sessionId, parentCwd: process.cwd(), stopGraceMs: 100 });
		await recovery.initialize();
		t.after(() => recovery.shutdown());
		const recovered = await recovery.get(id);
		assert.equal(recovered.state, "interrupted");
		assert.equal(recovered.error?.code, "OWNER_RESTARTED");
		assert.equal(isProcessGroupAlive(metadata.processPid), false);
	} finally {
		if (reportTimeout) clearTimeout(reportTimeout);
		lines.close();
		if (processUnderTest.pid && processUnderTest.exitCode === null) processUnderTest.kill("SIGKILL");
		await rm(root, { recursive: true, force: true });
	}
});

test("records early child stdin closure without an unhandled EPIPE or parent crash", async (t) => {
	const { paths } = await fixture(t);
	const config = parseSupervisorConfig({
		defaultProfile: "early-exit",
		profiles: {
			"early-exit": { executable: process.execPath, args: ["-e", "process.exit(0)"], taskTransport: "stdin" },
		},
	});
	const supervisor = new Supervisor(config, { paths, sessionId: "early-stdin-exit", parentCwd: process.cwd() });
	await supervisor.initialize();
	t.after(() => supervisor.shutdown());
	const started = await supervisor.start({ task: "x".repeat(1024 * 1024) });
	const result = await waitForState(supervisor, started.id, (state) => ["interrupted", "exited"].includes(state));
	assert.equal(result.state, "interrupted");
	assert.equal(result.error?.code, "STDIN_IO");
	assert.match(result.error?.message ?? "", /stdin/i);
	assert.equal(process.exitCode, undefined, "an early child exit must not crash the supervisor process");
});

test("fails a spawn race as launch_failed rather than manufacturing an exit", async (t) => {
	const { root, paths } = await fixture(t);
	const badExecutable = join(root, "bad-agent");
	await writeFile(badExecutable, "#!/definitely/missing/interpreter\nexit 0\n");
	await chmod(badExecutable, 0o755);
	const supervisor = new Supervisor(fakeConfig("argument", badExecutable), {
		paths,
		sessionId: "spawn-failure-session",
		parentCwd: process.cwd(),
		queueRetryMs: 25,
	});
	await supervisor.initialize();
	t.after(() => supervisor.shutdown());
	const run = await supervisor.start({ task: "prompt" });
	const failed = await waitForState(supervisor, run.id, (state) => state === "launch_failed");
	assert.equal(failed.error?.code, "SPAWN_FAILED");
	assert.equal(failed.exitCode, undefined);
});
