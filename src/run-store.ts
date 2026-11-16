import { appendFile, chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { SupervisorPaths } from "./config.js";
import type { OutputProtocol, RunPresentation } from "./presentation.js";
import type { Isolation, WorktreeInfo } from "./worktrees.js";
import type { ResolvedExtensions } from "./profiles.js";

export type RunState =
	| "queued" // Legacy records only; new runs launch as starting without a scheduler queue.
	| "starting"
	| "running"
	| "stopping"
	| "exited"
	| "launch_failed"
	| "cancelled"
	| "timed_out"
	| "interrupted";

export interface StoredRun {
	extensions?: ResolvedExtensions;
	control?: { protocol: "pi-rpc"; sessionPath: string; conversationId: string; turn: number; continuedFrom?: string };
	worktreeOwnerId?: string;
	isolation?: Isolation;
	worktree?: WorktreeInfo;
	label?: string;
	outputProtocol?: OutputProtocol;
	presentation?: RunPresentation;
	/** Read-only compatibility with older queued records. */
	queueReason?: string;
	stdoutPath?: string;
	stderrPath?: string;
	id: string;
	sessionId: string;
	supervisorToken: string;
	profile: string;
	model?: string;
	/** Legacy display alias retained when reading pre-direct-ID run records. */
	modelAlias?: string;
	effort?: string;
	effortAlias?: string;
	task: string;
	cwd: string;
	state: RunState;
	createdAt: string;
	startedAt?: string;
	endedAt?: string;
	notifiedAt?: string;
	exitCode?: number | null;
	signal?: string | null;
	error?: { code: string; message: string };
	logPath: string;
	logBytes: number;
	logTruncated: boolean;
	processPid?: number;
	processStartIdentity?: string;
	processToken: string;
	timeoutMs?: number;
}

export interface RunView extends Omit<StoredRun, "supervisorToken" | "processToken" | "processPid" | "processStartIdentity" | "logBytes"> {
	outputTail: string;
	capabilities?: { steer: boolean; followUp: boolean };
}

export type RunSummary = Omit<RunView, "outputTail" | "presentation"> & {
	presentation?: Omit<RunPresentation, "transcript">;
};

const TERMINAL_STATES = new Set<RunState>(["exited", "launch_failed", "cancelled", "timed_out", "interrupted"]);

export function isTerminalState(state: RunState): boolean {
	return TERMINAL_STATES.has(state);
}

function sessionKey(sessionId: string): string {
	return createHash("sha256").update(sessionId).digest("hex");
}

function isStoredRun(value: unknown): value is StoredRun {
	if (typeof value !== "object" || value === null) return false;
	const run = value as Partial<StoredRun>;
	return typeof run.id === "string" && /^[0-9a-f-]{36}$/.test(run.id)
		&& typeof run.sessionId === "string"
		&& typeof run.supervisorToken === "string"
		&& typeof run.profile === "string"
		&& typeof run.task === "string"
		&& typeof run.cwd === "string"
		&& typeof run.state === "string"
		&& ["queued", "starting", "running", "stopping", "exited", "launch_failed", "cancelled", "timed_out", "interrupted"].includes(run.state)
		&& typeof run.createdAt === "string"
		&& typeof run.logPath === "string"
		&& typeof run.logBytes === "number"
		&& typeof run.logTruncated === "boolean"
		&& typeof run.processToken === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(run.processToken)
		&& (run.processPid === undefined || (Number.isSafeInteger(run.processPid) && run.processPid > 0))
		&& (run.processStartIdentity === undefined || (typeof run.processStartIdentity === "string" && run.processStartIdentity.length > 0))
		&& (run.isolation === undefined || run.isolation === "shared" || run.isolation === "worktree")
		&& (run.extensions === undefined || (run.extensions !== null && typeof run.extensions === "object"
			&& ["none", "inherit", "custom"].includes(run.extensions.mode)
			&& (run.extensions.mode === "custom" ? typeof run.extensions.set === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(run.extensions.set) : run.extensions.set === undefined)
			&& Array.isArray(run.extensions.paths) && run.extensions.paths.every((path) => typeof path === "string" && (path.startsWith("/") || /^builtin:[a-zA-Z0-9.-]+$/.test(path)) && !/[\x00-\x1f\x7f-\x9f]/.test(path))
			&& (run.extensions.mode !== "none" || run.extensions.paths.length === 0)
			&& (run.extensions.mode !== "custom" || run.extensions.paths.length > 0)))
		&& (run.worktree === undefined || isWorktreeInfo(run.worktree))
		&& (run.worktreeOwnerId === undefined || /^[0-9a-f-]{36}$/.test(run.worktreeOwnerId))
		&& (run.control === undefined || (run.control?.protocol === "pi-rpc"
			&& typeof run.control.sessionPath === "string" && typeof run.control.conversationId === "string"
			&& /^[0-9a-f-]{36}$/.test(run.control.conversationId) && Number.isSafeInteger(run.control.turn) && run.control.turn > 0
			&& (run.control.continuedFrom === undefined || /^[0-9a-f-]{36}$/.test(run.control.continuedFrom))));
}

function isWorktreeInfo(value: unknown): value is WorktreeInfo {
	if (!value || typeof value !== "object") return false;
	const info = value as WorktreeInfo;
	return ["path", "branch", "baseCommit", "sourceRoot", "sourceCwd", "commonDir", "relativeCwd", "note"].every((key) => typeof info[key as keyof WorktreeInfo] === "string")
		&& ["pending", "ready", "retained", "not_created", "failed", "removed"].includes(info.state);
}

export class RunStore {
	readonly directory: string;
	readonly logsDirectory: string;
	private readonly records = new Map<string, StoredRun>();
	readonly recoveryWarnings: string[] = [];

	constructor(paths: SupervisorPaths, readonly sessionId: string) {
		const sessionDirectory = sessionKey(sessionId);
		this.directory = join(paths.runtimeDirectory, "runs", sessionDirectory);
		this.logsDirectory = join(paths.runtimeDirectory, "logs", sessionDirectory);
	}

	async initialize(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700);
		await mkdir(this.logsDirectory, { recursive: true, mode: 0o700 });
		await chmod(this.logsDirectory, 0o700);
		this.records.clear();
		this.recoveryWarnings.length = 0;
		const files = (await readdir(this.directory)).filter((name) => name.endsWith(".json"));
		for (const name of files) {
			const filePath = join(this.directory, name);
			try {
				const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
				if (!isStoredRun(raw) || raw.sessionId !== this.sessionId || `${raw.id}.json` !== name) throw new Error("Invalid metadata");
				this.records.set(raw.id, raw);
			} catch {
				this.recoveryWarnings.push(`Could not recover run metadata: ${filePath}. File left unchanged; this run's ownership and outcome are unknown. Inspect/repair it manually; no process was signalled from this record.`);
			}
		}
	}

	create(input: Omit<StoredRun, "id" | "logPath" | "logBytes" | "logTruncated">, id = randomUUID()): StoredRun {
		const record: StoredRun = {
			...input,
			id,
			logPath: join(this.logsDirectory, `${id}.log`),
			stdoutPath: join(this.logsDirectory, `${id}.stdout.log`),
			stderrPath: join(this.logsDirectory, `${id}.stderr.log`),
			logBytes: 0,
			logTruncated: false,
		};
		this.records.set(id, record);
		return record;
	}

	async persist(record: StoredRun): Promise<void> {
		if (record.sessionId !== this.sessionId || !this.records.has(record.id)) {
			throw new Error("Cannot persist a run outside this session's registry");
		}
		const filePath = this.recordPath(record.id);
		await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
		const tempPath = `${filePath}.${randomUUID()}.tmp`;
		const handle = await open(tempPath, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(tempPath, filePath);
		await chmod(filePath, 0o600);
	}

	async createLog(record: StoredRun): Promise<void> {
		for (const path of [record.logPath, record.stdoutPath, record.stderrPath]) {
			if (!path) continue;
			const handle = await open(path, "wx", 0o600);
			await handle.close();
		}
	}

	async appendLog(record: StoredRun, chunk: Buffer, maxBytes: number): Promise<void> {
		if (chunk.length === 0) return;
		const info = await stat(record.logPath).catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined;
			throw error;
		});
		const priorBytes = info?.size ?? 0;
		const bytes = priorBytes + chunk.length;
		if (bytes <= maxBytes) {
			await appendFile(record.logPath, chunk, { mode: 0o600 });
			await chmod(record.logPath, 0o600);
		} else {
			const prior = info ? await readFile(record.logPath) : Buffer.alloc(0);
			const combined = Buffer.concat([prior, chunk]);
			const bounded = combined.subarray(Math.max(0, combined.length - maxBytes));
			await writeFile(record.logPath, bounded, { mode: 0o600 });
			await chmod(record.logPath, 0o600);
			record.logTruncated = true;
		}
		record.logBytes = Math.min(maxBytes, bytes);
	}

	async appendStreamLog(record: StoredRun, chunk: Buffer, stream: "stdout" | "stderr", maxBytes: number): Promise<void> {
		const path = stream === "stdout" ? record.stdoutPath : record.stderrPath;
		if (!path) return;
		// Reuse the bounded writer without changing the combined log's counters.
		await this.appendLog({ ...record, logPath: path }, chunk, maxBytes);
	}

	summary(record: StoredRun): RunSummary {
		const { supervisorToken: _owner, processToken: _token, processPid: _pid,
			processStartIdentity: _identity, logBytes: _bytes, presentation, ...publicRecord } = record;
		const { transcript: _transcript, ...status } = presentation ?? { transcript: [] };
		return structuredClone({ ...publicRecord, ...(presentation ? { presentation: status } : {}) });
	}

	async tail(record: StoredRun, maxBytes: number): Promise<string> {
		try {
			const content = await readFile(record.logPath);
			return content.subarray(Math.max(0, content.length - maxBytes)).toString("utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
			throw error;
		}
	}

	get(id: string): StoredRun | undefined {
		return this.records.get(id);
	}

	list(): StoredRun[] {
		return [...this.records.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async view(record: StoredRun, outputTailBytes: number): Promise<RunView> {
		const { supervisorToken: _supervisorToken, processToken: _processToken, processPid: _processPid,
			processStartIdentity: _processStartIdentity, logBytes: _logBytes, ...publicRecord } = record;
		return { ...structuredClone(publicRecord), outputTail: await this.tail(record, outputTailBytes) };
	}

	async discard(record: StoredRun): Promise<void> {
		this.records.delete(record.id);
		await Promise.all([record.logPath, record.stdoutPath, record.stderrPath]
			.filter((path): path is string => Boolean(path)).map((path) => rm(path, { force: true })));
		await rm(this.recordPath(record.id), { force: true });
	}

	private recordPath(id: string): string {
		if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid run ID");
		return join(this.directory, `${id}.json`);
	}
}
