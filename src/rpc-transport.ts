import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { Writable } from "node:stream";

/** Explicit wire protocol capability, never inferred from an executable name. */
export class RpcTransport {
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";
	private dropping = false;
	private closed = false;
	private started = false;
	private settled = false;
	private accepted = false;
	private readonly requests = new Map<string, { command: string; resolve(data: Record<string, unknown>): void; reject(error: Error): void; timer: NodeJS.Timeout }>();

	constructor(private readonly input: Writable, private readonly changed: () => void) {}

	get canSteer(): boolean { return this.accepted && !this.settled && !this.closed; }

	async prompt(message: string): Promise<void> {
		this.started = true;
		const data = await this.request("prompt", message);
		if (data.disposition !== "started") throw new Error("RPC prompt did not start a run; no automatic retry was made");
		this.accepted = true;
		this.changed();
		this.endIfSettled();
	}

	async steer(message: string): Promise<string> {
		if (!this.canSteer) throw new Error("Agent is no longer accepting steering; nothing was sent");
		const data = await this.request("steer", message);
		if (this.settled) throw new Error("Agent settled during steering submission; delivery is uncertain. Inspect the transcript; do not resend automatically");
		if (data.disposition !== "queued" && data.disposition !== "handled") throw new Error("Unexpected steering acknowledgement; inspect diagnostics");
		return data.disposition;
	}

	push(chunk: Buffer): void {
		const text = this.decoder.write(chunk);
		for (let start = 0; start < text.length;) {
			const newline = text.indexOf("\n", start);
			const end = newline < 0 ? text.length : newline;
			if (!this.dropping) {
				if (this.pending.length + end - start > 256 * 1024) { this.pending = ""; this.dropping = true; }
				else this.pending += text.slice(start, end);
			}
			if (newline < 0) break;
			if (!this.dropping) this.record(this.pending.replace(/\r$/, ""));
			this.pending = "";
			this.dropping = false;
			start = newline + 1;
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const request of this.requests.values()) {
			clearTimeout(request.timer);
			request.reject(new Error("RPC process closed before acknowledging the command"));
		}
		this.requests.clear();
		this.changed();
	}

	private request(command: string, message: string): Promise<Record<string, unknown>> {
		if (this.closed || this.settled) return Promise.reject(new Error("RPC turn has finished; nothing was sent"));
		if (this.requests.size) return Promise.reject(new Error("Another control command is awaiting acknowledgement; nothing was sent"));
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.requests.delete(id);
				reject(new Error("RPC acknowledgement timed out; delivery is uncertain, do not retry automatically"));
				this.endIfSettled();
			}, 15_000);
			timer.unref();
			this.requests.set(id, { command, resolve, reject, timer });
			// One bounded command in flight: its response gates the next write,
			// bounding Writable's backpressure queue. Never automatically resend.
			this.input.write(JSON.stringify({ id, type: command, message }) + "\n", "utf8", (error) => {
				if (!error) return;
				const pending = this.requests.get(id);
				if (pending) { clearTimeout(timer); this.requests.delete(id); pending.reject(error); }
			});
		});
	}

	private record(line: string): void {
		let event: Record<string, unknown>;
		try { event = JSON.parse(line); } catch { return; }
		if (!event || typeof event !== "object") return;
		if (event.type === "agent_settled" && this.started) {
			this.settled = true;
			this.changed();
			this.endIfSettled();
		} else if (event.type === "response" && typeof event.id === "string") {
			const request = this.requests.get(event.id);
			if (!request || event.command !== request.command) return;
			clearTimeout(request.timer);
			this.requests.delete(event.id);
			if (event.success !== true) request.reject(new Error(typeof event.error === "string" ? event.error : "RPC command rejected"));
			else request.resolve(event.data && typeof event.data === "object" ? event.data as Record<string, unknown> : {});
			this.endIfSettled();
		}
	}

	private endIfSettled(): void {
		if (this.accepted && this.settled && !this.requests.size && !this.closed) {
			this.close();
			this.input.end();
		}
	}
}
