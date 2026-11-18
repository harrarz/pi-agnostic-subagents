# Configuration

## Profiles

Pi, Codex, and Claude Code are bundled. Install/authenticate each CLI separately. Optional overrides live in `$PI_CODING_AGENT_DIR/agent-supervisor/profiles.json` (default: `~/.pi/agent/agent-supervisor/profiles.json`). Each named override replaces that whole profile; other bundled profiles remain available.

Add a CLI without changing source:

```json
{
  "profiles": {
    "my-cli": {
      "executable": "my-cli",
      "args": ["{task}"],
      "taskTransport": "argument",
      "outputProtocol": "text"
    }
  }
}
```

Use `stdin` transport without `{task}` for stdin-based CLIs. `pi-rpc` requires a whole `{session}` slot and `pi-jsonl` output. Output protocols: `text` for plain stdout, `pi-jsonl` for Pi, `codex-jsonl` for Codex, or `raw` for diagnostics only.

Profiles are trusted user configuration, never project/task input. Arguments are literal, not shell commands. Add `defaultProfile` to choose a default CLI. Profiles load once per session; restart/reload only after active runs finish. Updates never rewrite private profiles.

## Models and effort

- Model precedence: run override → saved per-profile preference → parent model. Use `/agent settings` to save or clear a preference.
- A `modelArgs` group such as `["--model", "{model}"]` expands at `{modelArgs}` in `args`. `modelFormat` is `qualified` (`provider/id`, default) or `id`; optional `parentProviders` restricts inheritance.
- `effortArgs` works similarly with `{effort}`/`{effortArgs}`. Declare verified aliases under `models.<model-id>.efforts`. Omitted effort uses configured defaults or leaves the CLI unchanged. Unsupported selections fail; no model is silently substituted.

## Worker extensions

| Mode | Loads |
|---|---|
| `none` (default) | No discovered or built-in extensions. |
| `inherit` | Enabled user extensions and built-ins, respecting Pi's resource filters. |
| `custom` | Only a trusted named set of explicit entry files/built-in IDs. |

```text
/agent run --profile pi --extensions inherit -- Fix the parser
/agent run --profile pi --extensions custom --extension-set durable -- Update tests
/agent run --profile pi --extensions none -- Explain this module
```

`agent_start` accepts the same `extensions` and `extensionSet` choices. Set names require explicit `custom` mode; agents cannot supply paths or install packages. Precedence: run override → saved preference → profile default → `none`.

Use `/agent extensions` (also linked from `/agent settings`) to pick defaults and create named sets from user extensions. Choices are saved privately in `agent-supervisor/extensions.json`; changes affect new launches only. Rerun with changes also offers a mode picker.

The bundled Pi profile supports these modes. For an existing private Pi-compatible profile, replace its literal extension flags with one whole `{extensionArgs}` slot and add:

```json
{
  "extensionArgs": { "none": ["--no-extensions"], "load": ["--extension", "{extension}"] },
  "extensions": { "mode": "none" }
}
```

Keep its other session/model/effort arguments. Profiles without this capability keep their old behaviour and reject overrides; Codex/Claude defaults are unchanged. A custom default uses `{"mode":"custom","set":"durable"}`.

Trusted sets can also be added alongside `profiles` in `profiles.json`:

```json
{ "extensionSets": { "durable": ["/absolute/path/to/pi-durable-harness/src/index.ts"] } }
```

Sets accept absolute JS/TS entry files or `builtin:<name>`. Picker-created sets take precedence over same-named file definitions. Inherit uses the worker's effective `PI_CODING_AGENT_DIR`; project extensions and temporary parent `-e` additions are not inherited. Missing configured packages are not installed automatically.

Follow-ups and unchanged reruns keep the resolved selection. Missing selected files fail; extension code itself is not frozen. Worker guards disable this supervisor's delegation tools. Extension errors and unsupported blocking dialogs stop the worker—no automatic approvals. Durable must actually load to journal a worker; this does not add automatic worker restart.

## Workspaces and history

Shared runs write concurrently; no checkout locks or conflict prevention. `--isolation worktree` creates a separate checkout at committed HEAD, excluding dirty/untracked source files. Use `--cwd path` to choose a directory in the session's checkout or under its working directory; nested Git repos use their own HEAD for isolation.

### One agent, multiple repos

```text
/agent run --label contract-fix --profile pi --repo ../web=main --repo '/path/to/my api=release/v2' -- Update the API and its consumer together. Do not commit.
```

Repeat `--repo path=ref` (or pass `repos: [{path, ref}, …]` to `agent_start`). Use existing Git checkout roots, with paths absolute or relative to the Pi session directory. Checkouts may be anywhere Git can access on that machine. No repo list, cloning, or fetching is required. Quote `path=ref` as one argument if it contains spaces. For a ref containing `=`, use its commit ID or the structured `repos` input. Don't combine a bundle with `--cwd` or shared isolation.

Each ref is pinned to a commit before any worktree is created. The worker starts only once all members are ready, in the parent directory of the new checkouts. Use a profile that supports starting outside Git (such as Pi). For Codex, opt in via a trusted profile with `--skip-git-repo-check` in its `exec` args; leave sandbox settings intact. Folders use repo names where possible, with distinct names if they collide. Two runs get separate sets of checkouts; use the same exact commit IDs to guarantee matching bases. Failed or cancelled setup leaves any created members for inspection and does not launch the worker.

`/agent show <id>` and `agent_get` report each checkout, branch, and pinned commit. Review, commit, and merge per repo. Follow-up reuses the original bundle; a fresh rerun resolves the same refs again. Worktrees and branches stay retained. `/agent worktree remove <id>` requires confirmation and verified process cleanup; it checks that all checkouts are clean before removing any, never forces deletion, and keeps the branches and any files in the bundle directory outside the checkouts.

`/agent` inspects runs and offers human-directed steering/follow-up for RPC profiles. Model tools remain `agent_start`, `agent_get`, and `agent_stop`; `agent_get` supports `answer`, `transcript`, and `raw` views.

Private records/logs/sessions live under `agent-supervisor/runtime/`. Diagnostic logs are bounded; saved conversations are not. Remove history only while idle. Worktrees and extension modes are not security sandboxes, and exit code 0 does not establish task correctness.
