---
name: traecn-mcp-development
description: >-
  Maintain traecn-mcp: audit naming migrations, the 20-tool MCP contract, CDP task ownership, long queues, crash recovery, workspace switching, live evidence, packaging and distribution. Use for repository work, not merely operating TraeCN through its runtime Skill.
license: MIT
metadata:
  author: Luckycat133
  version: "2.3.0"
---

# traecn-mcp Development

Implement the requested outcome in the current branch. Source and executable evidence win over historical plans. Do not reopen completed work or turn a naming cleanup into a runtime rewrite.

## Load only the relevant reference

- [Current audit](references/project-audit.md): pinned remote baseline, accepted local test evidence, naming gaps and next work.
- [MCP contract](references/mcp-product-design.md): the exact v5 surface and compatibility requirements.
- [Task recovery](references/task-recovery.md): lock scopes, durable transitions and ambiguous native submission.
- [Live proof and workspace protection](references/live-proof-workspace.md): GLM-5.2 evidence, fault matrix and single-runtime workspace ownership.
- [Distribution and promotion](references/distribution-promotion-plan.md): canonical identity, legacy aliases, GEO and channel migration.
- [Glama browser runbook](references/glama-browser-runbook.md): reconcile an existing listing without duplicating it.

## Product and naming baseline

The product and canonical repository identity are `traecn-mcp` and `Luckycat133/traecn-mcp`. TraeCN is the desktop application being controlled, not a deprecated project name. GLM-5.2 is a requested UI model label, not proof of the serving backend.

MCP is the Agent surface; the web console is the human surface; CLI is for setup, operations and scripts. All share one local gateway. macOS remains the platform available for real testing. Do not add another product, transport or platform solely for a directory listing.

This maintainer Skill is canonical at `.codex/skills/traecn-mcp-development`. The `.agents` and `.claude` entries are symlinks to this one source. Do not retain a second active maintainer Skill under the old name.

Runtime compatibility identifiers are a separate migration. Inspect actual `package.json`, launcher resolution, generated contracts, installed configuration and state paths before changing a package, bin, runtime Skill ID, MCP registry identity, service label or storage directory. The audit records the legacy values still present in its pinned snapshot. Never mechanically replace those values and strand accepted tasks or installed clients.

## Evidence discipline

1. Resolve the requested branch to a commit and record a dirty-tree summary when local access exists.
2. Accept the user's completed checks as supplied evidence. Distinguish them from checks executed in this session and from historical reports.
3. A local PASS with no attached revision/log is not a failure, but do not silently attribute it to a different remote commit.
4. Static/local Skill equality, mock integration, protocol conformance, live readiness, real generation, long queue observation and crash recovery are different claims.
5. For documentation-only edits, validate names, links, symlinks, references and changed-file scope. Do not spend model quota or rerun the full product suite just to edit prose.
6. For runtime changes, add a failing regression at the owning boundary, run focused tests, then the necessary integration gate. Run the full gate for cross-cutting lifecycle/protocol changes and release gates for actual package changes.

## Owners to inspect

- `src/mcp/contract.js`, `tools.js`, `tool-metadata.js`, `handler.js`: public names/order, schemas, metadata and results.
- `src/mcp/protocol.js`, `stdio-server.js`, `task-extension.js`: protocol negotiation, Tasks, subscriptions and request lifetime.
- `src/http/task-orchestrator.js`: acceptance, request identity and active/terminal idempotency.
- `src/http/task-store.js`: snapshots, terminal replay, persistence health and file-writer ownership.
- `src/http/queue-state-machine.js`, `task-queue-service.js`, `recovery-helper.js`: task claims, durable recovery and pending transitions.
- `src/http/gateway.js`: polling, preparation, native dispatch and collection; characterize before extracting.
- `src/http/handlers/project.js`, `handlers/unified-agent.js`, `src/cdp/trae-control.js`: workspace/context mutation paths.
- `src/shared/task-event-store.js`, `task-history.js`, `src/http/completion-signal.js`: durable events, history and delivery.
- `scripts/long-queue-proof.js`: proof observer, submission, marker registry and evidence files.
- `src/trae-adapters`, `src/config/runtime-schema.js`: adapter evidence and canonical configuration.
- `scripts/public-mirror.js`, package scripts and `distribution/`: generated runtime Skill/package/channel surfaces.

## Invariants

- MCP contract v5 has exactly 20 tools in its existing order. Preserve `traecn_*` names; project renaming is not a tool migration.
- No Agent-facing wait, poll, proof, recovery or generic command tools.
- A durable acceptance receipt follows successful persistence, not merely an in-memory insertion.
- HTTP idempotency prevents duplicate accepted requests; it does not by itself make a CDP click exactly-once.
- Persist native submission intent before a side effect. After an ambiguous crash, reconcile the owned native conversation before any resend; ambiguity is not permission to submit again.
- Process-local task locks, snapshot file locks, short UI mutexes and long-lived runtime/workspace ownership are distinct.
- Native queue waiting does not release workspace ownership. A dead gateway or expired observer timer does not prove TraeCN stopped.
- Preserve cancellation/persistence checkpoints, follow-up parent completion markers, terminal replay and exact result ownership already implemented.
- Bind collection to task, native conversation, workspace and runtime generation, not just a matching title or recent text.
- Keep text/structured result parity, existing status/error schemas and task completion semantics. Internal recovery phases do not silently create public enum values.
- Public claims use current evidence; historical release metadata and compatibility aliases are not rewritten as if newly published.

## Next implementation order

1. Reconcile local tested revision with the requested remote branch; resolve README/bin/runtime-Skill path contradictions without erasing supplied PASS evidence.
2. Add deterministic regressions for ambiguous native dispatch, proof POST retry identity and resuming the already-owned queued task.
3. Implement submission intent/reconciliation in the existing task owner and a shared runtime/workspace mutation guard across all entry points.
4. Validate interruption, restart and competing workspace cases with fake drivers/clocks and process fault injection.
5. Run one authorized real GLM-5.2 evidence scenario using the live-proof reference. Mark an unobserved queue or unavailable model explicitly, never synthesize success.
6. Reconcile naming/source URLs in existing channels and publish only artifacts built from the final tested revision.

## Autonomous workflow

For each selected item: trace callers and persisted fields; reproduce; implement in the owner; test the behavior; remove the obsolete path; update the relevant reference. In a completion campaign continue across all unblocked selected items, not arbitrary optional features. Record external blockers with the exact missing environment/action and expected evidence.

A live desktop, native model availability and publishing credentials can block their own steps, not local fault tests. A docs audit is not authorization to send a paid prompt, cancel someone else's task, switch the active user's workspace or publish a new package.

## Stop with an accurate handoff

Report changes actually committed, checks actually run, user-reported checks, remaining source findings and the next executable acceptance test. Never report a design as implemented or a passing mock as a real GLM-5.2 receipt. Keep ordinary development focused on correctness and user experience, not speculative security/marketing wording.
