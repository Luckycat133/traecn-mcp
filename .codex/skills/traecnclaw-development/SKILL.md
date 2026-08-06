---
name: traecnclaw-development
description: Develop, debug, refactor, test, package, release, and maintain TRAECNclaw. Use for gateway, durable state, MCP protocol, TraeCN adapters, distribution, compatibility, CI, and architecture work. Do not use merely to operate TraeCN through MCP.
license: MIT
metadata:
  author: TRAECNclaw
  version: "1.4.0"
---

# TRAECNclaw Development

Act as the repository maintainer. Solve the requested engineering problem end-to-end: inspect current code, reproduce the issue, implement the smallest correct change, add regression coverage, update affected documentation, and leave the repository in a verifiable state.

The repository is the source of truth. Do not assume roadmap items are unfinished. Inspect `package.json`, current commits, open PRs, tests, and implementation before changing architecture.

## Operating rules

1. Find the owning subsystem before editing.
2. Reproduce failures with tests, fixtures, protocol transcripts, or clean-room flows before broad changes.
3. Prefer one canonical implementation over compatibility layers.
4. Make production changes narrow and evidence-driven.
5. Run focused tests first, then the smallest wider verification command.
6. Update docs, changelog, generated files, and contracts only when behavior or release surfaces change.

## Current architecture owners

- `src/mcp/contract.js`: frozen MCP contract v5 and ordered 20-tool surface.
- `src/mcp/protocol.js`, `stdio-server.js`, `task-extension.js`: MCP transport, Tasks, subscriptions, protocol eras.
- `src/http/task-store.js`: durable active-task snapshots, atomic persistence, recovery, ownership.
- `src/http/task-orchestrator.js`: candidate task construction, durable acceptance, rollback, history mirror, idempotency-key replay resolution.
- `src/shared/task-event-store.js`: completion event ordering, cursors, acknowledgements, replay.
- `src/http/completion-signal.js`: completion event generation and delivery adapters.
- `src/trae-adapters`: versioned TraeCN capability detection and fixture replay.
- `src/config/runtime-schema.js`: canonical runtime configuration.
- `scripts/public-mirror.js`: generated distribution surfaces.

## Priority order after 0.5.2

When no explicit target is given, solve work in this order:

1. Durable reliability:
   - TaskEventStore atomic persistence and recovery.
   - Cursor, pruning, replay, acknowledgement, restart correctness.
   - Task identity and idempotency boundaries.
   - Partial-write and crash recovery.

2. Compatibility evidence:
   - Verify the actual TraeCN version.
   - Capture sanitized fixtures.
   - Update adapters only from real evidence.
   - Never claim support for untested versions.

3. Architecture reduction:
   - Extract TaskOrchestrator responsibilities gradually.
   - Reduce Gateway ownership without changing public behavior.
   - Remove old paths after migration.

4. Release engineering:
   - Build artifacts from one commit.
   - Verify checksums and provenance.
   - Run clean-room installation.
   - Keep public mirrors synchronized.

5. Protocol evolution:
   - Follow published MCP behavior and SDK evidence.
   - Do not add Agent-facing tools for transport lifecycle problems.

## Invariants

- MCP contract v5 remains exactly 20 ordered tools unless an explicit migration is requested.
- MCP protocol revisions and TRAECNclaw tool contracts are separate.
- Gateway owns queueing, recovery, persistence, task identity, and UI mechanics.
- Never report a task as durably accepted before persistence succeeds.
- Never submit the same accepted task twice after retry, restart, timeout, or reconnect.
- Results must remain bound to the submitting task identity and conversation.
- TaskEventStore cursors must remain correct after empty pages, pruning, restart, and multiple clients.
- Subscription requests require stable request IDs and must resolve exactly once.
- Current task snapshots must not be followed by historical replay of the same state.
- Cancellation failures must propagate; only confirmed terminal races are idempotent success.
- Runtime defaults have one canonical schema.
- Generated mirrors and artifacts must come from canonical sources.
- Keep Node.js 22 CommonJS and existing test style unless a migration is explicitly requested.

## Development workflows

### Durable state
Inspect TaskStore, TaskEventStore, history, queue lifecycle, and completion delivery together. Add fault tests for disk failures, crashes, locks, duplicate submission, replay, and ownership.

### MCP
Inspect contract, handlers, protocol, task extension, and stdio server together. Test initialization, framing, Tasks, subscriptions, cancellation, JSON-RPC errors, and exact tool ordering.

### TraeCN
Capture version and sanitized fixtures first. Prefer structural UI state over text heuristics. Update compatibility claims only after live evidence.

### Distribution
Use a fresh environment. Verify launcher resolution, server discovery, exact tools, mock task submission, completion, and artifact provenance.

## Avoid wasted work

Do not:

- Rebuild completed 0.5.x capabilities without a failing regression.
- Add tools for waiting, polling, recovery, or subscription internals.
- Restore MCP profiles.
- Rewrite the project language/framework instead of improving ownership boundaries.
- Create generic TraeCN fallbacks without evidence.
- Duplicate routes, configs, versions, contracts, or generated files.
- Spend unrelated tasks on policy wording or marketplace discussion.

## Autonomous completion requirement

For any assigned roadmap item:

1. Inspect current implementation and decide whether the item is actually incomplete.
2. Create or update tests before changing broad behavior.
3. Implement the fix completely, including related edge cases discovered during investigation.
4. Update the maintainer Skill roadmap if priorities or ownership change.
5. Leave a concise final report:
   - changed files;
   - behavior fixed;
   - tests executed;
   - remaining uncertainty.

Do not stop at analysis when a safe code change is possible. Continue until the requested engineering task is complete or a concrete external blocker is reached.

## Completion standard

Before finishing:

1. Focused regression tests exist and pass.
2. Relevant verification commands were run.
3. Contracts and generated artifacts remain synchronized.
4. Documentation matches changed behavior.
5. No ownership, durability, compatibility, or protocol invariant was weakened.
