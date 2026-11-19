import { StringDecoder } from "node:string_decoder";

export const OUTPUT_PROTOCOLS = ["raw", "text", "pi-jsonl", "codex-jsonl", "claude-stream-json"] as const;
export type OutputProtocol = typeof OUTPUT_PROTOCOLS[number];
export interface TranscriptEntry {
	kind: "user" | "assistant" | "tool" | "error";
	text: string;
}
export interface RunPresentation {
	activity?: string;
	lastActivityAt?: string;
	finalAnswer?: string;
	answerTruncated?: boolean;
	protocolWarning?: string;
	transcript: TranscriptEntry[];
	transcriptTruncated?: boolean;
}

const MAX_RECORD_CHARS = 256 * 1024;
const MAX_ANSWER_CHARS = 12 * 1024;
const MAX_TRANSCRIPT_CHARS = 24 * 1024;
const MAX_ENTRIES = 100;

export function boundedText(value: string, limit: number): string {
	return value.length <= limit ? value : value.slice(0, limit) + "\n… [truncated]";
}

function object(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textBlocks(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return boundedText(value.filter((part) => object(part).type === "text")
		.map((part) => typeof object(part).text === "string" ? object(part).text : "").join("\n"), MAX_ANSWER_CHARS);
}

function toolActivity(name: unknown, args: unknown): string {
	const input = object(args);
	const tool = typeof name === "string" ? name : "tool";
	const detail = input.path ?? input.file_path ?? input.command ?? input.pattern;
	return boundedText(`${tool}${typeof detail === "string" ? ` · ${detail.replace(/\s+/g, " ")}` : ""}`, 180);
}

/** Presentation-only decoder. It never controls process lifecycle, ownership or success. */
export class OutputPresenter {
	readonly state: RunPresentation = { transcript: [] };
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";
	private droppingRecord = false;
	private text = "";
	private textTruncated = false;
	private candidate?: string;
	private settled = false;
	private protocolFailed = false;
	private readonly tools = new Map<string, string>();

	constructor(readonly protocol: OutputProtocol) {}

	push(chunk: Buffer): void {
		this.consume(this.decoder.write(chunk));
	}

	finish(publishAnswer: boolean): void {
		this.consume(this.decoder.end());
		if (this.pending && !this.droppingRecord) this.record(this.pending);
		this.pending = "";
		if (this.protocol === "text") {
			if (this.text) this.add("assistant", this.text);
			if (publishAnswer && this.text.trim()) {
				this.state.finalAnswer = this.text.trim();
				this.state.answerTruncated = this.textTruncated;
			}
		} else if (this.protocol !== "raw") {
			if (publishAnswer && this.settled && !this.protocolFailed && this.candidate) {
				this.state.finalAnswer = this.candidate;
				this.state.answerTruncated = this.candidate.endsWith("… [truncated]");
			} else if (publishAnswer && !this.settled) {
				this.warn("No settled final answer received; inspect diagnostics.");
			}
		}
	}

	private consume(text: string): void {
		if (!text || this.protocol === "raw") return;
		this.state.lastActivityAt = new Date().toISOString();
		if (this.protocol === "text") {
			this.state.activity = "Producing output";
			const remaining = Math.max(0, MAX_ANSWER_CHARS - this.text.length);
			this.text += text.slice(0, remaining);
			if (text.length > remaining) this.textTruncated = true;
			return;
		}
		// LF only: U+2028/U+2029 are valid inside JSON strings.
		for (let start = 0; start < text.length;) {
			const newline = text.indexOf("\n", start);
			const end = newline < 0 ? text.length : newline;
			if (!this.droppingRecord) {
				if (this.pending.length + end - start > MAX_RECORD_CHARS) {
					this.pending = "";
					this.droppingRecord = true;
					this.warn("Oversized protocol record skipped; inspect diagnostics.");
				} else this.pending += text.slice(start, end);
			}
			if (newline < 0) break;
			if (!this.droppingRecord) this.record(this.pending.replace(/\r$/, ""));
			this.pending = "";
			this.droppingRecord = false;
			start = newline + 1;
		}
	}

	private record(line: string): void {
		if (!line.trim()) return;
		let event: Record<string, unknown>;
		try { event = object(JSON.parse(line)); }
		catch { this.warn("Malformed protocol record skipped; inspect diagnostics."); return; }
		if (this.protocol === "codex-jsonl") { this.codexRecord(event); return; }
		if (this.protocol === "claude-stream-json") { this.claudeRecord(event); return; }
		switch (event.type) {
			case "agent_start":
			case "turn_start":
				this.settled = false;
				this.candidate = undefined;
				this.protocolFailed = false;
				this.state.activity = "Working";
				break;
			case "message_update": {
				const update = object(event.assistantMessageEvent);
				if (update.type === "text_delta") this.state.activity = "Writing response";
				else if (update.type === "thinking_delta") this.state.activity = "Thinking";
				break;
			}
			case "tool_execution_start": {
				this.candidate = undefined;
				this.settled = false;
				const activity = toolActivity(event.toolName, event.args);
				if (typeof event.toolCallId === "string" && this.tools.size < 100) this.tools.set(event.toolCallId, activity);
				this.state.activity = activity;
				this.add("tool", activity);
				break;
			}
			case "tool_execution_end": {
				if (typeof event.toolCallId === "string") this.tools.delete(event.toolCallId);
				this.state.activity = this.tools.values().next().value ?? "Working";
				const output = textBlocks(object(event.result).content);
				if (output || event.isError === true) this.add(event.isError === true ? "error" : "tool", `${typeof event.toolName === "string" ? event.toolName : "tool"}${event.isError === true ? " failed" : " result"}${output ? `:\n${output}` : ""}`);
				break;
			}
			case "message_end": {
				const message = object(event.message);
				if (message.role === "user") {
					const input = typeof message.content === "string" ? message.content : textBlocks(message.content);
					if (input) this.add("user", input);
					break;
				}
				if (message.role !== "assistant") break;
				const text = textBlocks(message.content);
				if (text) this.add("assistant", text);
				const hasTools = Array.isArray(message.content) && message.content.some((part) => object(part).type === "toolCall");
				this.candidate = !hasTools && typeof message.stopReason === "string" && ["stop", "end"].includes(message.stopReason) ? text || undefined : undefined;
				if (message.stopReason === "error" || message.stopReason === "aborted") {
					this.protocolFailed = true;
					this.warn(typeof message.errorMessage === "string" ? boundedText(message.errorMessage, 300) : `Agent response ${message.stopReason}`);
				}
				break;
			}
			case "auto_retry_start":
				this.candidate = undefined;
				this.state.activity = "Retrying provider request";
				break;
			case "compaction_start": this.state.activity = "Compacting context"; break;
			case "agent_settled":
				this.settled = true;
				if (event.aborted === true) { this.protocolFailed = true; this.candidate = undefined; }
				this.state.activity = "Settled; awaiting process exit";
				break;
		}
	}

	private codexRecord(event: Record<string, unknown>): void {
		if (event.type === "turn.started") {
			this.settled = false;
			this.candidate = undefined;
			this.protocolFailed = false;
			this.tools.clear();
			this.state.activity = "Working";
		} else if (event.type === "turn.completed") {
			this.settled = true;
			this.state.activity = "Settled; awaiting process exit";
		} else if (event.type === "turn.failed" || event.type === "error") {
			this.protocolFailed = true;
			this.candidate = undefined;
			this.settled = true;
			const message = object(event.error).message ?? event.message;
			const error = typeof message === "string" ? boundedText(message, 300) : "Agent reported a protocol error; inspect diagnostics.";
			this.warn(error);
			this.add("error", error);
			this.state.activity = "Agent reported an error";
		} else if (typeof event.type === "string" && ["item.started", "item.updated", "item.completed"].includes(event.type)) {
			const item = object(event.item);
			if (item.type === "agent_message") {
				if (event.type === "item.completed") {
					const text = typeof item.text === "string" ? boundedText(item.text, MAX_ANSWER_CHARS) : "";
					if (text) this.add("assistant", text);
					this.candidate = item.phase === "commentary" ? undefined : text || undefined;
					this.state.activity = "Writing response";
				}
				return;
			}
			// Reasoning and unknown future items stay diagnostic-only.
			if (typeof item.type !== "string" || !["command_execution", "file_change", "mcp_tool_call", "web_search", "todo_list"].includes(item.type)) return;
			const activity = toolActivity(item.type, item);
			this.candidate = undefined;
			this.settled = false;
			if (event.type === "item.completed") {
				if (typeof item.id === "string") this.tools.delete(item.id);
				const failed = item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0);
				const output = typeof item.aggregated_output === "string" ? boundedText(item.aggregated_output, MAX_ANSWER_CHARS) : "";
				this.add(failed ? "error" : "tool", `${activity}${failed ? " failed" : " completed"}${output ? `:\n${output}` : ""}`);
				this.state.activity = this.tools.values().next().value ?? "Working";
			} else {
				if (typeof item.id === "string" && this.tools.size < 100) this.tools.set(item.id, activity);
				if (event.type === "item.started") this.add("tool", activity);
				this.state.activity = activity;
			}
		}
	}

	private claudeRecord(event: Record<string, unknown>): void {
		const blocks = (Array.isArray(object(event.message).content) ? object(event.message).content as unknown[] : []).map(object);
		if (event.type === "system" && event.subtype === "init") {
			this.settled = false;
			this.candidate = undefined;
			this.protocolFailed = false;
			this.tools.clear();
			this.state.activity = "Working";
		} else if (event.type === "assistant") {
			// Delegated-agent text is commentary; only the top-level agent answers the task.
			const text = typeof event.parent_tool_use_id === "string" ? "" : textBlocks(blocks);
			if (text) {
				this.add("assistant", text);
				this.candidate = text;
				this.state.activity = "Writing response";
			} else if (blocks.some((block) => block.type === "thinking")) this.state.activity = "Thinking";
			for (const block of blocks) {
				if (block.type !== "tool_use") continue;
				const activity = toolActivity(block.name, block.input);
				if (typeof block.id === "string" && this.tools.size < 100) this.tools.set(block.id, activity);
				this.candidate = undefined;
				this.state.activity = activity;
				this.add("tool", activity);
			}
		} else if (event.type === "user") {
			for (const block of blocks) {
				if (block.type !== "tool_result") continue;
				const activity = typeof block.tool_use_id === "string" ? this.tools.get(block.tool_use_id) : undefined;
				if (typeof block.tool_use_id === "string") this.tools.delete(block.tool_use_id);
				const failed = block.is_error === true;
				const output = typeof block.content === "string" ? boundedText(block.content, MAX_ANSWER_CHARS) : textBlocks(block.content);
				if (output || failed) this.add(failed ? "error" : "tool", `${activity ?? "tool"}${failed ? " failed" : " result"}${output ? `:\n${output}` : ""}`);
				this.state.activity = this.tools.values().next().value ?? "Working";
			}
		} else if (event.type === "result") {
			this.settled = true;
			this.tools.clear();
			const result = typeof event.result === "string" ? boundedText(event.result, MAX_ANSWER_CHARS) : "";
			if (event.is_error === true || event.subtype !== "success") {
				this.protocolFailed = true;
				this.candidate = undefined;
				const error = boundedText(result || `Agent run ended with ${typeof event.subtype === "string" ? event.subtype : "an error"}; inspect diagnostics.`, 300);
				this.warn(error);
				this.add("error", error);
				this.state.activity = "Agent reported an error";
			} else {
				if (result.trim()) this.candidate = result;
				this.state.activity = "Settled; awaiting process exit";
			}
		}
	}

	private warn(message: string): void {
		this.state.protocolWarning = message;
	}

	private add(kind: TranscriptEntry["kind"], text: string): void {
		this.state.transcript.push({ kind, text: boundedText(text, MAX_ANSWER_CHARS) });
		let chars = this.state.transcript.reduce((sum, entry) => sum + entry.text.length, 0);
		while (this.state.transcript.length > MAX_ENTRIES || chars > MAX_TRANSCRIPT_CHARS) {
			chars -= this.state.transcript.shift()!.text.length;
			this.state.transcriptTruncated = true;
		}
	}
}
