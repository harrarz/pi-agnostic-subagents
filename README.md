# Pi Agnostic Subagents

Launch and control whichever Pi subagent fits your task—no forced roles or workflows.

- **Agent-agnostic:** bundled Pi, Codex, and Claude Code profiles; add another CLI through trusted user JSON.
- **Explicit delegation:** run tasks concurrently in shared folders, single worktrees, or multi-repo worktree bundles—no automatic fanout or nested delegation.
- **Observability:** `/agent` browser and status widget, clean answers, transcripts, diagnostics, and confirmed stop/rerun.
- **Live controls:** human- or agent-directed steering and saved-session follow-up for RPC-capable profiles.
- **Owned lifecycle:** timeouts, descendant cleanup, crash recovery, private records, and bounded diagnostic logs.
- **Worker extensions:** none, inherited user extensions, or custom sets; choose per profile or run.

## Install

Requires Node.js ≥22.19, Pi ≥1.5, and macOS or Linux. Install and authenticate each agent CLI separately.

```sh
pi install npm:@harrarz/pi-agnostic-subagents
```

## Use

```text
/agent run --profile pi -- Fix token refresh and run the relevant tests
/agent run --profile codex --isolation worktree -- Update setup documentation
/agent run --profile pi --repo ../web=main --repo ../api=release/v2 -- Update the API and its consumer together
/agent
```

Use the browser to inspect, steer, stop, follow up, or rerun. `/agent settings` saves preferences; `/agent extensions` selects worker extensions; `/agent profiles` lists trusted launch profiles. Unsupported interactive actions are hidden. The model-facing tools are `agent_start`, `agent_get`, and `agent_stop`.

## Know the boundaries

- Shared runs can overwrite each other's edits. Single worktrees start at committed HEAD; bundles pin a branch or commit per repo. Neither copies dirty files or provides a security sandbox.
- No automatic commits, merges, dependency installation, spending limits, or default timeout. There is no agent-count cap or scheduler queue.
- Worktrees, records, and saved conversations remain until explicitly cleaned up.

## Development

```sh
npm ci
npm run check           # typecheck, offline tests, package-content checks
npm run test:tui        # actual terminals with fake children; no inference
pi -e ./src/index.ts    # one-off local trial
```

Development tests require Git; Linux zombie regression and terminal checks also require Python 3. Provider-backed checks are separately opt-in and may consume quota; see the guides before running them.

[Configuration and custom CLIs](docs/configuration.md) · [MIT license](LICENSE)
