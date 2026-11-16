import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Supervisor } from "../../src/supervisor.ts";
import { parseSupervisorConfig } from "../../src/profiles.ts";

const [pathsJson, cwd, sessionId, taskJson] = process.argv.slice(2);
const paths = JSON.parse(pathsJson);
const task = JSON.parse(taskJson);
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
const supervisor = new Supervisor(config, {
	paths,
	sessionId,
	parentCwd: cwd,
	stopGraceMs: 100,
});
await supervisor.initialize();
const started = await supervisor.start({ task: JSON.stringify(task) });
process.stdout.write(`${JSON.stringify({ event: "admitted", id: started.id, state: started.state })}\n`);
let lastState = "";
for (;;) {
	const current = await supervisor.get(started.id);
	if (current.state !== lastState) {
		lastState = current.state;
		process.stdout.write(`${JSON.stringify({ event: "state", id: started.id, state: current.state })}\n`);
	}
	if (["exited", "launch_failed", "cancelled", "timed_out", "interrupted"].includes(current.state)) break;
	await new Promise((resolveWait) => setTimeout(resolveWait, 20));
}
await supervisor.shutdown();
