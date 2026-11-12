import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { CheckoutLockManager, checkoutLockPath } from "../../src/checkout-lock.ts";
import { getProcessStartIdentity } from "../../src/process.ts";

const [lockDirectory, checkoutRoot, mode] = process.argv.slice(2);
const paths = { lockDirectory };
const commands = createInterface({ input: process.stdin });
const input = commands[Symbol.asyncIterator]();
let database;
let lock;
try {
	if (mode === "guard") {
		database = new DatabaseSync(`${checkoutLockPath(paths, checkoutRoot)}.guard.sqlite`);
		database.exec("BEGIN IMMEDIATE");
		console.log(JSON.stringify({ event: "ready" }));
		await input.next();
	} else {
		const identity = await getProcessStartIdentity(process.pid);
		console.log(JSON.stringify({ event: "ready" }));
		await input.next();
		lock = await new CheckoutLockManager(paths).tryAcquire(checkoutRoot, {
			runId: `run-${process.pid}`, supervisorToken: `owner-${process.pid}`,
			supervisorPid: process.pid, supervisorStartIdentity: identity,
		});
		console.log(JSON.stringify({ event: "acquired", acquired: Boolean(lock) }));
		await input.next(); // Keep the winner alive until all contenders report.
	}
} finally {
	await lock?.release();
	if (database) { database.exec("ROLLBACK"); database.close(); }
	commands.close();
}
