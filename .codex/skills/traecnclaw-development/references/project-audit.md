# TRAECNclaw project audit, tests, and real experience

This file replaces the historical development guide and rolling roadmap. It is a current operational document, not a changelog. Re-read the repository before trusting any status below.

## Audit snapshot

Observed on 2026-08-07:

- `package.json`, `main`, and tag `v0.5.5` identify source version `0.5.5`.
- The latest downloadable GitHub Release is still `v0.5.4`; do not tell users that a `0.5.5` Release archive is available until it actually exists.
- `package.json` is still private and npm is not an established public installation channel.
- The public MCP contract remains version 5 with exactly 20 ordered tools.
- The runtime has durable active-task and completion-event stores, active-task idempotency across restart, modern Tasks/subscriptions, clean-room mock installation, release-manifest verification, a first `TaskOrchestrator` boundary, and central route composition.
- Version-specific compatibility remains macOS TraeCN `1.107.x`, backed by historical `1.107.1` live evidence plus sanitized fixture replay. The currently installed TraeCN build has not yet passed a fresh strict live run.
- PR #19 was closed as an obsolete 0.5.4-based Skill proposal. PR #20 is the current 0.5.5 audit/Skill change.

Revalidate with:

```sh
git status --short
git log --oneline --decorate -20
node -p "require('./package.json').version"
git rev-list -n1 "v$(node -p "require('./package.json').version")"
gh release view --json tagName,assets,publishedAt 2>/dev/null || true
gh pr list --state open 2>/dev/null || true
gh issue list --state open 2>/dev/null || true
```

## Implemented capabilities

Do not rebuild these without a failing regression:

- Atomic, checksummed active-task snapshots with backup, quarantine, crash recovery, health, and single-writer ownership.
- Atomic, checksummed completion-event snapshots with backup, quarantine, cursor rollback, pruning-aware cursors, and recovery health.
- Durable task acceptance before HTTP `202`.
- Active-task idempotency replay after gateway restart.
- Exact task/conversation result ownership and guarded response collection.
- Modern MCP Tasks, exact-ID subscriptions, graceful cancellation, and official-client conformance coverage.
- Frozen MCP contract v5 with 20 focused tools and no profiles.
- Clean-room Skill/server packaging and release-manifest verification.
- `TaskOrchestrator` ownership of candidate construction, acceptance, rollback, history mirror, and active-task idempotency lookup.
- Versioned Trae adapter registry with verified `1.107` macOS replay and explicit degraded fallback.
- HTTP UI, CLI, OpenClaw adapter, stdio MCP server, metrics, doctor, inspect tooling, mock system tests, and live UAT tooling.

## Confirmed code defects or weak guarantees

### Q1 — quickstart CDP probe is not production-grade

Owner: `scripts/quickstart.js`.

Current behavior:

- raw `http.get()` has no request timeout and may hang indefinitely;
- any JSON from `/json/version` is accepted, including Chrome or another Electron app;
- the script has no direct behavior test; existing quickstart tests cover configuration helpers;
- an already-running non-debug TraeCN produces a failed probe rather than one integrated restart-with-debug experience.

Acceptance:

- injectable bounded CDP probe;
- reject non-2xx, invalid JSON, and non-TraeCN identity;
- actionable recovery for “TraeCN running without debug”;
- tests for success, timeout, wrong product, invalid JSON, and refusal;
- keep auto-launch opt-in.

### C1 — CLI request timeout option is ignored

Owner: `scripts/traecn-cli.js`, `src/client/traecnapi-client.js`.

`apiRequest()` passes `timeoutMs: 60000`, while `TraeCNApiClient` reads `options.timeout`. The CLI therefore uses the client default instead of its intended timeout.

Acceptance:

- use one canonical constructor option or deliberately support both;
- add a focused client/CLI regression test;
- keep runtime environment names separate from in-process options.

### H1 — task history is less durable than active tasks and events

Owner: `src/shared/task-history.js`.

Current behavior:

- persistence directly overwrites one JSON file without checksum, temp commit, backup, or quarantine;
- `recordStep()` sets `_dirty` but does not schedule `_persist()`, so a step-only update may stay memory-only until another mutation or graceful shutdown;
- load failure warns and starts empty.

This normally does not lose the accepted task or terminal event, but it can lose diagnostic and replay evidence.

Acceptance:

- schedule persistence from `recordStep()`;
- reuse a shared atomic JSON primitive or add equivalent temp/backup/quarantine semantics;
- expose health if history is advertised as durable evidence;
- add interrupted-write, corrupt-primary, step-only, and restart tests.

## Product decisions, not ordinary bugs

### I1 — terminal idempotency

Active tasks persist the key. Terminal tasks leave the active queue, and the restart test deliberately expects no replay after that point. An uncertain retry after completion and gateway restart can therefore create duplicate work.

Choose:

1. **Active-only idempotency** — document the boundary.
2. **Terminal replay ledger** — persist key + semantic request fingerprint + terminal task/result for a bounded TTL.

Recommended for option 2:

- reject the same key with different meaningful input;
- return the original terminal status/result;
- test restart, expiry, deliberate repeated work, and collision;
- start with a 24-hour configurable TTL unless the product requires longer.

### M1 — completion depends on host capability

Hosts implementing the draft Tasks extension can subscribe. Other hosts receive the accepted task and need an intentional later read. There is no universal automatic wake-up across every MCP host.

Do not add Agent-facing wait/poll tools. Build a host adapter only for a named host that needs it.

### P1 — primary entry point

Supported paths:

- MCP Skill / ClawHub;
- CLI;
- built-in web UI;
- OpenClaw plugin.

Recommended roles:

- MCP Skill: product path;
- CLI: developer and live validation;
- web UI: diagnostics;
- OpenClaw: ecosystem adapter.

### D1 — source/tag and published artifacts are out of sync

At this snapshot source/tag is `0.5.5`, while the latest GitHub Release is `0.5.4`; npm publication is not established. Treat 0.5.5 as source-only until exact artifacts are published.

Do not repair this by changing version text again. Publish verified 0.5.5 artifacts or move to a later exact release commit.

## Features not completed

### Required before broad public promotion

- Fresh strict live UAT against the currently installed TraeCN version.
- Published server and Skill artifacts matching the advertised version.
- One clean public install channel: GitHub Release, npm, MCPB, or another exact-version source.
- One documented primary onboarding path.
- Real-host verification for the intended MCP client, not only the protocol test client.

### Valuable next engineering work

- Q1 quickstart hardening.
- C1 CLI timeout correction.
- H1 history persistence hardening.
- Decide and implement or document I1 terminal idempotency.
- Add a human-facing first-run/setup command if MCP becomes the primary path.
- Continue one lifecycle-transition extraction from `Gateway` only after characterization tests.

### Conditional or optional

Do not call these missing unless product scope selects them:

- Windows support;
- second TraeCN adapter;
- Streamable HTTP MCP transport;
- MCPB, npm, or official Registry publication;
- more MCP tools;
- generic multi-IDE adapter.

## Test ladder

### 1. Fast static confidence

```sh
npm ci
npm run verify:static
```

Checks versions, generated configuration, Skill contracts, and release scanning. It does not prove runtime behavior.

### 2. Focused subsystem tests

```sh
node src/http/task-restart-retry.test.js
node src/shared/task-event-store.test.js
node src/shared/task-history.test.js
node src/http/task-orchestrator.test.js
node scripts/doctor.test.js
npm run test:mcp-conformance
npm run test:trae-adapters
```

Run the nearest focused test first.

### 3. Mock runtime integration

```sh
npm run test:system
npm run test:mcp-stdio-smoke
```

Proves real gateway/MCP processes against the mock bridge, not live DOM compatibility.

### 4. Full repository gate

```sh
npm run verify
```

Use before merging repository-wide reliability or refactor work.

### 5. Release and clean-room gate

```sh
npm run test:release
```

Builds Skill/server archives, verifies provenance and checksums, installs under a temporary HOME, discovers all 20 tools, submits a mock task, subscribes, and reads completion.

This does not prove a public asset exists or that a real TraeCN build works.

### 6. Live readiness without sending a task

```sh
npm run doctor
npm run inspect:verify
node scripts/live-uat.js --strict --require-ready --require-verified-adapter
```

Expected evidence:

- CDP identifies TraeCN;
- readiness is true;
- `/api/status.traeAdapter` reports exact version/platform and `verified: true`;
- queue, dialog, capabilities, and selector checks pass;
- mock bridge is off.

### 7. Live task experience

Only when sending a real prompt is acceptable:

```sh
node scripts/live-uat.js \
  --strict \
  --require-ready \
  --require-verified-adapter \
  --delegate \
  --delegate-task "请只回复 TRAECNCLAW_LIVE_OK"
```

Add `--exercise-background-workflow` to verify task ID, review state, continuation, and final result.

## How to experience the project

### Five-minute mock experience

Terminal 1:

```sh
npm ci
TRAECN_ENABLE_MOCK_BRIDGE=1 npm run start:gateway
```

Open:

```text
http://127.0.0.1:8788/
```

Terminal 2:

```sh
node scripts/traecn-cli.js status
node scripts/traecn-cli.js delegate "Return MOCK_EXPERIENCE_OK"
```

Confirm mock mode, task creation, completion, and visible history. Never use this as live compatibility evidence.

### Source-checkout live experience

1. Quit a non-debug TraeCN instance when necessary.
2. Start the existing logged-in profile with CDP:

```sh
TRAECN_QUICKSTART_PROFILE_MODE=existing \
  npm run start:traecn -- --force-new --use-existing-profile
```

3. Verify and start:

```sh
npm run doctor
npm run inspect:verify
npm run start:gateway
```

4. Send one real task:

```sh
node scripts/traecn-cli.js status
node scripts/traecn-cli.js delegate "请只回复 TRAECNCLAW_REAL_OK"
```

5. Inspect `http://127.0.0.1:8788/`, `/api/status`, and the exact task result.

### MCP experience

1. Keep the gateway running.
2. Copy `skills/traecnclaw-mcp/assets/mcp-client-config.json` into the host and replace `SKILL_DIR`.
3. Restart the host.
4. Call `traecn_list_models`, optionally change one context item, then call `traecn_send_message`.
5. Verify the same durable task ID in the host and gateway.
6. With Tasks support, verify subscription completion; otherwise perform one intentional `traecn_get_task` read later.

### Release-package experience

Use only a version with actual downloadable assets. Install the matching server and Skill archives, start the mock gateway, and repeat MCP discovery/task completion. `npm run test:release` is the automated local equivalent.

## Questions for the maintainer

Discuss these before changing product semantics, not before ordinary bug fixes:

1. Publish 0.5.5 now, or wait for fresh live UAT and publish a later exact version?
2. Which entry point is primary: MCP Skill, CLI, web UI, or OpenClaw?
3. Should idempotency survive terminal completion and restart? Is 24 hours an acceptable default TTL?
4. Is macOS-only support acceptable for the next public milestone, or is Windows near-term?
5. Which non-Tasks host, if any, must receive an automatic completion wake-up?
6. Will the repository/package be public or intentionally invite-only?

## Recommended order

1. Fix Q1 and C1 because they directly affect first use.
2. Run live readiness against the installed TraeCN and update compatibility evidence.
3. Decide I1 and P1.
4. Harden H1 if history/replay is a product promise.
5. Publish one exact verified version and install it from the downloadable artifact.
6. Resume architecture extraction only after the real experience path is stable.
