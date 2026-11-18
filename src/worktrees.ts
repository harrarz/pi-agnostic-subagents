import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
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

export interface WorktreeRepoInput {
	path: string;
	ref: string;
}

export interface BundleWorktree extends WorktreeInfo {
	name: string;
	ref: string;
}

export interface WorktreeBundleInfo {
	path: string;
	members: BundleWorktree[];
}

// Keep the existing single-worktree record shape for callers and saved history.
export interface RunWorktrees {
	worktree?: WorktreeInfo;
	worktreeBundle?: WorktreeBundleInfo;
}

export function worktreeMembers(run: RunWorktrees): WorktreeInfo[] {
	return run.worktreeBundle?.members ?? (run.worktree ? [run.worktree] : []);
}

export function worktreeRoot(run: RunWorktrees): string | undefined {
	return run.worktreeBundle?.path ?? run.worktree?.path;
}

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SNAPSHOT_NOTE = "uncommitted and untracked source changes are not copied. No automatic commit or merge.";
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

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

async function gitDirectory(root: string, flag: "--git-common-dir" | "--show-toplevel"): Promise<string> {
	// Remove Git's newline, not whitespace that might be part of the path.
	return realpath((await git(root, ["rev-parse", "--path-format=absolute", flag])).replace(/\n$/, ""));
}

function nameKey(name: string): string { return name.normalize("NFD").toLowerCase(); }

function isCheckoutName(name: string): boolean {
	return Boolean(name && name !== "." && name !== ".." && nameKey(name) !== ".git" && !name.includes(sep) && !CONTROL.test(name));
}

function checkoutName(source: string, used: Set<string>): string {
	const preferred = basename(source);
	let name = preferred;
	for (let suffix = 1; !isCheckoutName(name) || used.has(nameKey(name)); suffix++) name = `repo-${suffix}`;
	used.add(nameKey(name));
	return name;
}

/** Git workspace lifecycle only. Does not spawn agents, commit, merge or force-delete. */
export class WorktreeManager {
	readonly directory: string;
	constructor(paths: SupervisorPaths) { this.directory = join(paths.runtimeDirectory, "worktrees"); }

	async plan(sourceRoot: string, sourceCwd: string, id: string): Promise<WorktreeInfo> {
		let source: Awaited<ReturnType<typeof this.pinSource>>;
		try { source = await this.pinSource(sourceRoot, sourceCwd, "HEAD"); }
		catch (error) {
			throw new WorktreeError("WORKTREE_SOURCE", `Worktree isolation requires a Git checkout with a committed HEAD and committed cwd: ${error instanceof Error ? error.message : String(error)}`);
		}
		return this.planCheckout(source, await this.planPath(id), id, `Starts from committed HEAD; ${SNAPSHOT_NOTE}`);
	}

	async planBundle(repos: readonly WorktreeRepoInput[], cwd: string, id: string): Promise<WorktreeBundleInfo> {
		if (!Array.isArray(repos) || !repos.length || repos.some((repo) => !repo || typeof repo.path !== "string" || !repo.path.trim() || CONTROL.test(repo.path)
			|| typeof repo.ref !== "string" || !repo.ref.trim() || CONTROL.test(repo.ref))) {
			throw new WorktreeError("INVALID_REPOS", "A worktree bundle requires at least one repository path and a Git ref per repository");
		}
		const sources = await Promise.all(repos.map(async ({ path, ref }) => {
			try {
				const root = await realpath(resolve(cwd, path));
				return { ...await this.pinSource(root, root, ref), ref };
			} catch (error) {
				throw new WorktreeError("WORKTREE_SOURCE", `Cannot pin ${JSON.stringify(ref)} at repository root ${JSON.stringify(path)}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}));
		if (new Set(sources.map((source) => source.commonDir)).size !== sources.length) {
			throw new WorktreeError("INVALID_REPOS", "Each repository may appear only once in a worktree bundle, including linked checkouts of the same repo");
		}
		const path = await this.planPath(id);
		const names = new Set<string>();
		const members = sources.map(({ ref, ...source }) => {
			const name = checkoutName(source.sourceRoot, names);
			return { name, ref, ...this.planCheckout(source, join(path, name), id, `Starts from the pinned commit; ${SNAPSHOT_NOTE}`) };
		});
		return { path, members };
	}

	async prepare(info: WorktreeInfo, id: string): Promise<string> {
		return this.prepareCheckout(info, id, await this.runPath(id));
	}

	async prepareBundle(bundle: WorktreeBundleInfo, id: string, cancelled: () => boolean): Promise<string> {
		await this.verifyBundleLayout(bundle, id);
		if (cancelled()) return bundle.path;
		try { await mkdir(bundle.path, { mode: 0o700 }); }
		catch (error) { throw new WorktreeError("WORKTREE_CREATE", `Cannot create bundle directory ${bundle.path}: ${error instanceof Error ? error.message : String(error)}`); }
		// Each run prepares only its own members. If a checkout fails or this
		// run is stopped, leave any completed members and never spawn the worker.
		for (const member of bundle.members) {
			if (cancelled()) break;
			await this.verifyDirectory(bundle.path);
			if (cancelled()) break;
			await this.prepareCheckout(member, id, join(bundle.path, member.name));
		}
		return bundle.path;
	}

	/** Verify a retained workspace before a follow-up launches into it. */
	async resume(info: WorktreeInfo, id: string): Promise<string> {
		const cwd = await this.verifyRetained(info, id, await this.runPath(id));
		info.state = "ready";
		return cwd;
	}

	async resumeBundle(bundle: WorktreeBundleInfo, id: string): Promise<string> {
		await this.verifyBundleLayout(bundle, id);
		await this.verifyDirectory(bundle.path);
		for (const member of bundle.members) await this.verifyRetained(member, id, join(bundle.path, member.name));
		for (const member of bundle.members) member.state = "ready";
		return bundle.path;
	}

	/** Called only by the human command after terminal/process/ownership checks. */
	async remove(info: WorktreeInfo, id: string): Promise<void> {
		const registered = await this.checkRemoval(info, id, await this.runPath(id));
		await this.removeChecked(info, registered);
	}

	async removeBundle(bundle: WorktreeBundleInfo, id: string): Promise<void> {
		await this.verifyBundleLayout(bundle, id);
		if (await exists(bundle.path)) await this.verifyDirectory(bundle.path);
		// Preflight every member before deleting any. Git still refuses dirty
		// checkouts at removal; successful removals are recorded individually.
		const registered = await Promise.all(bundle.members.map((member) => this.checkRemoval(member, id, join(bundle.path, member.name))));
		for (const [index, member] of bundle.members.entries()) await this.removeChecked(member, registered[index]);
	}

	private async pinSource(sourceRoot: string, sourceCwd: string, ref: string) {
		if (await gitDirectory(sourceRoot, "--show-toplevel") !== sourceRoot || !inside(sourceRoot, sourceCwd)) throw new Error("Name the root of an existing Git working checkout");
		const relativeCwd = relative(sourceRoot, sourceCwd);
		const [stdout, commonDir] = await Promise.all([
			git(sourceRoot, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]), gitDirectory(sourceRoot, "--git-common-dir"),
		]);
		const baseCommit = stdout.trim();
		if (!COMMIT.test(baseCommit)) throw new Error("Git ref does not resolve to a commit");
		if (relativeCwd && (await git(sourceRoot, ["cat-file", "-t", `${baseCommit}:${relativeCwd.split(sep).join("/")}`])).trim() !== "tree") throw new Error("Requested cwd is not a committed directory");
		return { baseCommit, sourceRoot, sourceCwd, commonDir, relativeCwd };
	}

	private planCheckout(source: Awaited<ReturnType<typeof this.pinSource>>, path: string, id: string, note: string): WorktreeInfo {
		return { ...source, path, branch: `pi-agent/${id}`, state: "pending", note };
	}

	private async planPath(id: string): Promise<string> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		await chmod(this.directory, 0o700);
		return this.runPath(id);
	}

	private async runPath(id: string): Promise<string> {
		if (!UUID.test(id)) throw new WorktreeError("WORKTREE_ID", "Invalid generated worktree identity");
		return join(await realpath(this.directory), id);
	}

	private async verifyBundleLayout(bundle: WorktreeBundleInfo, id: string): Promise<void> {
		if (bundle.path !== await this.runPath(id) || !bundle.members.length
			|| bundle.members.some((member) => !isCheckoutName(member.name) || member.relativeCwd !== "")
			|| new Set(bundle.members.map((member) => nameKey(member.name))).size !== bundle.members.length
			|| new Set(bundle.members.map((member) => member.commonDir)).size !== bundle.members.length) {
			throw new WorktreeError("WORKTREE_IDENTITY", "Worktree bundle identity changed; manual inspection required");
		}
	}

	private async verifyIdentity(info: WorktreeInfo, id: string, expectedPath: string): Promise<void> {
		if (info.branch !== `pi-agent/${id}` || info.path !== expectedPath || !COMMIT.test(info.baseCommit)
			|| !inside(info.sourceRoot, info.sourceCwd) || relative(info.sourceRoot, info.sourceCwd) !== info.relativeCwd
			|| await gitDirectory(info.sourceRoot, "--show-toplevel") !== info.sourceRoot
			|| await gitDirectory(info.sourceRoot, "--git-common-dir") !== info.commonDir) {
			throw new WorktreeError("WORKTREE_IDENTITY", "Worktree identity/source repository changed; manual inspection required");
		}
	}

	private async verifyDirectory(path: string): Promise<void> {
		if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) throw new WorktreeError("WORKTREE_IDENTITY", `Worktree path was substituted: ${path}`);
	}

	private async verifyRegistration(info: WorktreeInfo): Promise<void> {
		const registered = (await this.registrations(info.sourceRoot)).find((entry) => entry.path === info.path);
		if (registered?.branch !== `refs/heads/${info.branch}`) throw new WorktreeError("WORKTREE_IDENTITY", "Worktree registration or branch changed; refusing to act on a foreign/detached checkout");
		await this.verifyDirectory(info.path);
		if (await gitDirectory(info.path, "--git-common-dir") !== info.commonDir) throw new WorktreeError("WORKTREE_IDENTITY", "Worktree repository changed; refusing to act on a foreign checkout");
	}

	private async checkoutCwd(info: WorktreeInfo): Promise<string> {
		const cwd = await realpath(join(info.path, info.relativeCwd));
		if (!inside(info.path, cwd)) throw new WorktreeError("WORKTREE_IDENTITY", "Worktree cwd resolves outside the workspace");
		return cwd;
	}

	private async prepareCheckout(info: WorktreeInfo, id: string, expectedPath: string): Promise<string> {
		try {
			await this.verifyIdentity(info, id, expectedPath);
			if (await exists(info.path)) throw new Error("Generated worktree path already exists; refusing to reuse it");
			await git(info.sourceRoot, ["worktree", "add", "-b", info.branch, "--", info.path, info.baseCommit]);
			await this.verifyRegistration(info);
			await chmod(info.path, 0o700);
			const cwd = await this.checkoutCwd(info);
			info.state = "ready";
			return cwd;
		} catch (error) {
			info.state = "failed";
			info.note += " Setup failed; any partial worktree/branch is preserved for inspection.";
			throw new WorktreeError("WORKTREE_CREATE", `Could not prepare isolated worktree ${info.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async verifyRetained(info: WorktreeInfo, id: string, expectedPath: string): Promise<string> {
		if (info.state !== "retained") throw new WorktreeError("WORKTREE_UNCERTAIN", "Only a retained workspace can be resumed");
		await this.verifyIdentity(info, id, expectedPath);
		await this.verifyRegistration(info);
		return this.checkoutCwd(info);
	}

	private async checkRemoval(info: WorktreeInfo, id: string, expectedPath: string): Promise<boolean> {
		await this.verifyIdentity(info, id, expectedPath);
		const registered = (await this.registrations(info.sourceRoot)).some((entry) => entry.path === info.path);
		if (!registered && !await exists(info.path)) return false;
		await this.verifyRegistration(info);
		// Include ignored files; never silently discard build artifacts/dependencies.
		const changes = await git(info.path, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"]);
		if (changes.trim()) throw new WorktreeError("WORKTREE_DIRTY", `Worktree ${info.path} contains tracked, untracked or ignored changes. Preserve/recover them before removing it; no files were deleted.`);
		return true;
	}

	private async removeChecked(info: WorktreeInfo, registered: boolean): Promise<void> {
		if (registered) await git(info.sourceRoot, ["worktree", "remove", "--", info.path]);
		info.state = "removed";
		info.note = registered ? `Clean worktree removed. Branch ${info.branch} was kept; no automatic merge or branch deletion.` : "Worktree already absent; no branch was deleted.";
	}

	private async registrations(root: string): Promise<Array<{ path: string; branch?: string }>> {
		const output = await git(root, ["worktree", "list", "--porcelain", "-z"]);
		return output.split("\0\0").filter(Boolean).map((record) => {
			const fields = record.split("\0");
			return { path: fields.find((field) => field.startsWith("worktree "))?.slice(9) ?? "", branch: fields.find((field) => field.startsWith("branch "))?.slice(7) };
		});
	}
}
