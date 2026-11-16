import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { loadSupervisorConfig } from "../src/config.js";
import { findOwnedProcesses, isProcessGroupAlive } from "../src/process.js";
import { RunStore, isTerminalState } from "../src/run-store.js";
import { Supervisor } from "../src/supervisor.js";
import { prepareLivePiConfig } from "./fixtures/live-config.js";

const approved = process.env.PI_AGENT_SUPERVISOR_LIVE_PI === "1";

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-C", cwd, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Live Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", ...args], { encoding: "utf8" }).trim();
}

test("LIVE two Pi worktrees edit the same path independently and a saved follow-up retains its changes", { skip: !approved, timeout: 240_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-supervisor-live-parallel-"));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	let supervisor: Supervisor | undefined;
	try {
		const { model, effort } = await prepareLivePiConfig(agentDir);
		const paths = { configDirectory: join(agentDir, "agent-supervisor"), profilesFile: join(agentDir, "agent-supervisor/profiles.json"), runtimeDirectory: join(agentDir, "agent-supervisor/runtime") };
		const config = await loadSupervisorConfig(paths.profilesFile);
		config.profiles.pi.environment = { ...config.profiles.pi.environment, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" };
		await mkdir(project);
		git(project, "init", "-q", "-b", "main");
		await writeFile(join(project, "seed.txt"), "17\n");
		git(project, "add", "--all"); git(project, "commit", "-qm", "seed");
		const base = git(project, "rev-parse", "HEAD");
		await writeFile(join(project, "seed.txt"), "999\n");
		await writeFile(join(project, "untracked.txt"), "parent only\n");
		const sessionId = randomUUID();
		supervisor = new Supervisor(config, { paths, parentCwd: project, sessionId });
		await supervisor.initialize();
		let overlap = false;
		const dispose = supervisor.subscribe(() => { if (supervisor!.snapshot().filter((run) => run.state === "running").length === 2) overlap = true; });
		const values = [34, 51];
		const runs = await Promise.all(values.map((value, index) => supervisor!.start({ profile: "pi", model, ...(effort ? { effort } : {}), isolation: "worktree", timeoutMs: 120_000,
			task: `This is a disposable isolation test. Stay inside cwd. Read seed.txt. Multiply its number by ${index + 2}, then write result.txt containing that number followed by a newline. Do not commit, edit seed.txt or do unrelated work. Your final reply must contain only this exact marker (no punctuation or extra text): LIVE_WORKTREE_${value}_OK`, label: `live-worktree-${value}` })));
		const complete = async (id: string) => {
			const deadline = Date.now() + 135_000;
			while (!isTerminalState(supervisor!.inspect(id).state) && Date.now() < deadline) await delay(50);
			const run = await supervisor!.get(id);
			assert.equal(run.state, "exited", run.error?.message ?? "expected normal exit");
			return run;
		};
		const results = await Promise.all(runs.map((run) => complete(run.id)));
		dispose();
		assert.equal(overlap, true, "both actual Pi child processes must overlap");
		assert.notEqual(results[0].cwd, results[1].cwd);
		for (const [index, run] of results.entries()) {
			assert.equal(run.presentation?.finalAnswer, `LIVE_WORKTREE_${values[index]}_OK`);
			assert.equal(await readFile(join(run.cwd, "result.txt"), "utf8"), `${values[index]}\n`);
			assert.equal(await readFile(join(run.cwd, "seed.txt"), "utf8"), "17\n");
			assert.equal(existsSync(join(run.cwd, "untracked.txt")), false);
			assert.equal(run.worktree?.baseCommit, base);
			assert.equal(run.worktree?.state, "retained");
			await assert.rejects(supervisor.removeWorktree(run.id), /tracked, untracked or ignored/);
		}
		assert.equal(await readFile(join(project, "seed.txt"), "utf8"), "999\n");
		assert.equal(await readFile(join(project, "untracked.txt"), "utf8"), "parent only\n");
		assert.equal(existsSync(join(project, "result.txt")), false);
		assert.equal(git(project, "rev-parse", "HEAD"), base);
		const next = await supervisor.followUp(runs[0].id, "Stay inside cwd. Read result.txt from the previous turn, double its value and write followup.txt containing that number followed by a newline. Do not edit result.txt or commit. Your final reply must contain only this exact marker (no punctuation or extra text): LIVE_WORKTREE_FOLLOWUP_OK");
		const followed = await complete(next.id);
		assert.equal(followed.cwd, results[0].cwd);
		assert.equal(followed.control?.turn, 2);
		assert.equal(followed.control?.sessionPath, results[0].control?.sessionPath);
		assert.equal(followed.presentation?.finalAnswer, "LIVE_WORKTREE_FOLLOWUP_OK");
		assert.equal(await readFile(join(followed.cwd, "followup.txt"), "utf8"), "68\n");
		assert.equal(await readFile(join(results[1].cwd, "result.txt"), "utf8"), "51\n");
		assert.equal(existsSync(join(results[1].cwd, "followup.txt")), false);
		const store = new RunStore(paths, sessionId); await store.initialize();
		for (const run of store.list()) {
			assert.equal(isProcessGroupAlive(run.processPid!), false);
			assert.deepEqual(await findOwnedProcesses(run.processToken, run.processStartIdentity), []);
		}
		console.log(`Live parallel Pi verified: ${model}; overlapping worktrees, independently checked 34/51 artifacts, dirty parent untouched, saved follow-up produced 68, no owned descendants remain.`);
	} finally {
		await supervisor?.shutdown();
		await rm(root, { recursive: true, force: true });
	}
});
