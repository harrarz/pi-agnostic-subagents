import type { Theme } from "@earendil-works/pi-coding-agent";
import { getTerminalColorMode, rgbColor, stripTerminalSequences, styleText } from "@earendil-works/pi-tui";
import { isTerminalState, type RunSummary } from "./run-store.js";

/** Child-authored strings must never execute terminal controls in a UI surface. */
export function safeText(value: string): string {
	return stripTerminalSequences(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\r/g, "");
}

export function oneLine(value: string, limit = 100): string {
	const text = safeText(value).replace(/\s+/g, " ");
	return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

export function elapsed(run: RunSummary, now = Date.now()): string {
	const start = Date.parse(run.startedAt ?? run.createdAt);
	const end = run.endedAt ? Date.parse(run.endedAt) : now;
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "?";
	const seconds = Math.floor((end - start) / 1000);
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function runTitle(run: RunSummary): string {
	return `${oneLine(run.label ?? run.task, 60)} [${run.id.slice(0, 8)}]`;
}

const STATE_COLOURS = {
	blue: { dark: rgbColor(96, 165, 250), light: rgbColor(37, 99, 235) },
	amber: { dark: rgbColor(251, 191, 36), light: rgbColor(180, 83, 9) },
	yellow: { dark: rgbColor(250, 204, 21), light: rgbColor(161, 98, 7) },
	green: { dark: rgbColor(74, 222, 128), light: rgbColor(21, 128, 61) },
	red: { dark: rgbColor(248, 113, 113), light: rgbColor(185, 28, 28) },
	gray: { dark: rgbColor(148, 163, 184), light: rgbColor(100, 116, 139) },
};

/** Colour describes process state only; the text remains meaningful without colour. */
export function stateIndicator(run: RunSummary, theme: Theme): string {
	let colour: keyof typeof STATE_COLOURS;
	let label: string = run.state.replaceAll("_", " ");
	switch (run.state) {
		case "queued": colour = "amber"; break;
		case "starting":
		case "running": colour = "blue"; break;
		case "stopping": colour = "yellow"; break;
		case "cancelled": colour = "gray"; break;
		case "exited":
			label = `exited (${run.exitCode ?? oneLine(run.signal ?? "unknown")})${run.error ? " · error" : ""}`;
			colour = run.error || run.signal || (run.exitCode != null && run.exitCode !== 0) ? "red" : run.exitCode === 0 ? "green" : "gray";
			break;
		default: colour = "red";
	}
	return styleText(`● ${label}`, { fg: STATE_COLOURS[colour][theme.appearance === "light" ? "light" : "dark"] }, getTerminalColorMode());
}

export function runLine(run: RunSummary, now = Date.now(), theme?: Theme): string {
	return `${runTitle(run)} · ${theme ? stateIndicator(run, theme) : run.state} · ${elapsed(run, now)}${run.isolation === "worktree" ? " · worktree" : ""}`;
}

export function runActivity(run: RunSummary): string {
	return run.queueReason ?? run.error?.message ?? run.presentation?.protocolWarning
		?? (isTerminalState(run.state) ? (run.presentation?.finalAnswer ? "Answer available" : "No final answer extracted")
			: run.presentation?.activity ?? (run.state === "running" ? "Running; activity unavailable" : ""));
}
