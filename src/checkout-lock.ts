import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SupervisorPaths } from "./config.js";
import { getProcessStartIdentity, isPidAlive, isProcessGroupAlive } from "./process.js";

export interface CheckoutLockOwner {
	runId: string;
	supervisorToken: string;
	supervisorPid: number;
	supervisorStartIdentity: string;
}

interface LockRecord extends CheckoutLockOwner {
	version: 1;
	checkoutRoot: string;
	createdAt: string;
	lockToken: string;
	childPid?: number;
	childStartIdentity?: string;
	childToken?: string;
}

export interface CheckoutLock {
	readonly path: string;
	readonly token: string;
	setChild(pid: number, startIdentity: string, processToken: string): Promise<void>;
	release(): Promise<void>;
}

function checkoutHash(checkoutRoot: string): string {
	return createHash("sha256").update(checkoutRoot).digest("hex");
}

export function checkoutLockPath(paths: SupervisorPaths, checkoutRoot: string): string {
	return join(paths.lockDirectory, `${checkoutHash(checkoutRoot)}.json`);
}

function isLockRecord(value: unknown): value is LockRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Partial<LockRecord>;
	return record.version === 1
		&& typeof record.checkoutRoot === "string"
		&& typeof record.createdAt === "string"
		&& typeof record.lockToken === "string"
		&& typeof record.runId === "string"
		&& typeof record.supervisorToken === "string"
		&& typeof record.supervisorPid === "number"
		&& typeof record.supervisorStartIdentity === "string";
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	const tempPath = `${filePath}.${randomUUID()}.tmp`;
	const handle = await open(tempPath, "wx", 0o600);
	try {
		await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
		await handle.sync();
	} finally {
		await handle.close();
	}
	await rename(tempPath, filePath);
	await chmod(filePath, 0o600);
}

export class CheckoutLockManager {
	constructor(private readonly paths: SupervisorPaths, private readonly malformedLockGraceMs = 30_000) {}

	async tryAcquire(checkoutRoot: string, owner: CheckoutLockOwner): Promise<CheckoutLock | undefined> {
		await mkdir(this.paths.lockDirectory, { recursive: true, mode: 0o700 });
		await chmod(this.paths.lockDirectory, 0o700);
		const filePath = checkoutLockPath(this.paths, checkoutRoot);
		const record: LockRecord = {
			...owner,
			version: 1,
			checkoutRoot,
			createdAt: new Date().toISOString(),
			lockToken: randomUUID(),
		};

		return this.withGuard(filePath, false, async () => {
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					const handle = await open(filePath, "wx", 0o600);
					try {
						await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
						await handle.sync();
					} finally {
						await handle.close();
					}
					await chmod(filePath, 0o600);
					return this.makeHandle(filePath, record);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				}

				if (!await this.isStale(filePath, checkoutRoot)) return undefined;
				try {
					await unlink(filePath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
				}
			}
			return undefined;
		});
	}

	/**
	 * A kernel-backed SQLite reservation serializes the complete check/mutate
	 * operation, including stale recovery. Checking a token before unlink alone
	 * is insufficient: another contender can replace the file after the check.
	 * The guard inode is permanent; closing/crashing releases its OS lock.
	 */
	private async withGuard<T>(filePath: string, wait: boolean, action: () => Promise<T>): Promise<T | undefined> {
		const guardPath = `${filePath}.guard.sqlite`;
		const handle = await open(guardPath, "a", 0o600);
		await handle.close();
		await chmod(guardPath, 0o600);
		for (;;) {
			const database = new DatabaseSync(guardPath);
			let acquired = false;
			try {
				try {
					database.exec("BEGIN IMMEDIATE");
					acquired = true;
				} catch (error) {
					const code = (error as { errcode?: number }).errcode;
					if (code !== 5 && code !== 6) throw error; // SQLITE_BUSY / SQLITE_LOCKED
					if (!wait) return undefined;
				}
				if (acquired) return await action();
			} finally {
				try {
					if (acquired) database.exec("ROLLBACK");
				} finally {
					database.close();
				}
			}
			await new Promise((resolveWait) => setTimeout(resolveWait, 20));
		}
	}

	private async isStale(filePath: string, checkoutRoot: string): Promise<boolean> {
		let lock: LockRecord;
		try {
			const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
			if (!isLockRecord(parsed) || parsed.checkoutRoot !== checkoutRoot) return false;
			lock = parsed;
		} catch {
			try {
				const info = await stat(filePath);
				return Date.now() - info.mtimeMs > this.malformedLockGraceMs;
			} catch {
				return true;
			}
		}

		const supervisorIdentity = await getProcessStartIdentity(lock.supervisorPid);
		if (supervisorIdentity === lock.supervisorStartIdentity) return false;
		if (!supervisorIdentity && isPidAlive(lock.supervisorPid)) return false;
		if (lock.childPid && lock.childStartIdentity && lock.childToken) {
			if (isProcessGroupAlive(lock.childPid)) return false;
			const childIdentity = await getProcessStartIdentity(lock.childPid);
			if (childIdentity === lock.childStartIdentity) return false;
			if (!childIdentity && isPidAlive(lock.childPid)) return false;
		}
		return true;
	}

	private makeHandle(filePath: string, initial: LockRecord): CheckoutLock {
		let released = false;
		return {
			path: filePath,
			token: initial.lockToken,
			setChild: async (pid, startIdentity, processToken) => {
				await this.withGuard(filePath, true, async () => {
					if (released) throw new Error("Cannot update a released checkout lock");
					const current = await this.readCurrent(filePath);
					if (!current || current.lockToken !== initial.lockToken) throw new Error("Checkout lock ownership changed before child registration");
					await writeJsonAtomic(filePath, { ...current, childPid: pid, childStartIdentity: startIdentity, childToken: processToken });
				});
			},
			release: async () => {
				await this.withGuard(filePath, true, async () => {
					if (released) return;
					const current = await this.readCurrent(filePath);
					if (current?.lockToken === initial.lockToken) {
						try {
							await unlink(filePath);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
						}
					}
					released = true;
				});
			},
		};
	}

	private async readCurrent(filePath: string): Promise<LockRecord | undefined> {
		try {
			const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
			return isLockRecord(parsed) ? parsed : undefined;
		} catch {
			return undefined;
		}
	}
}
