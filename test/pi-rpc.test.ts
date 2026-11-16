import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RpcTestClient } from "./fixtures/rpc-client.js";

test("loads the extension in the installed Pi RPC runtime and runs slash commands without a model call", async () => {
	const piBin = process.env.PI_BIN ?? "pi";
	const root = await mkdtemp(join(tmpdir(), "pi-agent-supervisor-live-pi-"));
	const agentDir = join(root, "pi-agent");
	const project = join(root, "project");
	const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");
	const fakeAgent = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-agent.mjs");
	await mkdir(join(agentDir, "agent-supervisor"), { recursive: true });
	await mkdir(project, { recursive: true });
	execFileSync("git", ["init", "-q", project]);
	await writeFile(join(agentDir, "agent-supervisor", "profiles.json"), JSON.stringify({
		defaultProfile: "fake-third-party",
		profiles: {
			"fake-third-party": {
				outputProtocol: "text",
				executable: process.execPath,
				args: [fakeAgent, "--", "{task}"],
				taskTransport: "argument",
			},
		},
	}));

	const client = new RpcTestClient(spawn(piBin, [
		"--mode", "rpc", "--no-session", "--no-extensions", "--extension", extensionPath,
		"--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
	], {
		cwd: project,
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
		stdio: ["pipe", "pipe", "pipe"],
	}));
	try {
		const response = await client.request({ type: "prompt", message: "/agent run --profile fake-third-party -- End-to-end from installed Pi" });
		assert.equal(response.success, true);
		assert.equal(response.data?.disposition, "handled");
		const startNotice = await client.waitFor((record) => record.type === "extension_ui_request" && record.method === "notify" && String(record.message).includes("Started agent run"));
		const idMatch = String(startNotice.message).match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i);
		assert.ok(idMatch, `run ID missing from notification: ${startNotice.message}`);
		const runId = idMatch[0];
		const completedNotice = await client.waitFor((record) => record.type === "extension_ui_request" && record.method === "notify" && String(record.message).includes(`Run ${runId}.`));
		assert.match(String(completedNotice.message), /Agent process exited with code 0/);
		assert.match(String(completedNotice.message), /does not establish task correctness/);

		const showResponse = await client.request({ type: "prompt", message: `/agent show ${runId}` });
		assert.equal(showResponse.success, true);
		const detailNotice = await client.waitFor((record) => record.type === "extension_ui_request" && record.method === "notify" && String(record.message).includes(`Run ${runId} — exited`));
		assert.match(String(detailNotice.message), /OUT:End-to-end from installed Pi/);
		assert.doesNotMatch(String(detailNotice.message), /ERR:End-to-end from installed Pi/);
		assert.equal(client.records.some((record) => record.type === "agent_start"), false, "slash commands and completion must not start a parent model turn");
	} finally {
		await client.close();
		await rm(root, { recursive: true, force: true });
	}
});
