# Project guidance

Read `docs/implementation-plan.md` before implementing anything. This repository currently contains planning/scaffolding only.

Keep the extension agent-agnostic: new CLIs are added through trusted launch-profile configuration, not engine-specific supervisor branches. A model override is optional; default model selection comes from the chosen profile. Do not add orchestration, automatic reviews, messaging, Herdr, or Whiteboard integration.

Implement the plan in dependency order, keep each increment testable, and record any changed assumptions in the plan. Verify real Pi/Codex flags and model identifiers rather than guessing. Do not claim semantic task success based on process exit code 0. Run the relevant tests and typecheck before reporting completion.
