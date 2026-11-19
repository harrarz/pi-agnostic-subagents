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

function claudeAssistant(presenter: OutputPresenter, content: unknown[], parentToolUseId: string | null = null): void {
	event(presenter, { type: "assistant", message: { role: "assistant", content, stop_reason: null }, parent_tool_use_id: parentToolUseId });
}
function claudeToolResult(presenter: OutputPresenter, id: string, content: unknown, isError = false): void {
	event(presenter, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: null });
}
function claudeResult(presenter: OutputPresenter, fields: Record<string, unknown> = {}): void {
	event(presenter, { type: "result", subtype: "success", is_error: false, stop_reason: "end_turn", result: "Final answer 雪", ...fields });
}

test("Claude Code presentation reports tool activity, transcript and only the settled result", () => {
	const presenter = new OutputPresenter("claude-stream-json");
	event(presenter, { type: "system", subtype: "hook_started", hook_name: "SessionStart:startup" });
	event(presenter, { type: "system", subtype: "init", model: "claude-sonnet-5-5" });
	assert.equal(presenter.state.activity, "Working");
	claudeAssistant(presenter, [{ type: "thinking", thinking: "SECRET REASONING" }]);
	assert.equal(presenter.state.activity, "Thinking");
	claudeAssistant(presenter, [{ type: "tool_use", id: "a", name: "Read", input: { file_path: "note.txt" } }]);
	claudeAssistant(presenter, [{ type: "tool_use", id: "b", name: "Bash", input: { command: "npm  test" } }]);
	assert.equal(presenter.state.activity, "Bash · npm test");
	claudeToolResult(presenter, "b", [{ type: "text", text: "tests passed" }]);
	assert.equal(presenter.state.activity, "Read · note.txt");
	claudeToolResult(presenter, "a", "File does not exist.", true);
	assert.equal(presenter.state.activity, "Working");
	event(presenter, { type: "rate_limit_event", rate_limit_info: { status: "allowed" } });
	claudeAssistant(presenter, [{ type: "text", text: "Final answer 雪" }]);
	assert.equal(presenter.state.finalAnswer, undefined, "assistant text alone is not run completion");
	claudeResult(presenter);
	presenter.finish(true);
	assert.equal(presenter.state.finalAnswer, "Final answer 雪");
	assert.equal(presenter.state.protocolWarning, undefined);
	assert.deepEqual(presenter.state.transcript, [
		{ kind: "tool", text: "Read · note.txt" },
		{ kind: "tool", text: "Bash · npm test" },
		{ kind: "tool", text: "Bash · npm test result:\ntests passed" },
		{ kind: "error", text: "Read · note.txt failed:\nFile does not exist." },
		{ kind: "assistant", text: "Final answer 雪" },
	]);
	assert.doesNotMatch(JSON.stringify(presenter.state), /SECRET REASONING/);
});

test("Claude Code failed, missing or unsuccessful results never publish an answer", () => {
	const cases: Array<[string, (presenter: OutputPresenter) => void, boolean, RegExp]> = [
		["error result", (presenter) => claudeResult(presenter, { is_error: true, result: "Invalid API key" }), true, /Invalid API key/],
		["turn limit", (presenter) => claudeResult(presenter, { subtype: "error_max_turns", result: undefined }), true, /error_max_turns/],
		["no result record", () => {}, true, /No settled final answer/],
		["tool still pending", (presenter) => claudeAssistant(presenter, [{ type: "tool_use", id: "a", name: "Read", input: {} }]), true, /No settled final answer/],
	];
	for (const [name, finish, publish, warning] of cases) {
		const presenter = new OutputPresenter("claude-stream-json");
		claudeAssistant(presenter, [{ type: "text", text: "candidate" }]);
		finish(presenter);
		presenter.finish(publish);
		assert.equal(presenter.state.finalAnswer, undefined, name);
		assert.match(presenter.state.protocolWarning!, warning, name);
	}
	const processFailure = new OutputPresenter("claude-stream-json");
	claudeResult(processFailure);
	processFailure.finish(false);
	assert.equal(processFailure.state.finalAnswer, undefined);
});

test("Claude Code delegated-agent text, stale candidates and malformed fields do not become answers", () => {
	const presenter = new OutputPresenter("claude-stream-json");
	const malformed = { toString: null, valueOf: null };
	event(presenter, { type: "assistant", message: { content: malformed }, parent_tool_use_id: malformed });
	event(presenter, { type: "user", message: { content: [null, { type: "tool_result", tool_use_id: malformed, content: malformed, is_error: true }] } });
	claudeAssistant(presenter, [{ type: "text", text: "delegated commentary" }], "toolu_parent");
	assert.doesNotMatch(JSON.stringify(presenter.state.transcript), /delegated commentary/);
	claudeResult(presenter, { result: "stale" });
	event(presenter, { type: "system", subtype: "init" });
	claudeAssistant(presenter, [{ type: "text", text: "last assistant text" }]);
	claudeResult(presenter, { result: malformed });
	presenter.finish(true);
	assert.equal(presenter.state.finalAnswer, "last assistant text");
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
	for (const outputProtocol of ["guess", "claude-json", ["pi-jsonl"], null, 1]) {
		assert.throws(() => parseSupervisorConfig({ defaultProfile: "x", profiles: { x: { executable: "pi", args: ["{task}"], taskTransport: "argument", outputProtocol } } }), /outputProtocol/);
	}
});
