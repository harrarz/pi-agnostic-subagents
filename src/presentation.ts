import { StringDecoder } from "node:string_decoder";

export type OutputProtocol = "raw" | "text" | "pi-jsonl";
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
		if (this.protocol === "pi-jsonl" && this.pending && !this.droppingRecord) this.record(this.pending);
		this.pending = "";
		if (this.protocol === "text") {
			if (this.text) this.add("assistant", this.text);
			if (publishAnswer && this.text.trim()) {
				this.state.finalAnswer = this.text.trim();
				this.state.answerTruncated = this.textTruncated;
			}
		} else if (this.protocol === "pi-jsonl") {
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
