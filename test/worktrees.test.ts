import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { Supervisor, type SupervisorOptions } from "../src/supervisor.js";
import { parseSupervisorConfig } from "../src/profiles.js";
import { isTerminalState, RunStore } from "../src/run-store.js";
import { WorktreeManager, type WorktreeInfo } from "../src/worktrees.js";
import { registerAgentTools } from "../src/tools.js";
import type { PiExtensionApi } from "../src/pi-api.js";
import { isProcessGroupAlive } from "../src/process.js";

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args], { encoding: "utf8" }).trim();
}
function commit(root: string, message: string): void {
	git(root, "add", "--all");
	git(root, "-c", "user.name=Supervisor Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", message);
}

async function fixture(t: TestContext, options: Partial<SupervisorOptions> = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-supervisor-worktrees test-")));
	const project = join(root, "source");
	await mkdir(join(project, "subdir"), { recursive: true });
	git(project, "init", "-q", "-b", "main");
	await writeFile(join(project, "tracked.txt"), "committed source\n");
	await writeFile(join(project, "subdir/tracked.txt"), "committed subdirectory\n");
	await writeFile(join(project, ".gitignore"), "ignored.txt\n");
	commit(project, "seed");
	const paths = { configDirectory: join(root, "config"), profilesFile: join(root, "config/profiles.json"), runtimeDirectory: join(root, "runtime") };
	const config = parseSupervisorConfig({ defaultProfile: "fake", profiles: { fake: {
		executable: process.execPath, args: [resolve("test/fixtures/fake-agent.mjs"), "--", "{task}"], taskTransport: "argument", outputProtocol: "text",
	} } });
	const supervisors: Supervisor[] = [];
	const make = async (overrides: Partial<SupervisorOptions> = {}) => {
		const supervisor = new Supervisor(config, { paths, sessionId: randomUUID(), parentCwd: project, stopGraceMs: 100, ...options, ...overrides });
		await supervisor.initialize();
		supervisors.push(supervisor);
		return supervisor;
	};
	const supervisor = await make();
	t.after(async () => { await Promise.all(supervisors.map((supervisor) => supervisor.shutdown())); await rm(root, { recursive: true, force: true }); });
	return { root, project, paths, supervisor, make };
}

async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!await predicate() && Date.now() < end) await new Promise((done) => setTimeout(done, 20));
	assert.ok(await predicate(), "condition timed out");
}
async function complete(supervisor: Supervisor, id: string) {
	await until(() => isTerminalState(supervisor.inspect(id).state));
	return supervisor.get(id);
}

const editTask = (text: string, ms = 3000) => JSON.stringify({ mode: "workspace", text, ms });

function pausePreparation(t: TestContext): () => void {
	const prepare = WorktreeManager.prototype.prepare;
	let release!: () => void;
	const gate = new Promise<void>((done) => { release = done; });
	t.mock.method(WorktreeManager.prototype, "prepare", async function (this: WorktreeManager, info: WorktreeInfo, id: string) {
		await gate;
		return prepare.call(this, info, id);
	});
	return release;
}

test("two isolated writers overlap in one repository and never modify the dirty source", async (t) => {
	const { supervisor, project } = await fixture(t);
	await writeFile(join(project, "tracked.txt"), "UNCOMMITTED source\n");
	await writeFile(join(project, "untracked.txt"), "not copied");
	const first = await supervisor.start({ task: editTask("one"), isolation: "worktree" });
	const second = await supervisor.start({ task: editTask("two"), isolation: "worktree" });
	await until(() => supervisor.inspect(first.id).state === "running" && supervisor.inspect(second.id).state === "running");
	const a = supervisor.inspect(first.id);
	const b = supervisor.inspect(second.id);
	assert.notEqual(a.cwd, b.cwd);
	assert.notEqual(a.worktree!.branch, b.worktree!.branch);
	assert.equal(a.worktree!.baseCommit, git(project, "rev-parse", "HEAD"));
	assert.equal(git(a.cwd, "branch", "--show-current"), a.worktree!.branch);
	assert.equal(git(b.cwd, "branch", "--show-current"), b.worktree!.branch);
	assert.match(a.worktree!.note, /uncommitted.*not copied/);
	await until(async () => { try { return await readFile(join(a.cwd, "work.txt"), "utf8") === "one" && await readFile(join(b.cwd, "work.txt"), "utf8") === "two"; } catch { return false; } });
	assert.equal(await readFile(join(a.cwd, "tracked.txt"), "utf8"), "committed source\n");
	await assert.rejects(readFile(join(a.cwd, "untracked.txt")), { code: "ENOENT" });
	assert.equal(await readFile(join(project, "tracked.txt"), "utf8"), "UNCOMMITTED source\n");
	await assert.rejects(readFile(join(project, "work.txt")), { code: "ENOENT" });
	await supervisor.stop(first.id);
	assert.equal(supervisor.inspect(second.id).state, "running", "stopping one workspace must not stop another");
	await supervisor.stop(second.id);
	assert.equal(supervisor.inspect(first.id).worktree!.state, "retained");
	assert.equal(await readFile(join(a.cwd, "work.txt"), "utf8"), "one");
	assert.equal(git(project, "rev-parse", a.worktree!.branch), a.worktree!.baseCommit, "no automatic commit");
});

test("isolated work can run alongside a shared writer and across supervisor instances", async (t) => {
	const { supervisor, make } = await fixture(t);
	const shared = await supervisor.start({ task: JSON.stringify({ mode: "sleep", ms: 60_000 }) });
	await until(() => supervisor.inspect(shared.id).state === "running");
	const other = await make();
	const isolated = await other.start({ task: editTask("isolated"), isolation: "worktree" });
	await until(() => other.inspect(isolated.id).state === "running");
	assert.equal(supervisor.inspect(shared.id).state, "running");
	await assert.rejects(supervisor.get(isolated.id), /No run found/);
	await other.stop(isolated.id);
	await supervisor.stop(shared.id);
});

test("HEAD is pinned at admission and committed subdirectories map into the isolated checkout", async (t) => {
	const { supervisor, project } = await fixture(t);
	const release = pausePreparation(t);
	try {
		const isolated = await supervisor.start({ task: editTask("subdir", 150), isolation: "worktree", cwd: join(project, "subdir") });
		const plan = supervisor.inspect(isolated.id).worktree!;
		await writeFile(join(project, "tracked.txt"), "later commit\n");
		commit(project, "advance HEAD");
		assert.notEqual(git(project, "rev-parse", "HEAD"), plan.baseCommit);
		release();
		const result = await complete(supervisor, isolated.id);
		assert.equal(result.state, "exited", result.error?.message ?? "expected normal exit");
		assert.equal(result.cwd, join(plan.path, "subdir"));
		assert.equal(git(plan.path, "rev-parse", "HEAD"), plan.baseCommit);
		assert.equal(await readFile(join(plan.path, "tracked.txt"), "utf8"), "committed source\n");
		assert.equal(await readFile(join(result.cwd, "work.txt"), "utf8"), "subdir");
	} finally { release(); }
});

test("starting cancellation before preparation creates neither a worktree nor a branch", async (t) => {
	const { supervisor, project } = await fixture(t);
	let stopping: ReturnType<Supervisor["stop"]> | undefined;
	const unsubscribe = supervisor.subscribe(() => {
		const run = supervisor.snapshot().find((run) => run.label === "cancel-before-preparation" && run.state === "starting");
		if (run && !stopping) stopping = supervisor.stop(run.id);
	});
	t.after(unsubscribe);
	const run = await supervisor.start({ task: "never launched", label: "cancel-before-preparation", isolation: "worktree" });
	const plan = supervisor.inspect(run.id).worktree!;
	assert.ok(stopping);
	assert.equal((await stopping).state, "cancelled");
	assert.equal(supervisor.inspect(run.id).worktree!.state, "not_created");
	await assert.rejects(stat(plan.path), { code: "ENOENT" });
	assert.throws(() => git(project, "show-ref", "--verify", "--quiet", `refs/heads/${plan.branch}`));
});

test("non-Git/unborn/uncommitted cwd and invalid isolation fail before admission", async (t) => {
	const { supervisor, project, root, make } = await fixture(t);
	await mkdir(join(project, "untracked-dir"));
	await assert.rejects(supervisor.start({ task: "x", isolation: "worktree", cwd: join(project, "untracked-dir") }), /committed cwd/);
	await assert.rejects(supervisor.start({ task: "x", isolation: "invented" as "worktree" }), /isolation must/);
	const plain = join(root, "plain"); await mkdir(plain);
	const nonGit = await make({ parentCwd: plain });
	await assert.rejects(nonGit.start({ task: "x", isolation: "worktree" }), /committed HEAD/);
	git(plain, "init", "-q");
	await assert.rejects(nonGit.start({ task: "x", isolation: "worktree" }), /committed HEAD/);
	assert.equal(supervisor.snapshot().length, 0);
	assert.equal(nonGit.snapshot().length, 0);
});

test("worktree creation disables checkout hooks and retains clean completed workspaces", async (t) => {
	const { supervisor, project, root } = await fixture(t);
	const marker = join(root, "unexpected-hook");
	await writeFile(join(project, ".git/hooks/post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
	const run = await supervisor.start({ task: "clean worktree", isolation: "worktree" });
	const result = await complete(supervisor, run.id);
	assert.equal(result.state, "exited", result.error?.message ?? "expected normal exit");
	assert.equal(result.worktree!.state, "retained");
	await assert.rejects(stat(marker), { code: "ENOENT" });
	assert.equal((await stat(result.worktree!.path)).mode & 0o777, 0o700);
});

test("setup failure is explicit and never runs a child in the source checkout", async (t) => {
	const { supervisor, project } = await fixture(t);
	const release = pausePreparation(t);
	try {
		const isolated = await supervisor.start({ task: editTask("must not write", 0), isolation: "worktree" });
		const branch = supervisor.inspect(isolated.id).worktree!.branch;
		git(project, "branch", branch);
		release();
		const result = await complete(supervisor, isolated.id);
		assert.equal(result.state, "launch_failed");
		assert.equal(result.error?.code, "WORKTREE_CREATE");
		assert.equal(result.worktree!.state, "failed");
		await assert.rejects(supervisor.removeWorktree(isolated.id), /uncertain/);
		assert.equal(result.startedAt, undefined);
		await assert.rejects(readFile(join(project, "work.txt")), { code: "ENOENT" });
		assert.equal(git(project, "branch", "--show-current"), "main");
	} finally { release(); }
});

test("cancellation during Git preparation waits for setup and preserves the worktree without launching", async (t) => {
	const { supervisor, root } = await fixture(t);
	const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const bin = join(root, "bin"); await mkdir(bin);
	const preparing = join(root, "preparing");
	const wrapper = join(bin, "git");
	await writeFile(wrapper, `#!/bin/sh\ncase " $* " in *" worktree add "*) touch '${preparing}'; sleep 0.4;; esac\nexec '${realGit}' "$@"\n`);
	await chmod(wrapper, 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	try {
		const run = await supervisor.start({ task: "must never launch", isolation: "worktree" });
		await until(async () => { try { await stat(preparing); return true; } catch { return false; } });
		const stopped = await supervisor.stop(run.id);
		assert.equal(stopped.state, "cancelled");
		assert.equal(stopped.startedAt, undefined);
		assert.equal(stopped.worktree!.state, "retained");
		assert.ok((await stat(stopped.worktree!.path)).isDirectory());
	} finally { process.env.PATH = path; }
});

test("timeout and shutdown retain edited isolated work and release process groups", async (t) => {
	const { supervisor, paths } = await fixture(t);
	const timed = await supervisor.start({ task: editTask("timeout", 60_000), isolation: "worktree", timeoutMs: 400 });
	const result = await complete(supervisor, timed.id);
	assert.equal(result.state, "timed_out");
	assert.equal(result.worktree!.state, "retained");
	assert.equal(await readFile(join(result.cwd, "work.txt"), "utf8"), "timeout");
	const another = await supervisor.start({ task: editTask("shutdown", 60_000), isolation: "worktree" });
	await until(async () => { try { return await readFile(join(supervisor.inspect(another.id).cwd, "work.txt"), "utf8") === "shutdown"; } catch { return false; } });
	await supervisor.shutdown();
	const stored = new RunStore(paths, supervisor.inspect(another.id).sessionId); await stored.initialize();
	const metadata = stored.get(another.id)!;
	assert.equal(metadata.state, "cancelled");
	assert.equal(metadata.worktree!.state, "retained");
	assert.equal(isProcessGroupAlive(metadata.processPid!), false);
	assert.equal(await readFile(join(metadata.cwd, "work.txt"), "utf8"), "shutdown");
});

test("cleanup refuses live runs and dirty/ignored work; clean removal keeps branch commits", async (t) => {
	const { supervisor, project } = await fixture(t);
	const live = await supervisor.start({ task: editTask("dirty", 60_000), isolation: "worktree" });
	await until(() => supervisor.inspect(live.id).state === "running");
	await assert.rejects(supervisor.removeWorktree(live.id), /Stop the run/);
	await until(async () => { try { await stat(join(supervisor.inspect(live.id).cwd, "work.txt")); return true; } catch { return false; } });
	await supervisor.stop(live.id);
	await assert.rejects(supervisor.removeWorktree(live.id), /tracked, untracked or ignored/);
	const isolated = supervisor.inspect(live.id);
	assert.equal(await readFile(join(isolated.cwd, "work.txt"), "utf8"), "dirty");
	await rm(join(isolated.cwd, "work.txt"));
	await writeFile(join(isolated.cwd, "ignored.txt"), "ignored but must not be deleted");
	await assert.rejects(supervisor.removeWorktree(live.id), /ignored/);
	await rm(join(isolated.cwd, "ignored.txt"));
	await writeFile(join(isolated.cwd, "tracked.txt"), "manually committed work\n");
	commit(isolated.cwd, "manual save");
	const removed = await supervisor.removeWorktree(live.id);
	assert.equal(removed.worktree!.state, "removed");
	await assert.rejects(stat(isolated.cwd), { code: "ENOENT" });
	assert.equal(git(project, "show", `${removed.worktree!.branch}:tracked.txt`), "manually committed work");
	assert.equal((await supervisor.removeWorktree(live.id)).worktree!.state, "removed");
});

test("cleanup refuses renamed branches and substituted paths", async (t) => {
	const { supervisor, project, root } = await fixture(t);
	const run = await supervisor.start({ task: "clean", isolation: "worktree" });
	const result = await complete(supervisor, run.id);
	git(result.cwd, "checkout", "-qb", "human-branch");
	await assert.rejects(supervisor.removeWorktree(run.id), /registration or branch changed/);
	git(result.cwd, "checkout", "-q", result.worktree!.branch);
	git(project, "worktree", "remove", result.cwd);
	const victim = join(root, "foreign-directory"); await mkdir(victim); await writeFile(join(victim, "keep.txt"), "keep");
	await symlink(victim, result.cwd);
	await assert.rejects(supervisor.removeWorktree(run.id), /registration or branch changed/);
	assert.equal(await readFile(join(victim, "keep.txt"), "utf8"), "keep");
});

test("crash recovery stops the verified child but preserves branch, workspace and edits", async (t) => {
	const { project, paths, make } = await fixture(t);
	const sessionId = randomUUID();
	const driver = spawn(process.execPath, ["--import", "tsx", resolve("test/fixtures/restart-driver.mjs"), JSON.stringify(paths), project, sessionId, JSON.stringify({ isolation: "worktree", task: editTask("crash recovery", 60_000) })], { stdio: ["ignore", "pipe", "inherit"], cwd: process.cwd() });
	const lines = createInterface({ input: driver.stdout });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const [line] = await Promise.race([
			once(lines, "line"),
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("worktree restart driver did not become ready")), 10_000); }),
		]);
		if (timer) clearTimeout(timer);
		const id = JSON.parse(line).id as string;
		const store = new RunStore(paths, sessionId); await store.initialize();
		const record = store.get(id)!;
		await until(async () => { try { return await readFile(join(record.cwd, "work.txt"), "utf8") === "crash recovery"; } catch { return false; } });
		driver.kill("SIGKILL");
		await once(driver, "close");
		const recovery = await make({ sessionId });
		const restored = recovery.inspect(id);
		assert.equal(restored.state, "interrupted");
		assert.equal(restored.worktree!.state, "retained");
		await assert.rejects(recovery.removeWorktree(id), /uncertain/);
		assert.equal(isProcessGroupAlive(record.processPid!), false);
		assert.equal(await readFile(join(restored.cwd, "work.txt"), "utf8"), "crash recovery");
		assert.equal(git(project, "rev-parse", restored.worktree!.branch), record.worktree!.baseCommit);
	} finally {
		if (timer) clearTimeout(timer);
		lines.close();
		if (driver.exitCode === null && driver.signalCode === null) { driver.kill("SIGKILL"); await once(driver, "close"); }
		await make({ sessionId }).catch(() => undefined); // Reconcile any verified child on an assertion failure too.
	}
});

test("more than ten worktree runs launch concurrently with default options and no queue", async (t) => {
	// Use production cleanup grace for a simultaneous twelve-process shutdown;
	// the 100ms fixture override is below hosted-runner scheduling latency.
	const { supervisor } = await fixture(t, { stopGraceMs: 1200 });
	const task = JSON.stringify({ mode: "sleep", ms: 60_000 });
	const runs = await Promise.all(Array.from({ length: 12 }, () => supervisor.start({ task, isolation: "worktree" })));
	assert.ok(runs.every((run) => run.state === "starting"));
	await until(() => runs.every((run) => supervisor.inspect(run.id).state === "running"));
	assert.equal(new Set(runs.map((run) => supervisor.inspect(run.id).cwd)).size, 12);
	assert.equal(supervisor.snapshot().filter((run) => run.state === "queued").length, 0);
	await supervisor.shutdown();
	for (const run of runs) {
		const stopped = supervisor.inspect(run.id);
		assert.equal(stopped.state, "cancelled", JSON.stringify(stopped.error));
	}
});

test("model tools expose workspace identity and never expose destructive cleanup", async (t) => {
	const { supervisor } = await fixture(t);
	const tools = new Map<string, { execute: Function }>();
	registerAgentTools({ registerTool: (tool: { name: string; execute: Function }) => tools.set(tool.name, tool) } as unknown as PiExtensionApi, async () => supervisor);
	assert.deepEqual([...tools.keys()].sort(), ["agent_get", "agent_start", "agent_stop"]);
	const start = await tools.get("agent_start")!.execute("start", { task: "tool workspace", isolation: "worktree" }, undefined, undefined, {});
	const started = JSON.parse(start.content[0].text);
	assert.equal(started.isolation, "worktree");
	assert.equal(started.worktree.branch, `pi-agent/${started.id}`);
	assert.match(started.worktree.note, /uncommitted.*not copied/);
	await complete(supervisor, started.id);
	const result = await tools.get("agent_get")!.execute("get", { id: started.id }, undefined, undefined, {});
	const report = JSON.parse(result.content[0].text);
	assert.equal(report.worktree.state, "retained");
	assert.equal(report.worktree.path, supervisor.inspect(started.id).cwd);
	assert.equal(report.outputTail, undefined);
});

test("manager refuses metadata for an arbitrary path or branch", async (t) => {
	const { project, paths } = await fixture(t);
	const manager = new WorktreeManager(paths);
	const id = randomUUID();
	const plan = await manager.plan(project, project, id);
	await assert.rejects(manager.prepare({ ...plan, path: project }, id), /identity/);
	await assert.rejects(manager.remove({ ...plan, branch: "main" }, id), /identity/);
	assert.equal(git(project, "branch", "--show-current"), "main");
});
