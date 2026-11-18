import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";

const execFileAsync = promisify(execFile);
const PROCESS_TOKEN_ENV = "PI_AGENT_SUPERVISOR_PROCESS_TOKEN";


export class ProcessPreflightError extends Error {
	constructor(readonly code: string, message: string) {
		super(message);
		this.name = "ProcessPreflightError";
	}
}

export interface CanonicalCwd {
	cwd: string;
	checkoutRoot: string;
}

export async function resolveExecutable(executable: string, cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
	const pathValue = env.PATH ?? "";
	const hasSeparator = executable.includes(sep) || (sep === "/" && executable.includes("/"));
	const candidates = hasSeparator
		? [isAbsolute(executable) ? executable : resolve(cwd, executable)]
		: pathValue.split(delimiter).filter(Boolean).map((directory) => resolve(directory, executable));

	for (const candidate of candidates) {
		try {
			const canonical = await realpath(candidate);
			const info = await stat(canonical);
			if (!info.isFile()) continue;
			await access(canonical, constants.X_OK);
			return canonical;
		} catch {
			// Continue searching PATH entries; report one bounded error below.
		}
	}
	throw new ProcessPreflightError("EXECUTABLE_NOT_FOUND", `Configured executable is not available: ${executable}`);
}

async function gitRoot(cwd: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
			encoding: "utf8",
			timeout: 3000,
			maxBuffer: 64 * 1024,
		});
		return await realpath(stdout.replace(/\n$/, ""));
	} catch {
		return undefined;
	}
}

function isWithin(root: string, candidate: string): boolean {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

export async function canonicalizeCwd(requestedCwd: string | undefined, parentCwd: string): Promise<CanonicalCwd> {
	let parent: string;
	let cwd: string;
	try {
		parent = await realpath(parentCwd);
		cwd = requestedCwd === undefined ? parent : await realpath(resolve(parent, requestedCwd));
		if (!(await stat(cwd)).isDirectory()) throw new Error("Not a directory");
	} catch {
		throw new ProcessPreflightError("INVALID_CWD", `Working directory does not exist, is not a directory, or is inaccessible: ${requestedCwd ?? parentCwd}`);
	}
	const targetGitRoot = await gitRoot(cwd);
	// Nested repositories are fine. Preserve sibling access within the session's
	// own Git checkout, but don't let plain --cwd follow a symlink elsewhere.
	if (!isWithin(parent, cwd) && (!targetGitRoot || targetGitRoot !== await gitRoot(parent))) {
		throw new ProcessPreflightError("CWD_OUTSIDE_CHECKOUT", "Requested cwd must be inside the Pi session directory or its Git checkout");
	}
	return { cwd, checkoutRoot: targetGitRoot ?? cwd };
}

async function linuxProcessSnapshot(pid: number): Promise<{ state: string; identity: string; startTicks: bigint } | undefined> {
	try {
		const line = await readFile(`/proc/${pid}/stat`, "utf8");
		const closeParen = line.lastIndexOf(")");
		if (closeParen < 0) return undefined;
		const fields = line.slice(closeParen + 1).trim().split(/\s+/);
		if (!/^[A-Z]$/.test(fields[0]) || !/^[0-9]{1,30}$/.test(fields[19])) return undefined;
		return { state: fields[0], identity: `linux:${fields[19]}`, startTicks: BigInt(fields[19]) };
	} catch { return undefined; }
}

function terminatedLinuxState(state: string | undefined): boolean { return state === "Z" || state === "X"; }

export async function getProcessStartIdentity(pid: number): Promise<string | undefined> {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "linux") return (await linuxProcessSnapshot(pid))?.identity;
	try {
		const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
			encoding: "utf8",
			timeout: 2000,
			maxBuffer: 16 * 1024,
		});
		const value = stdout.trim();
		return value ? `${process.platform}:${value}` : undefined;
	} catch {
		return undefined;
	}
}

async function processHasToken(pid: number, token: string): Promise<boolean | undefined> {
	if (typeof token !== "string" || !token || token.includes("\0")) return false;
	if (process.platform === "linux") {
		try {
			const environment = await readFile(`/proc/${pid}/environ`);
			return environment.toString("utf8").split("\0").includes(`${PROCESS_TOKEN_ENV}=${token}`);
		} catch { return undefined; }
	}
	try {
		const options = { encoding: "utf8" as const, timeout: 2000, maxBuffer: 1024 * 1024 };
		const [withEnvironment, argumentsOnly] = await Promise.all([
			execFileAsync("ps", ["eww", "-p", String(pid), "-o", "command="], options),
			execFileAsync("ps", ["ww", "-p", String(pid), "-o", "command="], options),
		]);
		const args = argumentsOnly.stdout.trimEnd();
		if (!args || !withEnvironment.stdout.startsWith(args)) return undefined;
		// A token printed in argv is data, not proof of inherited ownership.
		return withEnvironment.stdout.slice(args.length).split(/\s+/).includes(`${PROCESS_TOKEN_ENV}=${token}`);
	} catch { return undefined; }
}

export async function isSameOwnedProcess(pid: number | undefined, startIdentity: string | undefined, token: string | undefined): Promise<boolean> {
	if (!pid || !startIdentity || !token) return false;
	const currentIdentity = await getProcessStartIdentity(pid);
	if (!currentIdentity || currentIdentity !== startIdentity) return false;
	return await processHasToken(pid, token) === true;
}

export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function isProcessGroupAlive(pgid: number): boolean {
	if (!Number.isInteger(pgid) || pgid <= 0 || process.platform === "win32") return false;
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function sendGroupSignal(pgid: number, signal: NodeJS.Signals): boolean {
	if (process.platform === "win32") return false;
	try {
		process.kill(-pgid, signal);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

async function waitForGroupExit(pgid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessGroupAlive(pgid)) return true;
		await new Promise((resolveWait) => setTimeout(resolveWait, 30));
	}
	return !isProcessGroupAlive(pgid);
}

export async function terminateProcessGroup(pgid: number, gracefulMs: number, locallyOwned = false): Promise<boolean> {
	if (process.platform === "win32") return false;
	if (!isProcessGroupAlive(pgid)) return true;
	if (!locallyOwned) return false;
	if (!sendGroupSignal(pgid, "SIGTERM")) return !isProcessGroupAlive(pgid);
	if (await waitForGroupExit(pgid, gracefulMs)) return true;
	if (!sendGroupSignal(pgid, "SIGKILL")) return !isProcessGroupAlive(pgid);
	return waitForGroupExit(pgid, Math.max(gracefulMs * 2, 500));
}

export async function terminateVerifiedProcessGroup(
	pid: number,
	startIdentity: string | undefined,
	token: string | undefined,
	gracefulMs: number,
): Promise<boolean> {
	if (!await isSameOwnedProcess(pid, startIdentity, token)) return false;
	return terminateProcessGroup(pid, gracefulMs, true);
}

interface OwnedProcess { pid: number; startIdentity: string }

function linuxStartTicks(identity: string | undefined): bigint | undefined {
	return identity && /^linux:[0-9]{1,30}$/.test(identity) ? BigInt(identity.slice(6)) : undefined;
}

/** Same-user token discovery only. Environment snapshots must never reach logs/errors. */
export async function findOwnedProcesses(token: string, earliestIdentity?: string): Promise<OwnedProcess[] | undefined> {
	if (typeof token !== "string" || !/^[A-Za-z0-9-]{8,128}$/.test(token) || process.platform === "win32" || !process.getuid) return undefined;
	const marker = `${PROCESS_TOKEN_ENV}=${token}`;
	const earliestTicks = linuxStartTicks(earliestIdentity);
	const pids = new Set<number>();
	try {
		if (process.platform === "linux") {
			const entries = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
			for (let offset = 0; offset < entries.length; offset += 32) {
				await Promise.all(entries.slice(offset, offset + 32).map(async (name) => {
					try {
						if ((await stat(`/proc/${name}`)).uid !== process.getuid!()) return;
						const snapshot = await linuxProcessSnapshot(Number(name));
						if (!snapshot) {
							if (!isPidAlive(Number(name))) return;
							throw new Error("Process identity unavailable");
						}
						// Zombies/dead tasks cannot execute, fork, or retain workspace
						// files. Their environ may deny access while awaiting reaping.
						if (terminatedLinuxState(snapshot.state)) return;
						// Older tasks cannot have inherited this run's new token.
						if (earliestTicks !== undefined && snapshot.startTicks < earliestTicks) return;
						const env = await readFile(`/proc/${name}/environ`);
						if (env.toString("utf8").split("\0").includes(marker)) pids.add(Number(name));
					} catch (error) {
						// Exit can race the earlier state read. Ignore only an observed
						// terminated state or vanished PID, never an unreadable live task.
						const latest = await linuxProcessSnapshot(Number(name));
						if (terminatedLinuxState(latest?.state) || (!latest && !isPidAlive(Number(name)))) return;
						if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw new Error("Process inspection unavailable");
					}
				}));
			}
		} else {
			const { stdout } = await execFileAsync("ps", ["eww", "-U", String(process.getuid()), "-o", "pid=,command="], {
				encoding: "utf8", timeout: 3000, maxBuffer: 16 * 1024 * 1024,
			});
			for (const line of stdout.split("\n")) {
				if (line.split(/\s+/).includes(marker)) {
					const pid = Number(line.trimStart().match(/^\d+/)?.[0]);
					if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
				}
			}
		}
		const owned: OwnedProcess[] = [];
		for (const pid of pids) {
			if (pid === process.pid) return undefined; // Never signal this supervisor.
			const startIdentity = await getProcessStartIdentity(pid);
			if (startIdentity) {
				const inherited = await processHasToken(pid, token);
				if (inherited === true) owned.push({ pid, startIdentity });
				else if (inherited === undefined && isPidAlive(pid)) return undefined;
			} else if (isPidAlive(pid)) return undefined;
		}
		return owned;
	} catch { return undefined; }
}

/** Clean the original group plus token-owned detached processes, rechecking identity per signal. */
export async function terminateOwnedProcessTree(
	pid: number | undefined, startIdentity: string | undefined, token: string, gracefulMs: number, locallyOwned = false,
): Promise<boolean> {
	// The original child's birth bounds all inheriting descendants. For a
	// locally observed fast exit without that identity, this supervisor's birth
	// is a conservative earlier floor. Never use a new owner's birth in recovery.
	const inspectionFloor = startIdentity ?? (locallyOwned && process.platform === "linux" ? await getProcessStartIdentity(process.pid) : undefined);
	const canSignalGroup = Boolean(pid && (locallyOwned || await isSameOwnedProcess(pid, startIdentity, token)));
	const groupCleanup = pid && canSignalGroup ? terminateProcessGroup(pid, gracefulMs, true) : Promise.resolve(true);
	let inspectionFailed = false;
	const unverified = new Map<number, string>();
	const signalled = new Map<string, "SIGTERM" | "SIGKILL">();
	const deadline = Date.now() + Math.max(gracefulMs * 3, 1500);
	const escalateAt = Date.now() + gracefulMs;
	// Scan again after signalling: descendants may fork while a parent handles SIGTERM.
	let emptyScans = 0;
	while (Date.now() < deadline) {
		const owned = await findOwnedProcesses(token, inspectionFloor);
		if (!owned) {
			// A process can disappear between ps/proc snapshots during cleanup.
			// Do not signal from an unavailable inspection, but retry within the
			// existing deadline. Persistent uncertainty still fails the final scan.
			emptyScans = 0;
			await new Promise((resolveWait) => setTimeout(resolveWait, 30));
			continue;
		}
		if (owned.length === 0) {
			if (++emptyScans >= 2) break;
		} else {
			emptyScans = 0;
			for (const child of owned) {
				if (!await isSameOwnedProcess(child.pid, child.startIdentity, token)) {
					unverified.set(child.pid, child.startIdentity);
					continue;
				}
				const signal = Date.now() >= escalateAt ? "SIGKILL" : "SIGTERM";
				const key = `${child.pid}:${child.startIdentity}`;
				if (signalled.get(key) === signal) continue;
				try { process.kill(child.pid, signal); signalled.set(key, signal); }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") inspectionFailed = true; }
			}
		}
		await new Promise((resolveWait) => setTimeout(resolveWait, 30));
	}
	const groupGone = await groupCleanup;
	let remaining = await findOwnedProcesses(token, inspectionFloor);
	while (remaining === undefined && Date.now() < deadline) {
		await new Promise((resolveWait) => setTimeout(resolveWait, 30));
		remaining = await findOwnedProcesses(token, inspectionFloor);
	}
	for (const [unverifiedPid, identity] of unverified) {
		if (process.platform === "linux" && terminatedLinuxState((await linuxProcessSnapshot(unverifiedPid))?.state)) continue;
		if (isPidAlive(unverifiedPid) && await getProcessStartIdentity(unverifiedPid) === identity) inspectionFailed = true;
	}
	return groupGone && (!pid || !isProcessGroupAlive(pid)) && !inspectionFailed && remaining !== undefined && remaining.length === 0;
}

export interface SpawnOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export function spawnConfiguredProcess(executable: string, args: string[], options: SpawnOptions): ChildProcess {
	return spawn(executable, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
		shell: false,
	});
}

export function processTokenEnvironment(token: string): Record<string, string> {
	return { [PROCESS_TOKEN_ENV]: token };
}
