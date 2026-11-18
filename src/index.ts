import type { PiExtensionApi, PiContext } from "./pi-api.js";
import { getSupervisorPaths, loadSupervisorConfig } from "./config.js";
import { registerAgentCommands } from "./commands.js";
import { registerAgentTools } from "./tools.js";
import { Supervisor, type RunTerminalNotice, type StartInput } from "./supervisor.js";
import { ModelSettings, openModelSettings } from "./model-settings.js";
import { attachRunWidget } from "./ui.js";
import { oneLine, safeText } from "./display.js";
import type { SupervisorConfig } from "./profiles.js";
import { WorkerExtensions, WORKER_ENV } from "./worker-extensions.js";

interface ActiveSession {
	sessionId: string;
	cwd: string;
	supervisor: Supervisor;
	config: SupervisorConfig;
	disposeUI: () => void;
}

function processMessage(notice: RunTerminalNotice): string {
	if (notice.state === "exited") {
		const result = notice.finalAnswer ? `\n${oneLine(notice.finalAnswer, 500)}` : notice.protocolWarning ? `\n${oneLine(notice.protocolWarning, 300)}` : "\nNo final answer extracted; inspect diagnostics with /agent.";
		return safeText(`Agent process exited${notice.exitCode === undefined || notice.exitCode === null ? "" : ` with code ${notice.exitCode}`}. Run ${notice.id}. ${notice.label ? `${oneLine(notice.label, 80)}. ` : ""}Exit status does not establish task correctness.${result}`);
	}
	if (notice.state === "cancelled") return `Agent process was cancelled. Run ${notice.id}.`;
	if (notice.state === "timed_out") return `Agent process timed out. Run ${notice.id}.`;
	return `Agent process ended as ${notice.state}. Run ${notice.id}.${notice.error ? ` ${notice.error.message}` : ""}`;
}

function terminalMessage(notice: RunTerminalNotice): string {
	const workspace = notice.worktreeBundle ? `\nWorktree bundle: ${notice.worktreeBundle.path}. Use /agent show ${notice.id} for checkout states.`
		: notice.worktree ? `\nWorktree: ${notice.worktree.path} (${notice.worktree.state})\nBranch: ${notice.worktree.branch}. No automatic commit or merge.` : "";
	return safeText(processMessage(notice) + workspace);
}

export default function agentSupervisorExtension(pi: PiExtensionApi): void {
	// Inherited/custom workers must never acquire this supervisor's delegation tools.
	if (process.env[WORKER_ENV] === "1") return;
	let active: ActiveSession | undefined;

	const getConfig = async (ctx: PiContext): Promise<SupervisorConfig> => {
		if (active?.sessionId === ctx.sessionManager.getSessionId() && active.cwd === ctx.cwd) return active.config;
		const paths = getSupervisorPaths();
		return loadSupervisorConfig(paths.profilesFile);
	};

	const getSupervisor = async (ctx: PiContext): Promise<Supervisor> => {
		const sessionId = ctx.sessionManager.getSessionId();
		if (active?.sessionId === sessionId && active.cwd === ctx.cwd) return active.supervisor;
		if (active) {
			active.disposeUI();
			await active.supervisor.shutdown();
			active = undefined;
		}

		const paths = getSupervisorPaths();
		const config = await loadSupervisorConfig(paths.profilesFile);
		const supervisor = new Supervisor(config, {
			paths,
			sessionId,
			parentCwd: ctx.cwd,
			...(ctx.hasUI ? { onRunTerminal: (notice) => ctx.ui.notify(terminalMessage(notice), notice.state === "interrupted" ? "warning" : "info") } : {}),
		});
		await supervisor.initialize();
		if (ctx.hasUI) for (const warning of supervisor.recoveryWarnings) ctx.ui.notify(safeText(warning), "warning");
		active = { sessionId, cwd: ctx.cwd, supervisor, config, disposeUI: attachRunWidget(ctx, supervisor) };
		return supervisor;
	};

	const extensionSettings = () => new WorkerExtensions(getSupervisorPaths().configDirectory);
	const modelSettings = () => new ModelSettings(getSupervisorPaths().configDirectory);
	const resolveStart = async (ctx: PiContext, input: StartInput): Promise<StartInput> => modelSettings().resolve(ctx, await getConfig(ctx), input);
	registerAgentTools(pi, getSupervisor, resolveStart);
	registerAgentCommands(pi, {
		getSupervisor, getConfig, resolveStart,
		openSettings: async (ctx) => openModelSettings(ctx, await getConfig(ctx), modelSettings(), async () => extensionSettings().openSettings(ctx, await getConfig(ctx))),
		openExtensions: async (ctx) => extensionSettings().openSettings(ctx, await getConfig(ctx)),
		chooseExtensions: async (ctx, profile, current) => extensionSettings().choose(ctx, await getConfig(ctx), profile, current),
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			await getSupervisor(ctx);
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
		}
	});

	pi.on("session_shutdown", async () => {
		const closing = active;
		active = undefined;
		if (closing) { closing.disposeUI(); await closing.supervisor.shutdown(); }
	});
}
