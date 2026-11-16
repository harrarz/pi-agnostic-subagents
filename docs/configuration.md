# Installation and configuration

This is an operator guide for installing the extension and defining its trusted headless-agent launch profiles. The extension does not read executable commands from the project checkout, task text, or tool arguments.

## Install the extension

Install the public Pi package (Node.js ≥22.19, Pi ≥1.5; macOS/Linux):

```sh
pi install npm:@harrarz/pi-agnostic-subagents
```

For development from this repository:

```sh
npm ci
pi install .
```

The public package name changed from the local project's working name; `/agent`, model tool names, and the existing `agent-supervisor` configuration/runtime directory are intentionally unchanged. Remove the old local extension/package declaration when migrating, rather than loading both copies.

For a one-invocation smoke test without changing Pi's package settings:

```sh
pi --extension ./src/index.ts
```

The package declares `./src/index.ts` as its Pi extension entry. Pi supplies `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` at runtime; they are peer dependencies, not bundled copies.

## Built-in and user profiles

The extension bundles trusted default profiles for Pi, Codex, and Claude Code; no profile copy step is required on a fresh install. If the private user profile file is absent, the bundled profiles are used without writing a file. If it exists, its profile entries overlay bundled entries by name: a matching user profile replaces that whole built-in profile, while unmentioned built-ins remain available. Both top-level fields are optional in user overrides: omitted `defaultProfile` keeps `pi`, and omitted `profiles` keeps all built-in entries. An explicit `defaultProfile` can name either a built-in or custom profile. Invalid or unreadable user configuration is reported rather than silently ignored.

The optional private user profile file is loaded only from:

- `$PI_CODING_AGENT_DIR/agent-supervisor/profiles.json`, when `PI_CODING_AGENT_DIR` is set; or
- `~/.pi/agent/agent-supervisor/profiles.json` otherwise.

Profiles are trusted executable configuration. Keep this file user-controlled; project-local profiles are never loaded. The extension loads profile definitions once per Pi session. After all agents finish, restart Pi or `/reload` to apply edits. Extension updates do not rewrite this file; no fork or source-code changes are needed.

Private run records and bounded output logs live below the same config root's `agent-supervisor/runtime/`. No checkout-lock directory or SQLite guard is created or consulted. Legacy lock artifacts are left untouched and ignored. The extension creates its runtime directories as `0700` and run records/logs as `0600`. Version 1 retains run records and bounded logs until an operator removes them; each of the combined/stdout/stderr logs is capped at 1 MiB (up to 3 MiB per new run) and diagnostic output tails at 16 KiB. Readable transcripts retain up to 100 entries and 24 Ki characters; extracted answers retain 12 Ki characters. Tool text responses are additionally capped below Pi's 50 KiB/2,000-line limit. Truncation is reported; retained logs are not complete archives. New runs persist their presentation at terminal completion; live activity is in memory and is not a crash-durable event journal. Do not remove runtime data while a supervised run is active.

## Profiles and model choices

A profile declares a literal executable, an argv array, task transport (`argument`, `stdin`, or explicit `pi-rpc`), model/effort argument groups, and optional verified effort mappings. **Profiles do not support `defaultModel`; bundled profiles force no effort defaults.** Normal launches select models in this order: explicit `--model`/tool argument → per-profile user selection from `/agent settings` → the current parent session model. A change to the parent model is picked up on the next launch unless a user preference overrides it. Running agents are never changed retroactively.

`/agent settings` (also `/agent config`) opens the model configuration TUI. Pick a launch profile, then Follow parent, Choose available model, or Enter exact model ID. Pi's current scoped models are used when set, otherwise its available model registry; bare-ID CLI profiles also offer configured CLI selectors. User preferences are saved privately in `<supervisor-config-directory>/settings.json` as `{"models":{"profile":"exact-model-id"}}`; removing a profile's entry restores inheritance. Save is atomic, files are mode `0600`, and project preferences are not loaded. Invalid/unavailable saved Pi choices fail rather than silently falling back. Exact bare CLI IDs are ultimately validated by that CLI; the supervisor does not invent cross-provider mappings.

Model flags are declarative: `modelArgs` is an argv array with one `{model}` placeholder, expanded at a whole-argument `{modelArgs}` slot in `args`. `effortArgs` similarly expands at `{effortArgs}` only when effort is selected; otherwise the complete group is omitted. Group ordering and task transport are preserved. `modelFormat: "qualified"` inherits `provider/model`; `"id"` inherits just the model ID. `parentProviders` optionally restricts compatible parent providers. An incompatible parent produces a clear selection error; a per-run or settings choice can explicitly name a compatible CLI model instead. There are no executable-name branches.

`models` is verified per-model **effort metadata**, not a model allowlist. New available Pi models need no profile edit when no effort override is requested. Unknown explicit effort mappings still fail. Older profiles must remove `defaultModel` and move direct `{model}`/`{effort}` argv values into `modelArgs`/`effortArgs`, replacing those flag/value pairs in `args` with the corresponding group slots. Old syntax is rejected rather than silently migrated; private files are never rewritten. The bundled profiles use the same generic launcher:

- `pi`: `pi --no-extensions --mode rpc --session <private-session-path> ...`; `--no-extensions` prevents recursive supervisor loading. `taskTransport: "pi-rpc"` sends prompts and human steering as correlated JSONL commands. The private path is generated internally via one whole-argument `{session}` slot; tasks cannot choose it. This transport requires `outputProtocol: "pi-jsonl"`. Other executable names may implement the same wire contract; no executable-name inference is used.
- `codex`: `codex exec --sandbox workspace-write --json ... --ephemeral -`; the task is written to stdin, and `-` tells Codex to read the prompt there. Workspace-write is explicit because headless Codex otherwise defaults to read-only; no sandbox/approval bypass is used. The `codex-jsonl` presenter exposes assistant replies and activity, including replies explaining that a task was blocked.
- `claude-code`: `claude --print --no-session-persistence --model ... --permission-mode acceptEdits --output-format json`; the task is written to stdin. It inherits only an Anthropic parent by bare ID, or accepts an explicit CLI selector such as `sonnet`/`opus`; neither is a supervisor default.

The bundled Pi effort metadata covers the verified IDs `openai-codex/gpt-6-luna` and `openai-codex/gpt-6.1-sol`; the Codex metadata covers `gpt-6-luna` and `gpt-6.1-sol`, including Sol's verified `ultra` effort. These are capability entries, not defaults. Codex inherits only an `openai-codex` parent by bare ID. Unspecified effort leaves the chosen CLI's own configuration in control. The Claude Code profile intentionally does not pass an effort override: supported levels depend on the model and provider, and the CLI can clamp unsupported levels. Therefore `--effort` selections for this profile are rejected until you explicitly configure verified effort mappings in your trusted profile. Use `/agent profiles` to view configured model IDs and effort options. For example:

```text
/agent run --profile pi --model openai-codex/gpt-6.1-sol --effort high -- Add a regression test
/agent run --profile codex --model gpt-6.1-sol --effort ultra -- Explain this module
/agent run --profile claude-code --model opus -- Update this module
```

Unavailable qualified Pi models and unsupported explicit effort selections fail before process launch; the extension does not silently choose a fallback. Other CLIs validate exact bare model IDs at execution. To customize flags or effort mappings, add that profile name to the optional user profile file; it replaces the bundled profile with that name. Verify flags/efforts before overriding. The executable names `pi`, `codex`, and `claude` are resolved through the parent Pi process's `PATH`.

### Add a custom CLI without a fork

Install/authenticate the CLI separately, then create `~/.pi/agent/agent-supervisor/profiles.json` (or the config-root override above). This is a complete user file for a CLI that reads its task from stdin:

```json
{
  "profiles": {
    "my-agent": {
      "executable": "my-agent",
      "args": [],
      "taskTransport": "stdin"
    }
  }
}
```

If a user file already exists, merge the entry into its `profiles` object instead of replacing the file. Keep it private (`chmod 600` on POSIX). No need to copy any bundled profiles; `pi`, `codex`, and `claude-code` remain available. After all agents finish, restart Pi or `/reload`, then run:

```text
/agent profiles
/agent run --profile my-agent -- Explain this module
```

Use the CLI's real executable and documented headless flags. `args` is a literal argv array, not a shell command. If it accepts a prompt argument instead, use `"taskTransport": "argument"` and put exactly one whole `"{task}"` element in `args`. Executables resolve through Pi's `PATH`, or can be absolute paths. The example captures diagnostics; set `"outputProtocol": "text"` only if stdout is plain answer text. Existing output protocols, timeouts, stop, and optional worktree isolation work without adding supervisor branches; arbitrary interactive terminals are not supported.

To make a built-in or custom profile the default, add e.g. `"defaultProfile": "my-agent"` alongside `profiles`. This does not pin a model. A profile without model-selection support uses that CLI's own configuration. To expose model choice, use `args: ["{modelArgs}"]` and `modelArgs: ["--model", "{model}"]` when the CLI supports that flag; set `modelFormat` to `qualified` or `id` according to its verified syntax, and restrict compatible parent providers where needed. Do not add a pinned model default. Add an `effortArgs` slot/group and per-model `models.*.efforts` mappings only when those flags and values have been verified.

### Verification scope

Launch syntax was cross-checked against the installed CLIs and their official online documentation on 2026-10-06:

- **Pi 1.0.0:** [Pi CLI docs](https://pi.dev/docs/latest/cli) document `--print`, `--mode json`, `--model`, `--thinking`, `--no-session`, and `--no-extensions`. The installed offline RPC state resolved `openai-codex/gpt-6-luna` and `openai-codex/gpt-6-sol`; the installed CLI lists `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max` thinking levels.
- **Codex CLI 0.160.1 (local recheck):** the [Codex CLI reference](https://developers.openai.com/codex/cli/reference) documents `codex exec`, `--json`, `--model`, and `--config key=value`; the [Codex CLI cookbook](https://developers.openai.com/codex/cookbook/examples/codex/build_iterative_repair_loops_with_codex) demonstrates stdin via `-` and `model_reasoning_effort`. Installed `codex exec --help` additionally confirms `--ephemeral`. `codex debug models` marked `gpt-6-luna` and `gpt-6.1-sol` as API-supported and lists `low`, `medium`, `high`, `xhigh`, and `max` for Luna, plus `ultra` for Sol. The profile passes effort in one literal argv value such as `model_reasoning_effort="max"`, not shell syntax.
- **Claude Code 2.1.175:** installed `claude --help` accepts `--print`, `--no-session-persistence`, `--model`, `--permission-mode acceptEdits`, and `--output-format json`; a no-task help invocation with these options exited successfully. The official [CLI reference](https://code.claude.com/docs/en/cli-reference), [model configuration](https://code.claude.com/docs/en/model-config), [programmatic usage guide](https://code.claude.com/docs/en/headless), and [permission modes](https://code.claude.com/docs/en/permission-modes) confirm print-mode stdin, JSON output, the `sonnet`/`opus` aliases, and the model-dependent nature of effort/permissions. The profile deliberately omits `--effort` so provider-specific aliases cannot silently clamp an unverified override. `acceptEdits` allows file edits and common filesystem commands; other shell/network commands still depend on Claude Code's configured permissions. Print mode skips the workspace trust dialog, so use only trusted checkouts.

The Pi and Codex model IDs and effort lists above were checked against installed offline catalogs; Claude Code's `sonnet`/`opus` CLI selectors are documented and passed through unchanged, but no model request was made to check provider entitlement or availability. Those original offline checks did not verify authentication, service availability, or billing. With explicit operator approval on 2026-11-10, real Pi parent/child tasks on `openai-codex/gpt-6-luna` at `minimal` effort subsequently passed: actual read/write artifact, exact clean final answer, parent tool retrieval, and real bash-descendant cleanup on stop and timeout. Regular/fullscreen PTY sessions also displayed real Pi child answers. These tests establish that tested Pi/account/model path at that time, not other providers or future service availability; a later approved Codex CLI prompt returned the requested marker, while Claude Code reached its authentication error without making a model request. Live Pi steering and saved-session follow-up also returned their requested markers. Recheck installed CLI catalogs and flags after upgrades. `PI_AGENT_SUPERVISOR_CLI_SMOKE=1 npm test` sends only Pi's `get_state` RPC command, queries Codex's local model catalog, and checks Claude's help output; it sends no task prompt.

### Opt-in real Pi checks

The ordinary suite never contacts a paid provider. Its installed-Pi RPC check uses a deterministic HTTP endpoint bound only to loopback, with a dummy key and isolated configuration. `PI_AGENT_SUPERVISOR_LIVE_PI=1 npx tsx --test test/live-pi*.test.ts` and `python3 test/fixtures/tui-smoke.py --live` are explicitly opt-in, use existing credentials, and consume quota or may incur charges. They read the existing trusted `pi` profile, use the current user-selected parent model (session environment, then Pi user settings), use a verified `minimal` effort override only when that model has one (otherwise omit the effort argument), copy credentials/config into private temporary directories, isolate task files in temporary Git workspaces, and select `pi-jsonl` in the temporary profile. No user profile/settings are rewritten or packages installed. The real read/write test asserts the file's contents and exact answer; it does not equate process exit with task correctness.

## Commands and tools

- `/agent` opens the live run browser in interactive TUI mode; a bounded widget above the editor shows starting/running work and activity.
- `/agent run [--label name] [--profile name] [--model model-id] [--effort alias] [--cwd path] [--isolation shared|worktree] [--timeout-ms n] -- <task>` starts one task.
- `/agent settings` (alias `/agent config`) configures Follow parent or a saved model per profile.
- `/agent list`, `/agent show <run-id>`, `/agent stop <run-id>`, and `/agent profiles` inspect or manage runs and configured model IDs/efforts.
- `/agent worktree remove <run-id>` confirms non-forced cleanup of one owned terminal worktree, keeping its branch.
- Model tools: `agent_start`, `agent_get`, and `agent_stop`. `agent_start` accepts optional `isolation: "worktree"`; cleanup is deliberately not a model tool.

The browser uses Pi's theme, terminal-width helpers, and selection keybindings; it supports regular/fullscreen modes, resizing, and keyboard-only operation. The browser paints a complete rectangular background inside a themed border, including blank rows. Up/down select a run or scroll detail; left/right select an inline contextual action and Enter executes it. Actions include Inspect, capability-gated Steer/Follow up, confirmed Stop/Cancel, confirmed fresh Rerun, Rerun with changes, and Workspace. `a` shows the answer, `t` the readable transcript, `d` a diagnostic snapshot, `s` confirmed stop, and Esc returns/closes. Rerun with changes edits task, exact model, effort, timeout (blank removes it), and isolation before explicit Run confirmation. PageUp/PageDown and Home/End also navigate. `/agent show <id>` opens that run in the browser in TUI mode and emits a clean text detail in RPC mode. Widget/browser subscriptions and timers are disposed on close, reload, session change, or shutdown. The browser retains all active runs and the latest 50 terminal runs; tools return up to 20 at a time, active first.

Each row is a direct child of `main` in the owning Pi session. Names are optional display labels, not ownership tokens; full run IDs remain authoritative. There is no nested-delegation channel and no invented ancestry. The widget shows at most four active runs (fewer on short terminals), plus an overflow count. Finished rows disappear while other runs continue. Once the last observed run finishes, the widget collapses immediately to one process-outcome summary line for three seconds, then disappears and returns the space to the editor. Failures/timeouts do not pin it open; once-per-run notifications and `/agent` retain their details. New work immediately restores live status and cancels pending dismissal. Initial/reloaded terminal history never resurrects the widget. Summary expiry does not close or disturb a manually opened browser/answer view; those remain open until Esc. Finished/failed counts describe process outcomes, not task correctness.

Tools remain available in JSON/RPC/print modes; no custom TUI is opened there. `agent_get` defaults to clean status, final answer, and diagnostic paths. `format: "transcript"` adds bounded assistant text and tool activity/results, excluding reasoning; `format: "raw"` adds the retained combined log tail. Oversized tool text is truncated with a diagnostic-path notice (and may therefore no longer be standalone JSON). Completion notifications include a bounded answer preview but never inject a message into the parent model or start an automatic turn. A process exit code is not a judgment that the coding task is correct.

### Steering and follow-up

These are explicit human browser actions, not model-facing messaging tools or automatic orchestration. Steer queues an instruction at the next turn boundary; it does not interrupt a running tool. An acknowledgement means queued/handled, not guaranteed delivery. If the agent finishes while the message editor is open, sending fails rather than silently starting another turn. Delivered user messages appear in the bounded readable transcript.

After a safely settled normal RPC exit with a saved answer/session, Follow up reopens the same conversation as a new tracked run/turn. It keeps the resolved model/effort, timeout, checkout and uncommitted workspace edits, and launches immediately after its starting record is persisted. Admission prevents simultaneous continuations of one conversation. No idle child is kept alive; no automatic follow-up occurs. Cancelled, timed-out, missing-session, removed-workspace and uncertain runs do not offer continuation. Historical turn results remain accessible by ID. Worktree cleanup checks all related turns, not just the originally selected run.

Rerun starts a separate conversation with the same resolved launch choices unless edited. An isolated rerun creates a **new** worktree from current committed HEAD, not a copy of the previous worktree. CLI defaults remain CLI defaults when an argument was originally omitted. Saved RPC conversations live privately under `runtime/sessions/`, are retained, contain full conversation/tool history, and are not subject to diagnostic-log bounds; remove them manually only while idle if no longer needed. Custom child extension UI dialogs are not bridged.

To enable this for an existing private `pi` profile, update its `args`, `taskTransport`, `modelArgs`, `effortArgs`, and `outputProtocol` to the bundled RPC recipe while retaining any other intentional user choices. If no user `pi` profile is present, the bundled RPC profile is already used. Reload only after existing runs finish. Old one-shot records lack saved sessions and cannot gain steering/history retroactively; unsupported profiles continue one-shot execution.

### Output protocols and existing profiles

Add `outputProtocol` to a **trusted profile**, not to a task/tool call:

- `"pi-jsonl"`: incremental parsing of Pi's documented JSON-mode event stream. Extracts tool activity, assistant text, and tool results. A final answer requires a final non-tool assistant message, `agent_settled`, and a normal process exit without a process/storage error. Protocol failure/abort/incomplete streams never manufacture a final answer or change process lifecycle state. Oversized or malformed records are skipped with a warning; raw logs remain available.
- `"text"`: treat stdout as answer text (first 12 Ki characters); stderr is diagnostic-only. Use this only for CLIs whose stdout is actually plain answer text, not JSON/events/progress logs.
- `"codex-jsonl"`: parses Codex's documented `turn.*` and `item.*` events. Extracts bounded command/file-change activity and assistant replies, omitting reasoning items. The latest reply is published only after `turn.completed` and clean process completion; protocol errors, incomplete turns and process failures suppress the answer. A blocked-task reply is displayed as written, not interpreted as task success.
- `"raw"` or omitted: diagnostics only; no guessed activity or final answer. This remains the default for unspecified protocols and the Claude JSON profile, whose structured adapter is deferred.

The bundled Pi profile selects `"pi-jsonl"`; Codex selects `"codex-jsonl"`. For an existing private Codex override, add `"outputProtocol": "codex-jsonl"` and `"--sandbox", "workspace-write"` to its `exec` arguments if editable tasks are intended (retain any intentionally stricter permission policy). Changes apply after an idle reload, not to historical runs. **Existing user profiles are not rewritten automatically:** if your private file overrides the `pi` profile, add this field to that profile and restart Pi. No model IDs or CLI flags need changing for presentation. Protocol adapters are presentation capabilities, not executable-name branches; another executable can emit the same Pi JSONL contract.

Raw stdout/stderr and combined logs can contain reasoning, commands, and sensitive output. They remain private and bounded. Terminal controls in child-authored display text are stripped before rendering. Legacy records with only a combined log remain readable; clean results cannot be reconstructed retroactively from a truncated legacy tail.

## Parallel shared folders (default)

Omit `isolation`, or use `--isolation shared` / `isolation: "shared"`, to run directly in the current folder. Shared agents execute concurrently, including in non-Git directories and across Pi sessions. They see the current uncommitted/untracked files and write changes directly into that same folder; no merge-back step is needed.

There is no checkout lock or lock-and-wait mode. Concurrent agents, the parent Pi and external tools can overwrite each other's edits or interfere with tests/builds. Scope simultaneous tasks to independent files when possible; choose worktrees when separate checkouts are needed. No conflict detection or automatic coordination is provided.

There is no extension-imposed active-agent limit, scheduler queue, queue-capacity rejection, or hidden replacement throttle. Every explicitly requested run launches once validation and its private starting record are ready; independent agents do not wait for other runs to finish. The available machine resources, CLI/provider limits and your spending choices determine practical concurrency. Actual spawn/provider failures are reported, not requeued or silently retried. Stop/timeout still clean up only that run's owned processes. Brief ordered admission bookkeeping protects record creation and duplicate saved-conversation continuations; it is not an agent-count quota.

## Optional separate worktrees

Use `/agent run --isolation worktree -- <task>` or `agent_start({ task: "…", isolation: "worktree" })` to give a run its own checkout and `pi-agent/<run-id>` branch. Shared and isolated runs launch without an active-agent ceiling or scheduler queue. This creates no tasks automatically and prescribes no roles or reviews.

- Source is the **committed HEAD captured at admission**. Local tracked edits, untracked files, ignored dependencies and other dirty state are not copied or stashed. The captured base stays pinned even if source HEAD advances during setup. Commit the inputs you want available first; the extension never commits/stashes the parent for you.
- A requested source `cwd` must still be inside the parent's Git checkout and must exist as a directory in the captured commit. It maps into the new worktree. Non-Git/unborn repositories and missing committed directories fail explicitly, never falling back to edit the parent.
- Private worktrees live at `<supervisor-runtime>/worktrees/<run-id>`. The generated intent/path/branch/base are persisted before Git creation; creation starts immediately after admission. Cancelling a starting run before workspace preparation creates no worktree/branch. Git checkout hooks are disabled for this operation. No dependencies or submodules are initialized automatically.
- There are no supervisor checkout locks. Each new isolated run has its own generated worktree path and branch. This is filesystem cwd/branch separation, **not an OS permission sandbox**: a trusted CLI can still address absolute paths elsewhere. External writers/editors are not coordinated.
- Tool start/detail/list results, notifications and the browser report isolation, workspace state, source path, branch, base commit and retained worktree path. Completed records remain inspectable after reload. Process status/exit code still makes no task-quality claim.
- All worktrees and branches are retained after exit, failure, cancellation, timeout, shutdown and crash recovery. No automatic commit, merge, branch deletion or destructive rescue step occurs. If setup fails partway, its generated path/branch are reported for manual inspection rather than silently removed. Disk usage is not bounded like the output logs.

After reviewing changes, commit/recover and merge manually using ordinary Git. For example, run `git -C <worktree-path> status`, commit there if desired, then merge its branch from the target checkout. Branches do not magically include uncommitted edits; the branch initially points at the recorded base commit.

`/agent worktree remove <run-id>` is human-confirmed and accepts only a terminal run owned by this Pi session. It verifies generated path/branch, source repository and Git registration; refuses active related turns and live/uncertain PIDs/groups/owned descendants; checks tracked, untracked **and ignored** files; then uses `git worktree remove` **without `--force`**. Git's own safety checks remain enabled. The branch is never deleted, including when it contains manually committed work. Already absent worktrees are handled idempotently. Branch changes, substituted/unregistered paths, dirty/ignored content or unclear ownership cause refusal with paths left intact. Runs marked `interrupted` after recovery and failed workspace setups require manual Git inspection/cleanup even if the directory appears clean: preparation/descendant state may be uncertain. Do not edit a worktree concurrently with manual cleanup; no extension can coordinate arbitrary external processes.

The optional feature works through the generic launcher for Pi, Codex, Claude Code and other configured CLIs. No user profile edits or package reinstall are required for the new per-run flag. Reload the extension **after existing runs finish** to load the new tool schema; reload otherwise cancels those runs as before.

## Safety and operating limits

- Treat `profiles.json` as executable configuration. Keep it in a user-controlled location and do not copy profile data from an untrusted project.
- No shell is used to launch a child. `{task}` occupies one argv element or is sent through stdin. A task passed as an argv element may be visible in process listings; the Codex sample uses stdin.
- Shared writes are concurrent by default, including across Pi sessions and outside Git. There is no supervisor file/checkout locking or conflict prevention. There is no per-session or global agent-count cap. Worktree isolation requires Git and does not copy the source folder's dirty state.
- Cleanup uses the original POSIX group plus same-user processes with the run's inherited ownership token, including detached groups. Each discovered PID is rechecked against its start identity and exact token before signalling; token-prefix matches are not ownership. On Linux, scans exclude processes older than the original child (or, only for a locally observed fast exit, this supervisor), because they cannot have inherited the new run token; unreadable potential descendants still cause uncertainty. Transient process-inspection gaps are retried only within the cleanup deadline, without signalling from unavailable snapshots. If inspection stays unavailable or cleanup remains uncertain, the run is `interrupted`, no final answer is published, and extension-managed continuation/worktree removal is refused. No checkout reservation blocks other runs. A very fast argument-transport child can finish before its birth identity is readable; only its locally observed child-process exit plus verified descendant cleanup permits normal terminal recording in that case. Unverified live processes and unsent stdin/RPC tasks remain interrupted. This is not containment of hostile processes that deliberately erase tokens or change user identity. Windows is rejected during initialization. Node.js 22.19.0 or newer remains the supported runtime baseline.
- Corrupt/unreadable individual run records are left unchanged and skipped with a startup warning and `agent_get.recoveryWarnings`. Independently valid runs are still reconciled, including owned-child cleanup after a crash. The skipped run's ownership/outcome remain unknown; inspect and repair the named file manually. Follow-up and extension-managed worktree removal are disabled while history warnings remain; repair and reload only while idle. No process is signalled based on invalid metadata.
- Agent counts are unrestricted by the extension. There is no built-in spending/token/turn budget or default run timeout. Request only the work you intend to pay for; stop a run or close the session to clean up owned children. Optional explicit timeouts and existing protocol/output/display bounds remain unchanged.

## Maintenance

Owner: project maintainers. Recheck the sample flags, model catalog entries, and effort lists whenever the installed Pi or Codex CLI changes. The opt-in offline smoke test is the executable check; update the profile and this guide together when model IDs or supported efforts change.
