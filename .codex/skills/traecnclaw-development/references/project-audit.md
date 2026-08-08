# TRAECNclaw project audit, tests, and real experience

This file replaces the historical development guide and rolling roadmap. It is a current operational document, not a changelog. Re-read the repository before trusting any status below.

## Audit snapshot

Observed on 2026-08-08:

- `package.json`, the lockfile, portable Skill, and OpenClaw manifests now identify source version `0.5.6`. The completed feature milestone is `ba53f06`; tag `v0.5.5` still points to `4c01911` and does not contain these changes.
- The latest downloadable GitHub Release is still `v0.5.4`; do not tell users that a `0.5.6` Release archive is available until it actually exists.
- The canonical GitHub repository is private. npm `traecnclaw` exists publicly but its `latest` tag is still `0.3.1`, sourced from the public mirror repository; it is not a matching server channel for current `0.5.x` behavior.
- ClawHub `traecnclaw-mcp` publishes a clean `0.5.5` Skill. Its canonical Skill/config/contract/launcher file hashes match the local `v0.5.5` Skill, but ClawHub does not supply the matching server by itself.
- The public `Luckycat133/traecnclaw-mcp-skill` mirror is visible, but its `SOURCE_REVISION` still identifies canonical commit `8b97e37` / release `v0.5.3`; its latest GitHub Release is the older `v0.3.0-mcp-skill.1` bundle.
- The public MCP contract remains version 5 with exactly 20 ordered tools.
- The runtime has durable active-task, terminal-idempotency, completion-event, and task-history stores; active and terminal replay across restart; modern Tasks/subscriptions; clean-room mock installation; release-manifest verification; a `TaskOrchestrator` ownership boundary; central route composition; and a tested MCP client-config generator.
- Version-specific compatibility remains macOS TraeCN `1.107.x`, backed by sanitized fixture replay and a fresh 2026-08-08 strict readiness run against installed TraeCN `1.107.1`. That run did not send a delegated task or spend model quota.
- PR #19 was closed as an obsolete 0.5.4-based Skill proposal. PR #20 merged the 0.5.5 audit/Skill refresh on 2026-08-08; there are currently no open pull requests or issues.

Revalidate with:

```sh
git status --short
git log --oneline --decorate -20
node -p "require('./package.json').version"
git rev-list -n1 "v$(node -p "require('./package.json').version")"
gh release view --json tagName,assets,publishedAt 2>/dev/null || true
gh pr list --state open 2>/dev/null || true
gh issue list --state open 2>/dev/null || true
npm view traecnclaw version dist-tags repository --json
clawhub inspect traecnclaw-mcp --versions --limit 3
gh api -H 'Accept: application/vnd.github.raw+json' repos/Luckycat133/traecnclaw-mcp-skill/contents/SOURCE_REVISION
```

## Completion verdict

- **Local implementation:** complete for the defects and accepted product work
  confirmed by this audit. Q1, C1, H1, U1, I1, and MCP-first setup have
  production changes plus executable regressions; no
  additional unblocked local `confirmed-bug` or unconditional
  `missing-required` item is known.
- **Repository evidence:** `npm run verify` passed on the current code and
  documentation state on 2026-08-08. Coverage was 86.04% lines/statements,
  76.38% branches, and 76.34% functions. Generated configuration, Skill
  contracts, release scanning, lint, tests, mock system/UAT, and coverage all
  passed; `git diff --check` was also clean.
- **Live readiness:** strict no-delegation UAT passed against TraeCN 1.107.1
  with the verified `traecn-1.107` adapter. It sent no prompt and deleted no
  conversation.
- **Release/product completion:** source preparation is at 0.5.6, but public
  completion is not. The exact clean revision must pass `npm run test:release`,
  and public server distribution remains version fragmented. The 0.5.6, I1,
  P1, and GitHub Release channel decisions are settled locally; publication
  access and real-host/live evidence remain external.

## 0.5.6 completion milestone

The feature and documentation set is committed at `ba53f06`; generated version
surfaces form the separate 0.5.6 release-preparation change:

| Area | Owning files | Outcome |
| --- | --- | --- |
| Quickstart and first use | `scripts/quickstart.js`, `scripts/quickstart.test.js`, `src/config/runtime-schema.js`, `package.json`, `README.md`, `docs/configuration.md` | Bounded identity-aware CDP probe, import-safe tests, and exact logged-in-profile recovery command. |
| CLI request boundary | `scripts/traecn-cli.js`, `scripts/traecn-cli.test.js` | The intended 60-second client timeout is actually applied. |
| Task-history durability | `src/shared/task-history.js`, `src/shared/task-history.test.js`, `src/http/gateway.js`, `src/http/gateway.test.js`, `src/http/openapi.js`, `docs/MIGRATING-TO-0.5.md` | Checksummed schema 2 snapshots, atomic replacement, backup/quarantine/recovery, step-only persistence, zero-retention correctness, and status/OpenAPI health. |
| Terminal idempotency | `src/http/task-store.js`, `src/http/task-queue-service.js`, `src/http/task-orchestrator.js`, `src/http/handlers/unified-agent.js`, `src/http/gateway.js`, `src/http/openapi.js`, `src/config/runtime-schema.js` and focused tests | TaskStore schema 3 retains fingerprinted terminal responses for a configurable 24-hour default TTL, replays across restart, rejects semantic collisions, and reports retention health. |
| MCP-first onboarding | `skills/traecnclaw-mcp/scripts/setup-mcp.js`, its test, `package.json`, `README.md`, and MCP setup/distribution guides | Validates matching server discovery, prints resolved JSON, and safely creates a new mode-0600 configuration file without overwrite. |
| Live contract and compatibility | `scripts/live-uat.js`, `scripts/uat-checklist.js`, `docs/COMPATIBILITY.md`, `docs/REAL-DOM-FINDINGS.md` | Live UAT follows the current MCP v5 surface and records fresh TraeCN 1.107.1 readiness evidence. |
| Maintainer and release truth | `.codex/skills/traecnclaw-development/SKILL.md`, this audit, `CHANGELOG.md`, `docs/DISTRIBUTION.md` | Closed defects, accepted 0.5.6/MCP/idempotency/Release decisions, version-channel inventory, and exact next actions are synchronized. |

Do not move or rebuild `v0.5.5` with these changes: that immutable tag predates
every change in this table.

## Implemented capabilities

Do not rebuild these without a failing regression:

- Atomic, checksummed TaskStore schema 3 snapshots for active tasks and bounded terminal idempotency replays, with backup, quarantine, crash recovery, health, and single-writer ownership.
- Atomic, checksummed completion-event snapshots with backup, quarantine, cursor rollback, pruning-aware cursors, and recovery health.
- Atomic, checksummed task-history snapshots with backup, quarantine, legacy/temp recovery, step-only persistence, and recovery health.
- Durable task acceptance before HTTP `202`.
- Active-task and fingerprinted terminal-result idempotency replay after gateway restart, with collision rejection and configurable expiry.
- Exact task/conversation result ownership and guarded response collection.
- Modern MCP Tasks, exact-ID subscriptions, graceful cancellation, and official-client conformance coverage.
- Frozen MCP contract v5 with 20 focused tools and no profiles.
- Clean-room Skill/server packaging and release-manifest verification.
- `TaskOrchestrator` ownership of candidate construction, acceptance, rollback, history mirror, request fingerprints, and active/terminal idempotency lookup.
- Versioned Trae adapter registry with verified `1.107` macOS replay and explicit degraded fallback.
- HTTP UI, CLI, OpenClaw adapter, stdio MCP server, metrics, doctor, inspect tooling, mock system tests, and live UAT tooling.

## Closed local defects on the current branch

### Q1 — Quickstart CDP probing

`scripts/quickstart.js` now uses an injectable five-second bounded probe over
the canonical CDP version fetcher, rejects non-2xx, invalid JSON, and
non-TraeCN endpoints, remains import-safe for tests, and prints the confirmed
logged-in-profile restart command when a running TraeCN lacks debug access.
`scripts/quickstart.test.js` covers success, timeout, refusal, HTTP failure,
invalid JSON, wrong product, injection, and import side effects.

### C1 — CLI request timeout

`scripts/traecn-cli.js` now passes the intended 60-second request timeout via
the client's canonical `timeout` option. `scripts/traecn-cli.test.js` executes
the adapter/client boundary and distinguishes the intended value from the
client's 120-second default.

### H1 — task-history durability

`src/shared/task-history.js` now schedules step-only writes and persists
checksummed schema 2 snapshots through a durable temporary file, preserving a
validated backup and recovering or quarantining legacy, backup, temporary, and
corrupt candidates. `GET /api/status` exposes `durability.taskHistory`, and its
degraded state contributes to aggregate durability. Focused tests cover atomic
writes, backup recovery, interrupted temporary recovery, migration, write
health, step-only restart, and the previously hidden zero-retention case.

### U1 — live-UAT MCP discovery drift

Strict live UAT exposed a stale assertion for the removed
`traecn_cleanup_queue_probe_chats` tool. `scripts/live-uat.js` now validates the
current gateway-managed MCP v5 task surface through `traecn_send_message`,
while retaining operator cleanup checks through the command set and OpenClaw
adapter. `scripts/uat-checklist.js` prevents the retired tool name from
returning. The corrected no-delegation UAT passed against TraeCN 1.107.1 on
2026-08-08.

## Settled product decisions and external scope

### I1 — terminal idempotency: closed locally

The selected behavior is a persistent terminal replay ledger under TaskStore
schema 3. It stores the stable key, semantic SHA-256 request fingerprint, task
ID, terminal status/result/error, completion time, and expiry. The default TTL
is 24 hours through `TRAECN_TERMINAL_IDEMPOTENCY_TTL_MS`. Active and terminal
collisions return HTTP 409, keys longer than 256 characters return HTTP 400,
and retained terminal retries return the original response with HTTP 200 before
any TraeCN connection work. Restart, migration, collision, write health, and
exact-expiry tests cover the boundary.

### M1 — completion depends on host capability

Hosts implementing the draft Tasks extension can subscribe. Other hosts receive the accepted task and need an intentional later read. There is no universal automatic wake-up across every MCP host.

Do not add Agent-facing wait/poll tools. Build a host adapter only for a named host that needs it.

### P1 — primary entry point: settled

The MCP Skill is the product path. `npm run --silent setup:mcp` validates the
matching server and emits a resolved host entry; `--output FILE` safely creates
a new configuration artifact. The CLI is for developer/live validation, the
built-in web UI is diagnostic, and OpenClaw is an ecosystem adapter. A real
intended-host task is still evidence to collect, not a missing local feature.

### D1 — source, tag, and published artifacts are out of sync

At this snapshot source is `0.5.6`, but the immutable `v0.5.5` tag is older
than the `ba53f06` feature milestone and its release preparation. The latest downloadable
GitHub Release is `v0.5.4`; npm is `0.3.1`; the public mirror identifies
`v0.5.3`; and only the standalone ClawHub Skill is at `0.5.5`. Current fixes
therefore have no exact published version or complete public server + Skill
installation pair.

Do not move or overwrite `v0.5.5`. Historical artifacts must come from that
exact tag. Verify source version 0.5.6 at one exact release commit and publish
only matching artifacts from that revision.

## Features not completed

### Required before broad public promotion

- Verify source version 0.5.6 from one exact clean commit.
- Publish a matching server artifact or package; the ClawHub Skill alone cannot run TRAECNclaw.
- Synchronize the public mirror and every published Skill/server surface from that exact commit.
- Publish the selected canonical GitHub Release through an explicitly public or otherwise intended access path.
- Real-host verification for the intended MCP client, not only the protocol test client.

### Valuable next engineering work

- Continue one lifecycle-transition extraction from `Gateway` only after characterization tests and after the release path is stable.

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
node skills/traecnclaw-mcp/scripts/setup-mcp.test.js
node scripts/doctor.test.js
node scripts/quickstart.test.js
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
- MCP/OpenClaw discovery surfaces match their current contracts;
- settings and Solo-chat reads complete, with cleanup dry-run reporting zero matches;
- mock bridge is off.

On 2026-08-08 this exact command passed against installed TraeCN 1.107.1 with
adapter `traecn-1.107`. No delegated task was sent and no conversation was
deleted.

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
2. Run `npm run --silent setup:mcp`, merge the emitted `mcpServers.traecn` entry into the intended host, and retain stderr as server-discovery evidence.
3. Restart or reconnect the host.
4. Call `traecn_list_models`, optionally change one context item, then call `traecn_send_message`.
5. Verify the same durable task ID in the host and gateway.
6. With Tasks support, verify subscription completion; otherwise perform one intentional `traecn_get_task` read later.

### Release-package experience

Use only a version with actual downloadable assets. Install the matching server and Skill archives, start the mock gateway, and repeat MCP discovery/task completion. `npm run test:release` is the automated local equivalent.

## Questions for the maintainer

The release version, product entry point, terminal-idempotency TTL, and GitHub
Release server channel are settled. Discuss only scope that still changes the
product:

1. Is macOS-only support acceptable after 0.5.6, or is Windows near-term?
2. Which non-Tasks host, if any, must receive an automatic completion wake-up?
3. Will the canonical repository/Release become publicly downloadable, or must the selected GitHub Release assets be mirrored to another public host?

## Recommended order

1. Commit the generated 0.5.6 version synchronization, then run
   `npm run test:release` from the resulting clean exact commit.
2. When model quota and UI effects are authorized, run the live delegated task
   and intended-host MCP completion path. Expected evidence is one owned task
   ID, one terminal result, no duplicate submission, and the same identity in
   the host and gateway.
3. After explicit publication/visibility authorization, tag only the verified commit, publish matching server and Skill artifacts,
   synchronize the public mirror to that full revision, and re-run GitHub,
   npm, and ClawHub inspection before announcing the version.
4. Resume optional Gateway extraction or wider platform work only after this
   product and distribution path is stable.
