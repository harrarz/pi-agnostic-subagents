# Pi Agent Supervisor

A planned Pi extension for explicitly launching and supervising headless coding agents. **No extension code has been implemented yet.**

- One requested task starts one background run; editing is the default.
- A configured launch profile supplies the executable, arguments, task transport, and model mapping. Pi and Codex are sample profiles, not separate code adapters.
- The supervisor tracks process status and bounded output, supports stop/timeout, and serializes supervised writers in the same checkout.
- The default model is configured (expected to be Luna); a caller can override it (for example, Sol) without a model-selection UI.
- Pi provides `/agent` and three model tools: `agent_start`, `agent_get`, `agent_stop`.
- No automatic fanout, reviews, agent messaging, shared channel, Herdr, or Whiteboard integration.

**Implementation handoff:** [docs/implementation-plan.md](docs/implementation-plan.md). Start there; it is the canonical scope and acceptance contract. Do not treat any illustrative CLI arguments or model aliases as verified until the preflight in the plan is complete.
