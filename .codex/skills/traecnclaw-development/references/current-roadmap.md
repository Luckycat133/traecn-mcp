# TRAECNclaw current roadmap

This file is the active engineering backlog after the 0.5.3 reliability and
security release. Check
`package.json`, the latest commits, open pull requests, and open issues before
treating an item as unfinished. The longer `development-guide.md` retains
architecture history and full playbooks.

## Current baseline

- Release line: 0.5.3.
- Runtime: Node.js 22 CommonJS.
- Public MCP contract: version 5 with exactly 20 ordered tools.
- Modern MCP: per-request 2026 metadata, Tasks adapter, exact-ID task
  subscriptions, and official-client conformance coverage.
- Durable task acceptance: atomic active-queue snapshots, health reporting,
  persistent idempotency, single-writer ownership, backup recovery, and crash
  tests.
- Distribution: package-resolving launcher, server archive, checksummed release
  manifest, and clean-room mock-task test.
- Trae compatibility: versioned 1.107 macOS adapter with sanitized fixture
  replay; broader support requires new evidence.
- Completion delivery: `CompletionSignal` owns durable events and outbound
  adapters; TaskEventStore schema 2 provides atomic snapshots, checksums,
  backup recovery, quarantine, migration, and write/load health.
- Acceptance ownership: `TaskOrchestrator` owns candidate task construction,
  durable active-queue acceptance, rollback, and history mirroring; extracted
  handler route slices are composed by the central route table.

Do not rebuild these capabilities from scratch. Fix demonstrated regressions at
the component that owns them.

## Reliability edge cases closed by the current patch

Preserve these behaviors after the patch is merged:

- `TaskEventStore.hasMore` uses the effective acknowledged/requested cursor even
  when the returned event page is empty.
- A fresh malformed TaskStore lock remains protected during the metadata-write
  grace period; an old malformed lock left by a crashed creator is recoverable.
- `tasks/cancel` does not turn HTTP 4xx or explicit gateway failures into false
  success. A race to a confirmed terminal status remains an idempotent no-op.
- `subscriptions/listen` requires a non-null request ID and duplicate active IDs
  are rejected instead of replacing unresolved requests.
- A cancelled subscription writes the final result for its original long-running
  request and cannot be closed a second time during server shutdown.
- A subscription baselines existing durable events before sending its current
  task snapshots, so historical events are not replayed after the snapshot.
- A partial initial-snapshot failure retries only the unfinished task IDs rather
  than duplicating snapshots already written successfully.
- `TaskEventStore` commits checksummed schema 2 snapshots through a durable
  temporary file, preserves a validated backup, quarantines corrupt candidates,
  and migrates version 1 or complete interrupted snapshots without losing
  events or acknowledgement cursors.
- Completion-event append failure rolls back the candidate and suppresses
  outbound delivery. A cursor persistence failure leaves the cursor unchanged
  and returns HTTP 503 instead of claiming acknowledgement.
- A valid completion-event cursor remains acknowledgeable after its event is
  pruned, and an unknown future cursor resets to the retained window instead of
  stalling future list or long-poll calls.
- `GET /api/status` reports completion-event persistence and recovery health
  under `durability.taskEvents`, and aggregate degraded durability includes both
  active tasks and completion events.

## P0 — durable-state reliability

Continue with the remaining edge behavior around the two durable stores and task
identity:

- Keep pagination, acknowledgement, pruning, restart, long-poll, and subscription
  cursor semantics executable and deterministic across multiple clients.
- Exercise restart and retry boundaries before submit, after durable accept,
  after Trae submission, during result collection, after terminal event
  creation, and during subscription reconnect.
- Verify idempotent retries return the same task without suppressing a genuinely
  different request.
- Keep task, conversation, result, event, subscription, and request identities
  visibly correlated in fixtures.

Exit criteria for the next reliability patch:

- Pruning does not make active client/subscription cursors replay another task or
  stall permanently.
- Focused fault tests and the repository-wide gate pass.

The cursor/pruning edge cases above are now covered by deterministic unit tests;
continue with restart and retry fault injection before changing retention policy.

## P1 — current live compatibility evidence

The adapter framework exists; the next value comes from evidence rather than
more fallback selectors:

1. Detect the exact installed TraeCN version and platform.
2. Run `inspect:verify` and scoped live UAT against a debug-enabled instance.
3. Capture sanitized fixtures for any changed queue, dialog, conversation,
   settings, response, or review state.
4. Update the existing adapter only when the version remains compatible.
5. Create a second adapter only when the exact new version/platform has both
   deterministic replay and live evidence.
6. Keep unknown versions degraded and explicit instead of promoting generic
   fallbacks to verified support.

## P1 — TaskOrchestrator extraction

`Gateway` still contains too much task application logic. The first extraction
is complete: `TaskOrchestrator` now owns candidate construction and the durable
acceptance transaction. Continue without a broad rewrite:

- Move lifecycle transitions only after characterizing current status codes,
  history steps, persisted fields, idempotency, and completion events.
- Inject driver, TaskStore, TaskEventStore, history, clock, and completion
  dependencies so restart/fault tests stay deterministic.
- Keep HTTP, MCP, OpenClaw, and CLI as adapters over one application API.
- Consolidate route metadata into one registry and remove per-handler duplicate
  declarations only with route/OpenAPI regression coverage.
- Delete the old implementation after each caller moves; do not leave two live
  paths.

A successful extraction should make `gateway.js` smaller and easier to reason
about while preserving every public response and state transition.

## P1 — release and publication verification

For each release-facing change:

- Build Skill and server artifacts from the final intended commit.
- Record full source revision, filename, size, and SHA-256 for every artifact.
- Run the clean-room install with no repository-relative server path.
- Verify modern discovery or legacy initialization, exact tool order, one mock
  submission, task completion, and result retrieval.
- Generate the public mirror from the same commit and compare canonical Skill
  bytes.
- Tag only after the final verification commit is known.
- `npm run verify:release-manifest` and the tag workflow verify source
  provenance, artifact sizes, and SHA-256 checksums before asset upload.
- Update external listings only after the exact downloadable/package version is
  visible.

## P2 — protocol and SDK evolution

The current Tasks implementation is independently negotiated and must evolve
through tests, not speculation:

- Track published MCP core, Tasks-extension, and official SDK versions.
- Keep 2024, 2025, modern 2026, and Content-Length compatibility cases separate.
- Add or change wire behavior only when an official client transcript or
  published schema demonstrates the need.
- Preserve JSON-RPC error codes, task identity, request-ID lifetime,
  subscription correlation, structured/text result equivalence, and
  protocol-era isolation.
- Do not expand the 20-tool contract to solve transport, subscription, or host
  lifecycle concerns.

## Suggested next issues

1. Add restart/retry fault tests for several legacy and Tasks subscription
   cursors.
2. Record live evidence for the currently installed TraeCN build.
3. Move one lifecycle transition from Gateway into `TaskOrchestrator` while
   preserving status, history, and completion-event behavior.
4. Consolidate remaining Gateway-owned route metadata only when the handler
   boundary is stable.
5. Refresh third-party listings only after the next verified package is
   published.

## Non-goals for the next patch

- Adding MCP tools or restoring profiles.
- Replacing Tasks/subscriptions with Agent polling tools.
- Broad language or framework migration.
- Claiming Windows, another IDE, or another TraeCN version without fixtures and
  live evidence.
- Reworking completed 0.5.x features without a concrete failing case.
