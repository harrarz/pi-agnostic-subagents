import { Type } from "typebox";
import { truncateHead, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { boundedText } from "./presentation.js";
import { oneLine, runActivity, runLine, safeText } from "./display.js";
import type { PiExtensionApi, PiToolContext, PiContext } from "./pi-api.js";
import type { Supervisor, StartInput } from "./supervisor.js";
import type { RunSummary } from "./run-store.js";

const StartParams = Type.Object({
	task: Type.String({ minLength: 1, description: "The single task to run in the configured headless agent" }),
	label: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Short task label for the agent tree; omitted derives one from the task" })),
	profile: Type.Optional(Type.String({ description: "Trusted configured profile alias; omitted uses the configured default" })),
	model: Type.Optional(Type.String({ description: "Exact model override only when the user chooses one; otherwise omit to follow the saved user setting or current parent model" })),
	effort: Type.Optional(Type.String({ description: "Optional reasoning-effort alias supported by the selected model" })),
	extensions: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("inherit"), Type.Literal("custom")], { description: "Override extensions on a capable profile: none disables extensions; inherit snapshots enabled user extensions; custom loads only a trusted named set. Omit to use saved/profile defaults." })),
	extensionSet: Type.Optional(Type.String({ description: "User-approved extension set name; requires extensions: custom. Never supply paths or package sources." })),
	cwd: Type.Optional(Type.String({ description: "Source directory inside the current checkout; worktree isolation maps committed subdirectories into the new checkout" })),
	isolation: Type.Optional(Type.Union([Type.Literal("shared"), Type.Literal("worktree")], { description: "shared (default) allows concurrent writes to the current files, with no checkout locking or conflict prevention, including outside Git; worktree creates a separate branch/checkout at committed HEAD for isolated edits. Uncommitted source changes are not copied. Worktree/branch are retained for explicit recovery/cleanup." })),
	timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_147_483_647, description: "Optional wall-clock timeout in milliseconds" })),
});

const GetParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Run ID for one detail record; omit to list recent runs" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum recent runs returned when id is omitted (max 20)" })),
	format: Type.Optional(Type.Union([Type.Literal("answer"), Type.Literal("transcript"), Type.Literal("raw")], {
		description: "Default answer: clean status and final answer. transcript: bounded readable conversation. raw: diagnostic output tail.",
	})),
});
const StopParams = Type.Object({ id: Type.String({ minLength: 1, description: "Run ID to stop" }) });
type SupervisorProvider = (ctx: PiToolContext) => Promise<Supervisor>;

function listItem(run: RunSummary) {
	return {
		id: run.id,
		label: run.label,
		parent: { sessionId: run.sessionId, label: "main" },
		state: run.state,
		profile: run.profile,
		extensions: run.extensions,
		isolation: run.isolation ?? "shared",
		...(run.worktree ? { worktree: run.worktree } : {}),
		model: run.model,
		effort: run.effortAlias,
		activity: runActivity(run),
		task: boundedText(run.task, 180),
		createdAt: run.createdAt,
		startedAt: run.startedAt,
		endedAt: run.endedAt,
		exitCode: run.exitCode,
		error: run.error,
	};
}

function jsonResult(value: Record<string, unknown>, summary: string) {
	// The full bounded data reaches the parent; terminal rendering stays compact.
	const output = truncateHead(JSON.stringify(value, null, 2), { maxBytes: 48 * 1024, maxLines: 1800 });
	const text = output.content + (output.truncated ? `\n[Response truncated; inspect retained diagnostics at ${boundedText(String(value.logPath ?? "the per-run log paths above"), 512)}.]` : "");
	return { content: [{ type: "text" as const, text }], details: { ...value, summary } };
}

export function renderAgentResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Text {
	const details = result.details as { summary?: string } | undefined;
	const text = options.isPartial ? "Working…" : options.expanded
		? boundedText(result.content.filter((item) => item.type === "text").map((item) => item.text ?? "").join("\n"), 16 * 1024)
		: details?.summary ?? oneLine(result.content.find((item) => item.type === "text")?.text ?? "No result", 240);
	return new Text(theme.fg("toolOutput", safeText(text)), 0, 0);
}

export function registerAgentTools(pi: PiExtensionApi, getSupervisor: SupervisorProvider, resolveStart?: (ctx: PiContext, input: StartInput) => Promise<StartInput>): void {
	pi.registerTool({
		name: "agent_start",
		label: "Start agent",
		description: "Launch one explicitly requested task immediately using a trusted configured headless-agent profile, without an agent-count limit or scheduler queue. Returns a run ID and process state; it does not claim the task was correct. No automatic roles, reviews, or fanout.",
		parameters: StartParams,
		annotations: { destructiveHint: true, openWorldHint: true },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const supervisor = await getSupervisor(ctx);
			const started = await supervisor.start(resolveStart ? await resolveStart(ctx, params) : params);
			const run = supervisor.inspect(started.id);
			return jsonResult({ id: started.id, state: started.state, ...(run.extensions ? { extensions: run.extensions } : {}), isolation: run.isolation ?? "shared", ...(run.worktree ? { worktree: run.worktree } : {}) }, `${runLine(run)}${run.worktree ? `\n${run.worktree.note}` : ""}`);
		},
		renderCall: (args, theme) => new Text(theme.fg("toolTitle", `Start agent · ${oneLine(args.label ?? args.task ?? "…", 100)}`), 0, 0),
		renderResult: renderAgentResult,
	});

	pi.registerTool({
		name: "agent_get",
		label: "Get agent run",
		description: "Inspect one owned agent run by ID, or list recent runs. Defaults to clean status and an extracted final answer (bounded to 12 Ki characters); transcript/raw diagnostics are opt-in. Process exit is not task correctness.",
		parameters: GetParams,
		annotations: { readOnlyHint: true, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const supervisor = await getSupervisor(ctx);
			if (params.id) {
				const run = supervisor.inspect(params.id);
				const answer = run.presentation?.finalAnswer;
				const details = {
					...listItem(run),
					...(supervisor.recoveryWarnings.length ? { recoveryWarnings: supervisor.recoveryWarnings } : {}),
					cwd: run.cwd,
					effort: run.effort,
					effortAlias: run.effortAlias,
					outputProtocol: run.outputProtocol ?? "raw",
					finalAnswer: answer,
					answerTruncated: run.presentation?.answerTruncated,
					protocolWarning: run.presentation?.protocolWarning,
					logPath: run.logPath,
					stdoutPath: run.stdoutPath,
					stderrPath: run.stderrPath,
					...(params.format === "transcript" ? { transcript: run.presentation?.transcript ?? [], transcriptTruncated: run.presentation?.transcriptTruncated } : {}),
					...(params.format === "raw" ? { outputTail: (await supervisor.get(params.id)).outputTail, logTruncated: run.logTruncated } : {}),
				};
				return jsonResult(details, `${runLine(run)}\n${oneLine(answer ?? (runActivity(run) || "No final answer extracted; inspect diagnostics if needed."), 240)}`);
			}
			const runs = supervisor.snapshot().slice(0, params.limit ?? 10);
			return jsonResult({ runs: runs.map(listItem), ...(supervisor.recoveryWarnings.length ? { recoveryWarnings: supervisor.recoveryWarnings } : {}) }, runs.length ? runs.map((run) => runLine(run)).join("\n") : "No supervised agents.");
		},
		renderCall: (args, theme) => new Text(theme.fg("toolTitle", `Agent status${args.id ? ` · ${oneLine(args.id, 36)}` : ""}`), 0, 0),
		renderResult: renderAgentResult,
	});

	pi.registerTool({
		name: "agent_stop",
		label: "Stop agent run",
		description: "Stop one owned run and wait for verified process-tree cleanup. Starting runs can be cancelled before process creation.",
		parameters: StopParams,
		annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const supervisor = await getSupervisor(ctx);
			const run = await supervisor.stop(params.id);
			return jsonResult({ id: run.id, state: run.state, exitCode: run.exitCode }, runLine(run));
		},
		renderCall: (args, theme) => new Text(theme.fg("toolTitle", `Stop agent · ${oneLine(args.id ?? "…", 36)}`), 0, 0),
		renderResult: renderAgentResult,
	});
}
