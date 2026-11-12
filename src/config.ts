import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseSupervisorConfig, type SupervisorConfig } from "./profiles.js";

export interface SupervisorPaths {
	configDirectory: string;
	profilesFile: string;
	runtimeDirectory: string;
	lockDirectory: string;
}

/**
 * Resolve the private, user-level supervisor directories. PI_CODING_AGENT_DIR is
 * Pi's supported config root override; it is not read from the project/task.
 */
export function getSupervisorPaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): SupervisorPaths {
	const piConfigRoot = env.PI_CODING_AGENT_DIR?.trim();
	const piRoot = piConfigRoot ? resolve(piConfigRoot) : join(home, ".pi", "agent");
	const configDirectory = join(piRoot, "agent-supervisor");
	const lockDirectory = join(home, ".pi", "agent", "agent-supervisor", "locks");
	return {
		configDirectory,
		profilesFile: join(configDirectory, "profiles.json"),
		runtimeDirectory: join(configDirectory, "runtime"),
		lockDirectory,
	};
}

export async function ensurePrivateSupervisorDirectories(paths = getSupervisorPaths()): Promise<void> {
	await mkdir(paths.configDirectory, { recursive: true, mode: 0o700 });
	await chmod(paths.configDirectory, 0o700);
	await mkdir(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
	await chmod(paths.runtimeDirectory, 0o700);
	await mkdir(paths.lockDirectory, { recursive: true, mode: 0o700 });
	await chmod(paths.lockDirectory, 0o700);
}

export async function loadSupervisorConfig(filePath = getSupervisorPaths().profilesFile): Promise<SupervisorConfig> {
	let source: string;
	try {
		source = await readFile(filePath, "utf8");
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read trusted supervisor profiles at ${filePath}: ${detail}`, { cause: error });
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(source);
	} catch (error) {
		throw new Error(`Invalid JSON in trusted supervisor profiles at ${filePath}`, { cause: error });
	}

	try {
		return parseSupervisorConfig(parsed);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid trusted supervisor profiles at ${filePath}: ${detail}`, { cause: error });
	}
}
