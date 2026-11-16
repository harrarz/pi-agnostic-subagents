import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { RpcTestClient } from "./fixtures/rpc-client.js";
import { prepareLivePiConfig } from "./fixtures/live-config.js";
import { isTerminalState, type StoredRun } from "../src/run-store.js";
import { isProcessGroupAlive } from "../src/process.js";

const approved = process.env.PI_AGENT_SUPERVISOR_LIVE_PI === "1";

test("LIVE Pi parent delegates once, real child reads/writes, and parent retrieves a clean answer", { skip: !approved, timeout: 240_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-supervisor-live-provider-"));
	const agentDir = join(root, "agent");
	const project = join(root, "project");
	let client: RpcTestClient | undefined;
	try {
		const { model, effort, thinking } = await prepareLivePiConfig(agentDir);
		await mkdir(project);
		execFileSync("git", ["init", "-q", project]);
		await writeFile(join(project, "seed.txt"), "17\n");
		const child = spawn(process.env.PI_BIN ?? "pi", [
			"--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--extension", resolve("src/index.ts"),
			"--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
			"--model", model, ...(thinking ? ["--thinking", thinking] : []), "--no-tools", "--tools", "agent_start,agent_get",
		], { cwd: project, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdio: ["pipe", "pipe", "pipe"] });
		client = new RpcTestClient(child);
		const state = await client.request({ type: "get_state" });
		assert.equal(state.success, true);
		assert.equal(`${state.data.model.provider}/${state.data.model.id}`, model);
		const session = state.data.sessionId as string;
		assert.ok(session);

		const task = "Read seed.txt. Write result.txt containing exactly 34 followed by a newline. Then reply exactly LIVE_CHILD_OK. Do not do other work.";
		const first = await client.request({ type: "prompt", message: `This is an explicitly authorized delegation test. Call agent_start exactly once with task ${JSON.stringify(task)}, label "live-proof", profile "pi", ${effort ? `effort "${effort}", ` : "omit effort, "}and timeoutMs 120000. Then reply STARTED. Do not call agent_get, start any other agents, or perform reviews.` });
		assert.equal(first.success, true);
		const start = await client.waitFor((record) => record.type === "tool_execution_end" && record.toolName === "agent_start", 120_000);
		assert.equal(start.isError, false, JSON.stringify(start.result));
		const started = JSON.parse(start.result.content[0].text) as { id: string };
		assert.ok(started.id);
		await client.waitFor((record) => record.type === "agent_settled", 120_000);
		const directory = join(agentDir, "agent-supervisor/runtime/runs", createHash("sha256").update(session).digest("hex"));
		const deadline = Date.now() + 130_000;
		let run: StoredRun | undefined;
		while (Date.now() < deadline) {
			run = JSON.parse(await readFile(join(directory, `${started.id}.json`), "utf8")) as StoredRun;
			if (isTerminalState(run.state)) break;
			await new Promise((done) => setTimeout(done, 100));
		}
		assert.equal(run?.state, "exited", `Unexpected child outcome: ${run?.state} ${run?.error?.message ?? ""}`);
		assert.equal(run.exitCode, 0);
		assert.equal(await readFile(join(project, "result.txt"), "utf8"), "34\n", "verify the actual artifact, not process exit");
		assert.equal(run.presentation?.finalAnswer, "LIVE_CHILD_OK");
		assert.equal(run.label, "live-proof");
		assert.equal(run.model, model, "child inherits the real parent model without a profile default");
		assert.equal(run.sessionId, session);
		assert.equal(run.effort, effort);
		const stdout = await readFile(run.stdoutPath!, "utf8");
		const events = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
		assert.ok(events.some((event) => event.type === "tool_execution_start" && event.toolName === "read"));
		assert.ok(events.some((event) => event.type === "tool_execution_start" && event.toolName === "write"));
		assert.ok(events.some((event) => event.type === "agent_settled"));
		assert.equal(isProcessGroupAlive(run.processPid!), false);

		await client.waitFor((record) => record.type === "extension_ui_request" && record.method === "notify" && String(record.message).includes(`Run ${started.id}.`) && String(record.message).includes("LIVE_CHILD_OK"), 20_000);
		assert.equal(client.records.filter((record) => record.type === "agent_start").length, 1, "child completion must not trigger an unsolicited parent turn");
		const before = client.records.length;
		const second = await client.request({ type: "prompt", message: `Call agent_get exactly once with id "${started.id}" and no format override. Do not start another agent or use other tools. Then quote the child's finalAnswer verbatim.` });
		assert.equal(second.success, true);
		const result = await client.waitFor((record) => record.type === "tool_execution_end" && record.toolName === "agent_get", 120_000);
		assert.equal(result.isError, false, JSON.stringify(result.result));
		const report = JSON.parse(result.result.content[0].text);
		assert.equal(report.finalAnswer, "LIVE_CHILD_OK");
		assert.equal(report.parent.sessionId, session);
		assert.equal(report.outputTail, undefined);
		assert.equal(report.transcript, undefined);
		await client.waitFor((record) => client!.records.indexOf(record) >= before && record.type === "agent_settled", 120_000);
		assert.ok(client.records.slice(before).some((record) => record.type === "message_end" && record.message?.role === "assistant" && record.message.content?.some((part: { type: string; text?: string }) => part.type === "text" && part.text?.includes("LIVE_CHILD_OK"))));
		assert.equal(client.records.filter((record) => record.type === "tool_execution_start" && record.toolName === "agent_start").length, 1);
		assert.equal((await readdir(directory)).filter((name) => name.endsWith(".json")).length, 1);
		console.log(`Live Pi verified: ${model}; one child, read/write artifact, clean final answer, parent retrieval, verified process cleanup.`);
	} finally {
		await client?.close();
		await rm(root, { recursive: true, force: true });
	}
});
