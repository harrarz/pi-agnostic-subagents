// Test-only deterministic provider: no network, credentials, or paid inference.
import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

export default function workerDurableProvider(pi: ExtensionAPI) {
	const provider = fauxProvider();
	let sessionFile: string | undefined;
	if (process.env.PI_WORKER_DURABLE_PHASE === "resume") provider.setResponses([
		fauxAssistantMessage(fauxToolCall("write", { path: "recovered.txt", content: "recovered\n" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Recovered worker."),
	]);
	else provider.setResponses([
		fauxAssistantMessage(fauxToolCall("bash", { command: "printf 'once\\n' >> receipt.txt" }), { stopReason: "toolUse" }),
		() => {
			writeFileSync(process.env.PI_WORKER_DURABLE_READY!, JSON.stringify({ pid: process.pid, sessionFile }));
			return new Promise<never>(() => {});
		},
	]);
	pi.registerProvider(provider.provider);
	pi.on("session_start", (_event, ctx) => { sessionFile = ctx.sessionManager.getSessionFile(); });
}
