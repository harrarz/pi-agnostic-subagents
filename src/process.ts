import { access, readFile, realpath, stat } from "node:fs/promises";
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
		return await realpath(stdout.trim());
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
		cwd = await realpath(requestedCwd ?? parentCwd);
	} catch (error) {
		throw new ProcessPreflightError("INVALID_CWD", `Working directory does not exist or is inaccessible: ${requestedCwd ?? parentCwd}`);
	}
	const [parentGitRoot, targetGitRoot] = await Promise.all([gitRoot(parent), gitRoot(cwd)]);
	const parentRoot = parentGitRoot ?? parent;
	const checkoutRoot = targetGitRoot ?? cwd;
	if (parentGitRoot || targetGitRoot) {
		if (!parentGitRoot || !targetGitRoot || parentGitRoot !== targetGitRoot) {
			throw new ProcessPreflightError("CWD_OUTSIDE_CHECKOUT", "Requested cwd must be inside the Pi session's Git checkout");
		}
	} else if (!isWithin(parentRoot, cwd)) {
		throw new ProcessPreflightError("CWD_OUTSIDE_CHECKOUT", "Requested cwd must be inside the Pi session working directory");
	}
	return { cwd, checkoutRoot };
}

export async function getProcessStartIdentity(pid: number): Promise<string | undefined> {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	if (process.platform === "linux") {
		try {
			const statLine = await readFile(`/proc/${pid}/stat`, "utf8");
			const closeParen = statLine.lastIndexOf(")");
			if (closeParen < 0) return undefined;
			const fieldsAfterComm = statLine.slice(closeParen + 1).trim().split(/\s+/);
			const startTicks = fieldsAfterComm[19];
			return startTicks ? `linux:${startTicks}` : undefined;
		} catch {
			return undefined;
		}
	}
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

async function processHasToken(pid: number, token: string): Promise<boolean> {
	if (!token || token.includes("\0")) return false;
	if (process.platform === "linux") {
		try {
			const environment = await readFile(`/proc/${pid}/environ`);
			return environment.toString("utf8").split("\0").includes(`${PROCESS_TOKEN_ENV}=${token}`);
		} catch {
			return false;
		}
	}
	try {
		const { stdout } = await execFileAsync("ps", ["eww", "-p", String(pid)], {
			encoding: "utf8",
			timeout: 2000,
			maxBuffer: 1024 * 1024,
		});
		return stdout.includes(`${PROCESS_TOKEN_ENV}=${token}`);
	} catch {
		return false;
	}
}

export async function isSameOwnedProcess(pid: number | undefined, startIdentity: string | undefined, token: string | undefined): Promise<boolean> {
	if (!pid || !startIdentity || !token) return false;
	const currentIdentity = await getProcessStartIdentity(pid);
	if (!currentIdentity || currentIdentity !== startIdentity) return false;
	return processHasToken(pid, token);
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
