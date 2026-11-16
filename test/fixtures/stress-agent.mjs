import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

if (process.argv[2] === "detached") {
	const file = process.argv[3];
	let forked = false;
	process.on("SIGTERM", () => {
		if (forked) return;
		forked = true;
		const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
		child.unref();
		writeFileSync(`${file}.fork`, String(child.pid));
	});
	writeFileSync(file, String(process.pid));
	setInterval(() => {}, 1000);
} else {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const task = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	const wait = async (file) => {
		const deadline = Date.now() + 120_000;
		while (!existsSync(file)) {
			if (Date.now() > deadline) throw new Error(`Barrier timeout: ${file}`);
			await delay(10);
		}
	};
	if (task.mode === "descendants") {
		for (let index = 0; index < 2; index++) {
			const file = `${task.ready}.${index}`;
			const child = spawn(process.execPath, [process.argv[1], "detached", file], { detached: true, stdio: "ignore" });
			child.unref();
			await wait(file);
		}
		await writeFile(task.ready, "ready");
		if (!task.exit) await delay(120_000);
	} else {
		const prior = task.collision ? await readFile(task.output, "utf8") : undefined;
		if (task.ready) await writeFile(task.ready, task.id);
		if (task.release) await wait(task.release);
		if (task.collision) await writeFile(task.output, `${prior}${task.id}\n`);
		else {
			if (task.ledger) {
				for (let seq = 0; seq < (task.rows ?? 1); seq++) await appendFile(task.ledger, JSON.stringify({ id: task.id, seq, text: task.text }) + "\n");
			}
			if (task.output) await writeFile(task.output, task.text ?? task.id);
		}
		if (task.flood) {
			for (const stream of [process.stdout, process.stderr]) {
				for (let count = 0; count < task.flood; count += 4096) {
					if (!stream.write("x".repeat(Math.min(4096, task.flood - count)))) await new Promise((done) => stream.once("drain", done));
				}
			}
		}
	}
	process.stdout.write(`DONE ${task.id}\n`);
}
