# Changelog

## [0.1.0]

- Prepare the first public release as `@harrarz/pi-agnostic-subagents`.
- Package the existing explicit, agent-agnostic launch/control workflow, trusted CLI profiles, model preferences, private history, bounded output, and optional worktrees.
- Preserve `/agent`, model tool names, and existing `agent-supervisor` configuration/runtime paths.
- Add MIT licensing, concise architecture documentation, public package metadata, package-content checks, and offline CI.
- Handle argument-transport children that exit before the OS birth-identity lookup, only after observing their actual child-process exit and verifying owned descendant cleanup. Unverified live children and unsent stdin/RPC tasks still fail closed.
- Retry transient process-inspection gaps within the existing cleanup deadline, without signalling from unavailable snapshots. Persistent inspection failures still report interrupted/unverified cleanup.
