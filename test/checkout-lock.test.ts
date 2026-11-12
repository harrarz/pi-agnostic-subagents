import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { CheckoutLockManager, checkoutLockPath } from "../src/checkout-lock.js";
import { getProcessStartIdentity } from "../src/process.js";

async function fixture() {
	const lockDirectory = await mkdtemp(join(tmpdir(), "supervisor-lock-regression-"));
	const paths = { configDirectory: lockDirectory, profilesFile: "", runtimeDirectory: lockDirectory, lockDirectory };
	const checkoutRoot = process.cwd();
	const path = checkoutLockPath(paths, checkoutRoot);
	await writeFile(path, JSON.stringify({
		version: 1, checkoutRoot, createdAt: new Date(0).toISOString(), lockToken: "stale",
		runId: "dead-run", supervisorToken: "dead-owner", supervisorPid: 2147000000, supervisorStartIdentity: "dead",
	}), { mode: 0o600 });
	return { paths, checkoutRoot, path };
}

function driver(lockDirectory: string, checkoutRoot: string, mode = "contend") {
	const child = spawn(process.execPath, ["--import", "tsx", resolve("test/fixtures/lock-driver.mjs"), lockDirectory, checkoutRoot, mode], { stdio: ["pipe", "pipe", "pipe"] });
	const lines = createInterface({ input: child.stdout });
	let stderr = "";
	child.stderr.on("data", (chunk) => { stderr += chunk; });
	const closed = once(child, "close");
	const ready = once(lines, "line");
	return { child, lines, closed, ready, get stderr() { return stderr; } };
}

async function stopDriver(child: ChildProcessWithoutNullStreams, closed: Promise<unknown>) {
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await closed;
}

test("concurrent stale-lock reclamation grants exactly one owner", { timeout: 10000 }, async () => {
	const { paths, checkoutRoot, path } = await fixture();
	const identity = await getProcessStartIdentity(process.pid);
	assert.ok(identity);
	try {
		const locks = await Promise.all(Array.from({ length: 12 }, (_, index) => new CheckoutLockManager(paths).tryAcquire(checkoutRoot, {
			runId: `run-${index}`, supervisorToken: `owner-${index}`, supervisorPid: process.pid, supervisorStartIdentity: identity,
		})));
		const winners = locks.filter((lock) => lock !== undefined);
		assert.equal(winners.length, 1);
		assert.equal(JSON.parse(await readFile(path, "utf8")).lockToken, winners[0].token);
		assert.equal((await stat(`${path}.guard.sqlite`)).mode & 0o777, 0o600);
		await winners[0].release();
		const next = await new CheckoutLockManager(paths).tryAcquire(checkoutRoot, {
			runId: "next", supervisorToken: "next", supervisorPid: process.pid, supervisorStartIdentity: identity,
		});
		assert.ok(next);
		await next.release();
	} finally { await rm(paths.lockDirectory, { recursive: true, force: true }); }
});

test("separate OS processes cannot both reclaim the same stale checkout lock", { timeout: 15000 }, async () => {
	const { paths, checkoutRoot } = await fixture();
	const drivers = Array.from({ length: 8 }, () => driver(paths.lockDirectory, checkoutRoot));
	try {
		await Promise.all(drivers.map((entry) => entry.ready));
		const reports = drivers.map((entry) => once(entry.lines, "line"));
		for (const entry of drivers) entry.child.stdin.write("go\n");
		const results = await Promise.all(reports);
		assert.equal(results.filter(([line]) => JSON.parse(line).acquired).length, 1);
		for (const entry of drivers) entry.child.stdin.end("release\n");
		const exits = await Promise.all(drivers.map((entry) => entry.closed));
		for (const [code] of exits) assert.equal(code, 0, drivers.map((entry) => entry.stderr).join("\n"));
	} finally {
		await Promise.all(drivers.map((entry) => stopDriver(entry.child, entry.closed)));
		for (const entry of drivers) entry.lines.close();
		await rm(paths.lockDirectory, { recursive: true, force: true });
	}
});

test("a crashed guard owner releases its kernel reservation without stale-guard deletion", { timeout: 10000 }, async () => {
	const { paths, checkoutRoot, path } = await fixture();
	await writeFile(`${path}.guard.sqlite`, "", { mode: 0o600 });
	const holder = driver(paths.lockDirectory, checkoutRoot, "guard");
	const identity = await getProcessStartIdentity(process.pid);
	assert.ok(identity);
	const owner = { runId: "recovery", supervisorToken: "recovery", supervisorPid: process.pid, supervisorStartIdentity: identity };
	try {
		await holder.ready;
		const manager = new CheckoutLockManager(paths);
		assert.equal(await manager.tryAcquire(checkoutRoot, owner), undefined);
		await stopDriver(holder.child, holder.closed);
		const recovered = await manager.tryAcquire(checkoutRoot, owner);
		assert.ok(recovered);
		await recovered.release();
	} finally {
		await stopDriver(holder.child, holder.closed);
		holder.lines.close();
		await rm(paths.lockDirectory, { recursive: true, force: true });
	}
});
