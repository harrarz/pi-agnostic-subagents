# Pi Agent Supervisor

Explicit delegation without a prescribed scout → worker → reviewer loop.

- **One requested task, one background agent.** Trusted profiles launch Pi, Codex, Claude Code, or another CLI. No automatic fanout, roles, reviews, messaging, or nested delegation.
- **Live TUI.** A compact widget shows active/queued work; `/agent` opens a bordered, fully painted browser with inline arrow-selectable actions, live status, model/effort, elapsed time, activity, and queue reasons.
- **Direct controls.** Steer an active RPC agent, follow up in its saved conversation, or rerun a finished task—with optional changes. Unsupported profiles hide interactive actions. Nothing is sent or restarted automatically.
- **Your model choice.** Agents follow the current parent model. `/agent settings` (alias `/agent config`) lets you save a model per profile or restore “Follow parent”; `--model` overrides one run. Shipped profiles pin no model or effort defaults.
- **Quiet output.** Final answers and readable transcripts are separate from protocol logs. Reasoning is omitted from the readable transcript; raw diagnostics are opt-in.
- **Separate worktrees.** Opt into `--isolation worktree` / `isolation: "worktree"` for concurrent edits on separate branches. Worktrees start at committed HEAD, retain their changes, and never auto-commit or merge.
- **Safe lifecycle.** Owned process-tree cleanup, timeouts, crash recovery, bounded logs, and cross-process checkout writer locks. Exit code 0 is not a task-quality judgment.
- **Agent-agnostic.** Protocol presentation is selected in trusted profile configuration, never inferred from an executable name. Initial extractors support Pi JSONL and explicit plain text; unsupported formats remain diagnostic-only.

## Try it

```sh
npm ci
pi --extension ./src/index.ts
```

This does not reinstall the extension into your Pi settings. For permanent installation, use `pi install .`.

Trusted launch profiles must already exist at `~/.pi/agent/agent-supervisor/profiles.json` (or below `PI_CODING_AGENT_DIR`). **For an existing Pi JSON-mode profile, add `"outputProtocol": "pi-jsonl"` to that profile and restart Pi.** Existing profiles without this field retain raw diagnostic capture; they do not guess final answers. See [configuration](docs/configuration.md) for initial setup and migration.

```text
/agent run --label auth-fix --profile pi --isolation worktree -- Fix token refresh
/agent
```

**Worktree caveat:** uncommitted/untracked changes in the source checkout are not copied. The TUI and tool results show each worktree's path, branch and base commit. Inspect/recover the work before merging manually. `/agent worktree remove <id>` offers confirmed cleanup of a clean terminal worktree only; tracked, untracked and ignored changes are refused, and its branch is kept.

Model precedence: explicit `--model`/tool argument → saved `/agent settings` choice → current parent model. Changes apply to future launches. Incompatible CLI/provider combinations fail clearly instead of guessing a fallback. Pi choices use the session's available/scoped catalog; other CLI profiles also accept exact CLI IDs/selectors.

In the browser: ↑/↓ selects an agent, ←/→ selects its inline action, Enter applies it. Running agents offer Inspect/Steer/Stop; queued agents offer Inspect/Cancel; finished agents offer Inspect/Follow up/Rerun/Rerun with changes. Steer/Follow up appear only when supported. Stop/Cancel and fresh reruns require confirmation. `a` shows the answer, `t` the readable transcript, `d` diagnostics, `s` confirmed stop, Esc backs out. Workspace details keep destructive cleanup separate. The tree is `main → direct child processes`, not invented grandchildren.

The shipped Pi profile uses RPC. **Existing installations:** replace only the Pi profile's `args` and `taskTransport` with those in `profiles/verified.json`, then `/reload` when existing runs have finished. Old one-shot runs cannot acquire steering or saved history retroactively. Model/effort selections remain yours.

Model tools: `agent_start`, `agent_get` (clean answer/status by default; `transcript`/`raw` opt-in), and `agent_stop`. Completion notifications include a short answer preview but do not trigger new parent model turns.

## Boundaries

- Shared-checkout runs remain serialized, including investigations. Explicit isolated worktrees can run concurrently within the session's capacity limit (two active by default). This is cwd/branch isolation, not an OS sandbox.
- Worktrees/branches are retained after stop, timeout, failure, crash and normal completion. No automatic dependency installation, source-dirty-state copying, commits, merges or forced cleanup. Worktree disk usage persists until explicit cleanup.
- Steering is delivered at a turn boundary, not an immediate interrupt. Follow-up reopens a safely settled saved RPC conversation as a new tracked turn, preserving model/settings and workspace, and reacquiring its writer lock. No idle process holds locks or capacity. Cancelled/timed-out/uncertain turns are not offered continuation. Rerun creates a fresh conversation and, for worktree mode, a fresh checkout from current committed HEAD; it does not copy the previous agent's edits. Nested delegation and inter-agent messaging remain absent.
- Saved RPC sessions are private and retained separately from bounded diagnostics; they contain conversation/tool history and can grow with follow-ups. There is no automatic session deletion. Custom RPC extension dialogs are not bridged.
- Node.js ≥22.19.0 and POSIX process groups are required. Windows is currently disabled.
- Retained logs are bounded, not complete archives; inspect truncation notices. Raw logs may contain reasoning and sensitive tool output.
- With explicit quota/cost approval, real Pi parent/child delegation, read/write artifacts, clean answer retrieval, stop/timeout of actual bash descendants, and regular/fullscreen terminal flows have been tested. Codex/Claude provider tasks remain unverified. Offline tests never call a provider; live tests are separately opt-in.

## Reproduce the checks

```sh
PI_AGENT_SUPERVISOR_CLI_SMOKE=1 npm test   # includes no-task CLI checks
npm run typecheck
python3 test/fixtures/tui-smoke.py         # actual terminals, fake children
```

Only after approving provider quota/cost:

```sh
PI_AGENT_SUPERVISOR_LIVE_PI=1 npx tsx --test test/live-pi*.test.ts
python3 test/fixtures/tui-smoke.py --live
```

Live checks use temporary private copies of the existing Pi config/credentials and temporary workspaces; they do not install packages or rewrite your user profiles. Merely loading the extension starts no agents—inside Pi, run `/agent` to open the browser or `/agent run -- <task>` to launch one.

[Implementation plan](docs/implementation-plan.md) · [Installation/configuration](docs/configuration.md)
