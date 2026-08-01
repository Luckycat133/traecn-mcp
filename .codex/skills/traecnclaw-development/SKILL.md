---
name: traecnclaw-development
description: Develop, debug, refactor, test, package, and release the TRAECNclaw repository. Use for changes to the gateway or task lifecycle, TaskStore durability, MCP protocol or the frozen 20-tool contract, TraeCN CDP/DOM adapters, clean-room ClawHub and server distribution, compatibility evidence, CI, or release artifacts. Do not use merely to operate TraeCN through the MCP tools.
license: MIT
metadata:
  author: TRAECNclaw
  version: "1.1.0"
---

# TRAECNclaw Development

Make the smallest coherent change that improves real behavior. Treat the
current repository as the source of truth, preserve settled 0.5.x decisions,
and avoid expanding an implementation task into a general policy, wording, or
marketplace review.

This is a repository-maintainer Skill. Keep it under `.codex/skills`; do not
copy it into `skills/traecnclaw-mcp` or the public ClawHub mirror.

## Start every task

1. Read `AGENTS.md` and inspect the current `package.json`, relevant source,
   tests, and maintained docs. Do not assume the version or backlog is unchanged.
2. Identify the single subsystem that owns the behavior. Prefer extending that
   owner over adding another compatibility shim or duplicate source of truth.
3. Reproduce the problem with a focused test, fixture, protocol transcript, or
   clean-room installation before changing broad code.
4. Implement the narrowest production change, then run the nearest test file
   before wider gates.
5. Update generated contracts, docs, compatibility evidence, and changelog only
   when the public behavior or release surface actually changes.

## Current sources of truth

- `package.json`: version, scripts, package contents, and release gates.
- `src/mcp/contract.js`: MCP contract version and the exact ordered 20-tool
  surface. Treat it as frozen unless the requested work explicitly authorizes a
  contract migration.
- `src/mcp/protocol.js`, `src/mcp/stdio-server.js`, and
  `src/mcp/task-extension.js`: protocol negotiation, result envelopes, stdio
  framing, modern Tasks, and correlated subscriptions.
- `src/config/runtime-schema.js`: canonical runtime names, aliases, defaults,
  and generated configuration documentation.
- `src/http/task-store.js`: durable active-task snapshot format and recovery.
- `src/http/completion-signal.js`: durable completion events and outbound
  WebSocket, OpenClaw, and webhook delivery.
- `src/trae-adapters`: exact-version detection, selector/capability profiles,
  and sanitized deterministic fixture replay.
- `docs/COMPATIBILITY.md`: verified TraeCN/platform support. Do not generalize
  beyond recorded live evidence.
- `skills/traecnclaw-mcp`: canonical public runtime Skill.
- `scripts/public-mirror.js`: generated public mirror and provenance rules.

## Development priority order

Unless the user names another target, prefer work in this order:

1. **Distribution closure** — make a clean ClawHub/source installation able to
   locate or install the matching server and complete a first mock task.
2. **Durable acceptance semantics** — return `accepted` only after TaskStore
   persistence succeeds; expose degraded durability and remove duplicate writes.
3. **Modern completion signaling** — restore a reliable completion path for
   modern MCP clients without adding wait or polling tools to the frozen surface.
4. **TraeCN compatibility** — add version detection, adapter capabilities,
   sanitized DOM fixtures, replay tests, and version-specific live evidence.
5. **Protocol conformance and architecture reduction** — test official client
   behaviors and move orchestration out of `gateway.js` without changing public
   behavior.

Read [references/development-guide.md](references/development-guide.md) for the
full roadmap, ownership model, playbooks, test matrix, and release checklist.

## Invariants to preserve

- `MCP_CONTRACT_VERSION === 5` and the ordered 20-tool list remain unchanged
  during ordinary compatible development.
- MCP protocol revision and TRAECNclaw tool-contract version are separate
  concepts.
- Queueing, recovery, task identity, result ownership, and routine UI mechanics
  remain gateway-owned; do not recreate them as Agent-facing tools.
- A task must never be reported as durably accepted when its TaskStore write
  failed.
- The same accepted task must not be sent to TraeCN twice after restart,
  reconnect, timeout conversion, or event replay.
- A collected result must remain bound to the task-specific conversation or
  visible identity that submitted it.
- Runtime defaults have one canonical schema. Change the schema, regenerate the
  derived files, and check them; do not hand-edit multiple copies.
- Public mirrors and release artifacts are generated from an exact canonical
  commit. Do not hand-edit generated copies.
- Keep Node.js 22 CommonJS, existing two-space style, and the plain `assert`
  test runner unless a separate migration is explicitly requested.

## Workflow by change type

### Task lifecycle, queue, or persistence

Inspect `gateway.js`, `task-queue-service.js`, `queue-state-machine.js`,
`recovery-helper.js`, `task-store.js`, task history, and task events together.
Write fault-injection tests for disk errors, restart boundaries, duplicate
submission, and ownership. Keep one owner for every transition and persistence
operation.

### MCP protocol or tool behavior

Start from `contract.js`, `tools.js`, `tool-metadata.js`, `handler.js`,
`protocol.js`, and `stdio-server.js`. Test legacy initialization, modern
per-request metadata, both supported framings, JSON-RPC error codes, structured
content, and exact tools/list order. Do not add an ordinary tool to solve a
transport or completion-signaling problem.

### TraeCN DOM or CDP behavior

Capture the TraeCN version and a sanitized fixture first. Prefer structural
state, stable visible identity, control state, and adapter capability checks
before text heuristics. Add fixture/replay coverage and update live compatibility
evidence only after the real version has been exercised.

### ClawHub, package, or public distribution

Test from a fresh temporary HOME with no repository-relative assumptions. The
installed Skill must either locate a verified package/binary or produce one
clear actionable setup failure. Check launcher resolution, mock gateway startup,
`server/discover` or legacy initialize, exact 20-tool discovery, one submitted
mock task, and one result read.

### Release work

Build every artifact from the final tagged commit, include the source revision
and checksums, verify the canonical Skill and mirror byte-for-byte, run the
clean-room install, and then update external listings. Do not advertise a
package channel until that exact version is visible and installable.

## Testing rules

- Prefer behavior assertions over checks that source text merely contains a
  symbol or test name.
- Keep contract audit, unit/integration/system tests, DOM replay, live UAT,
  clean-room installation, and fault injection as distinct evidence layers.
- Run the nearest test first; then the smallest relevant command set; run
  `npm run verify` for repository-wide or release-facing changes.
- Use mock mode for deterministic gateway work. Use live TraeCN only when the
  behavior depends on the real desktop UI, and record the exact version.
- Never describe mock output, a static audit, or a skipped live check as live
  compatibility evidence.

## Avoid unproductive work

- Do not reopen settled 0.5.x work—including the atomic TaskStore, generated
  runtime defaults, removed MCP profiles, Monaco severity mapping, Git branch
  parsing, task result/trace separation, modern error semantics, Tasks
  extension, official-client conformance matrix, versioned Trae adapter,
  `CompletionSignal`, settings navigation/extraction, or public mirror
  sync—unless a concrete regression demonstrates a defect.
- Do not spend an unrelated development task revising security posture,
  marketplace wording, protocol-status wording, or general policy language.
  Fix concrete implementation defects that are in scope and move on.
- Do not add tools, profiles, low-level wait/poll/recovery controls, or generic
  command surfaces to make one integration easier.
- Do not rewrite the project in TypeScript, Rust, or another framework as a
  substitute for clarifying ownership in the existing code.
- Do not start Windows or another IDE adapter before the requested macOS/TraeCN
  compatibility work has deterministic fixtures and repeatable live evidence.
- Do not duplicate routes, defaults, contracts, version values, or mirror files
  when a generator or canonical module already owns them.
- Do not run quota-consuming proof tasks unless the requested change genuinely
  requires that evidence.

## Completion standard

Before finishing a change:

1. The new or changed behavior has a focused regression test.
2. The relevant targeted tests pass.
3. Generated files and contracts are synchronized when affected.
4. Public behavior changes have matching docs and `CHANGELOG.md` entries.
5. Contract v5, task ownership, durability, and compatibility claims have not
   drifted unintentionally.
6. The final report states what changed, what was run, and any live or
   clean-room evidence that remains unavailable.
