import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Supervisor } from "../src/supervisor.js";
import { isTerminalState } from "../src/run-store.js";
import { parseSupervisorConfig, resolveLaunchRecipe } from "../src/profiles.js";

async function setup(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "supervisor-interactive-"));
	const cwd = join(root, "repo");
	execFileSync("git", ["init", "-q", cwd]);
	await writeFile(join(cwd, "seed"), "seed");
	const git = (...args: string[]) => execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" });
	git("add", "seed"); git("commit", "-qm", "seed");
	const paths = { configDirectory: join(root, "config"), profilesFile: join(root, "config/profiles.json"), runtimeDirectory: join(root, "runtime") };
	const config = parseSupervisorConfig({ defaultProfile: "custom", profiles: { custom: {
		executable: process.execPath, args: [resolve("test/fixtures/fake-rpc-agent.mjs"), "--session", "{session}", "{modelArgs}"],
		modelArgs: ["--model", "{model}"], taskTransport: "pi-rpc", outputProtocol: "pi-jsonl",
	} } });
	const options = { paths, parentCwd: cwd, sessionId: "interactive", stopGraceMs: 100 };
	const supervisor = new Supervisor(config, options);
	await supervisor.initialize();
	t.after(async () => { await supervisor.shutdown(); await rm(root, { recursive: true, force: true }); });
	return { supervisor, root, cwd, paths, config, options, git };
}
async function wait(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
	assert.ok(predicate(), "condition timed out");
}
async function completed(supervisor: Supervisor, id: string) {
	await wait(() => isTerminalState(supervisor.inspect(id).state));
	return supervisor.get(id);
}

test("explicit RPC transport steers through agent_end and resumes a durable conversation", async (t) => {
	const { supervisor } = await setup(t);
	const first = await supervisor.start({ task: '{"earlyEnd":true,"delayMs":60000}', model: "chosen/model", timeoutMs: 5000, label: "guided" });
	await wait(() => supervisor.inspect(first.id).capabilities?.steer === true);
	assert.equal(supervisor.inspect(first.id).state, "running");
	assert.equal(await supervisor.steer(first.id, "redirect 雪\u2028next line"), "queued");
	const finished = await completed(supervisor, first.id);
	assert.equal(finished.state, "exited");
	assert.match(finished.presentation!.finalAnswer!, /redirect 雪\u2028next line/);
	assert.equal(supervisor.inspect(first.id).capabilities?.followUp, true);
	assert.equal((await stat(finished.control!.sessionPath)).mode & 0o777, 0o600);
	await assert.rejects(supervisor.steer(first.id, "too late"), /no longer supports/);
	const next = await supervisor.followUp(first.id, "continue");
	assert.equal(supervisor.inspect(first.id).capabilities?.followUp, false);
	await assert.rejects(supervisor.followUp(first.id, "must not duplicate"), /No safely settled/);
	const second = await completed(supervisor, next.id);
	assert.match(second.presentation!.finalAnswer!, /redirect.*continue/s);
	assert.equal(second.control!.sessionPath, finished.control!.sessionPath);
	assert.equal(second.control!.turn, 2);
	assert.equal(second.control!.continuedFrom, first.id);
	assert.equal(second.model, "chosen/model");
	assert.equal(second.timeoutMs, 5000);
	assert.equal((await supervisor.get(first.id)).task, finished.task);
});

test("follow-ups retain dirty worktree content, serialize duplicate admission, and fresh reruns do not resume", async (t) => {
	const { supervisor, cwd } = await setup(t);
	const task = '{"write":"original","delayMs":20}';
	const first = await supervisor.start({ task, model: "chosen/model", isolation: "worktree", timeoutMs: 2000 });
	const one = await completed(supervisor, first.id);
	const requests = await Promise.allSettled([supervisor.followUp(first.id, '{"write":"+continued","delayMs":500}'), supervisor.followUp(first.id, '{"write":"+continued","delayMs":500}')]);
	assert.equal(requests.filter((r) => r.status === "fulfilled").length, 1);
	const follow = requests.find((r) => r.status === "fulfilled")! as PromiseFulfilledResult<{ id: string }>;
	await assert.rejects(supervisor.removeWorktree(first.id), /Stop the run/);
	const two = await completed(supervisor, follow.value.id);
	assert.equal(two.cwd, one.cwd);
	assert.equal(two.worktreeOwnerId, first.id);
	assert.equal(await readFile(join(two.cwd, "work.txt"), "utf8"), "original+continued");
	await assert.rejects(supervisor.removeWorktree(first.id), /tracked, untracked or ignored/);
	const fresh = await supervisor.rerun(first.id, { timeoutMs: undefined });
	const rerun = await completed(supervisor, fresh.id);
	assert.notEqual(rerun.cwd, one.cwd);
	assert.notEqual(rerun.control!.conversationId, one.control!.conversationId);
	assert.equal(rerun.presentation?.finalAnswer, task);
	assert.equal(rerun.timeoutMs, undefined);
	assert.equal(await readFile(join(rerun.cwd, "work.txt"), "utf8"), "original");
	await assert.rejects(readFile(join(cwd, "work.txt")), { code: "ENOENT" });
	await rm(join(two.cwd, "work.txt"));
	await supervisor.removeWorktree(two.id);
	assert.equal(supervisor.inspect(first.id).worktree?.state, "removed");
	assert.equal(supervisor.inspect(first.id).capabilities?.followUp, false);
});

test("fast settlement before prompt acknowledgement closes orderly; rejected steer does not stop work", async (t) => {
	const { supervisor } = await setup(t);
	const fast = await supervisor.start({ task: '{"lateAck":true}', model: "chosen/model" });
	assert.equal((await completed(supervisor, fast.id)).presentation?.finalAnswer, '{"lateAck":true}');
	const run = await supervisor.start({ task: '{"delayMs":60000}', model: "chosen/model" });
	await wait(() => supervisor.inspect(run.id).capabilities?.steer === true);
	await assert.rejects(supervisor.steer(run.id, "reject"), /steer rejected/);
	assert.equal(supervisor.inspect(run.id).state, "running");
	await supervisor.stop(run.id);
	assert.equal(supervisor.inspect(run.id).capabilities?.followUp, false);
	assert.equal(supervisor.inspect(run.id).presentation?.finalAnswer, undefined);
});

test("timeout, prompt rejection, and reload do not silently restart interactive children", async (t) => {
	const { supervisor, config, options } = await setup(t);
	const rejected = await supervisor.start({ task: '{"rejectPrompt":true}', model: "chosen/model" });
	assert.equal((await completed(supervisor, rejected.id)).state, "interrupted");
	const timeout = await supervisor.start({ task: '{"delayMs":60000}', model: "chosen/model", timeoutMs: 200 });
	assert.equal((await completed(supervisor, timeout.id)).state, "timed_out");
	const good = await supervisor.start({ task: '{"delayMs":10}', model: "chosen/model" });
	await completed(supervisor, good.id);
	await supervisor.shutdown();
	const restored = new Supervisor(config, options);
	await restored.initialize();
	t.after(() => restored.shutdown());
	assert.equal(restored.snapshot().filter((r) => !isTerminalState(r.state)).length, 0);
	const next = await restored.followUp(good.id, "after reload");
	assert.match((await completed(restored, next.id)).presentation!.finalAnswer!, /after reload/);
});

test("RPC profile session slot is private/internal and strict", () => {
	const profile = { executable: "custom-binary", args: ["--session", "{session}"], taskTransport: "pi-rpc", outputProtocol: "pi-jsonl" };
	const config = (changes: Record<string, unknown>) => ({ defaultProfile: "x", profiles: { x: { ...profile, ...changes } } });
	for (const changes of [{ args: [] }, { args: ["prefix{session}"] }, { args: ["{session}", "{task}"] }, { outputProtocol: "text" }, { taskTransport: "stdin" }]) assert.throws(() => parseSupervisorConfig(config(changes)));
	const recipe = resolveLaunchRecipe(parseSupervisorConfig(config({})), { task: "not argv" }, "/private/session path.jsonl");
	assert.deepEqual(recipe.args, ["--session", "/private/session path.jsonl"]);
	assert.equal(recipe.stdin, undefined);
});
