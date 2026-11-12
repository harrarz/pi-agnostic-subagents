import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelSettings, availableModels, openModelSettings } from "../src/model-settings.js";
import { parseSupervisorConfig, resolveLaunchRecipe } from "../src/profiles.js";
import type { PiContext } from "../src/pi-api.js";

function config() {
	return parseSupervisorConfig({ defaultProfile: "generic", profiles: {
		generic: { executable: "not-pi", args: ["{modelArgs}", "{effortArgs}", "--", "{task}"], taskTransport: "argument", modelArgs: ["--model", "{model}"], effortArgs: ["--effort", "{effort}"], modelFormat: "qualified", models: { "fake/one": { efforts: { quick: "low" } } } },
		bare: { executable: "not-codex", args: ["{modelArgs}"], modelArgs: ["--model={model}"], taskTransport: "stdin", modelFormat: "id", parentProviders: ["fake"], models: { selector: {} } },
		plain: { executable: "anything", args: ["{task}"], taskTransport: "argument" },
	} });
}

function context() {
	const notices: string[] = [];
	const picks: Array<number | undefined> = [];
	const prompts: string[] = [];
	const ctx = {
		mode: "tui", hasUI: true,
		model: { provider: "fake", id: "one" },
		scopedModels: [] as Array<{ model: { provider: string; id: string } }>,
		modelRegistry: { getAvailable: () => [{ provider: "fake", id: "one" }, { provider: "fake", id: "two" }, { provider: "fake", id: "three" }, { provider: "other", id: "one" }] },
		ui: {
			notify: (message: string) => notices.push(message),
			select: async (_title: string, choices: string[]) => { const index = picks.shift(); return index === undefined ? undefined : choices[index]; },
			input: async () => prompts.shift(),
		},
	};
	return { ctx, asContext: () => ctx as unknown as PiContext, notices, picks, prompts };
}

async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "pi-supervisor-model-settings-"));
	return { directory, settings: new ModelSettings(directory), cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("model follows the current parent on every launch without a saved default", async () => {
	const fixtureState = await fixture();
	try {
		const { settings } = fixtureState;
		const ctx = context();
		assert.equal((await settings.resolve(ctx.asContext(), config(), { task: "one" })).model, "fake/one");
		ctx.ctx.model.id = "two";
		assert.equal((await settings.resolve(ctx.asContext(), config(), { task: "two" })).model, "fake/two");
		await assert.rejects(readFile(settings.file), { code: "ENOENT" });
	} finally { await fixtureState.cleanup(); }
});

test("explicit override wins over saved selection, which wins over parent; clear restores parent", async () => {
	const fixtureState = await fixture();
	try {
		const { settings, directory } = fixtureState;
		const ctx = context();
		await settings.set("generic", "fake/two");
		assert.equal((await settings.resolve(ctx.asContext(), config(), { task: "saved" })).model, "fake/two");
		assert.equal((await settings.resolve(ctx.asContext(), config(), { task: "explicit", model: "fake/three" })).model, "fake/three");
		assert.equal((await new ModelSettings(directory).load()).models.generic, "fake/two");
		await settings.set("generic", undefined);
		assert.equal((await settings.resolve(ctx.asContext(), config(), { task: "parent" })).model, "fake/one");
		assert.equal((await stat(settings.file)).mode & 0o777, 0o600);
		assert.equal((await stat(directory)).mode & 0o777, 0o700);
	} finally { await fixtureState.cleanup(); }
});

test("model naming and compatible providers are declarative, never executable-name branches", async () => {
	const fixtureState = await fixture();
	try {
		const ctx = context();
		const resolved = await fixtureState.settings.resolve(ctx.asContext(), config(), { task: "bare", profile: "bare" });
		assert.equal(resolved.model, "one");
		assert.deepEqual(resolveLaunchRecipe(config(), resolved).args, ["--model=one"]);
		ctx.ctx.model.provider = "other";
		await assert.rejects(fixtureState.settings.resolve(ctx.asContext(), config(), { task: "incompatible", profile: "bare" }), /cannot inherit provider/);
		assert.equal((await fixtureState.settings.resolve(ctx.asContext(), config(), { task: "explicit CLI selector", profile: "bare", model: "selector" })).model, "selector");
	} finally { await fixtureState.cleanup(); }
});

test("no model and unavailable selections fail rather than silently choosing a default", async () => {
	const fixtureState = await fixture();
	try {
		const ctx = context();
		await fixtureState.settings.set("generic", "missing/model");
		await assert.rejects(fixtureState.settings.resolve(ctx.asContext(), config(), { task: "x" }), /not available/);
		await fixtureState.settings.set("generic", undefined);
		const missingParent = { ...ctx.asContext(), model: undefined };
		await assert.rejects(fixtureState.settings.resolve(missingParent, config(), { task: "x" }), /No parent model/);
		assert.equal((await fixtureState.settings.resolve(missingParent, config(), { task: "x", model: "fake/two" })).model, "fake/two");
		assert.deepEqual(await fixtureState.settings.resolve(missingParent, config(), { task: "plain", profile: "plain" }), { task: "plain", profile: "plain" });
	} finally { await fixtureState.cleanup(); }
});

test("available choices follow scoped models and provider capabilities", () => {
	const ctx = context();
	assert.ok(availableModels(ctx.asContext(), config().profiles.generic).includes("fake/three"));
	ctx.ctx.scopedModels = [{ model: { provider: "fake", id: "two" } }];
	assert.deepEqual(availableModels(ctx.asContext(), config().profiles.generic), ["fake/two"]);
	assert.deepEqual(availableModels(ctx.asContext(), config().profiles.bare), ["selector", "two"]);
});

test("optional argv groups preserve ordering, allow new models, and omit unrequested effort", () => {
	const selected = resolveLaunchRecipe(config(), { task: "--task 雪", model: "fake/three" });
	assert.deepEqual(selected.args, ["--model", "fake/three", "--", "--task 雪"]);
	assert.equal(selected.effort, undefined);
	assert.deepEqual(resolveLaunchRecipe(config(), { task: "x", model: "fake/one", effort: "quick" }).args, ["--model", "fake/one", "--effort", "low", "--", "x"]);
	assert.throws(() => resolveLaunchRecipe(config(), { task: "x", model: "fake/three", effort: "quick" }), /does not support/);
	assert.throws(() => resolveLaunchRecipe(config(), { task: "x" }), /select a model/);
});

test("argument groups reject missing/embedded/duplicate slots, shell expansion and unrelated placeholders", () => {
	const profile = { executable: "generic", args: ["{modelArgs}", "--", "{task}"], taskTransport: "argument", modelArgs: ["--model", "{model}"] };
	for (const patch of [
		{ args: ["{task}"] },
		{ args: ["prefix-{modelArgs}", "{task}"] },
		{ args: ["{modelArgs}", "{modelArgs}", "{task}"] },
		{ args: ["{modelArgs}", "{model}", "{task}"] },
		{ modelArgs: ["{task}"] },
		{ modelArgs: ["{model}", "{model}"] },
		{ modelArgs: ["$(id)", "{model}"] },
		{ modelFormat: "guess" },
		{ parentProviders: [] },
	]) assert.throws(() => parseSupervisorConfig({ defaultProfile: "x", profiles: { x: { ...profile, ...patch } } }));
});

test("settings TUI saves an available model, survives reload, and clears back to parent", async () => {
	const fixtureState = await fixture();
	try {
		const ctx = context();
		ctx.picks.push(0, 1, 2, undefined); // generic → available → fake/two → close
		await openModelSettings(ctx.asContext(), config(), fixtureState.settings);
		assert.equal((await fixtureState.settings.load()).models.generic, "fake/two");
		ctx.picks.push(0, 0, undefined);
		await openModelSettings(ctx.asContext(), config(), fixtureState.settings);
		assert.equal((await fixtureState.settings.load()).models.generic, undefined);
		assert.ok(ctx.notices.some((notice) => notice.includes("following the parent")));
	} finally { await fixtureState.cleanup(); }
});

test("cancelled or invalid TUI choices do not change a preference; exact CLI model input is supported", async () => {
	const fixtureState = await fixture();
	try {
		const ctx = context();
		ctx.picks.push(0, 1, undefined, undefined);
		await openModelSettings(ctx.asContext(), config(), fixtureState.settings);
		assert.deepEqual((await fixtureState.settings.load()).models, {});
		ctx.picks.push(0, 2, undefined);
		ctx.prompts.push("missing/model");
		await openModelSettings(ctx.asContext(), config(), fixtureState.settings);
		assert.ok(ctx.notices.some((notice) => notice.includes("not available")));
		assert.deepEqual((await fixtureState.settings.load()).models, {});
		ctx.picks.push(1, 2, undefined); // bare-ID CLI selector
		ctx.prompts.push("custom-cli-model");
		await openModelSettings(ctx.asContext(), config(), fixtureState.settings);
		assert.equal((await fixtureState.settings.load()).models.bare, "custom-cli-model");
	} finally { await fixtureState.cleanup(); }
});

test("corrupt settings and unsafe names are rejected instead of manufacturing preferences", async () => {
	const fixtureState = await fixture();
	try {
		await assert.rejects(fixtureState.settings.set("__proto__", "fake/one"), /profile/);
		await assert.rejects(fixtureState.settings.set("generic", "bad\nmodel"), /control/);
		await writeFile(fixtureState.settings.file, '{"models":[],"unknown":true}');
		await assert.rejects(fixtureState.settings.load(), /Invalid/);
	} finally { await fixtureState.cleanup(); }
});
