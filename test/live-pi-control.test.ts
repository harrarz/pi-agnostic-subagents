import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { RpcTestClient } from "./fixtures/rpc-client.js";
import { prepareLivePiConfig } from "./fixtures/live-config.js";
import { type StoredRun } from "../src/run-store.js";
import { getProcessStartIdentity, isPidAlive, isProcessGroupAlive, isSameOwnedProcess } from "../src/process.js";

const approved = process.env.PI_AGENT_SUPERVISOR_LIVE_PI === "1";

test("LIVE Pi stop cleans up a real bash tool's descendants; timeout cleans up another Pi child", { skip: !approved, timeout: 180_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-supervisor-live-control-"));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	let client: RpcTestClient | undefined;
	const toolProcesses: Array<{ pid: number; identity: string; token: string }> = [];
	try {
		const { model, effort, thinking } = await prepareLivePiConfig(agentDir);
		const effortFlag = effort ? ` --effort ${effort}` : "";
		await mkdir(project);
		execFileSync("git", ["init", "-q", project]);
		client = new RpcTestClient(spawn(process.env.PI_BIN ?? "pi", [
			"--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--extension", resolve("src/index.ts"),
			"--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-tools",
			"--model", model, ...(thinking ? ["--thinking", thinking] : []),
		], { cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdio: ["pipe", "pipe", "pipe"] }));
		const records = async (): Promise<StoredRun[]> => {
			const root = join(agentDir, "agent-supervisor/runtime/runs");
			const result: StoredRun[] = [];
			for (const directory of await readdir(root)) {
				for (const name of await readdir(join(root, directory))) {
					if (name.endsWith(".json")) result.push(JSON.parse(await readFile(join(root, directory, name), "utf8")) as StoredRun);
				}
			}
			return result;
		};
		const waitRun = async (label: string, state: string, timeoutMs = 60_000): Promise<StoredRun> => {
			const end = Date.now() + timeoutMs;
			while (Date.now() < end) {
				const run = (await records()).find((run) => run.label === label && run.state === state);
				if (run) return run;
				await new Promise((done) => setTimeout(done, 100));
			}
			throw new Error(`Live run ${label} never reached ${state}`);
		};
		const task = (name: string) => {
			const command = `sleep 60 & worker=$!; printf '%s\\n%s\\n' $$ "$worker" > ${name}.pids; wait "$worker"`;
			return `Use bash exactly once to execute this exact shell command: ${JSON.stringify(command)}. Do not replace bash with another tool. After the command finishes reply WAIT_DONE. Do not do any other work.`;
		};
		const start = await client.request({ type: "prompt", message: `/agent run --label live-stop --profile pi${effortFlag} --timeout-ms 90000 -- ${task("stop")}` });
		assert.equal(start.success, true);
		const active = await waitRun("live-stop", "running");
		const until = Date.now() + 60_000;
		let pids: number[] = [];
		while (Date.now() < until) {
			try { pids = (await readFile(join(project, "stop.pids"), "utf8")).trim().split(/\s+/).map(Number); if (pids.length === 2) break; }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			await new Promise((done) => setTimeout(done, 100));
		}
		assert.equal(pids.length, 2, "real model must actually start the bash tool before stopping");
		for (const pid of pids) {
			const identity = await getProcessStartIdentity(pid);
			assert.ok(identity);
			toolProcesses.push({ pid, identity, token: active.processToken });
		}
		const stopResponse = client.request({ type: "prompt", message: `/agent stop ${active.id}` });
		const confirmation = await client.waitFor((record) => record.type === "extension_ui_request" && record.method === "confirm", 20_000);
		client.child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: confirmation.id, confirmed: true })}\n`);
		assert.equal((await stopResponse).success, true);
		const stopped = await waitRun("live-stop", "cancelled");
		assert.equal(stopped.presentation?.finalAnswer, undefined);
		assert.equal(isProcessGroupAlive(stopped.processPid!), false);
		for (const pid of pids) assert.equal(isPidAlive(pid), false, `bash descendant ${pid} must not survive stop`);

		const timed = await client.request({ type: "prompt", message: `/agent run --label live-timeout --profile pi${effortFlag} --timeout-ms 20000 -- ${task("timeout")}` });
		assert.equal(timed.success, true);
		const timedOut = await waitRun("live-timeout", "timed_out", 35_000);
		assert.equal(timedOut.presentation?.finalAnswer, undefined);
		assert.equal(isProcessGroupAlive(timedOut.processPid!), false);
		let timedDuringTool = false;
		try {
			const timedPids = (await readFile(join(project, "timeout.pids"), "utf8")).trim().split(/\s+/).map(Number);
			for (const pid of timedPids) {
				const identity = await getProcessStartIdentity(pid);
				if (identity) toolProcesses.push({ pid, identity, token: timedOut.processToken });
				assert.equal(isPidAlive(pid), false, `bash descendant ${pid} must not survive timeout`);
			}
			timedDuringTool = true;
		} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		assert.equal((await records()).length, 2);
		console.log(`Live Pi controls verified: real bash/sleep descendants removed on stop; timeout cleanup verified (tool had started: ${timedDuringTool}).`);
	} finally {
		await client?.close();
		// Failure cleanup is identity/token-checked: never signal a reused PID.
		for (const { pid, identity, token } of toolProcesses) {
			if (await isSameOwnedProcess(pid, identity, token)) process.kill(pid, "SIGTERM");
		}
		await rm(root, { recursive: true, force: true });
	}
});
