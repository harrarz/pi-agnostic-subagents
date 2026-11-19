import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import { loadBundledSupervisorConfig } from "../src/config.js";
import { resolveLaunchRecipe } from "../src/profiles.js";

const enabled = process.env.PI_AGENT_SUPERVISOR_CLI_SMOKE === "1";

function findModel(value: unknown, slug: string): Record<string, any> | undefined {
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findModel(item, slug);
			if (found) return found;
		}
	} else if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		if (record.slug === slug) return record as Record<string, any>;
		for (const item of Object.values(record)) {
			const found = findModel(item, slug);
			if (found) return found;
		}
	}
	return undefined;
}

test("offline Pi/Codex catalog smoke-checks match direct model IDs and effort support (no task sent)", { skip: !enabled }, async () => {
	const config = loadBundledSupervisorConfig();
	const piBin = process.env.PI_BIN ?? "pi";
	const codexBin = process.env.CODEX_BIN ?? "codex";

	for (const [modelId, effort] of [["openai-codex/gpt-6-luna", "max"], ["openai-codex/gpt-6.1-sol", "high"]] as const) {
		const recipe = resolveLaunchRecipe(config, { profile: "pi", model: modelId, effort, task: "offline model-selection smoke test" });
		const output = execFileSync(piBin, [
			"--offline", "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills",
			"--no-prompt-templates", "--no-themes", "--no-context-files", "--model", recipe.model!, "--thinking", recipe.effort!,
		], {
			input: '{"id":"model-state","type":"get_state"}\n',
			encoding: "utf8",
			timeout: 15_000,
			env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
		});
		const stateResponse = output.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((record) => record.type === "response" && record.id === "model-state");
		assert.equal(stateResponse?.success, true, `Pi did not resolve model ID ${modelId}`);
		assert.equal(stateResponse.data?.model?.provider, "openai-codex");
		assert.equal(stateResponse.data?.model?.id, recipe.model!.split("/")[1]);
		assert.equal(stateResponse.data?.thinkingLevel, effort);
	}

	const catalogOutput = execFileSync(codexBin, ["-c", 'model_reasoning_effort="max"', "debug", "models"], {
		encoding: "utf8",
		timeout: 15_000,
		maxBuffer: 2 * 1024 * 1024,
	});
	const catalog = JSON.parse(catalogOutput) as unknown;
	for (const [modelId, requiredEffort] of [["gpt-6-luna", "max"], ["gpt-6.1-sol", "ultra"]] as const) {
		const recipe = resolveLaunchRecipe(config, { profile: "codex", model: modelId, effort: requiredEffort, task: "offline model-selection smoke test" });
		const slug = recipe.model!;
		const model = findModel(catalog, slug);
		assert.ok(model, `Codex catalog did not contain ${slug}`);
		assert.equal(model.supported_in_api, true);
		const efforts = (model.supported_reasoning_levels as Array<{ effort: string }>).map((item) => item.effort);
		assert.ok(efforts.includes(requiredEffort), `Codex catalog did not advertise ${requiredEffort} for ${slug}`);
		assert.ok(recipe.args.includes(`model_reasoning_effort="${requiredEffort}"`));
	}
});

test("Claude Code profile flags parse in help mode without submitting a task", { skip: !enabled }, async (t) => {
	const claudeBin = process.env.CLAUDE_BIN ?? "claude";
	const version = spawnSync(claudeBin, ["--version"], { encoding: "utf8", timeout: 15_000 });
	if (version.error && (version.error as NodeJS.ErrnoException).code === "ENOENT" && process.env.CLAUDE_BIN === undefined) {
		t.skip("Claude Code CLI is not installed");
		return;
	}
	assert.ifError(version.error);
	assert.equal(version.status, 0, version.stderr);

	const config = loadBundledSupervisorConfig();
	const recipe = resolveLaunchRecipe(config, { profile: "claude-code", model: "sonnet", effort: "max", task: "offline flag smoke test" });
	assert.equal(recipe.taskTransport, "stdin");
	assert.equal(recipe.stdin, "offline flag smoke test");
	const help = spawnSync(claudeBin, [...recipe.args, "--help"], { encoding: "utf8", timeout: 15_000 });
	assert.ifError(help.error);
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /--permission-mode/);
	assert.match(help.stdout, /"stream-json"/);
	assert.match(help.stdout, /--verbose/);
	for (const effort of Object.values(config.profiles["claude-code"].models!.sonnet.efforts!)) assert.match(help.stdout.match(/--effort[^)]*\)/s)?.[0] ?? "", new RegExp(`\\b${effort}\\b`));
});
