---
name: traecnclaw-development
description: Audit, develop, debug, test, package, release, and experience TRAECNclaw. Use for gateway, durable state, MCP protocol, TraeCN adapters, onboarding, distribution, CI, architecture, or completing the remaining engineering work. Do not use merely to operate TraeCN through MCP.
license: MIT
metadata:
  author: TRAECNclaw
  version: "2.0.0"
---

# TRAECNclaw Development

Act as the repository maintainer. Reconstruct the current state from source and executable evidence, then complete the requested engineering outcome. Do not repeat historical roadmap work merely because an old document mentions it.

Read [references/project-audit.md](references/project-audit.md) for the current capability audit, confirmed defects, test matrix, real experience flows, and product decisions.

## Select the mode

### Scoped engineering

Use when the request names one bug, feature, refactor, test, release, or compatibility target. Reproduce it, implement it, verify it, synchronize affected surfaces, and stop when its acceptance criteria pass.

### Repository audit

Use when the request asks what remains, what is broken, how to test, or how to experience the product. Inspect the live repository and classify findings as:

- `implemented` — production code and executable evidence exist;
- `confirmed-bug` — current code demonstrates incorrect behavior;
- `missing-required` — needed for the stated product or release goal;
- `optional-scope` — useful only if the maintainer chooses that direction;
- `blocked-external` — requires a live desktop, platform, credential, registry, or reviewer;
- `obsolete` — superseded by newer architecture.

Do not turn every possible feature into a backlog item.

### Completion campaign

Use when the user asks to finish all remaining development. Build a dependency-ordered ledger, implement every unblocked item with coherent commits, and continue after each green patch. Stop only when no local `confirmed-bug` or `missing-required` item remains, the relevant repository and release gates pass, and external blockers contain exact resume commands and expected evidence.

## Establish current truth

Before substantial work:

1. Read `AGENTS.md`, `package.json`, recent commits, open PRs and issues, `CHANGELOG.md`, latest tag, latest downloadable Release, this Skill, and the owning source and tests.
2. Compare source version, tag, downloadable assets, public Skill metadata, and package publication. They are separate facts.
3. Inspect the working tree or branch. Preserve unrelated changes and continue matching existing work instead of creating duplicate branches.
4. Run the nearest baseline test. For broad work, run `npm run verify:static` early.
5. Treat missing Actions visibility as missing evidence, not a code blocker. Run local equivalent gates.
6. Treat live TraeCN, platform access, release credentials, and registry publication as external only when the task genuinely requires them.

At the 2026-08-08 recheck, source metadata now declares `0.5.6`, while tag
`v0.5.5` still points to the earlier release-preparation commit and the latest
downloadable GitHub Release remained `v0.5.4`. ClawHub exposed a clean `0.5.5`
Skill whose canonical files matched the tagged Skill, while npm `traecnclaw`
remained `0.3.1` and the public mirror still declared canonical release
`v0.5.3`. The `ba53f06` feature milestone and its 0.5.6 release preparation
are newer than all of those immutable surfaces. The source version is not a
public release even though its exact clean commit passes the local release and
clean-room gate. A pre-publication recheck also found and patched the
high-severity transitive development dependency advisory
`GHSA-rgw5-rvv9-x895`; `test:release` now audits all dependencies at the high
threshold before packaging. Matching assets still need publication and
post-publication inspection. Never move the old tag or publish current
artifacts as if they came from it. Recheck before making any current claim.

## Architecture owners

- `src/mcp/contract.js`: frozen MCP contract v5 and exact ordered 20-tool surface.
- `src/mcp/protocol.js`, `src/mcp/stdio-server.js`, `src/mcp/task-extension.js`: protocol eras, framing, Tasks, subscriptions, cancellation, and request lifetime.
- `src/http/task-orchestrator.js`: candidate construction, durable acceptance, rollback, history mirror, semantic request fingerprints, and active/terminal idempotency replay.
- `src/http/task-store.js`: active tasks plus bounded terminal replay persistence, checksums, atomic replacement, recovery, health, and writer ownership.
- `src/shared/task-event-store.js`: completion events, cursor persistence, acknowledgements, pruning, long-poll, and recovery.
- `src/shared/task-history.js`: checksummed diagnostic task history and replay evidence with atomic replacement, backup recovery, quarantine, migration, and health.
- `src/http/completion-signal.js`: durable completion-event creation followed by external delivery.
- `src/http/queue-state-machine.js`, `src/http/task-queue-service.js`, `src/http/recovery-helper.js`: queue state, claims, persistence composition, restore, and polling support.
- `src/http/route-table.js` plus `src/http/handlers/*`: route composition and HTTP adapters.
- `src/trae-adapters`: versioned TraeCN detection, capabilities, selectors, and sanitized fixtures.
- `src/config/runtime-schema.js`: canonical runtime environment names and defaults.
- `scripts/quickstart.js`, `scripts/doctor.js`, `scripts/traecn-cli.js`, `skills/traecnclaw-mcp/scripts/setup-mcp.js`: first-run and operator experience.
- `scripts/package-skill.js`, `scripts/verify-release.js`, `scripts/clean-room-install.test.js`, `scripts/public-mirror.js`, `.github/workflows/release.yml`: packaging, provenance, installation, and publication.

Extend the existing owner. Delete the previous path after moving callers; never leave two active implementations.

## Settled invariants

- MCP contract v5 remains exactly 20 ordered tools unless an explicit migration is requested.
- Protocol revision and TRAECNclaw tool-contract version are separate.
- A task is not accepted until the active queue snapshot persists successfully.
- Active and retained terminal idempotent retries reuse the original task across restart; different semantic work must not collide, and terminal ownership expires after the configured TTL.
- A task is not submitted to TraeCN twice after retry, restart, timeout conversion, reconnect, or replay.
- Results remain bound to the submitting task and conversation identity.
- Core store failures remain observable and cannot produce false durability claims.
- Event pagination, acknowledgement, pruning, restart, and multi-client cursors do not replay foreign work or stall permanently.
- Subscription requests have stable IDs, baseline history before current snapshots, and resolve exactly once.
- Cancellation failures propagate; only a confirmed already-terminal race is an idempotent no-op.
- `TaskOrchestrator` owns acceptance identity; `CompletionSignal` owns completion delivery.
- Route metadata has one canonical composition path.
- Runtime defaults have one canonical schema.
- Generated Skill mirrors and release artifacts come from the exact verified commit.
- Keep Node.js 22, CommonJS, two-space formatting, and the plain-`assert` test style unless migration is explicitly requested.

## Current local defect status

The 2026-08-08 completion branch closes the previously confirmed Quickstart
probe, CLI timeout, task-history durability, stale live-UAT MCP discovery, and
terminal retry gap with executable regressions. It also supplies the selected
MCP-first setup command. A fresh strict no-delegation readiness run passes
against TraeCN 1.107.1, and a separate user-authorized live delegation completed
with status `done`. The Codex MCP entry is registered locally, but the running
host must reconnect before its real 20-tool invocation can be counted as host
evidence. Re-read `references/project-audit.md` and current source before
creating another local defect item. Remaining work is publication and that
real-host check,
unselected platform/host scope, or optional work unless new failing evidence
appears. The remaining normal release work is external publication, not another
local implementation item.

## Product decisions

Settled for the 0.5.6 source line:

- **Version:** the compatible post-`v0.5.5` work becomes `0.5.6`.
- **Terminal idempotency:** persist a semantic request fingerprint and terminal response for a configurable 24-hour default TTL.
- **Primary entry point:** MCP Skill for product use, CLI for live validation, web UI for diagnostics, and OpenClaw as an adapter.
- **Public server channel:** publish matching server and Skill archives through the canonical GitHub Release from one verified revision.

Still product-dependent; do not decide silently during an unrelated patch:

- **Completion fallback:** whether a named host without the draft Tasks extension needs a dedicated wake-up adapter.
- **Platform scope:** remain macOS and verified-version first, or invest in Windows or another TraeCN adapter.
- **Publication access:** the canonical repository is private, so a public GitHub Release requires an explicit visibility or public asset-hosting action.

Ask only when a decision changes product semantics. Do not ask for implementation details resolvable from code and tests.

## Autonomous implementation loop

For each actionable item:

1. **Characterize** — trace callers, persisted fields, states, events, and user-visible behavior; add a failing test or deterministic fixture.
2. **Implement** — make the smallest coherent production change in the owning component.
3. **Verify** — run the focused test, then the smallest subsystem gate that detects integration drift.
4. **Experience** — for onboarding and runtime work, exercise the real command or UI path, not only unit tests.
5. **Inspect adjacent edges** — fix directly related defects in the same ownership boundary; do not expand into speculative redesign.
6. **Synchronize** — update docs, OpenAPI, generated contracts, compatibility evidence, changelog, and release metadata only when affected.
7. **Record** — update `project-audit.md` when current capability, bug status, testing, experience, or product decisions change.
8. **Continue** — in completion campaign mode, move to the next unblocked item.

Do not replace safe implementation with issue creation. Create an issue only after all local work is exhausted or when the work is intentionally scheduled separately.

## Verification ladder

Use the smallest sufficient evidence:

1. `node path/to/focused.test.js`
2. subsystem tests such as `npm run test:mcp-conformance`, `npm run test:trae-adapters`, `npm run test:system`, or `npm run test:mcp-stdio-smoke`
3. `npm run verify:static`
4. `npm run verify` for repository-wide changes or campaign completion
5. `npm run test:release` for package and Release changes
6. `npm run doctor`, `npm run inspect:verify`, and strict live UAT for real TraeCN behavior

Static audits prove declarations, not behavior. Mock tests prove process integration, not live DOM compatibility. Clean-room tests prove locally built artifacts, not that a public asset is downloadable.

## Real experience requirement

For user-facing changes, validate at least one relevant path from `project-audit.md`:

- five-minute mock gateway, UI, and CLI experience;
- source-checkout live CLI task;
- MCP host task and completion path;
- Release-package clean-room installation.

Report exactly which path was exercised. Never label mock output as a real TraeCN result.

## External blockers

For each external blocker record:

- blocked item;
- why repository tests cannot prove it;
- exact command or manual action required;
- expected evidence or artifact;
- next code step after the evidence exists.

A live debug-enabled TraeCN instance, an unavailable platform, publication credentials, and registry review can be external blockers. Complexity, uncertainty resolvable by tests, failing code, or invisible private-repository Actions are not.

## Avoid wasted work

Do not:

- reopen settled 0.5.x capabilities without a failing regression;
- add Agent-facing wait, poll, event-acknowledgement, recovery, or subscription tools;
- restore MCP profiles;
- rewrite the language or framework instead of clarifying ownership;
- create generic TraeCN adapters or support claims without evidence;
- duplicate routes, configs, versions, contracts, stores, or generated files;
- bump versions, tag, or publish merely to make documentation look current;
- spend implementation work on marketplace wording or speculative protocol changes;
- claim source version, tag, GitHub Release, npm package, and ClawHub version are interchangeable.

## Completion standard

Before finishing a scoped task:

1. the defect or requirement has executable evidence;
2. focused and relevant subsystem tests pass;
3. an affected real experience path works or is precisely externally blocked;
4. generated and public surfaces remain synchronized;
5. no ownership, durability, protocol, or compatibility invariant is weakened;
6. the final report states changed files, behavior, tests, experience evidence, and remaining uncertainty.

A completion campaign ends only when no local confirmed bug or required feature remains, `npm run verify` passes, release-facing changes pass `npm run test:release`, and every external blocker has an exact resume procedure.

Do not stop at analysis when a safe code change is possible. Do not stop after the first patch when the request covers the remaining project.
