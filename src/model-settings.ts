import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PiContext } from "./pi-api.js";
import { resolveLaunchRecipe, type LaunchProfile, type SupervisorConfig } from "./profiles.js";
import type { StartInput } from "./supervisor.js";
import { safeText } from "./display.js";

interface ModelPreferences { models: Record<string, string> }

function validModel(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

export class ModelSettings {
	readonly file: string;
	constructor(configDirectory: string) { this.file = join(configDirectory, "settings.json"); }

	async load(): Promise<ModelPreferences> {
		let raw: string;
		try { raw = await readFile(this.file, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { models: {} }; throw error; }
		const value = JSON.parse(raw) as { models?: unknown };
		if (!value || typeof value !== "object" || Object.keys(value).some((key) => key !== "models") || !value.models || typeof value.models !== "object" || Array.isArray(value.models)) throw new Error(`Invalid supervisor model settings: ${this.file}`);
		const models: Record<string, string> = Object.create(null);
		for (const [profile, model] of Object.entries(value.models)) {
			if (!["__proto__", "prototype", "constructor"].includes(profile) && /^[\w.-]{1,64}$/.test(profile) && validModel(model)) models[profile] = model;
			else throw new Error(`Invalid model preference for profile ${JSON.stringify(profile)}`);
		}
		return { models };
	}

	async set(profile: string, model: string | undefined): Promise<void> {
		if (["__proto__", "prototype", "constructor"].includes(profile) || !/^[\w.-]{1,64}$/.test(profile)) throw new Error("Invalid profile name");
		if (model !== undefined && !validModel(model)) throw new Error("Model must be a nonempty exact ID without control characters (max 512 characters)");
		const preferences = await this.load();
		if (model === undefined) delete preferences.models[profile];
		else preferences.models[profile] = model.trim();
		await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
		await chmod(dirname(this.file), 0o700);
		const temporary = `${this.file}.${randomUUID()}.tmp`;
		try {
			const handle = await open(temporary, "wx", 0o600);
			try { await handle.writeFile(JSON.stringify(preferences, null, 2) + "\n"); await handle.sync(); }
			finally { await handle.close(); }
			await rename(temporary, this.file);
		} finally { await rm(temporary, { force: true }); }
	}

	async resolve(ctx: PiContext, config: SupervisorConfig, input: StartInput): Promise<StartInput> {
		const name = input.profile ?? config.defaultProfile;
		const profile = Object.hasOwn(config.profiles, name) ? config.profiles[name] : undefined;
		if (!profile?.modelArgs) return input;
		const chosen = input.model ?? (await this.load()).models[name];
		let model = chosen;
		if (model === undefined) {
			if (!ctx.model) throw new Error("No parent model is selected. Select a Pi model or choose one in /agent settings / --model.");
			if (profile.parentProviders && !profile.parentProviders.includes(ctx.model.provider)) throw new Error(`Profile ${name} cannot inherit provider ${ctx.model.provider}. Choose a compatible model with /agent settings or --model.`);
			model = modelName(profile, ctx.model.provider, ctx.model.id);
		}
		if (!validModel(model)) throw new Error("Invalid model selection");
		if ((profile.modelFormat ?? "qualified") === "qualified") {
			const available = availableModels(ctx, profile);
			if (!available.includes(model)) throw new Error(`Model ${JSON.stringify(model)} is not available in this Pi session's model scope. Choose another model; no fallback was applied.`);
		}
		return { ...input, model };
	}
}

function modelName(profile: LaunchProfile, provider: string, id: string): string {
	return profile.modelFormat === "id" ? id : `${provider}/${id}`;
}

export function availableModels(ctx: PiContext, profile: LaunchProfile): string[] {
	const registry = ctx.scopedModels?.length ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
	const models = registry.filter((model) => !profile.parentProviders || profile.parentProviders.includes(model.provider))
		.map((model) => modelName(profile, model.provider, model.id));
	// Bare-ID CLI profiles can also advertise CLI selectors (e.g. sonnet) that
	// are not Pi model IDs. Qualified profiles offer actual available models only.
	if (profile.modelFormat === "id") models.push(...Object.keys(profile.models ?? {}));
	return [...new Set(models)].sort();
}

export async function openModelSettings(ctx: PiContext, config: SupervisorConfig, settings: ModelSettings, openExtensions?: () => Promise<void>): Promise<void> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify("Model settings require TUI mode. Use an explicit --model override outside the TUI.", "warning");
		return;
	}
	for (;;) {
		const preferences = await settings.load();
		const profiles = Object.entries(config.profiles).filter(([, profile]) => profile.modelArgs);
		const hasExtensions = Boolean(openExtensions && Object.values(config.profiles).some((profile) => profile.extensionArgs));
		if (!profiles.length && !hasExtensions) { ctx.ui.notify("No profiles expose model or extension selection.", "info"); return; }
		const labels = profiles.map(([name, profile]) => {
			const inherited = ctx.model ? modelName(profile, ctx.model.provider, ctx.model.id) : "none selected";
			const incompatible = ctx.model && profile.parentProviders && !profile.parentProviders.includes(ctx.model.provider);
			return `${name} · ${preferences.models[name] ?? `Follow parent (${incompatible ? `incompatible provider: ${ctx.model?.provider}` : inherited})`}`;
		});
		if (hasExtensions) labels.push("Worker extension settings…");
		const selected = await ctx.ui.select("Agent settings · model per profile", labels);
		if (!selected) return;
		if (selected === "Worker extension settings…") { await openExtensions?.(); continue; }
		const entry = profiles[labels.indexOf(selected)];
		if (!entry) return;
		const [name, profile] = entry;
		const choices = ["Follow parent model", "Choose available model", "Enter exact model ID"];
		const choice = await ctx.ui.select(`${name} · ${preferences.models[name] ?? "Follow parent"}`, choices);
		if (choice === choices[0]) {
			await settings.set(name, undefined);
			ctx.ui.notify(`${name}: following the parent session model.`, "info");
		} else if (choice === choices[1] || choice === choices[2]) {
			const models = availableModels(ctx, profile);
			if (choice === choices[1] && models.length === 0) { ctx.ui.notify("No compatible available models. Enter an exact CLI model ID instead.", "warning"); continue; }
			const model = choice === choices[1] ? await ctx.ui.select("Choose model · next launches only", models)
				: await ctx.ui.input("Exact CLI model ID", preferences.models[name] ?? "");
			if (model === undefined) continue;
			try {
				const resolved = await settings.resolve(ctx, config, { task: "validate model selection", profile: name, model: model.trim() });
				resolveLaunchRecipe(config, resolved); // Validate argv/model syntax before persisting a choice.
				await settings.set(name, resolved.model);
				ctx.ui.notify(safeText(`${name}: ${resolved.model}. Applies to subsequent launches.`), "info");
			} catch (error) { ctx.ui.notify(safeText(error instanceof Error ? error.message : String(error)), "error"); }
		}
	}
}
