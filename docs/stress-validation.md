# Validation history

## Publication preparation — 2026-11-16

Prepared `@harrarz/pi-agnostic-subagents` 0.1.0 with Pi 1.5.2 development dependencies. Fresh offline suites pass **106 tests, zero failures, 12 opt-in checks skipped** on macOS with Node 22.19.0 and Node 26.3.0. Typecheck and publication-content checks pass; the actual allowlisted npm tarball loads in an isolated Pi runtime without development dependencies or a model request. Regular/fullscreen PTY checks use fake children, not provider inference. GitHub's macOS/Linux Node 22/24 CI matrix is configured, not yet remotely executed.

The minimum-Node check exposed a fast argument-transport child exiting before OS birth-identity lookup completed. Normal finalization now accepts only an exit observed through the local child handle and still requires verified owned-descendant cleanup; live/unobserved identity failures and unsent stdin/RPC tasks remain fail-closed. The existing lifecycle test now includes repeated external `true`/`false` processes. Final publication checking also exposed a transient cleanup-inspection gap: cleanup now retries unavailable snapshots within its existing deadline, still requiring a successful final scan. The existing macOS stop test injects both transient and persistent inspection failures; the former recovers, while the latter remains interrupted with `CLEANUP_UNVERIFIED`. No user run, settings, or installed extension was reloaded; no fresh provider-backed checks were run.

## Stress and live validation — 2026-11-13

Tested unrestricted explicit launches (no agent-count limit or scheduler queue) and the concurrent-shared-folder policy on macOS 15.5 (arm64), Node 26.3.0, Pi 1.5.0 and Codex CLI 0.169.0. Provider-backed checks used the selected `openai-codex/gpt-6.1-sol` model (Codex CLI: `gpt-6.1-sol`). Inference and disposable-project writes were explicitly authorized.

## Final result

**118 tests passed, zero failed, zero skipped** with CLI smoke, live Pi and stress flags enabled together. Typecheck and whitespace checks passed. Actual regular/fullscreen terminal checks also passed with live Pi children. Optional default LSP servers were unavailable; compiler diagnostics were used.

Removed `maxConcurrent`, `maxQueued`, `CAPACITY_FULL` and the pending-job scheduler. Every admitted run now launches from `starting`, without waiting for another run to finish. Shutdown waits for tracked launch/terminal-persistence completion; cancellation, process ownership/recovery, conversation identity, optional worktrees, explicit timeouts, and all existing output/protocol/display bounds remain intact. Legacy `queued` records are recovered as interrupted, never rescheduled. Private settings and active user sessions were not changed or reloaded.

## Deterministic stress checks

These run actual local child processes, not model inference, in temporary projects:

| Check | Observed evidence |
| --- | --- |
| Default unrestricted launches | All 32 simultaneous requests admitted and observed running, with zero queued/rejected. Five independent stops left the other 27 running; five replacements also launched immediately. No concurrency overrides. |
| Regression/public-runtime checks | 12 shared-folder children and 12 isolated worktrees ran concurrently with default options. Installed Pi RPC also launched 12 shared children together and confirmed each explicit stop. Starting cancellation never created a process; a delayed terminal write held shutdown until persistence completed. |
| Shared non-Git soak | 1,024 jobs in 64-job test batches, observed peak 64 active and zero queued. Every output file matched its quoted/multiline/Unicode stdin, all 8,192 append records were intact and unique, and all saved answers/process outcomes matched. No concurrency overrides; batch size is a test workload, not a product cap. |
| Soak timing/resources | Final combined run: 46,922 ms for the soak; test-process RSS rose from 176 MiB to a measured peak of 249 MiB while retaining 1,024 run records. This is a measurement, not a memory bound or proof of leak freedom. |
| Deliberate file collision | Both writers read the same original file before either wrote. One update was lost. This confirms concurrent shared writes, **not** conflict prevention. |
| Worktree concurrency/integration | 16 worktrees simultaneously running. Dirty/untracked parent state was not copied. All outputs stayed separate; dirty removal was refused. Explicit test-owned commits/merges integrated 14 independent artifacts, while competing edits to `common.txt` produced a real Git conflict. Clean removal kept the branches. |
| Output flood | 16 children emitted 64 MiB total. Each combined/stdout/stderr log stayed within its configured 32 KiB cap, and diagnostic tails stayed within 1 KiB. |
| Descendant cleanup | Eight runs exercised normal exit, stop, timeout and shutdown, including detached SIGTERM-resistant processes that forked on termination. Verified original groups and token-owned descendants were gone. |
| Crash/corrupt-record recovery | Killed a supervisor with eight active children. Six independently valid records were reconciled; two corrupt records stayed byte-for-byte unchanged and did not authorize signalling. The test used its previously captured valid ownership records to clean up those two children explicitly afterward. |

The barrier counts actual ready workers independently of submission order and holds all 64 before releasing them. Standalone and combined stress runs passed without any internal concurrency overrides. An initial combined run caught two fixture issues: the new RPC stop checks omitted the mandatory human confirmation responses, and a live final-answer prompt ambiguously ended its marker with a period. The fixture now answers each confirmation; the prompt explicitly excludes punctuation while keeping the exact-answer assertion. The complete rerun passed 118/118. Earlier 16-slot soak barrier/order fixes belong to the superseded bounded-capacity validation.

## Real inference and public tools

- Real Pi parent called `agent_start` once, a real child read/wrote a checked artifact, and the parent retrieved the exact clean answer through `agent_get`. Completion did not start an unsolicited parent turn.
- Real bash/sleep descendants were observed before stop and before timeout; cleanup removed them.
- Two real Pi worktrees overlapped, independently writing **34** and **51** to the same relative path without changing the dirty parent. A saved follow-up reused its workspace/history and produced **68**. Ownership checks found no remaining child processes.
- Current regular/fullscreen PTYs passed with both deterministic and real-inference children: answer/transcript/diagnostic rendering, resize, explicit control actions, model settings, three unrestricted shared agents, parallel worktrees, confirmed stop, timeout, widget dismissal/manual-view retention, reload and shutdown. They explicitly reject any capacity-wait message.

### Earlier public-tool checks

These public Pi/Pi and Codex/Pi interoperability checks predate count-cap removal; their evidence is retained, not claimed as a new cross-CLI rerun:

- Two public `agent_start` calls using default shared mode overlapped for **20,481 ms**. Their files contained **34** and **51**, each agent read its peer's result, and `agent_get` returned exact `LIVE_SHARED_ALPHA_OK` / `LIVE_SHARED_BETA_OK` answers.
- Public Codex and Pi runs overlapped for **30,347 ms** in the same disposable folder. Checked files contained **46** and **69**; input/parent markers were unchanged. `agent_get` returned exact `LIVE_CODEX_SHARED_OK` / `LIVE_PI_CROSSCLI_OK` answers through their respective protocol adapters.
- Both public-tool pairs had verified absent process groups and empty token-owner discovery after completion. Their disposable folders were removed; normal private run/session history was retained.

## Reproduce

Heavy local-process tests only (no provider requests):

```sh
PI_AGENT_SUPERVISOR_STRESS=1 npx tsx --test test/stress.test.ts
```

All automated checks, **including paid/quota-consuming inference**:

```sh
PI_AGENT_SUPERVISOR_CLI_SMOKE=1 \
PI_AGENT_SUPERVISOR_LIVE_PI=1 \
PI_AGENT_SUPERVISOR_STRESS=1 npm test
npm run typecheck
git diff --check
python3 test/fixtures/tui-smoke.py --live
```

The public-tool handshake checks above were explicitly dispatched in this Pi session rather than by `npm test`.

## Boundaries

This is strong evidence for the tested workloads, platform and account, not a guarantee of arbitrary task correctness or the machine's maximum possible concurrency. The extension imposes no agent-count ceiling or scheduler queue. Tested peaks of 32/64 shared agents and 16 isolated agents are workload sizes, not configured limits, proof of infinite capacity, or a measurement of this machine's maximum. Shared writes intentionally have no merge/conflict protection. Worktree integration remains explicit, not a new automatic extension feature. Logs are bounded, but retained metadata/session history and worktree disk usage are not globally capped. A plain non-Git directory cannot use Git worktree isolation. Windows and hostile processes that erase ownership metadata remain outside the supported cleanup guarantee. Claude's help flags were checked, but no Claude model execution was verified.
