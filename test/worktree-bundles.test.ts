import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { parseRunCommandArgs } from "../src/commands.js";
import type { PiExtensionApi } from "../src/pi-api.js";
import { isProcessGroupAlive } from "../src/process.js";
import { parseSupervisorConfig } from "../src/profiles.js";
import { isTerminalState, RunStore } from "../src/run-store.js";
import { Supervisor } from "../src/supervisor.js";
import { registerAgentTools } from "../src/tools.js";
import { WorktreeManager, type WorktreeBundleInfo } from "../src/worktrees.js";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { encoding: "utf8" }).trim();
}

async function commit(cwd: string, contents: string): Promise<string> {
	await writeFile(join(cwd, "tracked.txt"), contents);
	git(cwd, "add", "tracked.txt");
	git(cwd, "commit", "-qm", "snapshot");
	return git(cwd, "rev-parse", "HEAD");
}

async function makeRepo(cwd: string, contents: string) {
	await mkdir(cwd, { recursive: true });
	git(cwd, "init", "-q", "-b", "main");
	await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
	git(cwd, "add", ".gitignore");
	return commit(cwd, contents);
}

async function fixture(t: TestContext) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-worktree-bundle-")));
	const cwd = join(root, "session");
	const web = join(cwd, "web");
	const api = join(root, "other", "api repo");
	const supervisors: Supervisor[] = [];
	t.after(async () => { await Promise.all(supervisors.map((supervisor) => supervisor.shutdown())); await rm(root, { recursive: true, force: true }); });
	const webBase = await makeRepo(web, "web base\n");
	const apiBase = await makeRepo(api, "api base\n");
	const paths = { configDirectory: join(root, "config"), profilesFile: join(root, "config/profiles.json"), runtimeDirectory: join(root, "runtime") };
	const config = parseSupervisorConfig({ defaultProfile: "fake", profiles: {
		fake: { executable: process.execPath, args: [resolve("test/fixtures/fake-agent.mjs"), "--", "{task}"], taskTransport: "argument", outputProtocol: "text" },
		rpc: { executable: process.execPath, args: [resolve("test/fixtures/fake-rpc-agent.mjs"), "--session", "{session}"], taskTransport: "pi-rpc", outputProtocol: "pi-jsonl" },
	} });
	const make = async (sessionId: string) => {
		const supervisor = new Supervisor(config, { paths, sessionId, parentCwd: cwd });
		await supervisor.initialize();
		supervisors.push(supervisor);
		return supervisor;
	};
	const sessionId = "bundle-test";
	const supervisor = await make(sessionId);
	const repos = [{ path: "web", ref: "main" }, { path: api, ref: apiBase }];
	return { root, cwd, web, api, webBase, apiBase, paths, sessionId, make, supervisor, repos };
}

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await delay(20);
	}
	assert.fail("Timed out waiting for bundle run");
}

async function complete(supervisor: Supervisor, id: string) {
	await until(() => isTerminalState(supervisor.inspect(id).state));
	return supervisor.get(id);
}

function pausePreparation(t: TestContext): () => void {
	const prepare = WorktreeManager.prototype.prepareBundle;
	let release!: () => void;
	const gate = new Promise<void>((done) => { release = done; });
	t.mock.method(WorktreeManager.prototype, "prepareBundle", async function (this: WorktreeManager, bundle: WorktreeBundleInfo, id: string, cancelled: () => boolean) {
		await gate;
		return prepare.call(this, bundle, id, cancelled);
	});
	return release;
}

test("slash command accepts repeated repo path=ref flags, preserving spaces and the task", () => {
	assert.deepEqual(parseRunCommandArgs(`--label one --repo web=feat/qa --repo='/outside =dir/api=abcd' -- fix both --repo unchanged`), {
		task: "fix both --repo unchanged",
		options: { label: "one", repos: [{ path: "web", ref: "feat/qa" }, { path: "/outside =dir/api", ref: "abcd" }] },
	});
	for (const option of ["--repo web", "--repo web=", "--repo =main"]) assert.throws(() => parseRunCommandArgs(`${option} -- x`), /path=ref/);
	assert.throws(() => parseRunCommandArgs("--cwd web --cwd api -- x"), /only be used once/);
});

test("two full-stack runs overlap; each pins both repos and edits only its own pair of worktrees", async (t) => {
	const { supervisor, web, api, webBase, apiBase, paths, sessionId, repos } = await fixture(t);
	git(web, "branch", "feat/qa");
	await commit(web, "different from the selected branch\n");
	await commit(api, "different from the selected commit\n");
	await writeFile(join(web, "tracked.txt"), "dirty web\n");
	await writeFile(join(api, "untracked.txt"), "untracked api\n");
	const selected = [{ ...repos[0], ref: "feat/qa" }, repos[1]];
	const release = pausePreparation(t);
	try {
		const labels = ["contract-one", "contract-two"];
		const requests = await Promise.all(labels.map((label) => supervisor.start({ label, repos: selected,
			task: JSON.stringify({ mode: "bundle", repos: ["web", "api repo"], text: label, ms: 60_000 }),
		})));
		const store = new RunStore(paths, sessionId); await store.initialize();
		const plans = requests.map(({ id }) => store.get(id)!);
		assert.ok(plans.every((run) => run.state === "starting" && !run.processPid));
		assert.equal(new Set(plans.map((run) => run.worktreeBundle!.path)).size, 2);
		for (const plan of plans) {
			assert.deepEqual(plan.worktreeBundle!.members.map((member) => member.baseCommit), [webBase, apiBase]);
			assert.deepEqual(plan.worktreeBundle!.members.map((member) => member.state), ["pending", "pending"]);
			await assert.rejects(stat(plan.worktreeBundle!.path), { code: "ENOENT" });
		}
		git(web, "branch", "-f", "feat/qa", "main");
		release();
		await until(() => requests.every(({ id }) => supervisor.inspect(id).state === "running"));
		for (const [index, plan] of plans.entries()) {
			const live = supervisor.inspect(plan.id);
			assert.equal(live.cwd, plan.worktreeBundle!.path);
			assert.equal(live.worktree, undefined);
			for (const [slot, member] of live.worktreeBundle!.members.entries()) {
				assert.equal(member.state, "ready");
				assert.equal(dirname(member.path), live.cwd);
				assert.equal(git(member.path, "branch", "--show-current"), `pi-agent/${plan.id}`);
				assert.equal(git(member.path, "rev-parse", "HEAD"), [webBase, apiBase][slot]);
				const expected = `${labels[index]}:${["web base\n", "api base\n"][slot]}`;
				await until(async () => await readFile(join(member.path, "fix.txt"), "utf8").catch(() => undefined) === expected);
				await assert.rejects(stat(join(member.path, "untracked.txt")), { code: "ENOENT" });
			}
		}
		await assert.rejects(supervisor.removeWorktree(plans[0].id), /Stop the run/);
		await supervisor.stop(plans[0].id);
		assert.equal(supervisor.inspect(plans[1].id).state, "running");
		await supervisor.stop(plans[1].id);
		await store.initialize();
		for (const plan of plans) {
			const run = store.get(plan.id)!;
			assert.equal(run.state, "cancelled");
			assert.equal(isProcessGroupAlive(run.processPid!), false);
			assert.ok(run.worktreeBundle!.members.every((member) => member.state === "retained"));
		}
		assert.equal(await readFile(join(web, "tracked.txt"), "utf8"), "dirty web\n");
		assert.equal(await readFile(join(api, "untracked.txt"), "utf8"), "untracked api\n");
		await assert.rejects(stat(join(web, "fix.txt")), { code: "ENOENT" });
		await assert.rejects(stat(join(api, "fix.txt")), { code: "ENOENT" });
		assert.equal(git(web, "branch", "--show-current"), "main");
	} finally { release(); }
});

test("bundle preflight rejects invalid refs, non-roots, duplicate repositories and conflicting modes before admission", async (t) => {
	const { supervisor, cwd, web, api, repos } = await fixture(t);
	await mkdir(join(web, "subdir"));
	const anotherCheckout = join(cwd, "linked-web");
	git(web, "worktree", "add", "--detach", anotherCheckout, "HEAD");
	const inputs = [
		{ repos: [repos[0], { ...repos[1], ref: "missing-branch" }] },
		{ repos: [repos[0], { ...repos[1], ref: "--help" }] },
		{ repos: [{ path: "web/subdir", ref: "HEAD" }] },
		{ repos: [repos[0], { path: anotherCheckout, ref: "HEAD" }] },
		{ repos, cwd: "web" }, { repos, isolation: "shared" as const }, { repos: [] },
	];
	for (const options of inputs) await assert.rejects(supervisor.start({ task: "must not start", ...options }), (error: unknown) => {
		assert.match((error as { code: string }).code, /^(INVALID_REPOS|WORKTREE_SOURCE)$/);
		return true;
	});
	assert.deepEqual(supervisor.snapshot(), []);
	for (const source of [web, api]) assert.equal(git(source, "branch", "--list", "pi-agent/*"), "");
});

test("a late setup failure keeps earlier members and never launches an agent", async (t) => {
	const { supervisor, root, api, repos } = await fixture(t);
	const release = pausePreparation(t);
	try {
		const marker = join(root, "worker-started");
		const started = await supervisor.start({ repos, task: JSON.stringify({ mode: "mark", path: marker }) });
		git(api, "branch", `pi-agent/${started.id}`); // Conflicts only with the second checkout.
		release();
		const result = await complete(supervisor, started.id);
		assert.equal(result.state, "launch_failed");
		assert.equal(result.error?.code, "WORKTREE_CREATE");
		assert.equal(result.startedAt, undefined);
		const [first, second] = result.worktreeBundle!.members;
		assert.equal(first.state, "retained");
		assert.equal(git(first.path, "rev-parse", "HEAD"), first.baseCommit);
		assert.equal(second.state, "failed");
		await assert.rejects(stat(marker), { code: "ENOENT" });
		await assert.rejects(supervisor.removeWorktree(started.id), /uncertain/);
	} finally { release(); }
});

test("stop during preparation retains the first checkout and skips the remaining members and worker", async (t) => {
	const { supervisor, root, api, repos } = await fixture(t);
	const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
	const bin = join(root, "bin"); await mkdir(bin);
	const preparing = join(root, "preparing"), release = join(root, "release");
	await writeFile(join(bin, "git"), `#!/bin/sh\ncase " $* " in *" worktree add "*) touch '${preparing}'; while [ ! -f '${release}' ]; do sleep 0.02; done;; esac\nexec '${gitPath}' "$@"\n`, { mode: 0o755 });
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	try {
		const marker = join(root, "worker-started");
		const started = await supervisor.start({ repos, task: JSON.stringify({ mode: "mark", path: marker }) });
		await until(() => stat(preparing).then(() => true, () => false));
		const stopping = supervisor.stop(started.id);
		await writeFile(release, "release");
		const stopped = await stopping;
		assert.equal(stopped.state, "cancelled");
		assert.equal(stopped.startedAt, undefined);
		assert.deepEqual(stopped.worktreeBundle!.members.map((member) => member.state), ["retained", "not_created"]);
		assert.equal(git(api, "branch", "--list", "pi-agent/*"), "");
		await assert.rejects(stat(marker), { code: "ENOENT" });
	} finally { await writeFile(release, "release"); process.env.PATH = path; }
});

test("agent tools report colliding repo names distinctly; cleanup checks the whole bundle and keeps branches", async (t) => {
	const { supervisor, root, web, repos, sessionId, make } = await fixture(t);
	const otherWeb = join(root, "other", "web");
	await makeRepo(otherWeb, "separate repository\n");
	const tools = new Map<string, { execute: Function }>();
	registerAgentTools({ registerTool: (tool: { name: string; execute: Function }) => tools.set(tool.name, tool) } as unknown as PiExtensionApi, async () => supervisor);
	const call = async (name: string, params: object) => JSON.parse((await tools.get(name)!.execute(name, params, undefined, undefined, {})).content[0].text);
	const started = await call("agent_start", { task: "clean bundle", repos: [repos[0], { path: otherWeb, ref: "HEAD" }] });
	assert.equal(started.isolation, "worktree");
	assert.deepEqual(started.worktreeBundle.members.map(({ name }: { name: string }) => name), ["web", "repo-1"]);
	await complete(supervisor, started.id);
	const detail = await call("agent_get", { id: started.id });
	const bundle: WorktreeBundleInfo = detail.worktreeBundle;
	assert.equal(detail.cwd, bundle.path);
	assert.equal(bundle.members.length, 2);
	assert.ok(bundle.members.every((member) => member.state === "retained"));
	await supervisor.shutdown();
	const reopened = await make(sessionId);
	assert.deepEqual(reopened.inspect(started.id).worktreeBundle, bundle);
	const [first, second] = bundle.members;
	const ignored = join(second.path, "ignored.txt");
	await writeFile(ignored, "do not remove ignored files");
	await writeFile(join(bundle.path, "keep.txt"), "bundle-level file");
	await assert.rejects(reopened.removeWorktree(started.id), /tracked, untracked or ignored/);
	assert.ok((await stat(first.path)).isDirectory(), "a dirty later member must stop all removals");
	assert.equal(await readFile(ignored, "utf8"), "do not remove ignored files");
	await rm(ignored);
	const savedCommit = await commit(first.path, "manually committed changes\n");
	const removed = await reopened.removeWorktree(started.id);
	assert.ok(removed.worktreeBundle!.members.every((member) => member.state === "removed"));
	assert.equal(git(web, "rev-parse", first.branch), savedCommit);
	assert.equal(git(otherWeb, "rev-parse", second.branch), second.baseCommit);
	for (const member of bundle.members) await assert.rejects(stat(member.path), { code: "ENOENT" });
	assert.equal(await readFile(join(bundle.path, "keep.txt"), "utf8"), "bundle-level file");
});

test("RPC follow-up reuses a verified whole bundle; rerun creates a fresh bundle at the requested refs", async (t) => {
	const { supervisor, web, repos } = await fixture(t);
	const task = JSON.stringify({ write: "first", file: "web/review.txt", delayMs: 10 });
	const start = await supervisor.start({ task, profile: "rpc", repos });
	const first = await complete(supervisor, start.id);
	assert.equal(first.state, "exited", first.error?.message ?? "expected normal exit");
	const next = await supervisor.followUp(first.id, JSON.stringify({ write: "+next", file: "web/review.txt", delayMs: 300 }));
	await assert.rejects(supervisor.removeWorktree(first.id), /Stop the run/);
	const second = await complete(supervisor, next.id);
	assert.equal(second.cwd, first.cwd);
	assert.equal(second.control!.conversationId, first.control!.conversationId);
	assert.deepEqual(second.worktreeBundle, first.worktreeBundle);
	assert.equal(await readFile(join(second.cwd, "web", "review.txt"), "utf8"), "first+next");
	const newHead = await commit(web, "moved after the original run\n");
	const rerun = await supervisor.rerun(first.id);
	const fresh = await complete(supervisor, rerun.id);
	assert.equal(fresh.state, "exited", fresh.error?.message ?? "expected normal exit");
	assert.notEqual(fresh.cwd, first.cwd);
	assert.notEqual(fresh.control!.conversationId, first.control!.conversationId);
	assert.equal(fresh.worktreeBundle!.members[0].baseCommit, newHead);
	assert.equal(fresh.worktreeBundle!.members[1].baseCommit, first.worktreeBundle!.members[1].baseCommit);
	assert.equal(await readFile(join(fresh.cwd, "web", "review.txt"), "utf8"), "first");
	await rm(join(second.cwd, "web", "review.txt"));
	await supervisor.removeWorktree(second.id);
	assert.ok(supervisor.inspect(first.id).worktreeBundle!.members.every((member) => member.state === "removed"));
	assert.equal(supervisor.inspect(first.id).capabilities?.followUp, false);

	const api = fresh.worktreeBundle!.members[1];
	git(api.sourceRoot, "worktree", "remove", api.path);
	const blocked = await supervisor.followUp(fresh.id, "must not launch after losing one member");
	const failed = await complete(supervisor, blocked.id);
	assert.equal(failed.state, "launch_failed");
	assert.equal(failed.error?.code, "WORKTREE_IDENTITY");
	assert.equal(failed.startedAt, undefined);
});
