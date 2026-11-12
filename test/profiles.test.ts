import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensurePrivateSupervisorDirectories, getSupervisorPaths, loadSupervisorConfig } from "../src/config.js";
import {
	parseSupervisorConfig,
	ProfileConfigurationError,
	resolveLaunchRecipe,
	type SupervisorConfig,
} from "../src/profiles.js";

const fixturePath = new URL("./fixtures/profiles.json", import.meta.url);

async function fixtureConfig(): Promise<SupervisorConfig> {
	return parseSupervisorConfig(JSON.parse(await readFile(fixturePath, "utf8")));
}

function baseConfig(profile: Record<string, unknown> = {
	executable: "fake-agent",
	args: ["--", "{task}"],
	taskTransport: "argument",
}): Record<string, unknown> {
	return { defaultProfile: "fake", profiles: { fake: profile } };
}

function expectConfigError(action: () => unknown, message: RegExp): void {
	assert.throws(action, (error: unknown) => error instanceof ProfileConfigurationError && message.test(error.message));
}

test("verified Pi, Codex, and Claude Code profiles resolve generic CLI recipes", async () => {
	const file = new URL("../profiles/verified.json", import.meta.url);
	const config = parseSupervisorConfig(JSON.parse(await readFile(file, "utf8")));
	assert.equal(Object.values(config.profiles).some((profile) => profile.defaultModel), false);
	assert.throws(() => resolveLaunchRecipe(config, { profile: "pi", task: "missing parent/model" }), /select a model/);
	const pi = resolveLaunchRecipe(config, { profile: "pi", model: "openai-codex/gpt-6-luna", effort: "max", task: "edit this checkout" });
	assert.equal(pi.model, "openai-codex/gpt-6-luna");
	assert.equal(pi.effort, "max");
	assert.deepEqual(pi.args, ["--no-extensions", "--mode", "rpc", "--session", "{session}", "--model", "openai-codex/gpt-6-luna", "--thinking", "max"]);
	assert.equal(pi.taskTransport, "pi-rpc");

	const codex = resolveLaunchRecipe(config, { profile: "codex", model: "gpt-6.1-sol", effort: "ultra", task: "edit this checkout" });
	assert.equal(codex.model, "gpt-6.1-sol");
	assert.equal(codex.effort, "ultra");
	assert.equal(codex.stdin, "edit this checkout");
	assert.deepEqual(codex.args, ["exec", "--json", "--model", "gpt-6.1-sol", "--config", 'model_reasoning_effort="ultra"', "--ephemeral", "-"]);
	assert.throws(() => resolveLaunchRecipe(config, { profile: "codex", task: "no pinned model" }), /select a model/);
	assert.throws(() => resolveLaunchRecipe(config, { profile: "codex", model: "gpt-6-luna", effort: "ultra", task: "unsupported" }), /does not support/);

	const claude = resolveLaunchRecipe(config, { profile: "claude-code", model: "sonnet", task: "edit this checkout" });
	assert.equal(claude.model, "sonnet");
	assert.equal(claude.effort, undefined);
	assert.equal(claude.stdin, "edit this checkout");
	assert.deepEqual(claude.args, ["--print", "--no-session-persistence", "--model", "sonnet", "--permission-mode", "acceptEdits", "--output-format", "json"]);

	const claudeOpus = resolveLaunchRecipe(config, { profile: "claude-code", model: "opus", task: "use the alternative model" });
	assert.equal(claudeOpus.model, "opus");
	assert.throws(() => resolveLaunchRecipe(config, { profile: "claude-code", model: "sonnet", effort: "high", task: "unsupported effort override" }), /does not support/);
});

test("loads the fake-profile fixture and resolves model and effort defaults independently", async () => {
	const config = await fixtureConfig();
	const recipe = resolveLaunchRecipe(config, { task: "  summarize 雪  " });

	assert.equal(recipe.profile, "fake-stdin");
	assert.deepEqual(recipe.args, ["--model", "fake/model-steady", "--reasoning", "max", "--"]);
	assert.equal(recipe.stdin, "  summarize 雪  ");
	assert.equal(recipe.model, "fake/model-steady");
	assert.equal(recipe.effort, "max");
	assert.equal(recipe.effortAlias, "deep");
	assert.deepEqual(recipe.environment, { FAKE_AGENT_MODE: "test" });
});

test("explicit model and effort overrides resolve independently", async () => {
	const config = await fixtureConfig();
	const recipe = resolveLaunchRecipe(config, { task: "do it", model: "fake/model-swift", effort: "deep" });

	assert.equal(recipe.model, "fake/model-swift");
	assert.equal(recipe.effort, "high");
	assert.equal(recipe.effortAlias, "deep");
	assert.deepEqual(recipe.args, ["--model", "fake/model-swift", "--reasoning", "high", "--"]);
});

test("an omitted effort uses the selected model's own default before the profile fallback", async () => {
	const config = await fixtureConfig();
	const recipe = resolveLaunchRecipe(config, { task: "do it", model: "fake/model-swift" });
	assert.equal(recipe.effortAlias, "quick");
	assert.equal(recipe.effort, "minimal");

	const perModelDefaults = parseSupervisorConfig({
		defaultProfile: "fake",
		profiles: {
			fake: {
				executable: "fake-agent",
					args: ["--model", "{model}", "--effort", "{effort}", "--", "{task}"],
					taskTransport: "argument",
					defaultModel: "fake/special",
					defaultEffort: "fallback",
					models: {
					"fake/fallback": { efforts: { fallback: "low" } },
					"fake/special": { defaultEffort: "custom", efforts: { custom: "high" } },
				},
			},
		},
	});
	assert.equal(resolveLaunchRecipe(perModelDefaults, { task: "go" }).effort, "high");
});

test("argument transport inserts task as one argv element without interpreting it", async () => {
	const config = await fixtureConfig();
	const task = "--dangerous-looking 'quoted' $HOME $(literal) 雪";
	const recipe = resolveLaunchRecipe(config, { task, profile: "fake-argument" });

	assert.deepEqual(recipe.args, ["--", task]);
	assert.equal(recipe.stdin, undefined);
	assert.equal(recipe.taskTransport, "argument");
});

test("rejects empty tasks and unknown profile, model, or effort selections", async () => {
	const config = await fixtureConfig();
	expectConfigError(() => resolveLaunchRecipe(config, { task: "  " }), /task: expected nonempty/);
	expectConfigError(() => resolveLaunchRecipe(config, { task: "x", profile: "missing" }), /unknown profile/);
	expectConfigError(() => resolveLaunchRecipe(config, { task: "x", model: "missing" }), /does not define model ID/);
	expectConfigError(() => resolveLaunchRecipe(config, { task: "x", model: "toString" }), /does not define model ID/);
	expectConfigError(() => resolveLaunchRecipe(config, { task: "x", effort: "turbo" }), /does not support/);
});

test("rejects model and effort overrides for profiles that do not support them", async () => {
	const config = await fixtureConfig();
	expectConfigError(() => resolveLaunchRecipe(config, { task: "x", profile: "fake-argument", model: "fake/model-steady" }), /does not support model/);
	expectConfigError(() => resolveLaunchRecipe(config, { task: "x", profile: "fake-argument", effort: "deep" }), /does not support/);
});

test("validates default profile, profile names, and unknown config fields", () => {
	expectConfigError(() => parseSupervisorConfig({ defaultProfile: "missing", profiles: { fake: { executable: "agent", args: [], taskTransport: "stdin" } } }), /unknown profile/);
	expectConfigError(() => parseSupervisorConfig({ defaultProfile: "fake", profiles: { "bad name": {} } }), /invalid|expected a safe name/);
	expectConfigError(() => parseSupervisorConfig({ defaultProfile: "__proto__", profiles: { "__proto__": {} } }), /safe name/);
	expectConfigError(() => parseSupervisorConfig({ ...baseConfig(), unexpected: true }), /unknown property/);
	expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: [], taskTransport: "stdin", shell: true })), /unknown property/);
});

test("requires task placeholders to match the selected transport exactly once", () => {
	expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["{task}"], taskTransport: "shell" })), /expected "stdin" or "argument"/);
	expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: [], taskTransport: "argument" })), /requires exactly one/);
	expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["{task}", "{task}"], taskTransport: "argument" })), /exactly one/);
	expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["--task={task}"], taskTransport: "argument" })), /entire argv element/);
	expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["{task}"], taskTransport: "stdin" })), /must not include/);
});

test("rejects unknown, embedded task, duplicated, and unavailable placeholders", () => {
	for (const arg of ["{unknown}", "prefix-{task}", "{{task}}"] as const) {
		expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["--", "{task}", arg], taskTransport: "argument" })), /placeholder/);
	}
	expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["--", "{model}", "{task}"], taskTransport: "argument" })), /requires a models map/);
	expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["{task}", "{task}"], taskTransport: "argument" })), /exactly one/);
});

test("rejects shell expansion syntax rather than treating it as a command", () => {
	for (const value of ["$(whoami)", "${HOME}", "$HOME", "`id`", "--prefix=$(cmd)"]) {
		expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["--", "{task}", value], taskTransport: "argument" })), /shell expansion/);
	}
});

test("supports one safe embedded model or effort placeholder for literal CLI config arguments", () => {
	const config = parseSupervisorConfig(baseConfig({
		executable: "codex",
		args: ["exec", "--json", "--model", "{model}", "-c", 'model_reasoning_effort="{effort}"', "--", "-"],
		taskTransport: "stdin",
		defaultModel: "gpt-6-luna",
		defaultEffort: "deep",
		models: { "gpt-6-luna": { efforts: { deep: "max" }, defaultEffort: "deep" } },
	}));
	const recipe = resolveLaunchRecipe(config, { task: "Implement the requested change" });
	assert.deepEqual(recipe.args, ["exec", "--json", "--model", "gpt-6-luna", "-c", 'model_reasoning_effort="max"', "--", "-"]);
	assert.equal(recipe.stdin, "Implement the requested change");
	assert.throws(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["task={task}"], taskTransport: "argument" })), /task.*entire argv element/);
	assert.throws(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["--model", "{model}", "--", "{task}"], taskTransport: "argument", defaultModel: "provider/model-v1", models: { "provider/model-v1": { id: "provider/model-v1" } } })), /unknown property "id"/);
});

test("requires configured model IDs and efforts to be represented by one argv placeholder", () => {
	const models = { "fake/model": { efforts: { deep: "max" }, defaultEffort: "deep" } };
	expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["--", "{task}"], taskTransport: "argument", models, defaultModel: "fake/model" })), /models require exactly one/);
	expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["--model", "{model}", "--", "{task}"], taskTransport: "argument", models, defaultModel: "fake/model" })), /efforts require exactly one/);
	expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["--effort", "{effort}", "--", "{task}"], taskTransport: "argument" })), /requires configured effort/);
});

test("rejects invalid model/effort defaults and maps", () => {
	expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["{model}", "{task}"], taskTransport: "argument", models: { id: {} } })), /defaultModel.*required/);
	expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["{model}", "{effort}", "{task}"], taskTransport: "argument", models: { id: { efforts: { deep: "max" } } }, defaultModel: "id" })), /default effort for every model/);
	expectConfigError(() => parseSupervisorConfig(baseConfig({ executable: "agent", args: ["{model}", "{effort}", "{task}"], taskTransport: "argument", models: { id: { efforts: { deep: "max" }, defaultEffort: "unknown" } }, defaultModel: "id" })), /does not name a configured effort/);
});

test("uses Pi's supported config-root override and locates private supervisor data below it", () => {
	const paths = getSupervisorPaths({ PI_CODING_AGENT_DIR: "/Users/tester/custom-pi" }, "/Users/ignored");
	assert.equal(paths.configDirectory, "/Users/tester/custom-pi/agent-supervisor");
	assert.equal(paths.profilesFile, "/Users/tester/custom-pi/agent-supervisor/profiles.json");
	assert.equal(paths.runtimeDirectory, "/Users/tester/custom-pi/agent-supervisor/runtime");
	assert.equal(paths.lockDirectory, "/Users/ignored/.pi/agent/agent-supervisor/locks");
});

test("loads a JSON profile file and reports malformed or missing trusted config", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-agent-supervisor-"));
	try {
		const validPath = join(directory, "profiles.json");
		const fixtureText = await readFile(fixturePath, "utf8");
		await writeFile(validPath, fixtureText);
		assert.equal((await loadSupervisorConfig(validPath)).defaultProfile, "fake-stdin");
		await writeFile(validPath, "{");
		await assert.rejects(loadSupervisorConfig(validPath), /Invalid JSON/);
		await assert.rejects(loadSupervisorConfig(join(directory, "missing.json")), /Unable to read trusted supervisor profiles/);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("creates private config and runtime directories", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-agent-supervisor-private-"));
	try {
		const paths = {
			configDirectory: join(root, "agent-supervisor"),
			profilesFile: join(root, "agent-supervisor", "profiles.json"),
			runtimeDirectory: join(root, "agent-supervisor", "runtime"),
			lockDirectory: join(root, "agent-supervisor", "locks"),
		};
		await ensurePrivateSupervisorDirectories(paths);
		assert.equal((await stat(paths.configDirectory)).mode & 0o777, 0o700);
		assert.equal((await stat(paths.runtimeDirectory)).mode & 0o777, 0o700);
		assert.equal((await stat(paths.lockDirectory)).mode & 0o777, 0o700);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
