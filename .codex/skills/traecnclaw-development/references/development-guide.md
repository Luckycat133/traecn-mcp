# TRAECNclaw development guide

Use this reference for substantive repository work. Verify each baseline fact
against the current branch before relying on it; `package.json` and the live
source always win over this document.

## Baseline at Skill creation

- Release line: `0.5.0`.
- Runtime: Node.js 22, CommonJS, plain Node `assert` tests.
- MCP tool contract: version 5, exactly 20 ordered single-intent tools in
  `src/mcp/contract.js`.
- MCP transport: newline-delimited JSON-RPC by default, compatibility decoding
  for the former `Content-Length` framing.
- MCP protocol paths: legacy initialization for `2025-11-25` and `2024-11-05`,
  plus modern per-request metadata and `server/discover` for `2026-07-28`.
- Task persistence: TaskStore schema 2 with checksum, durable temporary writes,
  backup, quarantine, legacy migration, and forced-kill recovery tests.
- Configuration: canonical names and defaults in
  `src/config/runtime-schema.js`, with generated README and `.env.example`
  sections.
- Public runtime Skill: `skills/traecnclaw-mcp`; public mirror generation is
  owned by `scripts/public-mirror.js`.
- Verified desktop compatibility: TraeCN 1.107.1 on macOS. Other versions and
  Windows remain unverified unless `docs/COMPATIBILITY.md` has changed.
- Default repository gate: `npm run verify`.

## Settled 0.5.0 work

Do not repeat these changes without regression evidence:

- MCP profiles were removed and the 20-tool contract was frozen.
- Active queue persistence was consolidated into TaskStore.
- Primary, backup, temporary, checksum, and quarantine recovery were added.
- Runtime defaults were centralized and generated documentation was added.
- Non-loopback startup without the configured authentication requirement was
  made a startup failure.
- Monaco marker severity and Git status-bar branch parsing were corrected.
- The always-throwing queued-task service placeholder was removed.
- Verify CI, release scan, Skill contract checks, and public mirror provenance
  were restored.
- The public Skill mirror was synchronized to the final 0.5.0 source revision.

## Remaining engineering gaps

Work only on gaps relevant to the requested task.

### 1. Clean-room distribution is not closed

At the baseline, the public Skill is a companion package. Its launcher resolves
an explicit `TRAECN_MCP_SERVER_PATH` or an in-repository `mcp-server.js`; it does
not independently install or resolve the complete server package.

The desired clean-room flow is:

```text
fresh HOME
  -> install public Skill
  -> resolve or install exact TRAECNclaw server
  -> start mock gateway
  -> start stdio MCP
  -> discover or initialize
  -> tools/list returns the exact 20 tools
  -> submit one mock task
  -> read one completed result
```

Recommended launcher resolution order:

```text
TRAECN_MCP_SERVER_PATH
  -> repository-local mcp-server.js
  -> require.resolve("traecnclaw/mcp")
  -> executable `traecnclaw-mcp` on PATH
  -> one clear installation diagnostic
```

Publish only a channel that has a reproducible artifact and a clean-room test:
GitHub release archive, npm package, or MCPB bundle. Do not rely on the source
version alone as proof that a package exists.

### 2. Task acceptance is not yet a durability transaction

TaskStore returns `false` when persistence fails, but task creation and unified
submission can still proceed without checking that result. A caller may receive
HTTP 202 and a task ID even though the durable snapshot was not written.

Target invariant:

```text
validate request
  -> build candidate task
  -> persist candidate queue successfully
  -> publish task to active execution
  -> return accepted
```

Acceptable alternatives may stage the task in memory first, but they must roll
it back and return a clear error when persistence fails.

Implementation goals:

- Propagate TaskStore write failure instead of logging and continuing.
- Add a distinct error code and HTTP response for unavailable durability.
- Add readiness/status fields such as `taskStoreWritable`,
  `lastSuccessfulPersistAt`, `lastPersistError`, and `durabilityDegraded`.
- Remove duplicate writes around `_createQueuedTask` and submit handlers.
- Add disk-full, permission-denied, read-only-directory, and interrupted-write
  tests.
- Add a single-writer process lock or an equivalent rule so two gateways cannot
  independently mutate one active queue file.
- Preserve idempotency: a retry after an uncertain response must not submit the
  same task twice.

### 3. Modern MCP completion signaling is incomplete

Legacy clients can receive task-event logging notifications. Modern stateless
requests do not use the same free-floating notification path, so the caller can
release context after submission but lacks a universal completion wake-up.

Do not solve this by adding wait, poll, event-acknowledgement, or recovery tools
to contract v5.

Evaluate these layers separately:

1. Keep `TaskEventStore` as the durable internal event source.
2. Keep legacy logging notifications for compatible clients.
3. Keep OpenClaw or host-specific message delivery as host adapters.
4. Add a modern completion adapter when an official task/subscription mechanism
   is sufficiently implementable.
5. Until then, support intentional low-frequency `traecn_get_task` reads by the
   host, not a tight Agent polling loop.

Acceptance criteria:

- One submitted task can release the calling Agent turn.
- Completion survives gateway and MCP reconnects.
- A host can receive or discover terminal state without resending task context.
- Event replay never emits another task's result.
- No new ordinary Agent-facing lifecycle tools are introduced.

### 4. TraeCN compatibility needs an adapter layer

Current DOM automation mixes reusable CDP mechanics, TraeCN-version assumptions,
selector fallbacks, visible-text parsing, and completion heuristics.

Introduce a capability handshake similar to:

```json
{
  "traeVersion": "1.107.1",
  "platform": "darwin",
  "adapter": "traecn-1.107",
  "mode": "solo",
  "capabilities": {
    "conversationIdentity": true,
    "reviewGate": true,
    "settingsUI": true,
    "structuredTaskState": false
  }
}
```

Recommended structure:

```text
src/trae-adapters/
  detect.js
  registry.js
  traecn-1.107/
    capabilities.js
    selectors.js
    normalize-dom.js
    fixtures/
```

Prefer evidence in this order:

1. Stable structural state and explicit control state.
2. Stable conversation or task identity.
3. Version-specific selectors and attributes.
4. Visible text tied to a known control or state.
5. Broad model-output text heuristics as the last fallback.

For every supported version:

- detect the exact app version;
- capture sanitized DOM and visible-state fixtures;
- replay list, select, submit, queue, approval, response, and review states;
- run a version-scoped live UAT;
- update `docs/COMPATIBILITY.md` with the exact evidence level.

Unknown versions should report a capability gap or degraded adapter state rather
than silently claiming verified compatibility.

### 5. Protocol conformance needs independent clients

Test the server against protocol behavior, not only its own decoder and handler.
Build a matrix covering:

| Client path | Lifecycle | Framing | Required checks |
| --- | --- | --- | --- |
| Legacy 2024 | `initialize` | newline | tools, prompts, resources, notifications |
| Legacy 2025 | `initialize` | newline | negotiation, structured result fallback |
| Compatibility | `initialize` | Content-Length | bidirectional framing and errors |
| Modern 2026 | `server/discover` + per-request `_meta` | newline | identity, cache hints, result type, errors |

Use official SDK clients where practical. Assert:

- unsupported versions fail or negotiate according to the implemented era;
- a process cannot silently switch protocol era;
- malformed JSON and invalid requests return the correct JSON-RPC codes;
- tool argument validation rejects extra or missing fields;
- `tools/list` preserves the frozen order;
- text content and structured content describe the same result;
- reconnect and event behavior remain deterministic.

### 6. Gateway still owns too much application logic

Continue the extraction without changing public behavior.

Target ownership:

```text
MCP / OpenClaw / CLI / HTTP adapters
                  |
                  v
          Application API
                  |
       +----------+-----------+
       |          |           |
       v          v           v
TaskOrchestrator Policy/Review CompletionSignal
       |                      |
       v                      v
QueueStateMachine         TaskEventStore
       |
       v
TaskStore <-> TaskHistory
       |
       v
TraeAdapter -> CDP/DOM drivers
```

`Gateway` should eventually own dependency construction, HTTP lifecycle,
routing, connection setup, and graceful shutdown. It should not remain the only
place where task creation, completion classification, persistence, recovery,
model probing, and conversation ownership can be understood.

Extraction rules:

- Move one behavior and its tests at a time.
- Preserve error bodies, status codes, state transitions, and audit/history
  events unless the task explicitly changes them.
- Delete the old path after callers move; do not leave two live implementations.
- Keep route metadata in one canonical registry.
- Prefer dependency injection for drivers, stores, clocks, and process hooks so
  fault tests remain deterministic.

## Roadmap

### 0.5.1 — Distribution closure and durability semantics

Recommended scope:

- Publish or package the complete server through one verified channel.
- Extend launcher resolution beyond repository-relative paths.
- Add the clean-room public Skill installation test.
- Make task acceptance conditional on successful persistence.
- Add TaskStore health and single-writer protection.
- Remove duplicate queue snapshot writes.
- Generate an artifact manifest with exact source revision and SHA-256 values.
- Verify archives and mirrors against the final tagged commit.
- Refresh stale third-party directory entries after publication.

Exit criteria:

- A fresh machine or isolated HOME can install, discover 20 tools, and complete
  a mock task without manually locating repository internals.
- A simulated persistence failure cannot return `accepted`.
- A second gateway cannot corrupt or independently own the same active store.
- All published artifacts identify and match one final commit.

### 0.6.0 — Modern completion and verified compatibility

Recommended scope:

- Implement a modern completion adapter or task/subscription integration.
- Add official-SDK conformance tests for all supported protocol eras.
- Add TraeAdapter discovery and version capability reporting.
- Add sanitized DOM fixture replay.
- Record live evidence for each claimed TraeCN version.
- Move task orchestration and completion signaling out of `gateway.js`.
- Replace source-text acceptance checks with executable behavior where possible.

Exit criteria:

- Modern clients can release context and later receive or discover terminal
  state through a supported host mechanism.
- Compatibility claims are versioned and reproducible.
- Gateway responsibilities are substantially narrower.
- Contract v5 remains unchanged unless a separately planned migration is
  approved.

## Change playbooks

### Task lifecycle or persistence change

1. Trace submit -> task creation -> persist -> poll -> submit to Trae -> collect
   -> finalize -> event/history.
2. Write a state-transition or fault test before implementation.
3. Keep task identity, conversation identity, and idempotency visible in the
   fixture.
4. Test restart before submission, after submission, during collection, and
   after terminal event creation.
5. Run targeted task-store/queue/gateway tests, then system tests and verify.

### MCP change

1. Decide whether the change belongs to transport, protocol envelope, tool
   validation, tool behavior, or the contract.
2. Avoid touching `contract.js` for transport-only work.
3. Add transcript-level tests and one spawned stdio smoke test.
4. Test both result content forms and error paths.
5. Synchronize Skill contracts only when schemas or behavior changed.

### DOM or selector change

1. Record app version, mode, and sanitized fixture.
2. Reproduce against fixture before editing selectors.
3. Add the narrow selector or structural parser to the version adapter.
4. Keep broad fallback selectors last.
5. Run fixture replay, `inspect:verify`, and a scoped live check.

### ClawHub or package change

1. Build from an exact clean commit.
2. Install into a temporary HOME without a source checkout on the expected
   relative path.
3. Verify launcher/package resolution.
4. Start a mock gateway and stdio server.
5. Exercise discovery, exact tool order, submission, and result retrieval.
6. Compare canonical Skill and public mirror byte-for-byte.
7. Record artifact checksums and source revision.

### Gateway refactor

1. Pick one ownership boundary, not a broad rewrite.
2. Characterize existing behavior with tests.
3. Introduce the new component behind the current call site.
4. Move callers and delete the old implementation.
5. Run gateway, handler, system, and contract tests.

## Evidence layers

### Unit and pure parser tests

Use for configuration, schemas, state transitions, parser behavior, result
classification, selector normalization, and protocol helpers.

### Integration tests

Use injected clients, drivers, stores, clocks, and file systems to test component
ownership and error propagation.

### Mock system tests

Start the real gateway in mock mode. Exercise HTTP, MCP, task lifecycle,
authentication, task events, and shutdown without TraeCN.

### Contract audit

Use to detect drift between source, OpenAPI, generated Skill contracts, package
contents, versions, and mirror metadata. It is inventory evidence, not behavior
evidence.

### DOM replay

Use sanitized real-state fixtures to verify selectors and state interpretation
without spending live quota or depending on desktop timing.

### Live UAT

Use only for behavior that depends on the actual TraeCN desktop. Record exact
version, platform, mode, readiness, and which checks were skipped.

### Clean-room installation

Use for ClawHub, package, launcher, and release claims. A developer checkout is
not a clean-room environment.

### Fault injection

Use for TaskStore, process termination, CDP disconnect, gateway restart, MCP
reconnect, duplicate responses, and stale conversation identity.

## Test command guide

Run the smallest relevant set first:

```sh
node path/to/focused.test.js
npm run test:mcp-stdio-smoke
npm run test:system
npm run check:skill-contracts
npm run verify:static
npm run verify
```

For real desktop compatibility:

```sh
npm run inspect:verify
npm run test:live
node scripts/live-uat.js --strict --require-ready
```

Do not run quota-consuming proof commands for ordinary refactors, packaging,
protocol tests, or mock lifecycle work.

## Release checklist

1. Confirm the final version and release scope in `package.json` and
   `CHANGELOG.md`.
2. Run `npm run verify` from a clean checkout.
3. Run any required live/version-specific checks and save machine-readable
   evidence.
4. Run `npm run pack:skill` and build the complete server artifact.
5. Write an artifact manifest containing version, full source commit, filenames,
   sizes, and SHA-256 checksums.
6. Install the artifacts in a temporary HOME and run the clean-room smoke flow.
7. Generate and verify the public mirror from the same final commit.
8. Tag only the commit used to build the artifacts.
9. Verify the downloadable assets and any package registry contain that exact
   version before updating external listings.
10. Keep maintainer Skills and development references out of the public runtime
    Skill package.

## Suggested issue backlog

- Make ClawHub installation pass in a clean environment.
- Resolve the MCP server from package installation or PATH.
- Reject task acceptance when TaskStore persistence fails.
- Add TaskStore health and single-writer protection.
- Remove duplicate persistence during task creation.
- Add completion signaling for modern MCP hosts.
- Add official SDK protocol-conformance tests.
- Introduce a versioned TraeCN adapter registry.
- Add sanitized real-DOM fixture replay.
- Record live evidence for a second TraeCN version before widening support.
- Extract TaskOrchestrator from Gateway.
- Consolidate route ownership and remove duplicate route declarations.
- Generate release artifact provenance from the final tagged commit.
- Add automated clean-room release verification.

## Explicit non-goals

- Adding more MCP tools to avoid designing the correct internal adapter.
- Restoring public/ops/full profiles.
- Re-exposing wait, poll, recovery, proof, cleanup, or review-gate mechanics to
  the normal Agent surface.
- Rewriting the project in another language before ownership and tests are
  stable.
- Claiming broad TraeCN or Windows compatibility from mock tests.
- Treating static source-string checks as proof that a workflow operates.
- Editing generated configuration, Skill contracts, or public mirrors by hand.
- Expanding unrelated implementation work into a general policy or product-copy
  review.
