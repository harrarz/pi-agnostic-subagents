import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseSupervisorConfig } from "../../src/profiles.js";

/** Explicitly opt-in live tests only. Credential contents are never printed. */
export async function prepareLivePiConfig(agentDir: string) {
	const source = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const config = parseSupervisorConfig(JSON.parse(await readFile(join(source, "agent-supervisor/profiles.json"), "utf8")));
	const profile = config.profiles.pi;
	assert.ok(profile, "Live test requires the existing trusted pi profile");
	const parentSettings = JSON.parse(await readFile(join(source, "settings.json"), "utf8")) as { defaultProvider?: string; defaultModel?: string; defaultThinkingLevel?: string };
	const provider = process.env.PI_PROVIDER ?? parentSettings.defaultProvider;
	const id = process.env.PI_MODEL ?? parentSettings.defaultModel;
	assert.ok(provider && id, "Live test requires a user-selected parent provider/model");
	const model = process.env.PI_AGENT_SUPERVISOR_TEST_MODEL ?? (id.includes("/") ? id : `${provider}/${id}`);
	const effort = profile.models?.[model]?.efforts?.minimal ? "minimal" : undefined;
	const thinking = process.env.PI_REASONING_LEVEL ?? parentSettings.defaultThinkingLevel;
	await mkdir(join(agentDir, "agent-supervisor"), { recursive: true, mode: 0o700 });
	for (const name of ["auth.json", "models-store.json", "models.json"]) {
		try {
			await copyFile(join(source, name), join(agentDir, name));
			await chmod(join(agentDir, name), 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: provider, defaultModel: id, ...(thinking ? { defaultThinkingLevel: thinking } : {}) }), { mode: 0o600 });
	const isolatedProfile = {
		...profile,
		outputProtocol: "pi-jsonl",
		args: ["--offline", "--no-skills", "--no-prompt-templates", "--no-context-files", ...profile.args],
	};
	await writeFile(join(agentDir, "agent-supervisor/profiles.json"), JSON.stringify({ defaultProfile: "pi", profiles: { pi: isolatedProfile } }), { mode: 0o600 });
	return { model, effort, thinking, originalProtocol: profile.outputProtocol ?? "raw" };
}
