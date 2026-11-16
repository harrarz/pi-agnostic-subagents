# Pi Agnostic Subagents

Launch and control coding agents from Pi, without prescribing a scout → worker → reviewer workflow.

- **Agent-agnostic:** bundled Pi, Codex, and Claude Code profiles; add another CLI through trusted user JSON.
- **Explicit delegation:** one requested task per launch, concurrent execution, no automatic fanout or nested delegation.
- **Live controls:** `/agent` browser and status widget, clean answers, transcripts, diagnostics, and confirmed stop/rerun.
- **Conversation controls:** human-directed steering and saved-session follow-up for RPC-capable profiles.
- **Your choices:** inherit the parent model, save a per-profile preference, or override one run; optional Git worktrees.
- **Owned lifecycle:** timeouts, descendant cleanup, crash recovery, private records, and bounded diagnostic logs.

## Install

Requires Node.js ≥22.19, Pi ≥1.5, and macOS or Linux. Install and authenticate each agent CLI separately.

```sh
pi install npm:@harrarz/pi-agnostic-subagents
```

When migrating a local installation, remove its old extension/package entry to avoid duplicate tools. Existing `/agent` commands, `agent_start` / `agent_get` / `agent_stop` tools, and `~/.pi/agent/agent-supervisor/` settings remain unchanged.

## Use

```text
/agent run --profile pi -- Fix token refresh and run the relevant tests
/agent run --profile codex --isolation worktree -- Update setup documentation
/agent
```

Use the browser to inspect, steer, stop, follow up, or rerun. `/agent settings` saves model preferences; `/agent profiles` lists trusted launch profiles. Unsupported interactive actions are hidden. The model-facing tools are `agent_start`, `agent_get`, and `agent_stop`.

## Architecture

```text
/agent commands + model tools
              ↓
   profile / model resolution
              ↓
         supervisor ─────────→ private records + bounded logs
              ↓
 shared folder / Git worktree
              ↓
    Pi / Codex / Claude / custom CLI
              ↕
     RPC / stdin / argv
              ↓
 output adapters → TUI + clean answers
```

TypeScript + Node.js; Pi supplies the extension/TUI/TypeBox peers. CLI differences are profile data, not supervisor branches.

## Know the boundaries

- Shared runs can overwrite each other's edits. Worktrees start at **committed HEAD**, do not copy dirty files, and are not security sandboxes.
- No automatic commits, merges, dependency installation, spending limits, or default timeout. There is no agent-count cap or scheduler queue.
- Process exit 0 does **not** establish task correctness. Review results and tests.
- Worktrees, records, and saved conversations remain until explicitly cleaned up; conversation history can grow and contain sensitive data.
- Clean structured answers are supported for Pi and Codex. Claude Code currently retains diagnostics only; its real model execution has not been validated by this project.
- Windows is unsupported. Cleanup assumes cooperative same-user CLIs, not hostile processes that erase ownership metadata.

## Development

```sh
npm ci
npm run check           # typecheck, offline tests, package-content checks
npm run test:tui        # actual terminals with fake children; no inference
pi -e ./src/index.ts    # one-off local trial
```

Provider-backed checks are separately opt-in and may consume quota; see the guides before running them.

[Configuration and custom CLIs](docs/configuration.md) · [Validation history](docs/stress-validation.md) · [MIT license](LICENSE)
