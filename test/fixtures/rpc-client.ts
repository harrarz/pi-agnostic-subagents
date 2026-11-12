import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface RpcRecord {
	type?: string;
	id?: string;
	command?: string;
	success?: boolean;
	method?: string;
	message?: any;
	data?: any;
	result?: any;
	toolName?: string;
	[key: string]: any;
}
interface Waiter {
	predicate: (record: RpcRecord) => boolean;
	resolve(record: RpcRecord): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

/** Test-only RPC client: subscribe before sending, LF framing, safe waiter cleanup. */
export class RpcTestClient {
	readonly records: RpcRecord[] = [];
	stderr = "";
	private readonly decoder = new StringDecoder("utf8");
	private readonly waiters = new Set<Waiter>();
	private remainder = "";
	private ended?: Error;
	private readonly closed: Promise<void>;

	constructor(readonly child: ChildProcessWithoutNullStreams) {
		this.closed = new Promise((resolve) => child.once("close", () => resolve()));
		child.stdout.on("data", (chunk: Buffer) => {
			this.remainder += this.decoder.write(chunk);
			for (;;) {
				const newline = this.remainder.indexOf("\n");
				if (newline < 0) break;
				const line = this.remainder.slice(0, newline).replace(/\r$/, "");
				this.remainder = this.remainder.slice(newline + 1);
				if (!line) continue;
				try {
					const record = JSON.parse(line) as RpcRecord;
					this.records.push(record);
					for (const waiter of [...this.waiters]) {
						if (waiter.predicate(record)) {
							clearTimeout(waiter.timer);
							this.waiters.delete(waiter);
							waiter.resolve(record);
						}
					}
				} catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
			}
		});
		child.stderr.on("data", (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString("utf8")).slice(-6000); });
		child.once("error", (error) => this.fail(error));
		child.stdin.on("error", (error) => this.fail(error));
		child.once("close", (code, signal) => this.fail(new Error(`Pi closed (code=${code}, signal=${signal}): ${this.stderr}`)));
	}

	private fail(error: Error): void {
		this.ended ??= error;
		for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(error); }
		this.waiters.clear();
	}

	waitFor(predicate: (record: RpcRecord) => boolean, timeoutMs = 20_000): Promise<RpcRecord> {
		const prior = this.records.find(predicate);
		if (prior) return Promise.resolve(prior);
		if (this.ended) return Promise.reject(this.ended);
		return new Promise((resolve, reject) => {
			const waiter: Waiter = {
				predicate, resolve, reject,
				timer: setTimeout(() => {
					this.waiters.delete(waiter);
					reject(new Error(`Pi RPC timeout after ${timeoutMs}ms; stderr: ${this.stderr}`));
				}, timeoutMs),
			};
			this.waiters.add(waiter);
		});
	}

	async request(command: Record<string, unknown>, timeoutMs = 20_000): Promise<RpcRecord> {
		const id = randomUUID();
		const response = this.waitFor((record) => record.type === "response" && record.id === id, timeoutMs);
		this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		return response;
	}

	async close(): Promise<void> {
		this.child.stdin.end();
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let escalation: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([this.closed, new Promise<void>((resolve) => { timeout = setTimeout(resolve, 5000); })]);
			if (this.child.exitCode === null && this.child.signalCode === null) {
				this.child.kill("SIGTERM");
				escalation = setTimeout(() => this.child.kill("SIGKILL"), 5000);
				await this.closed;
			}
		} finally {
			if (timeout) clearTimeout(timeout);
			if (escalation) clearTimeout(escalation);
		}
	}
}
