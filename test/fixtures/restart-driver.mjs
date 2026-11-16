import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { RunStore } from "../../src/run-store.ts";
import { Supervisor } from "../../src/supervisor.ts";
import { parseSupervisorConfig } from "../../src/profiles.ts";

const args = process.argv.slice(2);
const paths = JSON.parse(args[0]);
const cwd = args[1];
const sessionId = args[2];
const fixture = resolve(dirname(fileURLToPath(import.meta.url)), "fake-agent.mjs");
const config = parseSupervisorConfig({
	defaultProfile: "fake",
	profiles: {
		fake: {
			executable: process.execPath,
			args: [fixture, "--", "{task}"],
			taskTransport: "argument",
		},
	},
});
const supervisor = new Supervisor(config, { paths, sessionId, parentCwd: cwd });
await supervisor.initialize();
const run = await supervisor.start(args[3] ? JSON.parse(args[3]) : { task: JSON.stringify({ mode: "sleep", ms: 60_000 }) });
const store = new RunStore(paths, sessionId);
for (let attempt = 0; attempt < 200; attempt++) {
	const current = await supervisor.get(run.id);
	// Poll the durable checkpoint, not just the mutable in-memory record:
	// the crash test must kill after PID/identity have reached disk.
	const durable = JSON.parse(await readFile(resolve(store.directory, `${run.id}.json`), "utf8"));
	if (current.state === "running" && durable.state === "running" && durable.processPid && durable.processStartIdentity) {
		process.stdout.write(`${JSON.stringify({ id: run.id })}\n`);
		await new Promise(() => {});
	}
	await new Promise((resolveWait) => setTimeout(resolveWait, 10));
}
throw new Error("fake child did not reach running state");
