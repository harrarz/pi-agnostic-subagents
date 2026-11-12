import assert from "node:assert/strict";
import { test } from "node:test";
import { OutputPresenter } from "../src/presentation.js";
import { parseSupervisorConfig } from "../src/profiles.js";

function event(presenter: OutputPresenter, value: unknown): void {
	presenter.push(Buffer.from(JSON.stringify(value) + "\n"));
}
function answer(presenter: OutputPresenter, text = "Final answer 雪", stopReason = "stop"): void {
	event(presenter, { type: "message_end", message: { role: "assistant", stopReason, content: [{ type: "thinking", thinking: "SECRET REASONING" }, { type: "text", text }] } });
}

test("Pi presentation extracts only settled final text, activity and readable transcript", () => {
	const presenter = new OutputPresenter("pi-jsonl");
	event(presenter, { type: "agent_start" });
	event(presenter, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "SECRET REASONING" } });
	assert.equal(presenter.state.activity, "Thinking");
	event(presenter, { type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "auth.ts" } });
	assert.equal(presenter.state.activity, "read · auth.ts");
	event(presenter, { type: "tool_execution_end", toolCallId: "a", toolName: "read", result: { content: [{ type: "text", text: "file contents" }] } });
	answer(presenter);
	assert.equal(presenter.state.finalAnswer, undefined, "message completion alone is not run completion");
	event(presenter, { type: "agent_end" });
	event(presenter, { type: "agent_settled", aborted: false });
	presenter.finish(true);
	assert.equal(presenter.state.finalAnswer, "Final answer 雪");
	assert.match(JSON.stringify(presenter.state.transcript), /file contents/);
	assert.doesNotMatch(JSON.stringify(presenter.state), /SECRET REASONING/);
});

test("LF framing handles split UTF-8, CRLF and Unicode line separators", () => {
	const presenter = new OutputPresenter("pi-jsonl");
	const bytes = Buffer.from(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "雪\u2028still one record\u2029" }] } }) + "\r\n" + JSON.stringify({ type: "agent_settled", aborted: false }));
	for (const byte of bytes) presenter.push(Buffer.from([byte]));
	presenter.finish(true);
	assert.equal(presenter.state.finalAnswer, "雪\u2028still one record\u2029");
});

test("malformed, unknown and oversized records cannot break subsequent parsing", () => {
	const presenter = new OutputPresenter("pi-jsonl");
	presenter.push(Buffer.from("not-json\nnull\n[]\n{\"type\":\"future-event\"}\n"));
	for (let i = 0; i < 10; i++) presenter.push(Buffer.alloc(64 * 1024, 0x78));
	presenter.push(Buffer.from("\n"));
	answer(presenter);
	event(presenter, { type: "agent_settled", aborted: false });
	presenter.finish(true);
	assert.equal(presenter.state.finalAnswer, "Final answer 雪");
	assert.match(presenter.state.protocolWarning!, /Oversized/);
	assert.ok(JSON.stringify(presenter.state).length < 2000);
});

test("malformed field types do not throw or stop subsequent stream consumption", () => {
	const presenter = new OutputPresenter("pi-jsonl");
	const malformed = { toString: null, valueOf: null };
	event(presenter, { type: "tool_execution_end", toolName: malformed, result: { content: [{ type: "text", text: "output" }] } });
	event(presenter, { type: "message_end", message: { role: "assistant", stopReason: malformed, content: [{ type: "text", text: "not final" }] } });
	answer(presenter);
	event(presenter, { type: "agent_settled", aborted: false });
	presenter.finish(true);
	assert.equal(presenter.state.finalAnswer, "Final answer 雪");
});

test("tool-calling text and intermediate responses are not final answers", () => {
	const presenter = new OutputPresenter("pi-jsonl");
	event(presenter, { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Let me check" }, { type: "toolCall", name: "read" }] } });
	event(presenter, { type: "agent_settled", aborted: false });
	presenter.finish(true);
	assert.equal(presenter.state.finalAnswer, undefined);
});

test("retry and subsequent turn discard stale answer candidates", () => {
	const presenter = new OutputPresenter("pi-jsonl");
	answer(presenter, "stale");
	event(presenter, { type: "auto_retry_start" });
	event(presenter, { type: "turn_start" });
	answer(presenter, "current");
	event(presenter, { type: "agent_settled", aborted: false });
	presenter.finish(true);
	assert.equal(presenter.state.finalAnswer, "current");
});

test("protocol failure, abort, incomplete stream and process failure never publish an answer", () => {
	for (const mode of ["error", "aborted", "unsettled", "process-failure", "length"]) {
		const presenter = new OutputPresenter("pi-jsonl");
		answer(presenter, "candidate", mode === "error" || mode === "length" ? mode : "stop");
		if (mode !== "unsettled") event(presenter, { type: "agent_settled", aborted: mode === "aborted" });
		presenter.finish(mode !== "process-failure");
		assert.equal(presenter.state.finalAnswer, undefined, mode);
	}
});

test("parallel tool activity retains the tool still running", () => {
	const presenter = new OutputPresenter("pi-jsonl");
	for (const id of ["a", "b"]) event(presenter, { type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: id } });
	event(presenter, { type: "tool_execution_end", toolCallId: "b" });
	assert.equal(presenter.state.activity, "read · a");
});

test("transcript count, transcript size and answer size are bounded independently", () => {
	const presenter = new OutputPresenter("pi-jsonl");
	for (let i = 0; i < 200; i++) answer(presenter, `${i}:` + "x".repeat(1500));
	answer(presenter, "z".repeat(20_000));
	event(presenter, { type: "agent_settled", aborted: false });
	presenter.finish(true);
	assert.ok(presenter.state.transcript.length <= 100);
	assert.ok(presenter.state.transcript.reduce((sum, entry) => sum + entry.text.length, 0) <= 24 * 1024);
	assert.ok(presenter.state.finalAnswer!.length < 13 * 1024);
	assert.equal(presenter.state.answerTruncated, true);
	assert.equal(presenter.state.transcriptTruncated, true);
});

test("raw output is diagnostic-only and never mistaken for an answer", () => {
	const presenter = new OutputPresenter("raw");
	presenter.push(Buffer.from("SECRET RAW LOG\n"));
	presenter.finish(true);
	assert.equal(presenter.state.finalAnswer, undefined);
	assert.deepEqual(presenter.state.transcript, []);
});

test("explicit text output extracts only stdout and bounds long answers", () => {
	const presenter = new OutputPresenter("text");
	presenter.push(Buffer.from("answer " + "x".repeat(100_000)));
	presenter.finish(true);
	assert.ok(presenter.state.finalAnswer!.startsWith("answer"));
	assert.equal(presenter.state.answerTruncated, true);
	assert.ok(presenter.state.finalAnswer!.length <= 12 * 1024);
});

test("protocol selection is trusted profile data, not executable name detection", () => {
	const config = parseSupervisorConfig({ defaultProfile: "arbitrary", profiles: { arbitrary: { executable: "not-pi", args: ["{task}"], taskTransport: "argument", outputProtocol: "pi-jsonl" } } });
	assert.equal(config.profiles.arbitrary.outputProtocol, "pi-jsonl");
	for (const outputProtocol of ["guess", ["pi-jsonl"], null, 1]) {
		assert.throws(() => parseSupervisorConfig({ defaultProfile: "x", profiles: { x: { executable: "pi", args: ["{task}"], taskTransport: "argument", outputProtocol } } }), /outputProtocol/);
	}
});
