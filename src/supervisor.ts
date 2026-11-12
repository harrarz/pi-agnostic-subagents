import { RpcTransport } from "./rpc-transport.js";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { OutputPresenter } from "./presentation.js";
import { WorktreeError, WorktreeManager, type Isolation, type WorktreeInfo } from "./worktrees.js";
import { spawn as spawnChild } from "node:child_process";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SupervisorPaths } from "./config.js";
import { ensurePrivateSupervisorDirectories } from "./config.js";
import { CheckoutLockManager, type CheckoutLock } from "./checkout-lock.js";
import {
	canonicalizeCwd,
	getProcessStartIdentity,
	ProcessPreflightError,
	isSameOwnedProcess,
	isPidAlive,
	isProcessGroupAlive,
	processTokenEnvironment,
	resolveExecutable,
	spawnConfiguredProcess,
	terminateProcessGroup,
	terminateVerifiedProcessGroup,
} from "./process.js";
import { resolveLaunchRecipe, type StartRecipeInput, type SupervisorConfig } from "./profiles.js";
import { isTerminalState, RunStore, type RunState, type RunView, type RunSummary, type StoredRun } from "./run-store.js";
import type { Readable } from "node:stream";

const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;
const DEFAULT_OUTPUT_TAIL_BYTES = 16 * 1024;

export interface StartInput extends StartRecipeInput {
	isolation?: Isolation;
	label?: string;
	cwd?: string;
	timeoutMs?: number;
}

export interface RunTerminalNotice {
	worktree?: WorktreeInfo;
	label?: string;
	finalAnswer?: string;
	protocolWarning?: string;
	id: string;
	profile: string;
	state: RunState;
	exitCode?: number | null;
	error?: { code: string; message: string };
}

export interface SupervisorOptions {
	paths: SupervisorPaths;
	sessionId: string;
	parentCwd: string;
	maxConcurrent?: number;
	maxQueued?: number;
	maxLogBytes?: number;
	outputTailBytes?: number;
	stopGraceMs?: number;
	queueRetryMs?: number;
	onRunTerminal?: (notice: RunTerminalNotice) => void;
}

export interface StartResult {
	id: string;
	state: RunState;
}

export interface SupervisorLimits {
	maxConcurrent: number;
	maxQueued: number;
	maxLogBytes: number;
	outputTailBytes: number;
	stopGraceMs: number;
	queueRetryMs: number;
}

interface ProcessClose {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
}

interface Job {
	rpc?: RpcTransport;
	presenter: OutputPresenter;
	record: StoredRun;
	executable: string;
	args: string[];
	stdin?: string;
	checkoutRoot: string;
	lock?: CheckoutLock;
	child?: ReturnType<typeof spawnChild>;
	childStartIdentity?: string;
	closePromise?: Promise<ProcessClose>;
	terminationPromise?: Promise<boolean>;
	timeout?: NodeJS.Timeout;
	stopReason?: "cancelled" | "timed_out";
	cancelRequested: boolean;
	finished: boolean;
	completion: Deferred<void>;
	logChain: Promise<void>;
	logError?: string;
	stdinError?: Error;
}

export class SupervisorError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "SupervisorError";
	}
}

function deferred<T>(): Deferred<T> {
	let resolvePromise!: (value: T) => void;
	const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
	return { promise, resolve: resolvePromise };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function validatePositiveInteger(value: number | undefined, fallback: number, name: string, allowZero = false): number {
	const selected = value ?? fallback;
	if (!Number.isInteger(selected) || (allowZero ? selected < 0 : selected <= 0)) {
		throw new SupervisorError("INVALID_CONFIGURATION", `${name} must be a ${allowZero ? "nonnegative" : "positive"} integer`);
	}
	return selected;
}

export class Supervisor {
	readonly limits: SupervisorLimits;
	private readonly store: RunStore;
	private readonly locks: CheckoutLockManager;
	private readonly worktrees: WorktreeManager;
	private readonly supervisorToken = randomUUID();
	private supervisorStartIdentity?: string;
	private readonly jobs = new Map<string, Job>();
	private readonly queue: Job[] = [];
	private readonly active = new Set<Job>();
	private readonly listeners = new Set<() => void>();
	private initialized = false;
	private closed = false;
	private pumping = false;
	private pumpCompletion?: Deferred<void>;
	private queueRetry?: NodeJS.Timeout;
	private admissionTail: Promise<void> = Promise.resolve();

	constructor(private readonly config: SupervisorConfig, private readonly options: SupervisorOptions) {
		this.limits = {
			maxConcurrent: validatePositiveInteger(options.maxConcurrent, 2, "maxConcurrent"),
			maxQueued: validatePositiveInteger(options.maxQueued, 8, "maxQueued", true),
			maxLogBytes: validatePositiveInteger(options.maxLogBytes, DEFAULT_MAX_LOG_BYTES, "maxLogBytes"),
			outputTailBytes: validatePositiveInteger(options.outputTailBytes, DEFAULT_OUTPUT_TAIL_BYTES, "outputTailBytes"),
			stopGraceMs: validatePositiveInteger(options.stopGraceMs, 1200, "stopGraceMs"),
			queueRetryMs: validatePositiveInteger(options.queueRetryMs, 250, "queueRetryMs"),
		};
		this.store = new RunStore(options.paths, options.sessionId);
		this.locks = new CheckoutLockManager(options.paths);
		this.worktrees = new WorktreeManager(options.paths);
	}

	async initialize(): Promise<void> {
		if (this.initialized) return;
		if (process.platform === "win32") {
			throw new SupervisorError("PLATFORM_UNSUPPORTED", "This build requires POSIX process groups to verify process-tree cleanup; Windows runs are disabled");
		}
		await ensurePrivateSupervisorDirectories(this.options.paths);
		await this.store.initialize();
		this.supervisorStartIdentity = await getProcessStartIdentity(process.pid);
		if (!this.supervisorStartIdentity) {
			throw new SupervisorError("PROCESS_IDENTITY_UNAVAILABLE", "Unable to verify this supervisor process identity");
		}
		for (const record of this.store.list()) {
			if (isTerminalState(record.state)) continue;
			let cleanupVerified = false;
			if (await isSameOwnedProcess(record.processPid, record.processStartIdentity, record.processToken)) {
				cleanupVerified = await terminateVerifiedProcessGroup(
					record.processPid!,
					record.processStartIdentity,
					record.processToken,
					this.limits.stopGraceMs,
				);
			}
			if (record.worktree) {
				record.worktree.state = record.worktree.state === "ready" ? "retained" : "failed";
				record.worktree.note += " Owner was lost; any workspace and branch are preserved for manual inspection.";
			}
			record.state = "interrupted";
			record.endedAt = new Date().toISOString();
			record.error = {
				code: "OWNER_RESTARTED",
				message: cleanupVerified
					? "The previous supervisor stopped its verified child during recovery; task outcome is unknown."
					: "The previous supervisor ended without a verifiable terminal process outcome; no process was signalled.",
			};
			await this.store.persist(record);
		}
		this.initialized = true;
	}

	/** Invalidation subscription; consumers pull log-free, by-value snapshots. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => { this.listeners.delete(listener); };
	}

	snapshot(): RunSummary[] {
		this.assertInitialized();
		const records = this.store.list();
		const active = records.filter((run) => !isTerminalState(run.state));
		const recent = records.filter((run) => isTerminalState(run.state)).slice(0, 50);
		return [...active, ...recent].map((run) => ({ ...this.store.summary(run), capabilities: this.capabilities(run) }));
	}

	inspect(id: string): Omit<RunView, "outputTail"> {
		this.assertInitialized();
		const record = this.store.get(id);
		if (!record) throw new SupervisorError("RUN_NOT_FOUND", `No run found with id ${JSON.stringify(id)}`);
		const { presentation: _summaryPresentation, ...summary } = this.store.summary(record);
		return { ...summary, capabilities: this.capabilities(record), ...(record.presentation ? { presentation: structuredClone(record.presentation) } : {}) };
	}

	private changed(): void {
		for (const listener of this.listeners) {
			try { listener(); } catch { /* UI failure must not affect supervised work. */ }
		}
	}

	async start(input: StartInput): Promise<StartResult> { return this.enqueue(input); }

	/** Human-directed fresh execution; never reuses a prior conversation/worktree. */
	async rerun(id: string, changes: Partial<StartInput> = {}): Promise<StartResult> {
		const run = await this.get(id);
		if (!isTerminalState(run.state)) throw new SupervisorError("RUN_ACTIVE", "Only terminal runs can be rerun");
		return this.start({ task: run.task, label: run.label, profile: run.profile, model: run.model, effort: run.effortAlias,
			cwd: run.worktree?.sourceCwd ?? run.cwd, isolation: run.isolation, timeoutMs: run.timeoutMs, ...changes });
	}

	async steer(id: string, message: string): Promise<string> {
		this.validateMessage(message);
		const job = this.jobs.get(id);
		if (this.closed || !job || job.record.state !== "running" || !job.rpc?.canSteer) throw new SupervisorError("STEER_UNAVAILABLE", "This agent no longer supports steering; nothing was sent");
		return job.rpc.steer(message);
	}

	async followUp(id: string, message: string): Promise<StartResult> {
		this.validateMessage(message);
		await this.get(id);
		const run = this.latestConversation(this.store.get(id)!);
		if (!this.capabilities(run).followUp) throw new SupervisorError("FOLLOW_UP_UNAVAILABLE", "No safely settled, saved conversation is available for follow-up");
		return this.enqueue({ task: message, label: run.label, profile: run.profile, model: run.model, effort: run.effortAlias,
			cwd: run.worktree?.sourceCwd ?? run.cwd, isolation: run.isolation, timeoutMs: run.timeoutMs }, run);
	}

	private validateMessage(message: string): void {
		if (typeof message !== "string" || !message.trim() || message.includes("\0") || Buffer.byteLength(message) > 64 * 1024) throw new SupervisorError("INVALID_MESSAGE", "Message must be nonempty, NUL-free and at most 64 KiB");
	}

	private latestConversation(run: StoredRun): StoredRun {
		if (!run.control) return run;
		return this.store.list().filter((item) => item.control?.conversationId === run.control!.conversationId)
			.sort((a, b) => b.control!.turn - a.control!.turn)[0] ?? run;
	}

	private capabilities(run: StoredRun): { steer: boolean; followUp: boolean } {
		const latest = this.latestConversation(run);
		return {
			steer: !this.closed && run.state === "running" && Boolean(this.jobs.get(run.id)?.rpc?.canSteer),
			followUp: !this.closed && Boolean(run.control && latest.state === "exited" && latest.exitCode === 0 && !latest.error
				&& latest.presentation?.finalAnswer && existsSync(latest.control!.sessionPath)
				&& this.config.profiles[latest.profile]?.taskTransport === "pi-rpc"
				&& (!latest.worktree || latest.worktree.state === "retained")),
		};
	}

	private async enqueue(input: StartInput, continuation?: StoredRun): Promise<StartResult> {
		this.assertInitialized();
		const recordId = randomUUID();
		const sessionPath = continuation?.control?.sessionPath ?? join(this.options.paths.runtimeDirectory, "sessions", `${recordId}.jsonl`);
		if (input.isolation !== undefined && input.isolation !== "shared" && input.isolation !== "worktree") throw new SupervisorError("INVALID_ISOLATION", "isolation must be shared or worktree");
		const isolation = input.isolation ?? "shared";
		if (input.label !== undefined && (typeof input.label !== "string" || !input.label.trim() || input.label.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(input.label))) {
			throw new SupervisorError("INVALID_LABEL", "label must be 1–80 characters without control characters");
		}
		if (this.closed) throw new SupervisorError("SUPERVISOR_CLOSED", "This supervisor session is shutting down");
		if (input.timeoutMs !== undefined && (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > MAX_TIMER_MS)) {
			throw new SupervisorError("INVALID_TIMEOUT", `timeoutMs must be finite and between 1 and ${MAX_TIMER_MS}`);
		}

		let recipe;
		try {
			recipe = resolveLaunchRecipe(this.config, input, sessionPath);
		} catch (error) {
			throw new SupervisorError("INVALID_PROFILE_INPUT", errorMessage(error));
		}
		let canonical: Awaited<ReturnType<typeof canonicalizeCwd>>;
		let executable: string;
		try {
			canonical = await canonicalizeCwd(input.cwd, this.options.parentCwd);
			executable = await resolveExecutable(recipe.executable, canonical.cwd, {
				...process.env,
				...recipe.environment,
			});
		} catch (error) {
			if (error instanceof ProcessPreflightError) throw new SupervisorError(error.code, error.message);
			throw error;
		}
		if (recipe.taskTransport !== "stdin" && Buffer.byteLength(input.task, "utf8") > 64 * 1024) {
			throw new SupervisorError("TASK_TOO_LARGE", "Argument/RPC-transport tasks must be at most 64 KiB");
		}

		return this.withAdmission(async () => {
			if (this.closed) throw new SupervisorError("SUPERVISOR_CLOSED", "This supervisor session is shutting down");
			let reservedLock: CheckoutLock | undefined;
			if (continuation) {
				if (this.latestConversation(continuation).id !== continuation.id || !this.capabilities(continuation).followUp) throw new SupervisorError("CONVERSATION_BUSY", "Conversation changed or is busy; no follow-up was started");
				const expected = join(this.options.paths.runtimeDirectory, "sessions", `${continuation.control!.conversationId}.jsonl`);
				if (sessionPath !== expected || !(await lstat(sessionPath)).isFile()) throw new SupervisorError("SESSION_IDENTITY", "Saved session identity changed; refusing continuation");
			}
			if (this.queue.length >= this.limits.maxQueued && (this.active.size >= this.limits.maxConcurrent || this.queue.length > 0)) throw new SupervisorError("CAPACITY_FULL", "Supervisor queue is at capacity");
			let worktree: WorktreeInfo | undefined = continuation?.worktree ? structuredClone(continuation.worktree) : undefined;
			if (isolation === "worktree" && !continuation) {
				try { worktree = await this.worktrees.plan(canonical.checkoutRoot, canonical.cwd, recordId); }
				catch (error) { if (error instanceof WorktreeError) throw new SupervisorError(error.code, error.message); throw error; }
			}
			const checkoutRoot = worktree?.path ?? canonical.checkoutRoot;
			if (this.queue.length >= this.limits.maxQueued) {
				reservedLock = await this.locks.tryAcquire(checkoutRoot, this.lockOwner(recordId));
				if (!reservedLock) throw new SupervisorError("CAPACITY_FULL", "Supervisor queue is at capacity and the checkout is already locked");
			}

			const processToken = randomUUID();
			const outputProtocol = this.config.profiles[recipe.profile].outputProtocol ?? "raw";
			const presenter = new OutputPresenter(outputProtocol);
			const record = this.store.create({
				isolation,
				...(recipe.taskTransport === "pi-rpc" ? { control: { protocol: "pi-rpc" as const, sessionPath,
					conversationId: continuation?.control?.conversationId ?? recordId, turn: (continuation?.control?.turn ?? 0) + 1,
					...(continuation ? { continuedFrom: continuation.id } : {}) } } : {}),
				...(worktree ? { worktreeOwnerId: continuation?.worktreeOwnerId ?? recordId } : {}),
				...(worktree ? { worktree } : {}),
				label: input.label?.trim() ?? input.task.replace(/\s+/g, " ").trim().slice(0, 60),
				outputProtocol,
				presentation: presenter.state,
				queueReason: "Waiting for admission",
				sessionId: this.options.sessionId,
				supervisorToken: this.supervisorToken,
				profile: recipe.profile,
				...(recipe.model !== undefined ? { model: recipe.model } : {}),
				...(recipe.effort !== undefined ? { effort: recipe.effort, effortAlias: recipe.effortAlias } : {}),
				task: input.task,
				cwd: canonical.cwd,
				state: "queued",
				createdAt: new Date().toISOString(),
				processToken,
				...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
			}, recordId);
			const job: Job = {
				presenter,
				record,
				executable,
				args: recipe.args,
				...(recipe.stdin !== undefined ? { stdin: recipe.stdin } : {}),
				checkoutRoot,
				...(reservedLock ? { lock: reservedLock } : {}),
				cancelRequested: false,
				finished: false,
				completion: deferred<void>(),
				logChain: Promise.resolve(),
			};
			this.jobs.set(record.id, job);
			try {
				await mkdir(dirname(record.logPath), { recursive: true, mode: 0o700 });
				await this.store.createLog(record);
				await this.store.persist(record);
			} catch (error) {
				this.jobs.delete(record.id);
				await this.store.discard(record).catch(() => undefined);
				if (reservedLock) await reservedLock.release();
				throw new SupervisorError("RUN_STORAGE_FAILED", errorMessage(error));
			}
			this.queue.push(job);
			this.changed();
			this.requestPump();
			return { id: record.id, state: record.state };
		});
	}

	async get(id: string): Promise<RunView> {
		this.assertInitialized();
		const job = this.jobs.get(id);
		if (job?.finished) await job.completion.promise;
		const record = this.store.get(id);
		if (!record) throw new SupervisorError("RUN_NOT_FOUND", `No run found with id ${JSON.stringify(id)}`);
		return this.store.view(record, this.limits.outputTailBytes);
	}

	async list(limit = 20): Promise<RunView[]> {
		this.assertInitialized();
		if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
			throw new SupervisorError("INVALID_LIMIT", "Run list limit must be an integer between 1 and 50");
		}
		const records = this.store.list().slice(0, limit);
		return Promise.all(records.map((record) => this.store.view(record, Math.min(this.limits.outputTailBytes, 2048))));
	}

	async stop(id: string): Promise<RunView> {
		this.assertInitialized();
		const record = this.store.get(id);
		if (!record) throw new SupervisorError("RUN_NOT_FOUND", `No run found with id ${JSON.stringify(id)}`);
		if (isTerminalState(record.state)) return this.store.view(record, this.limits.outputTailBytes);
		const job = this.jobs.get(id);
		if (!job) {
			record.state = "interrupted";
			record.endedAt = new Date().toISOString();
			record.error = { code: "OWNER_MISSING", message: "This run is not owned by the current supervisor instance" };
			await this.store.persist(record);
			return this.store.view(record, this.limits.outputTailBytes);
		}
		await this.requestStop(job, "cancelled");
		await job.completion.promise;
		return this.store.view(record, this.limits.outputTailBytes);
	}

	/** Human-only, non-forced cleanup. Never called automatically on completion. */
	async removeWorktree(id: string): Promise<RunView> {
		await this.get(id);
		return this.withAdmission(async () => {
			if (this.closed) throw new SupervisorError("SUPERVISOR_CLOSED", "This supervisor session is shutting down");
			const record = this.store.get(id)!;
			if (!record.worktree || record.isolation !== "worktree") throw new SupervisorError("NO_WORKTREE", "This run does not own an isolated worktree");
			if (this.store.list().some((other) => other.worktree?.path === record.worktree!.path && !isTerminalState(other.state))) throw new SupervisorError("WORKTREE_ACTIVE", "Stop the run and verify process cleanup before removing its worktree");
			const related = this.store.list().filter((other) => other.worktree?.path === record.worktree!.path);
			if (related.some((other) => other.state === "interrupted" || other.worktree?.state === "failed")) throw new SupervisorError("WORKTREE_UNCERTAIN", "Workspace setup or process outcome is uncertain; inspect/recover it with Git manually. No files were deleted.");
			if (related.some((other) => other.processPid && (isPidAlive(other.processPid) || isProcessGroupAlive(other.processPid)))) throw new SupervisorError("WORKTREE_ACTIVE", "A process/group may still be live; refusing workspace removal");
			const lock = await this.locks.tryAcquire(record.worktree.path, this.lockOwner(record.id));
			if (!lock) throw new SupervisorError("WORKTREE_BUSY", "Worktree is locked by another supervised run");
			try {
				await this.worktrees.remove(record.worktree, record.worktreeOwnerId ?? record.id);
				for (const other of this.store.list()) {
					if (other.worktree?.path === record.worktree.path) { other.worktree = structuredClone(record.worktree); await this.store.persist(other); }
				}
				this.changed();
				return this.store.view(record, this.limits.outputTailBytes);
			} finally { await lock.release(); }
		});
	}

	async shutdown(): Promise<void> {
		if (!this.initialized || this.closed) return;
		this.closed = true;
		if (this.queueRetry) clearTimeout(this.queueRetry);
		this.queueRetry = undefined;
		// Admission and checkout acquisition may still be awaiting filesystem I/O.
		// Drain both before teardown so no late lock writes outlive shutdown.
		await this.admissionTail;
		await this.pumpCompletion?.promise;
		const pending = [...this.jobs.values()].filter((job) => !isTerminalState(job.record.state));
		await Promise.all(pending.map(async (job) => {
			if (job.record.state === "queued") {
				await this.cancelQueued(job);
			} else {
				await this.requestStop(job, "cancelled");
				await job.completion.promise;
			}
		}));
		this.listeners.clear();
	}

	private async requestStop(job: Job, reason: "cancelled" | "timed_out"): Promise<void> {
		if (job.finished || isTerminalState(job.record.state)) return;
		if (!job.stopReason) job.stopReason = reason;
		job.cancelRequested = true;
		if (job.timeout) clearTimeout(job.timeout);
		job.timeout = undefined;

		if (job.record.state === "queued") {
			await this.cancelQueued(job);
			return;
		}

		if (job.record.state !== "stopping") {
			job.record.state = "stopping";
			await this.store.persist(job.record);
			this.changed();
		}
		const childPid = job.child?.pid;
		if (childPid && !job.terminationPromise) {
			job.terminationPromise = terminateProcessGroup(childPid, this.limits.stopGraceMs, true);
		}
	}

	private async cancelQueued(job: Job): Promise<void> {
		if (job.finished) return;
		this.removeFromQueue(job);
		job.cancelRequested = true;
		job.stopReason ??= "cancelled";
		if (job.lock) {
			await job.lock.release();
			job.lock = undefined;
		}
		await this.finish(job, "cancelled", { code: "CANCELLED", message: "Run was cancelled before launch" });
		this.requestPump();
	}

	private async launch(job: Job): Promise<void> {
		if (job.finished) return;
		let drainTasks: Promise<void>[] = [];
		delete job.record.queueReason;
		this.changed();
		try {
			if (!job.lock) {
				job.record.state = "starting";
				await this.store.persist(job.record);
				if (job.cancelRequested) {
					await this.finish(job, "cancelled", { code: "CANCELLED", message: "Run was cancelled before process creation" });
					return;
				}
				job.lock = await this.locks.tryAcquire(job.checkoutRoot, this.lockOwner(job.record.id));
				if (!job.lock) {
					// A lock can disappear between queue selection and acquisition. Return the job to FIFO queue.
					job.record.state = "queued";
					await this.store.persist(job.record);
					this.queue.unshift(job);
					return;
				}
			} else {
				job.record.state = "starting";
				await this.store.persist(job.record);
			}

			if (job.cancelRequested) {
				await this.finish(job, "cancelled", { code: "CANCELLED", message: "Run was cancelled before process creation" });
				return;
			}

			if (job.record.worktree) {
				job.record.queueReason = "Preparing isolated worktree";
				this.changed();
				job.record.cwd = job.record.control?.continuedFrom
					? await this.worktrees.resume(job.record.worktree, job.record.worktreeOwnerId!)
					: await this.worktrees.prepare(job.record.worktree, job.record.id);
				delete job.record.queueReason;
				await this.store.persist(job.record);
				this.changed();
				if (job.cancelRequested) {
					await this.finish(job, "cancelled", { code: "CANCELLED", message: "Run was cancelled during workspace preparation; worktree retained" });
					return;
				}
			}

			if (job.record.control) {
				await mkdir(dirname(job.record.control.sessionPath), { recursive: true, mode: 0o700 });
				await chmod(dirname(job.record.control.sessionPath), 0o700);
			}
			const child = spawnConfiguredProcess(job.executable, job.args, {
				cwd: job.record.cwd,
				env: {
					...process.env,
					...(this.config.profiles[job.record.profile]?.environment ?? {}),
					...processTokenEnvironment(job.record.processToken),
				},
			});
			job.child = child;
			if (job.record.control) job.rpc = new RpcTransport(child.stdin!, () => this.changed());
			child.once("close", () => job.rpc?.close());
			job.closePromise = new Promise<ProcessClose>((resolveClose) => {
				child.once("close", (exitCode, signal) => resolveClose({ exitCode, signal }));
			});
			const cleanupAfterExit = new Promise<ProcessClose>((resolveExit) => {
				child.once("exit", (exitCode, signal) => resolveExit({ exitCode, signal }));
			}).then(async () => {
				if (process.platform === "win32" || !child.pid) return true;
				job.terminationPromise ??= terminateProcessGroup(child.pid, this.limits.stopGraceMs, true);
				return job.terminationPromise;
			});
			let spawnError: Error | undefined;
			const spawnResult = new Promise<void>((resolveSpawn, rejectSpawn) => {
				child.once("spawn", () => resolveSpawn());
				child.once("error", (error) => {
					spawnError = error;
					rejectSpawn(error);
				});
			});
			child.on("error", (error) => { spawnError ??= error; });
			drainTasks = [
				this.drainOutput(job, child.stdout, "stdout"),
				this.drainOutput(job, child.stderr, "stderr"),
			];
			// stdin is a separate stream: ChildProcess's error event does not
			// handle EPIPE when a CLI exits/rejects input before reading the task.
			child.stdin?.on("error", (error: Error) => {
				job.stdinError ??= error;
				// Don't signal until the process group has been created and its PID
				// identity recorded below. Launch will handle an earlier EPIPE.
				if (job.childStartIdentity && child.pid) {
					job.terminationPromise ??= terminateProcessGroup(child.pid, this.limits.stopGraceMs, true);
				}
			});
			if (job.stdin !== undefined) child.stdin?.end(job.stdin, "utf8");
			else if (!job.rpc) child.stdin?.end();

			try {
				await spawnResult;
			} catch (error) {
				await job.closePromise;
				await Promise.all(drainTasks);
				await this.finish(job, "launch_failed", {
					code: "SPAWN_FAILED",
					message: errorMessage(spawnError ?? error),
				});
				return;
			}

			if (!child.pid) {
				throw new SupervisorError("PROCESS_IDENTITY_UNAVAILABLE", "Spawned process did not expose a PID");
			}
			job.record.processPid = child.pid;
			job.childStartIdentity = await getProcessStartIdentity(child.pid);
			job.record.processStartIdentity = job.childStartIdentity;
			if (!job.childStartIdentity) {
				job.terminationPromise = terminateProcessGroup(child.pid, this.limits.stopGraceMs, true);
				await job.terminationPromise;
				await job.closePromise;
				await Promise.all(drainTasks);
				await this.finish(job, "interrupted", job.stdinError
					? { code: "STDIN_IO", message: `Could not deliver the task to child stdin: ${job.stdinError.message}` }
					: { code: "PROCESS_IDENTITY_UNAVAILABLE", message: "Could not verify the spawned process identity; it was terminated without recording task success" });
				return;
			}
			await job.lock?.setChild(child.pid, job.childStartIdentity, job.record.processToken);
			job.record.startedAt = new Date().toISOString();
			job.record.state = job.stopReason ? "stopping" : "running";
			await this.store.persist(job.record);
			this.changed();
			if (job.stdinError || job.stopReason) {
				job.terminationPromise ??= terminateProcessGroup(child.pid, this.limits.stopGraceMs, true);
			} else if (job.record.timeoutMs !== undefined) {
				job.timeout = setTimeout(() => {
					void this.requestStop(job, "timed_out").catch(() => undefined);
				}, job.record.timeoutMs);
				job.timeout.unref();
			}

			if (job.rpc && !job.stopReason && !job.stdinError) {
				void job.rpc.prompt(job.record.task).catch((error: Error) => {
					job.stdinError ??= error;
					job.terminationPromise ??= terminateProcessGroup(child.pid!, this.limits.stopGraceMs, true);
				});
			}
			const close = await job.closePromise;
			if (job.record.control && existsSync(job.record.control.sessionPath)) await chmod(job.record.control.sessionPath, 0o600);
			if (job.timeout) clearTimeout(job.timeout);
			job.timeout = undefined;
			await Promise.all(drainTasks);
			const cleanupObserved = await cleanupAfterExit;
			if (job.logError) job.record.error = { code: "LOG_IO", message: job.logError };
			if (!cleanupObserved) {
				await this.finish(job, "interrupted", job.stdinError
					? { code: "STDIN_IO", message: `Could not deliver the task to child stdin: ${job.stdinError.message}; process-tree cleanup could not be verified` }
					: { code: "CLEANUP_UNVERIFIED", message: "The child exited but process-tree cleanup could not be verified" }, close);
			} else if (job.stopReason === "timed_out") {
				await this.finish(job, "timed_out", { code: "TIMEOUT", message: "Run timed out and owned process cleanup was observed" }, close);
			} else if (job.stopReason === "cancelled") {
				await this.finish(job, "cancelled", { code: "CANCELLED", message: "Run was stopped and owned process cleanup was observed" }, close);
			} else if (job.stdinError) {
				await this.finish(job, "interrupted", { code: "STDIN_IO", message: `Could not deliver the task to child stdin: ${job.stdinError.message}` }, close);
			} else {
				const error = close.exitCode !== null && close.exitCode !== 0
					? { code: "PROCESS_EXIT", message: `Child process exited with code ${close.exitCode}` }
					: close.signal
						? { code: "PROCESS_SIGNAL", message: `Child process exited due to signal ${close.signal}` }
						: job.record.error;
				await this.finish(job, "exited", error, close);
			}
		} catch (error) {
			if (job.child?.pid && process.platform !== "win32") {
				job.terminationPromise ??= terminateProcessGroup(job.child.pid, this.limits.stopGraceMs, true);
				await job.terminationPromise.catch(() => false);
			}
			if (job.child && job.closePromise) await job.closePromise.catch(() => undefined);
			await Promise.all(drainTasks);
			if (!job.finished) {
				const state: RunState = job.child ? "interrupted" : "launch_failed";
				await this.finish(job, state, {
					code: error instanceof WorktreeError ? error.code : state === "launch_failed" ? "LAUNCH_FAILED" : "PROCESS_INTERRUPTED",
					message: errorMessage(error),
				});
			}
		} finally {
			if (job.timeout) clearTimeout(job.timeout);
			job.timeout = undefined;
			if (job.lock) {
				await job.lock.release().catch(() => undefined);
				job.lock = undefined;
			}
		}
	}

	private async finish(job: Job, state: RunState, error?: { code: string; message: string }, close?: ProcessClose): Promise<void> {
		if (job.finished) return;
		let terminalState = state;
		let terminalError = error;
		if (job.lock) {
			try {
				await job.lock.release();
				job.lock = undefined;
			} catch (releaseError) {
				terminalState = "interrupted";
				terminalError = { code: "CHECKOUT_LOCK_RELEASE", message: `Could not release checkout lock: ${errorMessage(releaseError)}` };
			}
		}
		if (job.record.worktree?.state === "ready") job.record.worktree.state = "retained";
		else if (job.record.worktree?.state === "pending") job.record.worktree.state = "not_created";
		job.presenter.finish(terminalState === "exited" && close?.exitCode === 0 && !terminalError);
		job.finished = true;
		job.record.state = terminalState;
		delete job.record.queueReason;
		job.record.endedAt = new Date().toISOString();
		if (close) {
			job.record.exitCode = close.exitCode;
			job.record.signal = close.signal;
		}
		if (terminalError) job.record.error = terminalError;
		try {
			await this.store.persist(job.record);
			this.changed();
			if (this.options.onRunTerminal && !job.record.notifiedAt) {
				job.record.notifiedAt = new Date().toISOString();
				await this.store.persist(job.record);
				try {
					this.options.onRunTerminal({
						id: job.record.id,
						label: job.record.label,
						finalAnswer: job.record.presentation?.finalAnswer,
						protocolWarning: job.record.presentation?.protocolWarning,
						profile: job.record.profile,
						...(job.record.worktree ? { worktree: structuredClone(job.record.worktree) } : {}),
						state: job.record.state,
						...(job.record.exitCode !== undefined ? { exitCode: job.record.exitCode } : {}),
						...(job.record.error ? { error: job.record.error } : {}),
					});
				} catch {
					// A notification failure must not change the process outcome or replay it.
				}
			}
		} finally {
			job.completion.resolve();
		}
	}

	private async drainOutput(job: Job, stream: Readable | null, channel: "stdout" | "stderr"): Promise<void> {
		if (!stream) return;
		try {
			for await (const chunk of stream) {
				const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
				if (channel === "stdout") { job.presenter.push(bytes); job.rpc?.push(bytes); }
				this.changed();
				const next = job.logChain.then(async () => {
					await this.store.appendLog(job.record, bytes, this.limits.maxLogBytes);
					await this.store.appendStreamLog(job.record, bytes, channel, this.limits.maxLogBytes);
				});
				job.logChain = next.catch((error: unknown) => {
					job.logError ??= errorMessage(error);
				});
				await job.logChain;
			}
		} catch (error) {
			job.logError ??= errorMessage(error);
		}
	}

	private async requestPump(): Promise<void> {
		if (!this.initialized || this.closed || this.pumping) return;
		this.pumping = true;
		const completion = deferred<void>();
		this.pumpCompletion = completion;
		try {
			while (this.active.size < this.limits.maxConcurrent && this.queue.length > 0 && !this.closed) {
				for (let index = this.queue.length - 1; index >= 0; index--) {
					if (this.queue[index].finished || this.queue[index].cancelRequested) this.queue.splice(index, 1);
				}
				if (this.queue.length === 0) break;
				let selectedIndex = -1;
				let selectedLock: CheckoutLock | undefined;
				for (let index = 0; index < this.queue.length; index++) {
					const candidate = this.queue[index];
					if (candidate.cancelRequested || candidate.finished) continue;
					if (candidate.lock) {
						selectedIndex = index;
						selectedLock = candidate.lock;
						break;
					}
					const lock = await this.locks.tryAcquire(candidate.checkoutRoot, this.lockOwner(candidate.record.id));
					if (!lock && candidate.record.queueReason !== "Checkout busy") {
						candidate.record.queueReason = "Checkout busy";
						this.changed();
					}
					if (lock) {
						if (candidate.cancelRequested || candidate.finished || this.closed) {
							await lock.release();
							continue;
						}
						selectedIndex = index;
						selectedLock = lock;
						candidate.lock = lock;
						break;
					}
				}
				if (selectedIndex < 0) break;
				const [job] = this.queue.splice(selectedIndex, 1);
				if (!job || !selectedLock) continue;
				this.active.add(job);
				void this.launch(job).catch(async (error) => {
					if (!job.finished) await this.finish(job, "launch_failed", { code: "LAUNCH_FAILED", message: errorMessage(error) });
				}).finally(() => {
					this.active.delete(job);
					job.completion.resolve();
					this.requestPump();
				});
			}
		} finally {
			this.pumping = false;
			if (this.active.size >= this.limits.maxConcurrent) {
				for (const job of this.queue) job.record.queueReason = "Concurrency limit";
				this.changed();
			}
			if (this.queue.length === 0) {
				if (this.queueRetry) clearTimeout(this.queueRetry);
				this.queueRetry = undefined;
			} else {
				this.scheduleQueueRetry();
			}
			completion.resolve();
		}
	}

	private scheduleQueueRetry(): void {
		if (this.queueRetry || this.closed) return;
		this.queueRetry = setTimeout(() => {
			this.queueRetry = undefined;
			this.requestPump();
		}, this.limits.queueRetryMs);
		this.queueRetry.unref();
	}

	private removeFromQueue(job: Job): void {
		const index = this.queue.indexOf(job);
		if (index >= 0) this.queue.splice(index, 1);
	}

	private lockOwner(runId: string) {
		if (!this.supervisorStartIdentity) throw new SupervisorError("NOT_INITIALIZED", "Supervisor process identity is unavailable");
		return {
			runId,
			supervisorToken: this.supervisorToken,
			supervisorPid: process.pid,
			supervisorStartIdentity: this.supervisorStartIdentity,
		};
	}

	private async withAdmission<T>(action: () => Promise<T>): Promise<T> {
		const previous = this.admissionTail;
		let release!: () => void;
		this.admissionTail = new Promise<void>((resolveAdmission) => { release = resolveAdmission; });
		await previous;
		try {
			return await action();
		} finally {
			release();
		}
	}

	private assertInitialized(): void {
		if (!this.initialized) throw new SupervisorError("NOT_INITIALIZED", "Call initialize() before using the supervisor");
	}
}
