import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { findOwnedProcesses, getProcessStartIdentity, isProcessGroupAlive, processTokenEnvironment, terminateOwnedProcessTree } from "../src/process.js";
import { parseSupervisorConfig, type SupervisorConfig } from "../src/profiles.js";
import { RunStore, type StoredRun } from "../src/run-store.js";
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

async function fixture(t: TestContext, options: { maxLogBytes?: number; outputTailBytes?: number; stopGraceMs?: number; onRunTerminal?: () => void } = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-supervisor-e2e-"));
	const sessionId = `test-session-${Math.random()}`;
	const paths: SupervisorPaths = {
		configDirectory: join(root, "config"),
		profilesFile: join(root, "config", "profiles.json"),
		runtimeDirectory: join(root, "runtime"),
	};
	const supervisor = new Supervisor(fakeConfig(), {
		paths,
		sessionId,
		parentCwd: root,
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

test("shared writers run concurrently by default in a non-Git folder", async (t) => {
	const { supervisor, root } = await fixture(t);
	await writeFile(join(root, "tracked.txt"), "shared input");
	const first = await supervisor.start({ task: JSON.stringify({ mode: "workspace", file: "first.txt", text: "one", ms: 60_000 }) });
	const second = await supervisor.start({ task: JSON.stringify({ mode: "workspace", file: "second.txt", text: "two", ms: 60_000 }), isolation: "shared" });
	await Promise.all([first, second].map((run) => waitForState(supervisor, run.id, (state) => state === "running")));
	assert.equal(await waitForFile(join(root, "first.txt")), true);
	assert.equal(await waitForFile(join(root, "second.txt")), true);
	assert.equal(supervisor.inspect(first.id).cwd, supervisor.inspect(second.id).cwd);
	assert.equal(supervisor.inspect(first.id).isolation, "shared");
	assert.equal(await readFile(join(root, "first.txt"), "utf8"), "one");
	assert.equal(await readFile(join(root, "second.txt"), "utf8"), "two");
	await supervisor.stop(first.id);
	assert.equal(supervisor.inspect(second.id).state, "running");
	await supervisor.stop(second.id);
});

test("runs a real fake CLI through spawn, stdin/argv, bounded output, and durable exit status", async (t) => {
	const { supervisor, paths } = await fixture(t, { maxLogBytes: 4096, outputTailBytes: 512 });
	const task = "  echo 'quotes' 雪  ";
	const started = await supervisor.start({ task });
	assert.equal(started.state, "starting");
	const completed = await waitForState(supervisor, started.id, (state) => ["exited", "launch_failed", "interrupted"].includes(state));
	assert.equal(completed.state, "exited");
	assert.equal(completed.exitCode, 0);
	assert.match(completed.outputTail, /OUT:  echo 'quotes' 雪  /);
	assert.match(completed.outputTail, /ERR:  echo 'quotes' 雪  /);

	// True/false can exit before macOS ps (or /proc) records a birth identity.
	// Observe the actual child exit and retain the same descendant-cleanup gate.
	const fastSupervisor = new Supervisor(parseSupervisorConfig({ defaultProfile: "fast-exit", profiles: {
		"fast-exit": { executable: "true", args: ["{task}"], taskTransport: "argument" },
		"fast-fail": { executable: "false", args: ["{task}"], taskTransport: "argument" },
	} }), { paths, sessionId: "fast-argv-test-session", parentCwd: process.cwd(), stopGraceMs: 100 });
	await fastSupervisor.initialize();
	t.after(() => fastSupervisor.shutdown());
	for (const profile of ["fast-exit", "fast-fail"]) {
		for (let attempt = 0; attempt < 4; attempt++) {
			const run = await fastSupervisor.start({ task: "fixture", profile });
			const completed = await waitForState(fastSupervisor, run.id, (state) => ["exited", "interrupted", "launch_failed"].includes(state));
			assert.equal(completed.state, "exited");
			assert.equal(completed.exitCode, profile === "fast-exit" ? 0 : 1);
			assert.equal(completed.error?.code, profile === "fast-exit" ? undefined : "PROCESS_EXIT");
		}
	}

	const stdinConfig = fakeConfig("stdin");
	const stdinSupervisor = new Supervisor(stdinConfig, {
		paths,
		sessionId: "stdin-test-session",
		parentCwd: process.cwd(),
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

test("launches more than ten agents without overrides while preserving timeout and cwd validation", async (t) => {
	const { supervisor } = await fixture(t);
	const task = JSON.stringify({ mode: "sleep", ms: 60_000 });
	const runs = await Promise.all(Array.from({ length: 12 }, () => supervisor.start({ task })));
	assert.ok(runs.every((run) => run.state === "starting"));
	await Promise.all(runs.map((run) => waitForState(supervisor, run.id, (state) => state === "running")));
	assert.equal(supervisor.snapshot().filter((run) => run.state === "running").length, 12);
	assert.equal("maxConcurrent" in supervisor.limits, false);
	assert.equal("maxQueued" in supervisor.limits, false);
	await assert.rejects(
		supervisor.start({ task: "zero timeout", timeoutMs: 0 }),
		(error: unknown) => error instanceof SupervisorError && error.code === "INVALID_TIMEOUT",
	);
	await assert.rejects(
		supervisor.start({ task: "outside cwd", cwd: tmpdir() }),
		(error: unknown) => error instanceof SupervisorError && error.code === "CWD_OUTSIDE_CHECKOUT",
	);
	await Promise.all(runs.map((run) => supervisor.stop(run.id)));
});

test("can cancel a newly admitted starting run before process creation without a scheduler queue", async (t) => {
	const { supervisor, root, paths, sessionId } = await fixture(t);
	const marker = join(root, "must-not-exist");
	let stopping: ReturnType<Supervisor["stop"]> | undefined;
	const unsubscribe = supervisor.subscribe(() => {
		const run = supervisor.snapshot().find((run) => run.label === "cancel-before-spawn" && run.state === "starting");
		if (run && !stopping) stopping = supervisor.stop(run.id);
	});
	t.after(unsubscribe);
	const started = await supervisor.start({ task: JSON.stringify({ mode: "mark", path: marker }), label: "cancel-before-spawn" });
	assert.ok(stopping);
	assert.equal((await stopping).state, "cancelled");
	assert.equal(supervisor.inspect(started.id).startedAt, undefined);
	assert.equal(await waitForFile(marker, 150), false);
	const stored = new RunStore(paths, sessionId); await stored.initialize();
	assert.equal(stored.get(started.id)!.state, "cancelled");
	assert.equal(stored.get(started.id)!.processPid, undefined);
});

test("shutdown waits for tracked launches to finish persisting terminal records", async (t) => {
	const { supervisor } = await fixture(t);
	const persist = RunStore.prototype.persist;
	let release!: () => void;
	const gate = new Promise<void>((done) => { release = done; });
	t.mock.method(RunStore.prototype, "persist", async function (this: RunStore, record: StoredRun) {
		if (record.state === "exited") await gate;
		return persist.call(this, record);
	});
	try {
		const run = await supervisor.start({ task: JSON.stringify({ mode: "exit", code: 0 }) });
		const deadline = Date.now() + 8000;
		while (supervisor.inspect(run.id).state !== "exited" && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
		assert.equal(supervisor.inspect(run.id).state, "exited");
		let settled = false;
		const shutdown = supervisor.shutdown().then(() => { settled = true; });
		await new Promise((done) => setTimeout(done, 30));
		assert.equal(settled, false);
		release();
		await shutdown;
		assert.equal(settled, true);
	} finally { release(); }
});

test("legacy queued records are interrupted on recovery, never scheduled or restarted", async (t) => {
	const { root, paths, sessionId } = await fixture(t);
	const store = new RunStore(paths, sessionId); await store.initialize();
	const marker = join(root, "legacy-must-not-launch");
	const record = store.create({ sessionId, supervisorToken: randomUUID(), processToken: randomUUID(),
		profile: "fake", task: JSON.stringify({ mode: "mark", path: marker }), cwd: root,
		state: "queued", queueReason: "Concurrency limit", createdAt: new Date().toISOString() });
	await store.createLog(record); await store.persist(record);
	const recovered = new Supervisor(fakeConfig(), { paths, sessionId, parentCwd: root });
	t.after(() => recovered.shutdown());
	await recovered.initialize();
	const run = await recovered.get(record.id);
	assert.equal(run.state, "interrupted");
	assert.equal(run.error?.code, "OWNER_RESTARTED");
	assert.equal(run.queueReason, undefined);
	assert.equal(run.startedAt, undefined);
	assert.equal(await waitForFile(marker, 100), false);
});

test("stops a running process tree and waits until cleanup is observed", async (t) => {
	const { supervisor, paths, sessionId, root } = await fixture(t, { stopGraceMs: 80 });
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
	const originalPath = process.env.PATH;
	const shimDirectory = join(root, "ps-shim");
	const marker = join(root, "inspection-gap-observed");
	let realPs = "";
	const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
	if (process.platform === "darwin") {
		realPs = execFileSync("which", ["ps"], { encoding: "utf8" }).trim();
		await mkdir(shimDirectory);
		await writeFile(join(shimDirectory, "ps"), `#!/bin/sh\nif [ "$1" = eww ] && [ "$2" = -U ] && [ ! -e ${quote(marker)} ]; then : > ${quote(marker)}; exit 1; fi\nexec ${quote(realPs)} "$@"\n`, { mode: 0o700 });
		process.env.PATH = `${shimDirectory}:${originalPath ?? ""}`;
	}
	try {
		const stopped = await supervisor.stop(run.id);
		assert.equal(stopped.state, "cancelled", JSON.stringify(stopped.error));
		assert.equal(isProcessGroupAlive(processMetadata.processPid), false);
		if (process.platform === "darwin") assert.equal(await waitForFile(marker, 100), true);
	} finally {
		if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
	}
	if (process.platform === "darwin") {
		// A persistent inspection failure must remain interrupted, not clean.
		const uncertain = await supervisor.start({ task: JSON.stringify({ mode: "sleep", ms: 60_000, ignoreTerm: true }) });
		await waitForState(supervisor, uncertain.id, (state) => state === "running");
		const metadata = JSON.parse(await readFile(join(store.directory, `${uncertain.id}.json`), "utf8"));
		await writeFile(join(shimDirectory, "ps"), `#!/bin/sh\nif [ "$1" = eww ] && [ "$2" = -U ]; then exit 1; fi\nexec ${quote(realPs)} "$@"\n`, { mode: 0o700 });
		process.env.PATH = `${shimDirectory}:${originalPath ?? ""}`;
		try {
			const stopped = await supervisor.stop(uncertain.id);
			assert.equal(stopped.state, "interrupted");
			assert.equal(stopped.error?.code, "CLEANUP_UNVERIFIED");
			assert.equal(isProcessGroupAlive(metadata.processPid), false);
		} finally {
			if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
		}
	} else if (process.platform === "linux") {
		// A process predating the run cannot be an inheriting descendant, even
		// if a test deliberately gives it the same marker. Never signal it.
		const token = randomUUID();
		const options = { env: { ...process.env, ...processTokenEnvironment(token) }, detached: true, stdio: "ignore" as const };
		const older = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
		const olderClosed = once(older, "close");
		let younger: ReturnType<typeof spawn> | undefined;
		let youngerClosed: ReturnType<typeof once> | undefined;
		try {
			await once(older, "spawn");
			await new Promise((done) => setTimeout(done, 30));
			younger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options);
			youngerClosed = once(younger, "close");
			await once(younger, "spawn");
			const identity = await getProcessStartIdentity(younger.pid!);
			assert.ok(identity);
			const owned = await findOwnedProcesses(token, identity);
			assert.ok(owned);
			assert.ok(owned.some((entry) => entry.pid === younger!.pid));
			assert.equal(owned.some((entry) => entry.pid === older.pid), false);
			assert.equal(await terminateOwnedProcessTree(younger.pid, identity, token, 100, true), true);
			assert.equal(older.exitCode, null);
			assert.equal(older.signalCode, null);

			// A real zombie's environ may be unreadable. It is terminated, not
			// an unverified live owner; the original process group must still go.
			const parent = spawn("python3", [resolve(fixtureDir, "fixtures/zombie-parent.py")], { ...options, stdio: ["ignore", "pipe", "ignore"] });
			const parentClosed = once(parent, "close");
			const lines = createInterface({ input: parent.stdout! });
			const zombieLine = once(lines, "line");
			try {
				const [line] = await zombieLine;
				const zombiePid = Number(line);
				assert.ok(Number.isSafeInteger(zombiePid) && zombiePid > 0);
				let state = "";
				const deadline = Date.now() + 2000;
				while (state !== "Z" && Date.now() < deadline) {
					const stat = await readFile(`/proc/${zombiePid}/stat`, "utf8");
					state = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[0];
					if (state !== "Z") await new Promise((done) => setTimeout(done, 10));
				}
				assert.equal(state, "Z");
				const parentIdentity = await getProcessStartIdentity(parent.pid!);
				assert.ok(parentIdentity);
				const liveOwners = await findOwnedProcesses(token, parentIdentity);
				assert.ok(liveOwners);
				assert.ok(liveOwners.some((entry) => entry.pid === parent.pid));
				assert.equal(liveOwners.some((entry) => entry.pid === zombiePid), false);
				assert.equal(await terminateOwnedProcessTree(parent.pid, parentIdentity, token, 100, true), true);
			} finally {
				lines.close();
				if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
				await parentClosed;
			}
		} finally {
			older.kill("SIGKILL");
			if (younger?.exitCode === null && younger.signalCode === null) younger.kill("SIGKILL");
			await olderClosed;
			await youngerClosed;
		}
	}
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

test("shared writers overlap across supervisor instances in the same folder", async (t) => {
	const { supervisor: first, paths, root } = await fixture(t);
	const second = new Supervisor(fakeConfig(), {
		paths,
		sessionId: "separate-supervisor-session",
		parentCwd: root,
		stopGraceMs: 100,
	});
	await second.initialize();
	t.after(() => second.shutdown());
	const marker = join(root, "second-writer-started");
	const firstRun = await first.start({ task: JSON.stringify({ mode: "sleep", ms: 60_000 }) });
	await waitForState(first, firstRun.id, (state) => state === "running");
	const secondRun = await second.start({ task: JSON.stringify({ mode: "mark", path: marker }) });
	await waitForState(second, secondRun.id, (state) => state === "exited");
	assert.equal(await waitForFile(marker), true);
	assert.equal(first.inspect(firstRun.id).state, "running");
	await first.stop(firstRun.id);
});

test("allows writers in separate checkouts to run concurrently", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-supervisor-separate-checkouts-"));
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
		};
		const supervisor = new Supervisor(fakeConfig(), { paths, sessionId: `separate-checkout-${index}`, parentCwd: project });
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

test("shared writers launched by separate OS processes overlap in one checkout", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-supervisor-cross-process-"));
	const paths: SupervisorPaths = {
		configDirectory: join(root, "config"),
		profilesFile: join(root, "config", "profiles.json"),
		runtimeDirectory: join(root, "runtime"),
	};
	const driver = resolve(fixtureDir, "fixtures/writer-driver.mjs");
	const first = spawn(process.execPath, ["--import", "tsx", driver, JSON.stringify(paths), process.cwd(), "os-writer-one", JSON.stringify({ mode: "sleep", ms: 4000 })], {
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
		assert.equal(admitted.state, "starting");
		await waitForMessage(secondReader, (message) => message.event === "state" && message.state === "exited");
		assert.equal(await waitForFile(marker), true);
		assert.equal(first.exitCode, null, "the second writer must finish while the first is still running");
		await waitForMessage(firstReader, (message) => message.event === "state" && message.state === "exited");
	} finally {
		firstReader.lines.close();
		secondReader?.lines.close();
		if (first.pid && first.exitCode === null) first.kill("SIGKILL");
		if (second?.pid && second.exitCode === null) second.kill("SIGKILL");
		await rm(root, { recursive: true, force: true });
	}
});

test("reconciles durable active runs after a supervisor crash without restarting them", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-supervisor-restart-"));
	const paths: SupervisorPaths = {
		configDirectory: join(root, "config"),
		profilesFile: join(root, "config", "profiles.json"),
		runtimeDirectory: join(root, "runtime"),
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
	});
	await supervisor.initialize();
	t.after(() => supervisor.shutdown());
	const run = await supervisor.start({ task: "prompt" });
	const failed = await waitForState(supervisor, run.id, (state) => state === "launch_failed");
	assert.equal(failed.error?.code, "SPAWN_FAILED");
	assert.equal(failed.exitCode, undefined);
});
