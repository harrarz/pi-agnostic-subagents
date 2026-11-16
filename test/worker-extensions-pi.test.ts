import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseSupervisorConfig } from "../src/profiles.js";
import { Supervisor } from "../src/supervisor.js";
import { isTerminalState } from "../src/run-store.js";
import { WorkerExtensions } from "../src/worker-extensions.js";
import { findOwnedProcesses, isProcessGroupAlive } from "../src/process.js";
import { RpcTestClient } from "./fixtures/rpc-client.js";

const capability = { none: ["--no-extensions"], load: ["--extension", "{extension}"] };
const quiet = ["--offline", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];
async function until(predicate: () => Promise<boolean>, timeout = 20000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) { if (await predicate()) return; await new Promise((done) => setTimeout(done, 30)); }
	throw new Error("Offline worker condition timed out");
}

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "pi-worker-extensions-real-")));
	const agent = join(root, "agent"), project = join(root, "project"), configDirectory = join(root, "supervisor");
	await mkdir(join(agent, "extensions"), { recursive: true }); await mkdir(project);
	const requests: string[] = [];
	const server = createServer(async (req, res) => {
		let body = ""; for await (const chunk of req) body += chunk;
		requests.push(body);
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const delta = { id: `offline-${requests.length}`, object: "chat.completion.chunk", created: 0, model: "test", choices: [{ index: 0, delta: { role: "assistant", content: `ANSWER_${requests.length}` }, finish_reason: null }] };
		res.write(`data: ${JSON.stringify(delta)}\n\n`);
		res.end(`data: ${JSON.stringify({ ...delta, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	await writeFile(join(agent, "models.json"), JSON.stringify({ providers: { offline: {
		baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, api: "openai-completions", apiKey: "test-only",
		models: [{ id: "test", reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
	const alpha = join(agent, "extensions", "alpha.ts"), beta = join(agent, "extensions", "beta.ts");
	const marker = join(root, "factories.txt");
	const probe = (name: string) => `import {appendFileSync} from 'node:fs'; export default function(pi) { appendFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name + "\n")}); pi.on('before_agent_start',()=>pi.appendEntry('worker-extension-probe',{name:${JSON.stringify(name)},nested:pi.getAllTools().some(t=>t.name==='agent_start')||pi.getCommands().some(c=>c.name==='agent'),worker:process.env.PI_AGENT_SUPERVISOR_WORKER})); }`;
	await writeFile(alpha, probe("alpha")); await writeFile(beta, probe("beta"));
	await symlink(resolve("src/index.ts"), join(agent, "extensions", "supervisor.ts"));
	const settings = { defaultProjectTrust: "always", extensions: [`-${beta}`, ...["mcp", "llama.cpp", "codemode", "tool-search"].map((name) => `-builtin:${name}`)] };
	await writeFile(join(agent, "settings.json"), JSON.stringify(settings));
	await mkdir(join(project, ".pi", "extensions"), { recursive: true });
	await writeFile(join(project, ".pi", "extensions", "not-inherited.ts"), 'throw new Error("Project extension must not be inherited");');
	const config = parseSupervisorConfig({ defaultProfile: "worker", extensionSets: { beta: [beta] }, profiles: { worker: {
		executable: process.env.PI_BIN ?? "pi", args: [...quiet, "{extensionArgs}", "--mode", "rpc", "--session", "{session}", "{modelArgs}"],
		extensionArgs: capability, taskTransport: "pi-rpc", outputProtocol: "pi-jsonl", modelArgs: ["--model", "{model}"],
		environment: { PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
	} } });
	const paths = { configDirectory, profilesFile: join(configDirectory, "profiles.json"), runtimeDirectory: join(configDirectory, "runtime") };
	const supervisor = new Supervisor(config, { paths, parentCwd: project, sessionId: "offline-extension-modes", stopGraceMs: 300 });
	await supervisor.initialize();
	async function finished(id: string) { await until(async () => isTerminalState(supervisor.inspect(id).state)); return supervisor.get(id); }
	async function run(extensions: "none" | "inherit" | "custom", extensionSet?: string) {
		const started = await supervisor.start({ task: "OFFLINE_EXTENSION_CHECK", model: "offline/test", extensions, ...(extensionSet ? { extensionSet } : {}), timeoutMs: 15000 });
		return finished(started.id);
	}
	async function probes(session: string) {
		return (await readFile(session, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).filter((entry) => entry.customType === "worker-extension-probe").map((entry) => entry.data);
	}
	return { root, agent, project, config, paths, supervisor, alpha, beta, marker, settings, requests, run, finished, probes,
		cleanup: async () => { await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await rm(root, { recursive: true, force: true }); } };
}

test("real Pi loads none/inherit/custom exactly; saved snapshots survive follow-up/rerun and inherited supervisor cannot delegate", { timeout: 60000 }, async () => {
	const f = await fixture();
	try {
		const policy = new WorkerExtensions(f.paths.configDirectory);
		await policy.catalog(f.project, { PI_CODING_AGENT_DIR: f.agent });
		await assert.rejects(readFile(f.marker), { code: "ENOENT" }, "listing resources must not execute their factories");
		const none = await f.run("none");
		assert.equal(none.state, "exited", none.error?.message ?? none.outputTail); assert.equal(none.exitCode, 0);
		assert.deepEqual(await f.probes(none.control!.sessionPath), []);
		const inherited = await f.run("inherit");
		assert.equal(inherited.exitCode, 0, inherited.outputTail);
		const first = await f.probes(inherited.control!.sessionPath);
		assert.deepEqual(first.map((entry) => entry.name), ["alpha"]);
		assert.equal(first[0].nested, false); assert.equal(first[0].worker, "1");
		const custom = await f.run("custom", "beta");
		assert.equal(custom.exitCode, 0, custom.outputTail);
		assert.deepEqual((await f.probes(custom.control!.sessionPath)).map((entry) => entry.name), ["beta"]);
		await writeFile(join(f.agent, "settings.json"), JSON.stringify({ ...f.settings, extensions: [f.beta, `-${f.alpha}`, ...f.settings.extensions.filter((entry) => entry.startsWith("-builtin:"))] }));
		await policy.setProfile("worker", { mode: "custom", set: "beta" });
		const follow = await f.finished((await f.supervisor.followUp(inherited.id, "FOLLOW_WITH_SAME_SELECTION")).id);
		assert.equal(follow.exitCode, 0, follow.outputTail);
		assert.deepEqual(follow.extensions, inherited.extensions);
		assert.deepEqual((await f.probes(follow.control!.sessionPath)).map((entry) => entry.name), ["alpha", "alpha"]);
		const rerun = await f.finished((await f.supervisor.rerun(inherited.id)).id);
		assert.deepEqual(rerun.extensions, inherited.extensions);
		assert.deepEqual((await f.probes(rerun.control!.sessionPath)).map((entry) => entry.name), ["alpha"]);
		const changed = await f.finished((await f.supervisor.rerun(inherited.id, { extensions: "none" })).id);
		assert.deepEqual(changed.extensions, { mode: "none", paths: [] });
		assert.deepEqual(await f.probes(changed.control!.sessionPath), []);
		const saved = await f.finished((await f.supervisor.start({ task: "SAVED_DEFAULT", model: "offline/test" })).id);
		assert.equal(saved.extensions?.set, "beta");
		await rm(f.beta);
		const count = f.supervisor.snapshot().length;
		await assert.rejects(f.supervisor.rerun(custom.id), /missing/);
		assert.equal(f.supervisor.snapshot().length, count, "missing pinned extensions must fail before admission");
	} finally { await f.cleanup(); }
});

test("real Pi extension load/runtime/dialog errors fail visibly and suppress answers and continuation", { timeout: 60000 }, async () => {
	const f = await fixture();
	try {
		for (const [name, source] of Object.entries({
			load: 'export default function() { throw new Error("intentional load failure"); }',
			runtime: 'export default function(pi) { pi.on("session_start",()=>{throw new Error("intentional runtime failure")}); }',
			dialog: 'export default function(pi) { pi.on("session_start",async(_event,ctx)=>{await ctx.ui.confirm("Worker cannot ask", "Permission?")}); }',
			notification: 'export default function(pi) { pi.on("session_start",(_event,ctx)=>ctx.ui.notify("intentional extension error", "error")); }',
		})) {
			const path = join(f.root, `${name}.ts`); await writeFile(path, source);
			await new WorkerExtensions(f.paths.configDirectory).set(name, [path]);
			const run = await f.run("custom", name);
			assert.ok(run.error, `${name}: ${run.outputTail}`);
			assert.equal(run.presentation?.finalAnswer, undefined, name);
			assert.equal(run.capabilities?.followUp, undefined); // get() stores process facts; inspect() computes controls.
			assert.equal(f.supervisor.inspect(run.id).capabilities?.followUp, false, name);
			if (name !== "load") { assert.equal(run.state, "interrupted", run.outputTail); assert.equal(run.error?.code, "WORKER_EXTENSION"); }
			else assert.match(run.outputTail, /intentional load failure/);
		}
	} finally { await f.cleanup(); }
});

test("selected worker extensions and their detached children are cleaned on stop and timeout", { timeout: 40000 }, async () => {
	const f = await fixture();
	try {
		const ready = join(f.root, "extension-child.json"), entry = join(f.root, "long-extension.ts");
		await writeFile(entry, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; export default function(pi) { pi.on('session_start',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); child.unref(); writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,child:child.pid}));}); pi.on('before_agent_start',()=>new Promise(()=>{})); }`);
		await new WorkerExtensions(f.paths.configDirectory).set("long", [entry]);
		for (const outcome of ["cancelled", "timed_out"] as const) {
			await rm(ready, { force: true });
			const started = await f.supervisor.start({ task: "OFFLINE_LONG_WORKER", model: "offline/test", extensions: "custom", extensionSet: "long", timeoutMs: 4000 });
			await until(async () => { try { await readFile(ready); return true; } catch { return false; } });
			const checkpoint = JSON.parse(await readFile(ready, "utf8"));
			assert.ok(checkpoint.child > 0);
			const run = outcome === "cancelled" ? await f.supervisor.stop(started.id) : await f.finished(started.id);
			assert.equal(run.state, outcome, run.error?.message ?? run.outputTail);
			assert.equal(isProcessGroupAlive(checkpoint.pid), false);
			const { readdir } = await import("node:fs/promises");
			const [sessionDirectory] = await readdir(join(f.paths.runtimeDirectory, "runs"));
			const stored = JSON.parse(await readFile(join(f.paths.runtimeDirectory, "runs", sessionDirectory, `${run.id}.json`), "utf8"));
			assert.deepEqual(await findOwnedProcesses(stored.processToken, stored.processStartIdentity), []);
			assert.equal(run.presentation?.finalAnswer, undefined);
		}
		assert.equal(f.requests.length, 0, "the extension blocks before any provider request");
	} finally { await f.cleanup(); }
});

const durable = process.env.PI_AGENT_SUPERVISOR_DURABLE_EXTENSION;
test("actual Durable journals a selected worker and recovers the same saved session after SIGKILL (offline faux provider)", { skip: !durable, timeout: 60000 }, async () => {
	const f = await fixture();
	let recovered: RpcTestClient | undefined;
	try {
		const provider = resolve("test/fixtures/worker-durable-provider.ts");
		const ready = join(f.root, "durable-ready.json");
		f.config.extensionSets!.durable = [durable!, provider];
		f.config.profiles.worker.environment!.PI_WORKER_DURABLE_READY = ready;
		const started = await f.supervisor.start({ task: "OFFLINE_DURABLE_REQUEST", model: "faux/faux-1", extensions: "custom", extensionSet: "durable", timeoutMs: 30000 });
		await until(async () => { try { await readFile(ready); return true; } catch { const run = f.supervisor.inspect(started.id); assert.ok(!isTerminalState(run.state), JSON.stringify(run.error)); return false; } });
		const checkpoint = JSON.parse(await readFile(ready, "utf8"));
		assert.equal(checkpoint.sessionFile, f.supervisor.inspect(started.id).control!.sessionPath);
		assert.equal(await readFile(join(f.project, "receipt.txt"), "utf8"), "once\n");
		const metadataPath = join(f.paths.runtimeDirectory, "runs");
		const { readdir } = await import("node:fs/promises");
		const [sessionDirectory] = await readdir(metadataPath);
		const stored = JSON.parse(await readFile(join(metadataPath, sessionDirectory, `${started.id}.json`), "utf8"));
		assert.equal(stored.processPid, checkpoint.pid, "only kill the test-owned worker recorded by this supervisor");
		process.kill(checkpoint.pid, "SIGKILL");
		const interrupted = await f.finished(started.id);
		assert.equal(interrupted.signal, "SIGKILL");
		assert.equal(f.supervisor.inspect(started.id).capabilities?.followUp, false, "this feature does not silently enable interrupted-worker continuation");
		const entriesBefore = (await readFile(checkpoint.sessionFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
		assert.ok(entriesBefore.some((entry) => entry.customType === "pi-durable-harness.run" && entry.data.status === "started"));
		recovered = new RpcTestClient(spawn(process.env.PI_BIN ?? "pi", [...quiet, "--no-extensions", "-e", durable!, "-e", provider, "--mode", "rpc", "--session", checkpoint.sessionFile, "--model", "faux/faux-1"], {
			cwd: f.project, env: { ...process.env, PI_CODING_AGENT_DIR: f.agent, PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_WORKER_DURABLE_PHASE: "resume" }, stdio: ["pipe", "pipe", "pipe"],
		}));
		await recovered.waitFor((event) => event.type === "agent_settled", 35000);
		assert.equal(await readFile(join(f.project, "receipt.txt"), "utf8"), "once\n", "recovery must not repeat the completed side effect");
		assert.equal(await readFile(join(f.project, "recovered.txt"), "utf8"), "recovered\n");
		const entriesAfter = (await readFile(checkpoint.sessionFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
		assert.ok(entriesAfter.some((entry) => entry.customType === "pi-durable-harness.run" && entry.data.status === "completed"));
		assert.equal(f.requests.length, 0, "the Durable check uses only a local deterministic provider");
	} finally { await recovered?.close(); await f.cleanup(); }
});
