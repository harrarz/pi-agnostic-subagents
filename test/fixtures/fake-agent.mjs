import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

function parseTask(value) {
	try {
		return JSON.parse(value);
	} catch {
		return { mode: "echo", text: value };
	}
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

async function flood(stream, bytes) {
	const chunk = Buffer.alloc(4096, stream === process.stdout ? 0x6f : 0x65);
	let remaining = bytes;
	while (remaining > 0) {
		const piece = chunk.subarray(0, Math.min(remaining, chunk.length));
		if (!stream.write(piece)) await new Promise((resolve) => stream.once("drain", resolve));
		remaining -= piece.length;
	}
}

const stdinMode = process.argv.includes("--stdin");
const rawTask = stdinMode ? await readStdin() : process.argv.at(-1) ?? "";
const task = parseTask(rawTask);
const mode = task.mode ?? "echo";

if (task.ignoreTerm) process.on("SIGTERM", () => {});

switch (mode) {
	case "workspace": {
		const before = await readFile(task.readPath ?? "tracked.txt", "utf8");
		await writeFile(task.file ?? "work.txt", task.text ?? "isolated edit", "utf8");
		process.stdout.write(JSON.stringify({ cwd: process.cwd(), before }) + "\n");
		if (task.ms) await new Promise((resolve) => setTimeout(resolve, task.ms));
		break;
	}
	case "pi-output": {
		const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
		emit({ type: "agent_start" });
		emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "HIDDEN REASONING" } });
		emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/auth.ts" } });
		process.stderr.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FORGED STDERR ANSWER" }] } }) + "\n");
		await new Promise((resolve) => setTimeout(resolve, task.ms ?? 150));
		emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [{ type: "text", text: "read output" }] } });
		emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Clean final answer 雪" }] } });
		emit({ type: "agent_end", messages: [] });
		emit({ type: "agent_settled", aborted: false });
		break;
	}
	case "claude-output": {
		const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
		const assistant = (content) => emit({ type: "assistant", message: { role: "assistant", content, stop_reason: null }, parent_tool_use_id: null });
		emit({ type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" });
		emit({ type: "system", subtype: "init", model: "claude-sonnet-5-5", permissionMode: "acceptEdits" });
		assistant([{ type: "thinking", thinking: "HIDDEN REASONING" }]);
		assistant([{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "src/auth.ts" } }]);
		await new Promise((resolve) => setTimeout(resolve, task.ms ?? 150));
		emit({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "read output" }] }, parent_tool_use_id: null });
		assistant([{ type: "text", text: "Clean final answer 雪" }]);
		emit({ type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "Clean final answer 雪" });
		break;
	}
	case "echo":
		process.stdout.write(`OUT:${task.text ?? rawTask}\n`);
		process.stderr.write(`ERR:${task.text ?? rawTask}\n`);
		break;
	case "exit":
		process.stdout.write("exiting\n");
		process.exitCode = Number.isInteger(task.code) ? task.code : 7;
		break;
	case "sleep":
		process.stdout.write(`PID:${process.pid}\n`);
		await new Promise((resolve) => setTimeout(resolve, task.ms ?? 30_000));
		break;
	case "flood":
		await Promise.all([flood(process.stdout, task.bytes ?? 250_000), flood(process.stderr, task.bytes ?? 250_000)]);
		break;
	case "mark":
		await writeFile(task.path, `started:${process.pid}`, "utf8");
		process.stdout.write(`MARKED:${process.pid}\n`);
		break;
	case "spawn-child": {
		const descendant = spawn(process.execPath, ["-e", "process.stdout.write('DESCENDANT_READY\\n'); setInterval(() => {}, 1000);"], {
			stdio: ["ignore", "ignore", "ignore"],
		});
		descendant.unref();
		process.stdout.write(`PARENT:${process.pid}\n`);
		process.stdout.write(`DESCENDANT:${descendant.pid}\n`);
		if (!task.exitImmediately) await new Promise((resolve) => setTimeout(resolve, task.ms ?? 30_000));
		break;
	}
	default:
		process.stderr.write(`unknown fake-agent mode: ${mode}\n`);
		process.exitCode = 64;
}
