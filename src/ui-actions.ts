import type { PiCommandContext } from "./pi-api.js";
import { oneLine, safeText } from "./display.js";
import { isTerminalState, type RunSummary } from "./run-store.js";
import type { StartInput, Supervisor } from "./supervisor.js";

export type BrowserAction = "inspect" | "steer" | "stop" | "followUp" | "rerun" | "editRerun" | "workspace";
export interface BrowserRequest { id: string; action: BrowserAction; }
export const actionLabels: Record<BrowserAction, string> = {
	inspect: "Inspect", steer: "Steer", stop: "Stop", followUp: "Follow up", rerun: "Rerun", editRerun: "Rerun with changes", workspace: "Workspace",
};
export function browserActions(run: RunSummary): BrowserAction[] {
	const actions: BrowserAction[] = ["inspect"];
	if (run.capabilities?.steer) actions.push("steer");
	if (["queued", "starting", "running"].includes(run.state)) actions.push("stop");
	if (run.capabilities?.followUp) actions.push("followUp");
	if (isTerminalState(run.state)) actions.push("rerun", "editRerun");
	if (run.worktree) actions.push("workspace");
	return actions;
}
export function actionLabel(action: BrowserAction, run: RunSummary): string {
	return action === "stop" && (run.state === "starting" || run.state === "queued") ? "Cancel" : actionLabels[action];
}

async function editRerun(ctx: PiCommandContext, run: RunSummary): Promise<Partial<StartInput> | undefined> {
	const draft: Partial<StartInput> = { task: run.task, model: run.model, effort: run.effortAlias, timeoutMs: run.timeoutMs, isolation: run.isolation ?? "shared" };
	for (;;) {
		const choices = ["Run", `Task: ${oneLine(draft.task!, 70)}`, `Model: ${draft.model ?? "CLI configuration"}`, `Effort: ${draft.effort ?? "CLI configuration"}`, `Timeout (ms): ${draft.timeoutMs ?? "none"}`, `Isolation: ${draft.isolation === "shared" ? "shared (concurrent writes)" : "worktree"}`, "Cancel"];
		const choice = await ctx.ui.select("Rerun with changes · fresh conversation/workspace", choices.map(safeText));
		if (!choice || choice === "Cancel") return;
		const index = choices.map(safeText).indexOf(choice);
		if (index === 0) return draft;
		if (index === 5) {
			const isolation = await ctx.ui.select("Checkout isolation", ["shared (concurrent writes)", "worktree"]);
			if (isolation === "shared (concurrent writes)") draft.isolation = "shared";
			else if (isolation === "worktree") draft.isolation = "worktree";
			continue;
		}
		const field = (["task", "model", "effort", "timeoutMs"] as const)[index - 1];
		if (!field) continue;
		const value = await ctx.ui.editor(field === "timeoutMs" ? "Timeout in milliseconds · blank removes deadline" : `Edit ${field}`, String(draft[field] ?? ""));
		if (value === undefined) continue;
		if (field === "timeoutMs") {
			const n = value.trim() ? Number(value) : undefined;
			if (n !== undefined && (!Number.isSafeInteger(n) || n <= 0 || n > 2_147_483_647)) { ctx.ui.notify("Timeout must be 1–2147483647 ms, or blank", "error"); continue; }
			draft.timeoutMs = n;
		} else if (field === "task") {
			if (value.trim()) draft.task = value;
		} else draft[field] = value.trim() || undefined;
	}
}

/** Called after the custom browser has completed/disposed, never as a nested overlay. */
export async function executeBrowserRequest(ctx: PiCommandContext, supervisor: Supervisor, request: BrowserRequest): Promise<string | undefined> {
	const run = supervisor.inspect(request.id);
	if (request.action === "steer" || request.action === "followUp") {
		const message = await ctx.ui.editor(`${request.action === "steer" ? "Steer running agent" : "Follow up in saved conversation"} · ${oneLine(run.label ?? run.task, 60)}`);
		if (!message?.trim()) return;
		if (request.action === "steer") {
			const disposition = await supervisor.steer(run.id, message);
			ctx.ui.notify(disposition === "queued" ? "Steering queued; delivery occurs at an agent turn boundary, not immediately." : "Steering handled by the child input handler.", "info");
			return;
		}
		return (await supervisor.followUp(run.id, message)).id;
	}
	if (request.action === "rerun" || request.action === "editRerun") {
		const changes = request.action === "editRerun" ? await editRerun(ctx, run) : {};
		if (!changes) return;
		if (!await ctx.ui.confirm("Start fresh agent run?", safeText(`Same resolved settings unless edited. No conversation or previous worktree changes are copied.${(changes.isolation ?? run.isolation) === "worktree" ? " New worktree starts from current committed HEAD; previous worktree is retained." : " Uses the current shared folder with concurrent writes; overlapping edits can overwrite each other."}`))) return;
		return (await supervisor.rerun(run.id, changes)).id;
	}
}
