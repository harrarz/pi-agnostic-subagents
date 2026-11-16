import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { RpcTestClient } from "./fixtures/rpc-client.js";
import { RunStore, type StoredRun } from "../src/run-store.js";

test("installed Pi RPC launches over ten shared agents without limits and supports concurrent worktrees/cleanup", { timeout: 30_000 }, async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-worktree-rpc-")));
	const agent = join(root, "agent");
	const config = join(agent, "agent-supervisor");
	const project = join(root, "project");
	await mkdir(config, { recursive: true });
	await mkdir(project);
	execFileSync("git", ["init", "-q", "-b", "main", project]);
	await writeFile(join(project, "tracked.txt"), "committed source\n");
	execFileSync("git", ["-C", project, "add", "--all"]);
	execFileSync("git", ["-C", project, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "commit", "-qm", "seed"]);
	await writeFile(join(config, "profiles.json"), JSON.stringify({ defaultProfile: "fake", profiles: { fake: {
		executable: process.execPath, args: [resolve("test/fixtures/fake-agent.mjs"), "--", "{task}"], taskTransport: "argument", outputProtocol: "text",
	} } }));
	const client = new RpcTestClient(spawn(process.env.PI_BIN ?? "pi", [
		"--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--extension", resolve("src/index.ts"),
		"--no-skills", "--no-themes", "--no-prompt-templates", "--no-context-files",
	], { cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdio: ["pipe", "pipe", "pipe"] }));
	try {
		const state = await client.request({ type: "get_state" });
		assert.equal(state.success, true);
		const paths = { configDirectory: config, profilesFile: join(config, "profiles.json"), runtimeDirectory: join(config, "runtime") };
		const records = async () => { const store = new RunStore(paths, state.data.sessionId); await store.initialize(); return store.list(); };
		const waitRun = async (label: string, expected: string): Promise<StoredRun> => {
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				const run = (await records()).find((run) => run.label === label && run.state === expected);
				if (run) return run;
				await new Promise((done) => setTimeout(done, 20));
			}
			throw new Error(`${label} did not reach ${expected}`);
		};
		for (const name of ["one", "two"]) {
			const response = await client.request({ type: "prompt", message: `/agent run --label ${name} --isolation worktree -- ${JSON.stringify({ mode: "workspace", text: name, ms: 2500 })}` });
			assert.equal(response.success, true);
		}
		const one = await waitRun("one", "running");
		const two = await waitRun("two", "running");
		assert.notEqual(one.cwd, two.cwd);
		assert.notEqual(one.worktree!.branch, two.worktree!.branch);
		const detail = await client.request({ type: "prompt", message: `/agent show ${one.id}` });
		assert.equal(detail.success, true);
		await client.waitFor((record) => record.type === "extension_ui_request" && record.method === "notify" && String(record.message).includes(`Run ${one.id} —`) && String(record.message).includes(`Branch: ${one.worktree!.branch}`));
		await waitRun("one", "exited"); await waitRun("two", "exited");
		assert.equal(await readFile(join(one.cwd, "work.txt"), "utf8"), "one");
		assert.equal(await readFile(join(two.cwd, "work.txt"), "utf8"), "two");
		await assert.rejects(readFile(join(project, "work.txt")), { code: "ENOENT" });
		await rm(join(one.cwd, "work.txt"));

		const remove = async (confirmed: boolean) => {
			const before = client.records.length;
			const result = client.request({ type: "prompt", message: `/agent worktree remove ${one.id}` });
			const confirmation = await client.waitFor((record) => client.records.indexOf(record) >= before && record.type === "extension_ui_request" && record.method === "confirm");
			client.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: confirmation.id, confirmed })}\n`);
			assert.equal((await result).success, true);
		};
		await remove(false);
		assert.ok((await stat(one.cwd)).isDirectory());
		await remove(true);
		await assert.rejects(stat(one.cwd), { code: "ENOENT" });
		assert.equal(execFileSync("git", ["-C", project, "rev-parse", `refs/heads/${one.worktree!.branch}`], { encoding: "utf8" }).trim(), one.worktree!.baseCommit);
		assert.ok((await stat(two.cwd)).isDirectory());

		const labels = Array.from({ length: 12 }, (_, index) => `unrestricted-${index}`);
		await Promise.all(labels.map(async (label) => {
			const response = await client.request({ type: "prompt", message: `/agent run --label ${label} -- ${JSON.stringify({ mode: "sleep", ms: 60_000 })}` });
			assert.equal(response.success, true);
		}));
		const shared = await Promise.all(labels.map((label) => waitRun(label, "running")));
		assert.equal((await records()).filter((run) => run.state === "running").length, 12);
		assert.ok(shared.every((run) => run.cwd === project && !run.queueReason));
		for (const run of shared) {
			const before = client.records.length;
			const response = client.request({ type: "prompt", message: `/agent stop ${run.id}` });
			const confirmation = await client.waitFor((record) => client.records.indexOf(record) >= before && record.type === "extension_ui_request" && record.method === "confirm");
			client.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: confirmation.id, confirmed: true })}\n`);
			assert.equal((await response).success, true);
			await waitRun(run.label!, "cancelled");
		}
		assert.equal(client.records.some((record) => record.type === "agent_start"), false, "no parent model turn should be triggered");
	} finally { await client.close(); await rm(root, { recursive: true, force: true }); }
});
