import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DefaultPackageManager, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PiContext } from "./pi-api.js";
import { parseExtensionSelection, parseExtensionSets, type ExtensionSelection, type ResolvedExtensions, type StartRecipeInput, type SupervisorConfig } from "./profiles.js";
import { safeText } from "./display.js";

export const WORKER_ENV = "PI_AGENT_SUPERVISOR_WORKER";
// Pi 1.5's documented CLI built-ins. The resolver applies the user's enable/disable filters.
const BUILTINS = ["mcp", "llama.cpp", "codemode", "tool-search"];
interface Preferences { profiles: Record<string, ExtensionSelection>; sets: Record<string, string[]> }
export interface ExtensionResource { path: string; enabled: boolean }
export type ExtensionPicker = (profile: string, current?: ExtensionSelection) => Promise<ExtensionSelection | undefined>;
const validName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && !["__proto__", "prototype", "constructor"].includes(name);

export function extensionLabel(selection: ExtensionSelection): string {
	return selection.mode === "custom" ? `custom · ${selection.set}` : selection.mode;
}

/** User-owned policy only: no project configuration, extension execution, or package installation. */
export class WorkerExtensions {
	readonly file: string;
	constructor(configDirectory: string) { this.file = join(configDirectory, "extensions.json"); }

	async load(): Promise<Preferences> {
		let text: string;
		try { text = await readFile(this.file, "utf8"); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {}, sets: {} }; throw error; }
		const raw = JSON.parse(text);
		if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => !["profiles", "sets"].includes(key)) || !raw.profiles || typeof raw.profiles !== "object" || Array.isArray(raw.profiles)) throw new Error(`Invalid worker extension settings: ${this.file}`);
		const profiles: Record<string, ExtensionSelection> = Object.create(null);
		for (const [name, value] of Object.entries(raw.profiles)) {
			if (!validName(name)) throw new Error("Invalid extension preference profile name");
			profiles[name] = parseExtensionSelection(value);
		}
		return { profiles, sets: parseExtensionSets(raw.sets ?? {}) };
	}

	private async save(preferences: Preferences): Promise<void> {
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

	async setProfile(name: string, selection?: ExtensionSelection): Promise<void> {
		if (!validName(name)) throw new Error("Invalid extension preference profile name");
		const preferences = await this.load();
		if (selection) preferences.profiles[name] = parseExtensionSelection(selection);
		else delete preferences.profiles[name];
		await this.save(preferences);
	}

	async set(name: string, paths: string[]): Promise<void> {
		const validated = parseExtensionSets({ [name]: paths });
		const preferences = await this.load();
		preferences.sets[name] = await this.validatePaths(validated[name]);
		await this.save(preferences);
	}

	async catalog(cwd: string, environment: NodeJS.ProcessEnv = process.env): Promise<ExtensionResource[]> {
		const agentDir = environment.PI_CODING_AGENT_DIR ?? getAgentDir();
		const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		if (settings.drainErrors().length) throw new Error("Cannot read Pi user settings; fix them before selecting worker extensions");
		const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings, builtinExtensions: BUILTINS });
		const resources = await manager.resolve(async () => "error");
		if (resources.installFailures?.length) throw new Error("A configured Pi user package is unavailable. Install/fix it explicitly; no worker package installation was attempted");
		return resources.extensions.filter((entry) => entry.metadata.scope === "user").map(({ path, enabled }) => ({ path, enabled }));
	}

	private async validatePaths(paths: readonly string[]): Promise<string[]> {
		const result: string[] = [];
		for (const path of paths) {
			if (/^builtin:[a-zA-Z0-9.-]+$/.test(path)) { result.push(path); continue; }
			try {
				const canonical = await realpath(path);
				if (!(await stat(canonical)).isFile() || !/\.[cm]?[jt]s$/.test(canonical)) throw new Error();
				result.push(canonical);
			} catch { throw new Error(`Worker extension is missing or is not a local JS/TS entry file: ${safeText(path)}`); }
		}
		return [...new Set(result)];
	}

	async resolve(config: SupervisorConfig, input: StartRecipeInput, cwd: string, environment: NodeJS.ProcessEnv, pinned?: ResolvedExtensions): Promise<ResolvedExtensions | undefined> {
		const name = input.profile ?? config.defaultProfile;
		const profile = config.profiles[name];
		if (!profile?.extensionArgs) {
			if (input.extensions !== undefined || input.extensionSet !== undefined || pinned) throw new Error(`Profile ${name} does not declare extension selection support; keep its existing argv or add {extensionArgs}`);
			return undefined;
		}
		if (pinned) {
			const selection = parseExtensionSelection({ mode: pinned.mode, ...(pinned.set ? { set: pinned.set } : {}) });
			return { ...selection, paths: await this.validatePaths(pinned.paths) };
		}
		const preferences = await this.load();
		const fallback = preferences.profiles[name] ?? profile.extensions ?? { mode: "none" as const };
		if (input.extensionSet !== undefined && input.extensions !== "custom") throw new Error("--extension-set requires --extensions custom");
		const selection = input.extensions === undefined ? fallback : parseExtensionSelection({ mode: input.extensions, ...(input.extensions === "custom" ? { set: input.extensionSet ?? fallback.set } : {}) });
		if (selection.mode === "none") return { ...selection, paths: [] };
		let paths: string[];
		if (selection.mode === "inherit") paths = (await this.catalog(cwd, environment)).filter((entry) => entry.enabled).map((entry) => entry.path);
		else {
			const sets = { ...config.extensionSets, ...preferences.sets };
			if (!Object.hasOwn(sets, selection.set!)) throw new Error(`Unknown worker extension set ${JSON.stringify(selection.set)}; define it in trusted user settings or /agent extensions`);
			paths = sets[selection.set!];
		}
		return { ...selection, paths: await this.validatePaths(paths) };
	}

	async choose(ctx: PiContext, config: SupervisorConfig, profile: string, current?: ExtensionSelection): Promise<ExtensionSelection | undefined> {
		if (ctx.mode !== "tui") throw new Error("Worker extension selection requires TUI mode; use explicit run flags otherwise");
		if (!config.profiles[profile]?.extensionArgs) throw new Error(`Profile ${profile} does not declare extension selection support`);
		const mode = await ctx.ui.select(`Worker extensions · ${profile}${current ? ` · ${extensionLabel(current)}` : ""}`, ["None", "Inherit user extensions", "Custom set"]);
		if (mode === "None") return { mode: "none" };
		if (mode === "Inherit user extensions") return { mode: "inherit" };
		if (mode !== "Custom set") return;
		const sets = { ...config.extensionSets, ...(await this.load()).sets };
		const names = Object.keys(sets).sort();
		if (!names.length) { ctx.ui.notify("No extension sets yet. Create one in /agent extensions.", "warning"); return; }
		const selected = await ctx.ui.select("Choose approved extension set", names);
		if (selected && Object.hasOwn(sets, selected)) return { mode: "custom", set: selected };
	}

	private async editSet(ctx: PiContext, config: SupervisorConfig, name: string): Promise<void> {
		if (!validName(name)) throw new Error("Use a short extension-set name containing letters, digits, '.', '_' or '-'");
		if (Object.hasOwn(config.extensionSets ?? {}, name)) throw new Error("This set is declared in profiles.json; edit it there or choose a new name");
		const preferences = await this.load();
		const selected = new Set(preferences.sets[name] ?? []);
		const resources = await this.catalog(ctx.cwd);
		const paths = [...new Set([...resources.map((entry) => entry.path), ...selected])];
		for (;;) {
			const labels = paths.map((path) => safeText(`${selected.has(path) ? "[x]" : "[ ]"} ${path}`));
			const choice = await ctx.ui.select(`Extension set · ${name} · ${selected.size} selected`, ["Save selection", ...labels, "Cancel"]);
			if (!choice || choice === "Cancel") return;
			if (choice === "Save selection") {
				if (!selected.size) { ctx.ui.notify("Select at least one extension; use None for an empty selection.", "warning"); continue; }
				await this.set(name, [...selected]);
				ctx.ui.notify(`Saved extension set ${name}; ${selected.size} selected. Applies to subsequent launches.`, "info");
				return;
			}
			const path = paths[labels.indexOf(choice)];
			if (path) { if (selected.has(path)) selected.delete(path); else selected.add(path); }
		}
	}

	async openSettings(ctx: PiContext, config: SupervisorConfig): Promise<void> {
		if (ctx.mode !== "tui") { if (ctx.hasUI) ctx.ui.notify("Worker extension settings require TUI mode. Use --extensions and --extension-set for a launch.", "warning"); return; }
		for (;;) {
			const preferences = await this.load();
			const profiles = Object.entries(config.profiles).filter(([, profile]) => profile.extensionArgs);
			const labels = profiles.map(([name, profile]) => `${name} · ${extensionLabel(preferences.profiles[name] ?? profile.extensions ?? { mode: "none" })}`);
			const choice = await ctx.ui.select("Worker extension settings · next launches only", [...labels, "Create/edit extension set"]);
			if (!choice) return;
			try {
				if (choice === "Create/edit extension set") {
					const name = await ctx.ui.input("Extension set name", "durable");
					if (name !== undefined) await this.editSet(ctx, config, name.trim());
					continue;
				}
				const entry = profiles[labels.indexOf(choice)];
				if (!entry) return;
				const [name, profile] = entry;
				const action = await ctx.ui.select(`${name} · extension default`, ["Choose mode", "Follow profile default"]);
				if (action === "Follow profile default") await this.setProfile(name);
				else if (action === "Choose mode") {
					const selection = await this.choose(ctx, config, name, preferences.profiles[name] ?? profile.extensions);
					if (selection) await this.setProfile(name, selection);
				}
			} catch (error) { ctx.ui.notify(safeText(error instanceof Error ? error.message : String(error)), "error"); }
		}
	}
}
