import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Supervisor } from "../src/supervisor.js";
import { isTerminalState } from "../src/run-store.js";
import { parseSupervisorConfig } from "../src/profiles.js";

async function wait(predicate: () => boolean) {
	const deadline = Date.now() + 20_000;
	while (!predicate() && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
	assert.ok(predicate(), "condition timed out");
}

test("installed Pi RPC steers and resumes a real session against a loopback-only deterministic endpoint (no paid provider)", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "supervisor-rpc-local-"));
	const agentDir = join(root, "agent");
	await mkdir(agentDir);
	const requests: string[] = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk.toString();
		requests.push(body);
		const index = requests.length;
		if (req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const emit = (delta: object, finish_reason: string | null) => res.write(`data: ${JSON.stringify({ id: `offline-${index}`, object: "chat.completion.chunk", created: 0, model: "test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
		emit({ role: "assistant", content: `OFFLINE_${index}` }, null);
		setTimeout(() => { emit({}, "stop"); res.end("data: [DONE]\n\n"); }, index === 1 ? 1200 : 40);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	t.after(async () => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await rm(root, { recursive: true, force: true }); });
	const port = (server.address() as { port: number }).port;
	await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { offline: {
		baseUrl: `http://127.0.0.1:${port}/v1`, api: "openai-completions", apiKey: "test-only",
		models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	const config = parseSupervisorConfig({ defaultProfile: "local", profiles: { local: {
		executable: process.env.PI_BIN ?? "pi", args: ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--mode", "rpc", "--session", "{session}", "{modelArgs}"],
		taskTransport: "pi-rpc", outputProtocol: "pi-jsonl", modelArgs: ["--model", "{model}"], environment: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
	} } });
	const supervisor = new Supervisor(config, { paths: { configDirectory: root, profilesFile: join(root, "profiles.json"), runtimeDirectory: join(root, "runtime"), lockDirectory: join(root, "locks") }, parentCwd: root, sessionId: "real-rpc-loopback", stopGraceMs: 300 });
	await supervisor.initialize();
	t.after(() => supervisor.shutdown());
	const run = await supervisor.start({ task: "FIRST_CONTEXT_MARKER", model: "offline/test", timeoutMs: 15000 });
	await wait(() => requests.length === 1 && supervisor.inspect(run.id).capabilities?.steer === true);
	assert.equal(await supervisor.steer(run.id, "STEER_CONTEXT_MARKER"), "queued");
	await wait(() => isTerminalState(supervisor.inspect(run.id).state));
	const first = await supervisor.get(run.id);
	assert.equal(first.state, "exited", first.error?.message ?? "expected normal exit");
	assert.equal(first.exitCode, 0, first.error?.message ?? "expected zero exit");
	assert.equal(first.presentation?.finalAnswer, "OFFLINE_2");
	assert.match(requests[1], /FIRST_CONTEXT_MARKER/);
	assert.match(requests[1], /STEER_CONTEXT_MARKER/);
	const session = await readFile(first.control!.sessionPath, "utf8");
	assert.equal(JSON.parse(session.split("\n")[0]).type, "session");
	assert.match(session, /STEER_CONTEXT_MARKER/);
	const follow = await supervisor.followUp(first.id, "FOLLOW_CONTEXT_MARKER");
	await wait(() => isTerminalState(supervisor.inspect(follow.id).state));
	const second = await supervisor.get(follow.id);
	assert.equal(second.presentation?.finalAnswer, "OFFLINE_3", second.error?.message ?? second.presentation?.protocolWarning ?? "expected resumed answer");
	assert.match(requests[2], /FIRST_CONTEXT_MARKER/);
	assert.match(requests[2], /STEER_CONTEXT_MARKER/);
	assert.match(requests[2], /FOLLOW_CONTEXT_MARKER/);
	assert.equal(requests.length, 3, "no automatic extra model turns");
});
