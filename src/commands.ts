import type { PiCommandContext, PiExtensionApi, PiContext } from "./pi-api.js";
import type { Supervisor, StartInput } from "./supervisor.js";
import type { ExtensionSelection, SupervisorConfig } from "./profiles.js";
import { extensionLabel, type ExtensionPicker } from "./worker-extensions.js";
import type { RunView } from "./run-store.js";
import { openAgentBrowser } from "./ui.js";
import { bundleLines, safeText } from "./display.js";
import type { WorktreeRepoInput } from "./worktrees.js";

export interface AgentCommandDependencies {
	getSupervisor(ctx: PiContext): Promise<Supervisor>;
	getConfig(ctx: PiContext): Promise<SupervisorConfig>;
	resolveStart?(ctx: PiContext, input: StartInput): Promise<StartInput>;
	openSettings?(ctx: PiContext): Promise<void>;
	openExtensions?(ctx: PiContext): Promise<void>;
	chooseExtensions?(ctx: PiContext, profile: string, current?: ExtensionSelection): ReturnType<ExtensionPicker>;
}

export interface ParsedRunCommand {
	task: string;
	options: Omit<StartInput, "task">;
}

const SUBCOMMANDS = ["run", "list", "show", "stop", "profiles", "settings", "config", "extensions", "worktree"] as const;
const COMMAND_USAGE = "Usage: /agent [run [--label name] [--profile name] [--model model-id] [--effort alias] [--extensions none|inherit|custom] [--extension-set name] [--cwd path | --repo path=ref ...] [--isolation shared|worktree] [--timeout-ms n] -- <task> | list | show <id> | stop <id> | profiles | settings | extensions | worktree remove <id>]";

function skipWhitespace(input: string, index: number): number {
	while (index < input.length && /\s/.test(input[index])) index++;
	return index;
}

function readToken(input: string, start: number): { value: string; next: number } {
	let value = "";
	let quote: "'" | '"' | undefined;
	let index = start;
	for (; index < input.length; index++) {
		const char = input[index];
		if (quote) {
			if (char === quote) quote = undefined;
			else if (char === "\\" && index + 1 < input.length) value += input[++index];
			else value += char;
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (/\s/.test(char)) {
			break;
		} else {
			value += char;
		}
	}
	if (quote) throw new Error("Unclosed quote in command option");
	return { value, next: index };
}

export function parseRunCommandArgs(rawArgs: string): ParsedRunCommand {
	const input = rawArgs;
	let cursor = skipWhitespace(input, 0);
	const options: ParsedRunCommand["options"] = {};
	const repos: WorktreeRepoInput[] = [];
	const seen = new Set<string>();
	const optionMap = new Map<string, keyof ParsedRunCommand["options"]>([
		["--label", "label"],
		["--profile", "profile"],
		["--model", "model"],
		["--effort", "effort"],
		["--extensions", "extensions"],
		["--extension-set", "extensionSet"],
		["--cwd", "cwd"],
		["--repo", "repos"],
		["--isolation", "isolation"],
		["--timeout-ms", "timeoutMs"],
	]);

	while (cursor < input.length) {
		const token = readToken(input, cursor);
		if (token.value === "--") {
			cursor = token.next;
			if (cursor < input.length && /\s/.test(input[cursor])) cursor++;
			const task = input.slice(cursor);
			if (!task.trim()) throw new Error("A nonempty task is required");
			return { task, options };
		}
		if (!token.value.startsWith("--")) break;
		const equals = token.value.indexOf("=");
		const flag = equals >= 0 ? token.value.slice(0, equals) : token.value;
		const option = optionMap.get(flag);
		if (!option) throw new Error(`Unknown run option ${JSON.stringify(flag)}`);
		if (option !== "repos" && seen.has(flag)) throw new Error(`Run option ${flag} may only be used once`);
		seen.add(flag);
		let value: string;
		if (equals >= 0) {
			value = token.value.slice(equals + 1);
			cursor = token.next;
		} else {
			cursor = skipWhitespace(input, token.next);
			if (cursor >= input.length) throw new Error(`Run option ${flag} requires a value`);
			const valueToken = readToken(input, cursor);
			value = valueToken.value;
			cursor = valueToken.next;
		}
		if (!value) throw new Error(`Run option ${flag} requires a nonempty value`);
		if (option === "repos") {
			const separator = value.lastIndexOf("=");
			if (separator <= 0 || separator === value.length - 1) throw new Error("--repo requires path=ref (repeat for each repository)");
			repos.push({ path: value.slice(0, separator), ref: value.slice(separator + 1) });
			options.repos = repos;
		} else if (option === "timeoutMs") {
			const timeoutMs = Number(value);
			if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer");
			options.timeoutMs = timeoutMs;
		} else if (option === "extensions") {
			if (value !== "none" && value !== "inherit" && value !== "custom") throw new Error("--extensions must be none, inherit, or custom");
			options.extensions = value;
		} else if (option === "isolation") {
			if (value !== "shared" && value !== "worktree") throw new Error("--isolation must be shared or worktree");
			options.isolation = value;
		} else {
			options[option] = value;
		}
		cursor = skipWhitespace(input, cursor);
	}

	const task = input.slice(cursor).trimStart();
	if (!task.trim()) throw new Error("A nonempty task is required");
	return { task, options };
}

function notify(ctx: PiContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) ctx.ui.notify(safeText(message), type);
}

function oneLine(value: string, maxChars = 100): string {
	const normalized = value.replace(/\s+/g, " ");
	return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function elapsed(run: RunView, now = Date.now()): string {
	const start = Date.parse(run.startedAt ?? run.createdAt);
	const end = run.endedAt ? Date.parse(run.endedAt) : now;
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "unknown";
	const seconds = Math.floor((end - start) / 1000);
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function runLabel(run: RunView, maxTaskChars: number): string {
	const model = run.model ? ` ${run.model}${run.effortAlias ? `/${run.effortAlias}` : ""}` : "";
	return `${run.id}  ${run.state}  ${run.profile}${model}  ${elapsed(run)}  ${oneLine(run.label ?? run.task, maxTaskChars)}${run.worktreeBundle ? ` · ${run.worktreeBundle.members.length} worktrees` : run.isolation === "worktree" ? " · worktree" : ""}${run.queueReason ? ` · ${run.queueReason}` : ""}`;
}

function listText(runs: RunView[]): string {
	if (runs.length === 0) return "No supervised runs in this Pi session.";
	return runs.map((run) => runLabel(run, 88)).join("\n");
}

function detailText(run: RunView): string {
	const lines = [
		`Run ${run.id} — ${run.state}`,
		`Profile: ${run.profile}${run.model ? ` · Model: ${run.model}` : ""}${run.effort ? ` · Effort: ${run.effortAlias ?? run.effort}` : ""}`,
		`Elapsed: ${elapsed(run)}${run.startedAt ? ` · Started: ${run.startedAt}` : ""}${run.endedAt ? ` · Ended: ${run.endedAt}` : ""}`,
		`Working directory: ${run.cwd}`,
		`Isolation: ${run.worktreeBundle ? "worktree bundle" : run.isolation === "worktree" ? "separate worktree" : "shared · concurrent writes; no conflict prevention"}`,
		`Task: ${oneLine(run.task, 700)}`,
	];
	if (run.extensions) lines.push(`Extensions: ${extensionLabel(run.extensions)} · ${run.extensions.paths.length} selected`);
	if (run.worktree) lines.push(`Worktree: ${run.worktree.path} (${run.worktree.state})`, `Branch: ${run.worktree.branch}`, `Source: ${run.worktree.sourceCwd} · Base: ${run.worktree.baseCommit}`, run.worktree.note);
	if (run.worktreeBundle) lines.push(...bundleLines(run.worktreeBundle));
	if (run.exitCode !== undefined) lines.push(`Exit code: ${run.exitCode}`);
	if (run.signal) lines.push(`Signal: ${run.signal}`);
	if (run.error) lines.push(`Process note: ${run.error.message}`);
	lines.push(`Parent: main · session ${run.sessionId}`);
	if (run.queueReason) lines.push(`Queued: ${run.queueReason}`);
	if (run.presentation?.protocolWarning) lines.push(`Protocol note: ${run.presentation.protocolWarning}`);
	lines.push(`\nFinal answer:\n${run.presentation?.finalAnswer ?? "No final answer extracted. Inspect diagnostics if needed."}`);
	lines.push(`\nRaw bounded log: ${run.logPath}`);
	if (run.logTruncated) lines.push("Earlier output was truncated.");
	return lines.join("\n");
}

async function showRunList(ctx: PiContext, supervisor: Supervisor): Promise<void> {
	const runs = await supervisor.list(20);
	notify(ctx, listText(runs));
}

async function showRunDetails(ctx: PiCommandContext, supervisor: Supervisor, id: string, picker?: ExtensionPicker): Promise<void> {
	if (ctx.mode === "tui") { supervisor.inspect(id); await openAgentBrowser(ctx, supervisor, id, picker); return; }
	const run = await supervisor.get(id);
	notify(ctx, detailText(run));
}

async function openPicker(ctx: PiCommandContext, supervisor: Supervisor, picker?: ExtensionPicker): Promise<void> {
	await openAgentBrowser(ctx, supervisor, undefined, picker);
}

export function registerAgentCommands(pi: PiExtensionApi, dependencies: AgentCommandDependencies): void {
	pi.registerCommand("agent", {
		description: "Start and inspect concurrent shared-folder agents or isolated worktree runs",
		getArgumentCompletions: (prefix) => {
			const choices = SUBCOMMANDS.filter((subcommand) => subcommand.startsWith(prefix));
			return choices.length ? choices.map((value) => ({ value, label: value })) : null;
		},
		handler: async (rawArgs, ctx) => {
			const picker: ExtensionPicker | undefined = dependencies.chooseExtensions ? (profile, current) => dependencies.chooseExtensions!(ctx, profile, current) : undefined;
			const trimmed = rawArgs.trim();
			if (!trimmed) {
				try {
					await openPicker(ctx, await dependencies.getSupervisor(ctx), picker);
				} catch (error) {
					if (!ctx.hasUI) throw error;
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			const commandToken = readToken(trimmed, 0);
			const subcommand = commandToken.value;
			const args = trimmed.slice(commandToken.next).trimStart();
			try {
				const supervisor = await dependencies.getSupervisor(ctx);
				switch (subcommand) {
					case "run": {
						const parsed = parseRunCommandArgs(args);
						const input = { task: parsed.task, ...parsed.options };
						const started = await supervisor.start(dependencies.resolveStart ? await dependencies.resolveStart(ctx, input) : input);
						const run = supervisor.inspect(started.id);
						const workspace = run.worktreeBundle ? `Worktree bundle: ${run.worktreeBundle.path}\n${run.worktreeBundle.members.length} checkouts; use /agent show ${run.id} for paths and bases.`
							: run.worktree ? `Worktree: ${run.worktree.path}\nBranch: ${run.worktree.branch}\n${run.worktree.note}`
								: "Shared folder: concurrent writes allowed; overlapping edits can overwrite each other.";
						notify(ctx, `Started agent run ${started.id} (${started.state}). Process exit is not a task-quality judgment.\n${workspace}`);
						return;
					}
					case "list":
						await showRunList(ctx, supervisor);
						return;
					case "show": {
						if (!args) throw new Error("Usage: /agent show <run-id>");
						await showRunDetails(ctx, supervisor, readToken(args, 0).value, picker);
						return;
					}
					case "stop": {
						if (!args) throw new Error("Usage: /agent stop <run-id>");
						const id = readToken(args, 0).value;
						if (ctx.hasUI && !await ctx.ui.confirm("Stop agent run?", `Stop ${id}? The child process tree will be terminated.`)) {
							notify(ctx, `Run ${id} was not stopped.`);
							return;
						}
						const stopped = await supervisor.stop(id);
						notify(ctx, `Run ${stopped.id} is ${stopped.state}.`, stopped.state === "interrupted" ? "warning" : "info");
						return;
					}
					case "worktree": {
						const parts = args.trim().split(/\s+/);
						if (parts.length !== 2 || parts[0] !== "remove") throw new Error("Usage: /agent worktree remove <run-id>");
						if (!ctx.hasUI) throw new Error("Worktree removal requires human UI confirmation; use Git manually outside TUI/RPC mode.");
						const run = supervisor.inspect(parts[1]);
						if (!run.worktree && !run.worktreeBundle) throw new Error("This run has no isolated worktree");
						const target = run.worktreeBundle
							? `${run.worktreeBundle.path}\nAll ${run.worktreeBundle.members.length} checkouts will be checked before removal. Branches and files outside the checkouts will be kept.`
							: `${run.worktree!.path}\nBranch ${run.worktree!.branch} will be kept.`;
						if (!await ctx.ui.confirm(run.worktreeBundle ? "Remove clean agent worktree bundle?" : "Remove clean agent worktree?", safeText(`${target}\nDirty/ignored files and active runs are refused; no force deletion.`))) return;
						const removed = await supervisor.removeWorktree(run.id);
						notify(ctx, removed.worktreeBundle ? "Clean bundle checkouts removed. All branches were kept." : removed.worktree!.note);
						return;
					}
					case "extensions":
						await dependencies.openExtensions?.(ctx);
						return;
					case "settings":
					case "config":
						if (dependencies.openSettings) await dependencies.openSettings(ctx);
						return;
					case "profiles": {
						const config = await dependencies.getConfig(ctx);
						const lines = Object.entries(config.profiles).map(([name, profile]) => {
							const modelInfo = Object.entries(profile.models ?? {}).map(([modelId, model]) => {
								const effortAliases = Object.keys(model.efforts ?? {}).join(", ") || "unsupported";
								const defaultEffort = model.defaultEffort ?? profile.defaultEffort;
								return `${modelId} [efforts: ${effortAliases}${defaultEffort ? `; default ${defaultEffort}` : ""}]`;
							}).join("; ") || "model override unsupported";
							return `${name}${name === config.defaultProfile ? " (default profile)" : ""}: ${profile.executable}; ${profile.modelArgs ? "model: user selection / parent session; " : ""}${modelInfo}${profile.extensionArgs ? `; extensions: ${extensionLabel(profile.extensions ?? { mode: "none" })} (overridable)` : ""}`;
						});
						notify(ctx, lines.join("\n"));
						return;
					}
					default:
						throw new Error(COMMAND_USAGE);
				}
			} catch (error) {
				if (!ctx.hasUI) throw error;
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
