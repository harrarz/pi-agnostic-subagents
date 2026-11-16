import type { Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { PiCommandContext, PiContext } from "./pi-api.js";
import { oneLine, runActivity, runLine, runTitle, safeText, stateIndicator } from "./display.js";
import { isTerminalState, type RunSummary } from "./run-store.js";
import type { Supervisor } from "./supervisor.js";
import { extensionLabel, type ExtensionPicker } from "./worker-extensions.js";

import { actionLabel, browserActions, executeBrowserRequest, type BrowserAction, type BrowserRequest } from "./ui-actions.js";

const WIDGET_KEY = "agent-supervisor";
const WIDGET_COMPLETION_MS = 3000;

interface WidgetCompletion {
	finished: number;
	failed: number;
	cancelled: number;
}

/** Coalesces streaming events, advances elapsed time, and owns all timers. */
export function watchRuns(supervisor: Supervisor, refresh: () => void): () => void {
	let pending: ReturnType<typeof setTimeout> | undefined;
	let disposed = false;
	const unsubscribe = supervisor.subscribe(() => {
		if (disposed || pending) return;
		pending = setTimeout(() => { pending = undefined; if (!disposed) refresh(); }, 80);
		pending.unref();
	});
	const clock = setInterval(() => {
		if (!disposed && supervisor.snapshot().some((run) => !isTerminalState(run.state))) refresh();
	}, 1000);
	clock.unref();
	return () => {
		disposed = true;
		unsubscribe();
		clearInterval(clock);
		if (pending) clearTimeout(pending);
	};
}

export function widgetLines(runs: RunSummary[], width: number, height: number, theme: Theme, completion?: WidgetCompletion): string[] {
	if (width < 1 || height < 1) return [];
	const active = runs.filter((run) => !isTerminalState(run.state));
	if (!active.length) {
		if (!completion?.finished) return [];
		const outcome = `${completion.finished} finished${completion.failed ? ` · ${completion.failed} failed` : ""}${completion.cancelled ? ` · ${completion.cancelled} cancelled` : ""}`;
		return [truncateToWidth(theme.fg(completion.failed ? "warning" : "dim", `Agents · ${outcome} · /agent`), width)];
	}
	if (height < 3) return [];
	const budget = Math.max(1, Math.min(4, Math.floor(height / 4)));
	const shown = active.slice(0, budget);
	const lines = [theme.fg("accent", `Agents · ${active.length} active · /agent`), theme.fg("dim", "main")];
	for (const [index, run] of shown.entries()) {
		const branch = index === shown.length - 1 && active.length <= budget ? "└─" : "├─";
		lines.push(`${branch} ${runLine(run, Date.now(), theme)}${runActivity(run) ? ` · ${oneLine(runActivity(run), 100)}` : ""}`);
	}
	if (active.length > shown.length) lines.push(theme.fg("dim", `└─ +${active.length - shown.length} more`));
	return lines.map((line) => truncateToWidth(line, width));
}

export function attachRunWidget(ctx: PiContext, supervisor: Supervisor): () => void {
	if (ctx.mode !== "tui") return () => {};
	let disposeComponent: (() => void) | undefined;
	ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
		let runs = supervisor.snapshot();
		const observed = new Set(runs.filter((run) => !isTerminalState(run.state)).map((run) => run.id));
		let completion: WidgetCompletion = { finished: 0, failed: 0, cancelled: 0 };
		let dismissal: ReturnType<typeof setTimeout> | undefined;
		let clock: ReturnType<typeof setInterval> | undefined;
		let disposed = false;
		const refresh = () => {
			if (disposed) return;
			runs = supervisor.snapshot();
			const active = runs.filter((run) => !isTerminalState(run.state));
			if (active.length && dismissal) {
				clearTimeout(dismissal);
				dismissal = undefined;
				completion = { finished: 0, failed: 0, cancelled: 0 };
			}
			const byId = new Map(runs.map((run) => [run.id, run]));
			for (const id of observed) {
				// A long-running child can fall outside the latest-50 terminal snapshot.
				const run = byId.get(id) ?? supervisor.inspect(id);
				if (!isTerminalState(run.state)) continue;
				observed.delete(id);
				completion.finished++;
				if (run.state === "cancelled") completion.cancelled++;
				else if (run.state !== "exited" || run.exitCode !== 0 || run.error || run.signal) completion.failed++;
			}
			for (const run of active) observed.add(run.id);
			if (active.length) {
				clock ??= setInterval(() => { if (!disposed) tui.requestRender(); }, 1000);
				clock.unref();
			} else {
				if (clock) clearInterval(clock);
				clock = undefined;
				if (completion.finished && !dismissal) {
					dismissal = setTimeout(() => {
						dismissal = undefined;
						completion = { finished: 0, failed: 0, cancelled: 0 };
						if (!disposed) tui.requestRender();
					}, WIDGET_COMPLETION_MS);
					dismissal.unref();
				}
			}
			tui.requestRender();
		};
		// Observe transitions synchronously so even very short runs are counted.
		// Pi coalesces the render requests independently of these state updates.
		const unsubscribe = supervisor.subscribe(refresh);
		const dispose = () => {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			if (clock) clearInterval(clock);
			if (dismissal) clearTimeout(dismissal);
		};
		disposeComponent = dispose;
		refresh();
		return {
			render: (width: number) => disposed ? [] : widgetLines(runs, width, tui.terminal.rows, theme, completion),
			invalidate() {},
			dispose,
		};
	});
	return () => { disposeComponent?.(); ctx.ui.setWidget(WIDGET_KEY, undefined); };
}

type BrowserMode = "list" | "answer" | "transcript" | "diagnostics" | "workspace";

export class AgentBrowser implements Component {
	private runs: RunSummary[];
	private selectedId?: string;
	private mode: BrowserMode = "list";
	private action: BrowserAction = "inspect";
	private offset = 0;
	private listOffset = 0;
	private confirmStop = false;
	private stopping = false;
	private status = "";
	private diagnostics = "";
	private diagnosticsId?: string;
	private disposed = false;
	private readonly unwatch: () => void;

	constructor(
		private readonly supervisor: Supervisor,
		private readonly theme: Theme,
		private readonly keys: KeybindingsManager,
		private readonly requestRender: () => void,
		private readonly rows: () => number,
		private readonly done: (request?: BrowserRequest) => void,
		initialId?: string,
		initialMode?: BrowserMode,
	) {
		this.runs = supervisor.snapshot();
		this.selectedId = initialId ?? this.runs[0]?.id;
		if (initialId) this.mode = initialMode ?? "answer";
		this.unwatch = watchRuns(supervisor, () => {
			this.runs = supervisor.snapshot();
			if (!this.runs.some((run) => run.id === this.selectedId)) this.selectedId = this.runs[0]?.id;
			this.requestRender();
		});
	}

	dispose(): void { this.disposed = true; this.unwatch(); }
	invalidate(): void {}

	handleInput(data: string): void {
		if (this.keys.matches(data, "tui.select.cancel")) {
			if (this.confirmStop) this.confirmStop = false;
			else if (this.mode !== "list") { this.mode = "list"; this.offset = 0; }
			else { this.done(); return; }
		} else if (this.confirmStop) {
			if (data === "y" || this.keys.matches(data, "tui.select.confirm")) void this.stopSelected();
			else this.confirmStop = false;
		} else if (data === "s" && this.selectedId && !this.stopping) {
			const run = this.runs.find((run) => run.id === this.selectedId);
			if (run && !isTerminalState(run.state)) this.confirmStop = true;
		} else if (data === "t" && this.selectedId) {
			this.mode = "transcript"; this.offset = 0;
		} else if (data === "a" && this.selectedId) {
			this.mode = "answer"; this.offset = 0;
		} else if (data === "d" && this.selectedId) {
			this.mode = "diagnostics"; this.offset = 0;
			void this.loadDiagnostics(this.selectedId);
		} else if (this.mode === "list" && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) {
			const run = this.runs.find((run) => run.id === this.selectedId);
			if (run) {
				const actions = browserActions(run);
				const index = Math.max(0, actions.indexOf(this.action));
				this.action = actions[(index + (matchesKey(data, Key.right) ? 1 : -1) + actions.length) % actions.length];
			}
		} else if (this.keys.matches(data, "tui.select.confirm") && this.selectedId) {
			const run = this.runs.find((run) => run.id === this.selectedId);
			const action = run && browserActions(run).includes(this.action) ? this.action : "inspect";
			if (this.mode !== "list" || action === "inspect") { this.mode = "answer"; this.offset = 0; }
			else if (action === "stop") this.confirmStop = true;
			else if (action === "workspace") { this.mode = "workspace"; this.offset = 0; }
			else { this.done({ id: this.selectedId, action }); return; }
		} else if (this.keys.matches(data, "tui.select.up")) this.move(-1);
		else if (this.keys.matches(data, "tui.select.down")) this.move(1);
		else if (matchesKey(data, Key.pageUp)) this.move(-Math.max(1, this.rows() - 8));
		else if (matchesKey(data, Key.pageDown)) this.move(Math.max(1, this.rows() - 8));
		else if (matchesKey(data, Key.home)) { if (this.mode === "list") { this.selectedId = this.runs[0]?.id; this.action = "inspect"; } else this.offset = 0; }
		else if (matchesKey(data, Key.end)) { if (this.mode === "list") { this.selectedId = this.runs.at(-1)?.id; this.action = "inspect"; } else this.offset = Number.MAX_SAFE_INTEGER; }
		else return;
		this.requestRender();
	}

	private move(delta: number): void {
		this.confirmStop = false;
		if (this.mode !== "list") { this.offset = Math.max(0, this.offset + delta); return; }
		const index = this.runs.findIndex((run) => run.id === this.selectedId);
		this.selectedId = this.runs[Math.max(0, Math.min(this.runs.length - 1, index + delta))]?.id;
		this.action = "inspect";
		this.offset = 0;
	}

	private async stopSelected(): Promise<void> {
		const id = this.selectedId;
		if (!id || this.stopping) return;
		this.confirmStop = false;
		this.stopping = true;
		this.status = "Stopping; waiting for process cleanup…";
		this.requestRender();
		try { const run = await this.supervisor.stop(id); this.status = `${runTitle(run)} · ${run.state}`; }
		catch (error) { this.status = error instanceof Error ? error.message : String(error); }
		finally { this.stopping = false; if (!this.disposed) { this.runs = this.supervisor.snapshot(); this.requestRender(); } }
	}

	private async loadDiagnostics(id: string): Promise<void> {
		this.diagnosticsId = id;
		this.diagnostics = "Loading bounded diagnostic tail…";
		try {
			const run = await this.supervisor.get(id);
			if (this.disposed || this.diagnosticsId !== id) return;
			this.diagnostics = `Combined log: ${run.logPath}\nStdout: ${run.stdoutPath ?? "legacy combined log"}\nStderr: ${run.stderrPath ?? "legacy combined log"}\n${run.logTruncated ? "Earlier output was truncated.\n" : ""}\n${run.outputTail || "(no output)"}`;
		} catch (error) { this.diagnostics = String(error); }
		if (!this.disposed) this.requestRender();
	}

	private detailLines(run: RunSummary): string[] {
		const detail = this.supervisor.inspect(run.id);
		run = detail;
		const presentation = detail.presentation;
		const lines = [runLine(run), `Parent: main · session ${run.sessionId.slice(0, 8)}`, `Profile: ${run.profile} · ${run.model ?? "CLI configuration"}${run.effortAlias ? ` · ${run.effortAlias}` : ""}`, `Directory: ${run.cwd}`, `Task: ${run.task}`];
		if (run.extensions) lines.push(`Extensions: ${extensionLabel(run.extensions)} · ${run.extensions.paths.length} selected`, ...run.extensions.paths.map((path) => `  ${path}`));
		if (!run.worktree) lines.push("Isolation: shared · concurrent writes; overlapping edits can overwrite each other.");
		if (run.worktree) lines.push(`Worktree: ${run.worktree.path} · ${run.worktree.state}`, `Branch: ${run.worktree.branch}`, `Source: ${run.worktree.sourceCwd}`, `Base: ${run.worktree.baseCommit}`, run.worktree.note, `Cleanup (clean only): /agent worktree remove ${run.id}`);
		if (run.control) lines.push(`Conversation: ${run.control.conversationId} · turn ${run.control.turn}${run.control.continuedFrom ? ` · follows ${run.control.continuedFrom}` : ""}`);
		if (this.mode === "workspace") return [...lines, "", "Workspace is retained. Cleanup is explicit and refuses dirty/ignored files.", `Use /agent worktree remove ${run.id}; branch is kept.`];
		if (run.exitCode !== undefined) lines.push(`Exit code: ${run.exitCode} (not a correctness judgment)`);
		if (run.error) lines.push(`Process note: ${run.error.message}`);
		if (presentation?.protocolWarning) lines.push(`Protocol note: ${presentation.protocolWarning}`);
		lines.push("");
		if (this.mode === "diagnostics") return [...lines, this.diagnostics, "", "Diagnostic snapshot; press d to refresh."];
		if (this.mode === "transcript") {
			lines.push("Transcript (user/assistant text + tool activity; reasoning omitted)");
			if (presentation?.transcriptTruncated) lines.push("Earlier transcript entries were truncated; inspect logs if needed.");
			for (const entry of presentation?.transcript ?? []) lines.push(`[${entry.kind}] ${entry.text}`, "");
			if (!presentation?.transcript.length) lines.push("No readable transcript; diagnostics are available with d.");
		} else {
			lines.push(`Activity: ${runActivity(run) || "—"}`, "", "Final answer");
			lines.push(presentation?.finalAnswer ?? (isTerminalState(run.state) ? "No final answer extracted. Inspect transcript (t) or diagnostics (d)." : "Not finished yet."));
			if (presentation?.answerTruncated) lines.push("Answer truncated; inspect diagnostics for the retained output.");
		}
		return lines;
	}

	render(width: number): string[] {
		const outerWidth = Math.max(1, width);
		width = Math.max(1, outerWidth - 4);
		const height = Math.max(3, Math.min(this.rows() - 4, Math.floor(this.rows() * 0.9)));
		const selectedRun = this.runs.find((run) => run.id === this.selectedId);
		const header = this.theme.fg("accent", `Agents · ${this.runs.filter((run) => !isTerminalState(run.state)).length} active · ${this.mode}`)
			+ (this.mode !== "list" && selectedRun ? ` · ${stateIndicator(selectedRun, this.theme)}` : "");
		const help = this.mode === "list"
			? (width < 85 ? "↑↓ agent · ←→ action · Enter · Esc" : "↑↓ agent · ←→ action · Enter apply · a answer · t transcript · d logs · s stop · Esc")
			: (width < 65 ? "↑↓ scroll · a/t/d views · s stop · Esc back" : "↑↓ scroll · a answer · t transcript · d logs · s stop · Esc back");
		const footer = this.confirmStop
			? this.theme.fg("warning", width < 80 ? "Stop process tree? y/Enter yes · Esc cancel" : "Stop selected agent and terminate its process tree? y/Enter confirm · Esc cancel")
			: this.theme.fg("dim", help);
		const budget = Math.max(1, height - 6);
		let body: string[];
		if (this.mode === "list") {
			const selected = Math.max(0, this.runs.findIndex((run) => run.id === this.selectedId));
			const count = Math.max(1, Math.floor((budget - (budget >= 3 ? 1 : 0)) / 2));
			this.listOffset = Math.max(0, Math.min(this.listOffset, selected, Math.max(0, this.runs.length - count)));
			if (selected >= this.listOffset + count) this.listOffset = selected - count + 1;
			body = budget >= 3 ? [this.theme.fg("dim", `main · parent session ${this.runs[0]?.sessionId.slice(0, 8) ?? "(no children)"}`)] : [];
			for (const run of this.runs.slice(this.listOffset, this.listOffset + count)) {
				const line = `${run.id === this.selectedId ? "›" : " "} ├─ ${runLine(run, Date.now(), this.theme)}`;
				const selectedRow = run.id === this.selectedId;
				const actions = browserActions(run);
				if (selectedRow && !actions.includes(this.action)) this.action = "inspect";
				const controls = actions.map((action) => {
					const label = actionLabel(action, run);
					return selectedRow && action === this.action ? this.theme.fg("accent", `[${label}]`) : label;
				}).join(" · ");
				// Keep the selected action visible even in narrow terminals.
				const detail = selectedRow ? (visibleWidth(controls) + 5 <= width ? controls : `[${actionLabel(this.action, run)}] ←→`) : oneLine(runActivity(run) || run.task, 200);
				body.push(selectedRow ? this.theme.fg("accent", line) : line, `     ${detail}`);
			}
			if (!this.runs.length) body.push("No agents. Start one with /agent run -- <task>.");
		} else {
			const run = this.runs.find((item) => item.id === this.selectedId);
			const wrapped = (run ? this.detailLines(run) : ["Agent no longer available."])
				.flatMap((line) => safeText(line).split("\n").flatMap((part) => wrapTextWithAnsi(part, width)));
			this.offset = Math.min(this.offset, Math.max(0, wrapped.length - budget));
			body = wrapped.slice(this.offset, this.offset + budget);
		}
		const content = [header, ...body.slice(0, budget)];
		while (content.length < Math.max(1, height - 4)) content.push("");
		content.push(this.theme.fg("dim", oneLine(this.status, 160)), footer);
		const border = (left: string, right: string) => this.theme.fg("borderAccent", left + "─".repeat(Math.max(0, outerWidth - 2)) + right);
		const row = (line: string) => {
			const text = truncateToWidth(line, width);
			const padded = ` ${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))} `;
			return this.theme.fg("borderAccent", "│") + padded + this.theme.fg("borderAccent", "│");
		};
		const background = this.theme.bg("customMessageBg", "").replace(/\x1b\[49m$/, "");
		return [border("╭", "╮"), ...content.slice(0, Math.max(1, height - 2)).map(row), border("╰", "╯")]
			.slice(0, height).map((line) => {
				const text = truncateToWidth(line, outerWidth);
				// Truncation emits SGR resets; restore the window background after
				// them so long lines cannot punch differently coloured holes in it.
				const filled = (text + " ".repeat(Math.max(0, outerWidth - visibleWidth(text))))
					.replace(/\x1b\[(?:0|49)m/g, (reset) => reset + background);
				return this.theme.bg("customMessageBg", filled);
			});
	}
}

export async function openAgentBrowser(ctx: PiCommandContext, supervisor: Supervisor, id?: string, picker?: ExtensionPicker): Promise<void> {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify("Agent browser requires TUI mode. Use /agent list or /agent show <id>.", "warning");
		return;
	}
	let initialMode: BrowserMode | undefined;
	for (;;) {
		const request = await ctx.ui.custom<BrowserRequest | undefined>((tui, theme, keys, done) => new AgentBrowser(
			supervisor, theme, keys, () => tui.requestRender(), () => tui.terminal.rows, done, id, initialMode,
		), { overlay: true, overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" } });
		if (!request) return;
		id = request.id;
		initialMode = "list";
		try {
			const startedId = await executeBrowserRequest(ctx, supervisor, request, picker);
			if (startedId) { id = startedId; initialMode = "answer"; }
		} catch (error) { ctx.ui.notify(safeText(error instanceof Error ? error.message : String(error)), "error"); }
	}
}
