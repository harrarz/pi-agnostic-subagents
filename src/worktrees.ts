import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { SupervisorPaths } from "./config.js";

export type Isolation = "shared" | "worktree";
export interface WorktreeInfo {
	path: string;
	branch: string;
	baseCommit: string;
	sourceRoot: string;
	sourceCwd: string;
	commonDir: string;
	relativeCwd: string;
	state: "pending" | "ready" | "retained" | "not_created" | "failed" | "removed";
	note: string;
}

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SNAPSHOT_NOTE = "Starts from committed HEAD; uncommitted and untracked source changes are not copied. No automatic commit or merge.";

export class WorktreeError extends Error {
	constructor(readonly code: string, message: string) { super(message); this.name = "WorktreeError"; }
}

function inside(root: string, path: string): boolean {
	const value = relative(root, path);
	return !isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`);
}

async function exists(path: string): Promise<boolean> {
	try { await lstat(path); return true; }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function git(cwd: string, args: string[]): Promise<string> {
	const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete (env as NodeJS.ProcessEnv)[key];
	const { stdout } = await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
		encoding: "utf8", env, timeout: 30_000, maxBuffer: 256 * 1024,
	});
	return stdout;
}

async function commonDirectory(root: string): Promise<string> {
	return realpath((await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim());
}

/** Git workspace lifecycle only. Does not spawn agents, commit, merge or force-delete. */
export class WorktreeManager {
	readonly directory: string;
	constructor(paths: SupervisorPaths) { this.directory = join(paths.runtimeDirectory, "worktrees"); }

	async plan(sourceRoot: string, sourceCwd: string, id: string): Promise<WorktreeInfo> {
		if (!UUID.test(id)) throw new WorktreeError("WORKTREE_ID", "Invalid generated worktree identity");
		let baseCommit: string;
		let commonDir: string;
		const relativeCwd = relative(sourceRoot, sourceCwd);
		try {
			if (await realpath((await git(sourceRoot, ["rev-parse", "--show-toplevel"])).trim()) !== sourceRoot || !inside(sourceRoot, sourceCwd)) throw new Error("Source cwd is not in the expected Git checkout");
			baseCommit = (await git(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
			if (!/^[0-9a-f]{40,64}$/.test(baseCommit)) throw new Error("No committed HEAD");
			commonDir = await commonDirectory(sourceRoot);
			if (relativeCwd && (await git(sourceRoot, ["cat-file", "-t", `${baseCommit}:${relativeCwd.split(sep).join("/")}`])).trim() !== "tree") throw new Error("Requested cwd is not a committed directory");
		} catch (error) {
			throw new WorktreeError("WORKTREE_SOURCE", `Worktree isolation requires a Git checkout with a committed HEAD and committed cwd: ${error instanceof Error ? error.message : String(error)}`);
		}
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700);
		return {
			path: join(await realpath(this.directory), id), branch: `pi-agent/${id}`,
			baseCommit, sourceRoot, sourceCwd, commonDir, relativeCwd, state: "pending", note: SNAPSHOT_NOTE,
		};
	}

	async prepare(info: WorktreeInfo, id: string): Promise<string> {
		try {
			await this.verifyIdentity(info, id);
			if (await exists(info.path)) throw new Error("Generated worktree path already exists; refusing to reuse it");
			await git(info.sourceRoot, ["worktree", "add", "-b", info.branch, "--", info.path, info.baseCommit]);
			await chmod(info.path, 0o700);
			const cwd = await realpath(join(info.path, info.relativeCwd));
			if (!inside(info.path, cwd)) throw new Error("Worktree cwd resolves outside the isolated checkout");
			await this.verifyRegistration(info);
			info.state = "ready";
			return cwd;
		} catch (error) {
			info.state = "failed";
			info.note = `${SNAPSHOT_NOTE} Setup failed; any partial worktree/branch is preserved for inspection.`;
			throw new WorktreeError("WORKTREE_CREATE", `Could not prepare isolated worktree ${info.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Verify a retained workspace before a follow-up launches into it. */
	async resume(info: WorktreeInfo, ownerId: string): Promise<string> {
		if (info.state !== "retained") throw new WorktreeError("WORKTREE_UNCERTAIN", "Only a retained workspace can be resumed");
		await this.verifyIdentity(info, ownerId);
		await this.verifyRegistration(info);
		if ((await lstat(info.path)).isSymbolicLink() || await realpath(info.path) !== info.path) throw new WorktreeError("WORKTREE_IDENTITY", "Worktree path was substituted");
		const cwd = await realpath(join(info.path, info.relativeCwd));
		if (!inside(info.path, cwd)) throw new WorktreeError("WORKTREE_IDENTITY", "Worktree cwd resolves outside the workspace");
		info.state = "ready";
		return cwd;
	}

	/** Called only by the human command after terminal/process/ownership checks. */
	async remove(info: WorktreeInfo, id: string): Promise<void> {
		await this.verifyIdentity(info, id);
		const entries = await this.registrations(info.sourceRoot);
		const registered = entries.find((entry) => entry.path === info.path);
		if (!registered && !await exists(info.path)) {
			info.state = "removed";
			info.note = "Worktree already absent; no branch was deleted.";
			return;
		}
		await this.verifyRegistration(info);
		if ((await lstat(info.path)).isSymbolicLink() || await realpath(info.path) !== info.path) throw new WorktreeError("WORKTREE_IDENTITY", "Refusing to remove a substituted worktree path");
		// Git's own safety check is retained too. Include ignored files here so
		// ignored build artifacts/dependencies are never silently discarded.
		const changes = await git(info.path, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"]);
		if (changes.trim()) throw new WorktreeError("WORKTREE_DIRTY", "Worktree contains tracked, untracked or ignored changes. Preserve/recover them before removing it; no files were deleted.");
		await git(info.sourceRoot, ["worktree", "remove", "--", info.path]);
		info.state = "removed";
		info.note = `Clean worktree removed. Branch ${info.branch} was kept; no automatic merge or branch deletion.`;
	}

	private async verifyIdentity(info: WorktreeInfo, id: string): Promise<void> {
		if (!UUID.test(id) || info.branch !== `pi-agent/${id}` || info.path !== join(await realpath(this.directory), id)
			|| !inside(info.sourceRoot, info.sourceCwd) || relative(info.sourceRoot, info.sourceCwd) !== info.relativeCwd
			|| await commonDirectory(info.sourceRoot) !== info.commonDir) {
			throw new WorktreeError("WORKTREE_IDENTITY", "Worktree identity/source repository changed; manual inspection required");
		}
	}

	private async verifyRegistration(info: WorktreeInfo): Promise<void> {
		const registered = (await this.registrations(info.sourceRoot)).find((entry) => entry.path === info.path);
		if (!registered || registered.branch !== `refs/heads/${info.branch}` || await commonDirectory(info.path) !== info.commonDir) throw new WorktreeError("WORKTREE_IDENTITY", "Worktree registration or branch changed; refusing to act on a foreign/detached checkout");
	}

	private async registrations(root: string): Promise<Array<{ path: string; branch?: string }>> {
		const output = await git(root, ["worktree", "list", "--porcelain", "-z"]);
		return output.split("\0\0").filter(Boolean).map((record) => {
			const fields = record.split("\0");
			return { path: fields.find((field) => field.startsWith("worktree "))?.slice(9) ?? "", branch: fields.find((field) => field.startsWith("branch "))?.slice(7) };
		});
	}
}
