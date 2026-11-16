/**
 * Trusted, package-bundled launch recipes used when no user profile file exists.
 * This stays declarative so adding/reviewing a CLI does not require supervisor branches.
 */
export const BUNDLED_PROFILE_CONFIG: unknown = {
	defaultProfile: "pi",
	profiles: {
		pi: {
			outputProtocol: "pi-jsonl",
			executable: "pi",
			args: ["{extensionArgs}", "--mode", "rpc", "--session", "{session}", "{modelArgs}", "{effortArgs}"],
			extensionArgs: { none: ["--no-extensions"], load: ["--extension", "{extension}"] },
			extensions: { mode: "none" },
			taskTransport: "pi-rpc",
			modelArgs: ["--model", "{model}"],
			effortArgs: ["--thinking", "{effort}"],
			modelFormat: "qualified",
			models: {
				"openai-codex/gpt-6-luna": {
					efforts: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
				},
				"openai-codex/gpt-6.1-sol": {
					efforts: { off: "off", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
				},
			},
		},
		codex: {
			outputProtocol: "codex-jsonl",
			executable: "codex",
			args: ["exec", "--sandbox", "workspace-write", "--json", "{modelArgs}", "{effortArgs}", "--ephemeral", "-"],
			taskTransport: "stdin",
			modelArgs: ["--model", "{model}"],
			effortArgs: ["--config", 'model_reasoning_effort="{effort}"'],
			modelFormat: "id",
			parentProviders: ["openai-codex"],
			models: {
				"gpt-6-luna": {
					efforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
				},
				"gpt-6.1-sol": {
					efforts: { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max", ultra: "ultra" },
				},
			},
		},
		"claude-code": {
			executable: "claude",
			args: ["--print", "--no-session-persistence", "{modelArgs}", "--permission-mode", "acceptEdits", "--output-format", "json"],
			taskTransport: "stdin",
			modelArgs: ["--model", "{model}"],
			modelFormat: "id",
			parentProviders: ["anthropic"],
			models: { sonnet: {}, opus: {} },
		},
	},
};
