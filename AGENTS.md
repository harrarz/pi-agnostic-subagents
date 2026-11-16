# Project guidance

Read `README.md` and `docs/configuration.md` before changing behaviour. This is the implemented Pi Agnostic Subagents extension; legacy `agent-supervisor` configuration paths and public command/tool names remain compatibility contracts.

Keep the extension agent-agnostic: new CLIs are added through trusted launch-profile configuration, not engine-specific supervisor branches. Model and effort overrides are optional; defaults come from the chosen profile/model configuration. Do not add orchestration, automatic reviews, messaging, Herdr, or Whiteboard integration.

Keep changes testable and documentation concise. Do not add planning or validation Markdown files. Verify real Pi/Codex flags and model identifiers rather than guessing. Do not claim semantic task success based on process exit code 0. Run the relevant tests and typecheck before reporting completion.
