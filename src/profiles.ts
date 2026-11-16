import { isAbsolute } from "node:path";
import type { OutputProtocol } from "./presentation.js";

export type ExtensionMode = "none" | "inherit" | "custom";
export interface ExtensionSelection { mode: ExtensionMode; set?: string }
export interface ResolvedExtensions extends ExtensionSelection { paths: string[] }
export interface ExtensionArguments { none: string[]; load: string[] }

export type TaskTransport = "stdin" | "argument" | "pi-rpc";

export interface ModelProfile {
	efforts?: Record<string, string>;
	defaultEffort?: string;
}

export interface LaunchProfile {
	outputProtocol?: OutputProtocol;
	executable: string;
	args: string[];
	taskTransport: TaskTransport;
	environment?: Record<string, string>;
	models?: Record<string, ModelProfile>;
	/** Optional argument groups; slots in args preserve CLI argument ordering. */
	modelArgs?: string[];
	effortArgs?: string[];
	modelFormat?: "qualified" | "id";
	parentProviders?: string[];
	defaultEffort?: string;
	/** Explicit capability: a whole {extensionArgs} slot, never executable-name detection. */
	extensionArgs?: ExtensionArguments;
	extensions?: ExtensionSelection;
}

export interface SupervisorConfig {
	defaultProfile: string;
	profiles: Record<string, LaunchProfile>;
	extensionSets?: Record<string, string[]>;
}

export interface StartRecipeInput {
	task: string;
	profile?: string;
	model?: string;
	effort?: string;
	extensions?: ExtensionMode;
	extensionSet?: string;
}

export interface LaunchRecipe {
	profile: string;
	executable: string;
	args: string[];
	environment: Record<string, string>;
	taskTransport: TaskTransport;
	stdin?: string;
	model?: string;
	effort?: string;
	effortAlias?: string;
}

const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDERS = new Set(["task", "modelArgs", "effortArgs", "extensionArgs", "session"]);
const SHELL_EXPANSION = /\$\(|\$\{|`|\$[A-Za-z_]/;

export class ProfileConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProfileConfigurationError";
	}
}

function fail(path: string, message: string): never {
	throw new ProfileConfigurationError(`${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: string[], path: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) fail(path, `unknown property ${JSON.stringify(key)}`);
	}
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) fail(path, "expected an object");
	return value;
}

function requireName(value: unknown, path: string): string {
	if (typeof value !== "string" || !PROFILE_NAME.test(value) || ["__proto__", "prototype", "constructor"].includes(value)) {
		fail(path, "expected a safe name containing only letters, digits, '.', '_' or '-'");
	}
	return value;
}

function requireText(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
		fail(path, "expected a nonempty string without NUL characters");
	}
	return value;
}

function requireModelId(value: unknown, path: string): string {
	const modelId = requireText(value, path);
	rejectShellExpansion(modelId, path);
	return modelId;
}

function rejectShellExpansion(value: string, path: string): void {
	if (SHELL_EXPANSION.test(value)) {
		fail(path, "shell expansion is not supported; use literal argv values and placeholders");
	}
}

function parseStringMap(value: unknown, path: string, keyPattern: RegExp = PROFILE_NAME): Record<string, string> {
	const record = requireRecord(value, path);
	const result = Object.create(null) as Record<string, string>;
	for (const [key, raw] of Object.entries(record)) {
		if (!keyPattern.test(key)) fail(`${path}.${key}`, "invalid key");
		result[key] = requireText(raw, `${path}.${key}`);
		rejectShellExpansion(result[key], `${path}.${key}`);
	}
	return result;
}

function parseModelProfile(value: unknown, path: string): ModelProfile {
	const record = requireRecord(value, path);
	assertOnlyKeys(record, ["efforts", "defaultEffort"], path);
	const efforts = record.efforts === undefined ? undefined : parseStringMap(record.efforts, `${path}.efforts`);
	if (efforts && Object.keys(efforts).length === 0) fail(`${path}.efforts`, "must contain at least one effort alias");
	const defaultEffort = record.defaultEffort === undefined ? undefined : requireName(record.defaultEffort, `${path}.defaultEffort`);
	if (defaultEffort && !efforts?.[defaultEffort]) {
		fail(`${path}.defaultEffort`, `does not name a configured effort${efforts ? "" : " (efforts is missing)"}`);
	}
	return { ...(efforts ? { efforts } : {}), ...(defaultEffort ? { defaultEffort } : {}) };
}

function parseArgumentGroup(value: unknown, name: "model" | "effort", path: string): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.length === 0) fail(path, "expected a nonempty argv array");
	let count = 0;
	const args = value.map((value, index) => {
		const arg = requireText(value, `${path}[${index}]`);
		rejectShellExpansion(arg, `${path}[${index}]`);
		const slots = [...arg.matchAll(/\{([^{}]+)\}/g)];
		if (slots.some((slot) => slot[1] !== name) || /[{}]/.test(arg.replaceAll(`{${name}}`, ""))) fail(path, `only {${name}} placeholders are allowed in this group`);
		count += slots.length;
		return arg;
	});
	if (count !== 1) fail(path, `requires exactly one {${name}} placeholder`);
	return args;
}

export function parseExtensionSelection(value: unknown, path = "extensions"): ExtensionSelection {
	const record = requireRecord(value, path);
	assertOnlyKeys(record, ["mode", "set"], path);
	if (!["none", "inherit", "custom"].includes(String(record.mode))) fail(path, "mode must be none, inherit, or custom");
	const set = record.set === undefined ? undefined : requireName(record.set, `${path}.set`);
	if ((record.mode === "custom") !== (set !== undefined)) fail(path, "custom mode requires a set; other modes forbid it");
	return { mode: record.mode as ExtensionMode, ...(set ? { set } : {}) };
}

export function parseExtensionSets(value: unknown, path = "extensionSets"): Record<string, string[]> {
	const sets: Record<string, string[]> = Object.create(null);
	for (const [name, entries] of Object.entries(requireRecord(value, path))) {
		requireName(name, `${path}.${name}`);
		if (!Array.isArray(entries) || !entries.length) fail(`${path}.${name}`, "expected a nonempty array of local extension files or builtin IDs");
		sets[name] = [...new Set(entries.map((entry, index) => {
			const text = requireText(entry, `${path}.${name}[${index}]`);
			if (/[\x00-\x1f\x7f-\x9f]/.test(text) || (!isAbsolute(text) && !/^builtin:[a-zA-Z0-9.-]+$/.test(text))) fail(`${path}.${name}`, "use absolute local entry files or builtin:<name>; remote sources and relative paths are not allowed");
			return text;
		}))];
	}
	return sets;
}

function parseExtensionArguments(value: unknown, path: string): ExtensionArguments | undefined {
	if (value === undefined) return undefined;
	const record = requireRecord(value, path);
	assertOnlyKeys(record, ["none", "load"], path);
	const group = (key: "none" | "load") => {
		const raw = record[key];
		if (!Array.isArray(raw) || !raw.length) fail(`${path}.${key}`, "expected a nonempty argv array");
		const args = raw.map((arg, index) => {
			const text = requireText(arg, `${path}.${key}[${index}]`);
			rejectShellExpansion(text, path);
			if (/[{}]/.test(text) && !(key === "load" && text === "{extension}")) fail(path, "only a whole {extension} slot is allowed in load");
			return text;
		});
		if (args.filter((arg) => arg === "{extension}").length !== (key === "load" ? 1 : 0)) fail(path, "load requires exactly one whole {extension} slot");
		return args;
	};
	return { none: group("none"), load: group("load") };
}

function parseProfile(value: unknown, path: string): LaunchProfile {
	const record = requireRecord(value, path);
	assertOnlyKeys(record, ["executable", "args", "taskTransport", "environment", "models", "defaultEffort", "outputProtocol", "modelArgs", "effortArgs", "modelFormat", "parentProviders", "extensionArgs", "extensions"], path);
	if (record.outputProtocol !== undefined && (typeof record.outputProtocol !== "string" || !["raw", "text", "pi-jsonl", "codex-jsonl"].includes(record.outputProtocol))) {
		fail(`${path}.outputProtocol`, "expected raw, text, pi-jsonl, or codex-jsonl");
	}

	const extensionArgs = parseExtensionArguments(record.extensionArgs, `${path}.extensionArgs`);
	const extensions = record.extensions === undefined ? undefined : parseExtensionSelection(record.extensions, `${path}.extensions`);
	if (extensions && !extensionArgs) fail(path, "extensions requires an extensionArgs capability");
	const modelArgs = parseArgumentGroup(record.modelArgs, "model", `${path}.modelArgs`);
	const effortArgs = parseArgumentGroup(record.effortArgs, "effort", `${path}.effortArgs`);
	if (record.modelFormat !== undefined && record.modelFormat !== "qualified" && record.modelFormat !== "id") fail(`${path}.modelFormat`, "expected qualified or id");
	let parentProviders: string[] | undefined;
	if (record.parentProviders !== undefined) {
		if (!Array.isArray(record.parentProviders) || record.parentProviders.length === 0) fail(`${path}.parentProviders`, "expected a nonempty provider array");
		parentProviders = record.parentProviders.map((provider, index) => requireName(provider, `${path}.parentProviders[${index}]`));
	}
	const executable = requireText(record.executable, `${path}.executable`);
	rejectShellExpansion(executable, `${path}.executable`);
	const transport = record.taskTransport;
	if (transport !== "stdin" && transport !== "argument" && transport !== "pi-rpc") {
		fail(`${path}.taskTransport`, 'expected "stdin" or "argument" or "pi-rpc"');
	}
	if (!Array.isArray(record.args)) fail(`${path}.args`, "expected an array of argv strings");
	const args = record.args.map((arg, index) => {
		const parsed = requireText(arg, `${path}.args[${index}]`);
		rejectShellExpansion(parsed, `${path}.args[${index}]`);
		const matches = [...parsed.matchAll(/\{([^{}]+)\}/g)];
		const remainder = parsed.replace(/\{[^{}]+\}/g, "");
		if ((parsed.includes("{") || parsed.includes("}")) && /[{}]/.test(remainder)) {
			fail(`${path}.args[${index}]`, "malformed placeholder");
		}
		if (matches.length > 1) fail(`${path}.args[${index}]`, "only one placeholder is allowed per argv element");
		if (matches.length === 1 && !PLACEHOLDERS.has(matches[0][1])) {
			fail(`${path}.args[${index}]`, `unknown placeholder {${matches[0][1]}}`);
		}
		if (["modelArgs", "effortArgs", "extensionArgs", "session"].includes(matches[0]?.[1]) && parsed !== `{${matches[0][1]}}`) fail(`${path}.args[${index}]`, "argument-group slots must occupy an entire argv element");
		if (matches[0]?.[1] === "task" && parsed !== "{task}") {
			fail(`${path}.args[${index}]`, 'the "{task}" placeholder must occupy an entire argv element');
		}
		return parsed;
	});

	const count = (placeholder: string) => args.reduce((total, arg) => total + [...arg.matchAll(new RegExp(`\\{${placeholder}\\}`, "g"))].length, 0);
	for (const [name, group] of [["model", modelArgs], ["effort", effortArgs]] as const) {
		if (count(`${name}Args`) !== (group ? 1 : 0)) fail(`${path}.args`, `${name}Args requires exactly one matching group slot`);
	}
	if (count("extensionArgs") !== (extensionArgs ? 1 : 0)) fail(`${path}.args`, "extensionArgs requires exactly one matching group slot");
	if (extensionArgs) {
		const managedFlags = ["--no-extensions", "-ne", "--extension", "-e", ...extensionArgs.none, ...extensionArgs.load].filter((arg) => arg.startsWith("-") && arg !== "--");
		if ([...args, ...(modelArgs ?? []), ...(effortArgs ?? [])].some((arg) => managedFlags.some((flag) => arg === flag || arg.startsWith(`${flag}=`)))) fail(`${path}.args`, "extension flags must be supplied only through {extensionArgs}");
	}
	const taskCount = count("task");
	if (transport === "argument" && taskCount !== 1) {
		fail(`${path}.args`, 'argument task transport requires exactly one whole-argument "{task}" placeholder');
	}
	if (transport !== "argument" && taskCount !== 0) {
		fail(`${path}.args`, 'stdin/RPC task transport must not include a "{task}" placeholder');
	}
	if (count("session") !== (transport === "pi-rpc" ? 1 : 0)) fail(`${path}.args`, "pi-rpc requires exactly one whole-argument {session}; other transports forbid it");
	if (transport === "pi-rpc" && record.outputProtocol !== "pi-jsonl") fail(`${path}.outputProtocol`, "pi-rpc requires pi-jsonl output");

	let models: Record<string, ModelProfile> | undefined;
	if (record.models !== undefined) {
		models = Object.create(null) as Record<string, ModelProfile>;
		for (const [modelId, model] of Object.entries(requireRecord(record.models, `${path}.models`))) {
			requireModelId(modelId, `${path}.models.${modelId}`);
			models[modelId] = parseModelProfile(model, `${path}.models.${modelId}`);
		}
	}
	const defaultEffort = record.defaultEffort === undefined ? undefined : requireName(record.defaultEffort, `${path}.defaultEffort`);
	const environment = record.environment === undefined ? undefined : parseStringMap(record.environment, `${path}.environment`, ENVIRONMENT_NAME);

	if (models && Object.keys(models).length === 0) fail(`${path}.models`, "must contain at least one model ID");
	if (models && !modelArgs) fail(`${path}.modelArgs`, "models require a model argument group");

	const hasEffortMappings = Boolean(defaultEffort) || Object.values(models ?? {}).some((model) => Boolean(model.efforts));
	if (hasEffortMappings && !effortArgs) fail(`${path}.effortArgs`, "configured efforts require an effort argument group");
	if (defaultEffort && !models) fail(`${path}.defaultEffort`, "requires configured models");
	if (defaultEffort) {
		for (const [modelId, model] of Object.entries(models ?? {})) {
			if (!model.defaultEffort && !model.efforts?.[defaultEffort]) {
				fail(`${path}.defaultEffort`, `fallback effort ${JSON.stringify(defaultEffort)} is not configured for model ${JSON.stringify(modelId)}`);
			}
		}
	}

	return {
		...(extensionArgs ? { extensionArgs } : {}),
		...(extensions ? { extensions } : {}),
		...(record.outputProtocol !== undefined ? { outputProtocol: record.outputProtocol as OutputProtocol } : {}),
		executable,
		args,
		taskTransport: transport,
		...(modelArgs ? { modelArgs } : {}),
		...(effortArgs ? { effortArgs } : {}),
		...(record.modelFormat ? { modelFormat: record.modelFormat as "qualified" | "id" } : {}),
		...(parentProviders ? { parentProviders } : {}),
		...(environment ? { environment } : {}),
		...(models ? { models } : {}),
		...(defaultEffort ? { defaultEffort } : {}),
	};
}

/** User overrides may omit top-level defaults; each supplied profile replaces the whole entry. */
export function parseSupervisorConfig(value: unknown, defaults?: SupervisorConfig): SupervisorConfig {
	const record = requireRecord(value, "config");
	assertOnlyKeys(record, ["defaultProfile", "profiles", "extensionSets"], "config");
	const defaultProfile = requireName(record.defaultProfile === undefined ? defaults?.defaultProfile : record.defaultProfile, "config.defaultProfile");
	const rawProfiles = requireRecord(record.profiles === undefined && defaults ? {} : record.profiles, "config.profiles");
	const profiles = Object.assign(Object.create(null) as Record<string, LaunchProfile>, defaults?.profiles);
	for (const [name, profile] of Object.entries(rawProfiles)) {
		requireName(name, `config.profiles.${name}`);
		profiles[name] = parseProfile(profile, `config.profiles.${name}`);
	}
	if (Object.keys(profiles).length === 0) fail("config.profiles", "must contain at least one profile");
	if (!profiles[defaultProfile]) fail("config.defaultProfile", `unknown profile ${JSON.stringify(defaultProfile)}`);
	const extensionSets = { ...defaults?.extensionSets, ...(record.extensionSets === undefined ? {} : parseExtensionSets(record.extensionSets)) };
	return { defaultProfile, profiles, ...(Object.keys(extensionSets).length ? { extensionSets } : {}) };
}

export function resolveLaunchRecipe(config: SupervisorConfig, input: StartRecipeInput, sessionPath = "{session}", extensionPaths: readonly string[] = []): LaunchRecipe {
	if (typeof input.task !== "string" || input.task.trim().length === 0 || input.task.includes("\0")) {
		throw new ProfileConfigurationError("task: expected nonempty text without NUL characters");
	}
	const profileName = input.profile ?? config.defaultProfile;
	const profile = Object.hasOwn(config.profiles, profileName) ? config.profiles[profileName] : undefined;
	if (!profile) throw new ProfileConfigurationError(`profile: unknown profile ${JSON.stringify(profileName)}`);

	if (!profile.extensionArgs && (input.extensions !== undefined || input.extensionSet !== undefined)) throw new ProfileConfigurationError(`extensions: profile ${JSON.stringify(profileName)} does not declare extension selection support`);
	if (input.extensions !== undefined && !["none", "inherit", "custom"].includes(input.extensions)) throw new ProfileConfigurationError("extensions: expected none, inherit, or custom");
	if (input.extensionSet !== undefined) {
		requireName(input.extensionSet, "extensionSet");
		if (input.extensions !== "custom") throw new ProfileConfigurationError("extensionSet requires explicit custom mode");
	}

	let modelId: string | undefined;
	let modelProfile: ModelProfile | undefined;
	if (profile.modelArgs) {
		if (!input.model) throw new ProfileConfigurationError("model: select a model or inherit one from the parent session");
		modelId = requireModelId(input.model, "model");
		modelProfile = profile.models && Object.hasOwn(profile.models, modelId) ? profile.models[modelId] : undefined;
	} else if (input.model !== undefined) {
		throw new ProfileConfigurationError(`model: profile ${JSON.stringify(profileName)} does not support model selection`);
	}

	let effortAlias: string | undefined;
	let effortValue: string | undefined;
	if (input.effort !== undefined) {
		if (!modelProfile?.efforts?.[input.effort]) {
			throw new ProfileConfigurationError(`effort: profile ${JSON.stringify(profileName)} does not support ${JSON.stringify(input.effort)} for model ${JSON.stringify(modelId ?? "(none)")}`);
		}
		effortAlias = input.effort;
	} else {
		effortAlias = modelProfile?.defaultEffort ?? profile.defaultEffort;
	}
	if (effortAlias) {
		effortValue = modelProfile?.efforts?.[effortAlias];
		if (!effortValue) {
			throw new ProfileConfigurationError(`effort: ${JSON.stringify(effortAlias)} is not configured for model ${JSON.stringify(modelId ?? "(none)")}`);
		}
	} else if (input.effort !== undefined) {
		throw new ProfileConfigurationError(`effort: profile ${JSON.stringify(profileName)} does not support effort selection`);
	}

	const replacements: Record<string, string> = { task: input.task, session: sessionPath };
	if (modelId !== undefined) replacements.model = modelId;
	if (effortValue !== undefined) replacements.effort = effortValue;
	const substitute = (arg: string) => arg.replace(/\{(task|model|effort|session)\}/g, (_placeholder, name: string) => {
		const replacement = replacements[name];
		if (replacement === undefined) {
			throw new ProfileConfigurationError(`profile: placeholder {${name}} has no value for this launch`);
		}
		return replacement;
	});
	const args = profile.args.flatMap((arg) => {
		if (arg === "{extensionArgs}") return [...profile.extensionArgs!.none, ...extensionPaths.flatMap((path) => profile.extensionArgs!.load.map((value) => value === "{extension}" ? path : value))];
		if (arg === "{modelArgs}") return profile.modelArgs!.map(substitute);
		if (arg === "{effortArgs}") return effortValue === undefined ? [] : profile.effortArgs!.map(substitute);
		return [substitute(arg)];
	});

	return {
		profile: profileName,
		executable: profile.executable,
		args,
		environment: { ...(profile.environment ?? {}) },
		taskTransport: profile.taskTransport,
		...(profile.taskTransport === "stdin" ? { stdin: input.task } : {}),
		...(modelId !== undefined ? { model: modelId } : {}),
		...(effortValue !== undefined ? { effort: effortValue, effortAlias } : {}),
	};
}
