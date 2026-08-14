# TRAECNclaw project audit, tests, and real experience

This file replaces the historical development guide and rolling roadmap. It is a current operational document, not a changelog. Re-read the repository before trusting any status below.

## Audit snapshot

Observed on 2026-08-08:

- `package.json`, the lockfile, portable Skill, and OpenClaw manifests identify source version `0.5.6`. Canonical tag `v0.5.6`, both Release manifests, and the public mirror `SOURCE_REVISION` identify the same immutable source commit.
- The canonical GitHub repository and its matching `v0.5.6` provenance Release remain private. Its full history was not made public merely for distribution.
- The public `Luckycat133/traecnclaw-mcp-skill` mirror exposes a matching `v0.5.6` Release containing the server archive, Skill archives, and release manifest from that canonical commit.
- ClawHub `traecnclaw-mcp` publishes the matching clean 0.5.6 Skill. It pairs with the public mirror server archive; ClawHub does not carry the server by itself.
- npm `traecnclaw` remains public at `latest=0.3.1`; it is a separate older channel and is not a matching 0.5.6 server.
- The public MCP contract remains version 5 with exactly 20 ordered tools.
- The runtime has durable active-task, terminal-idempotency, completion-event, and task-history stores; active and terminal replay across restart; modern Tasks/subscriptions; clean-room mock installation; release-manifest verification; a `TaskOrchestrator` ownership boundary; central route composition; and a tested MCP client-config generator.
- A pre-publication push exposed Dependabot alert 6 / `GHSA-rgw5-rvv9-x895` in the transitive development dependency `brace-expansion@5.0.8`. The lock now resolves patched 5.0.9, `npm audit` reports zero vulnerabilities, and `test:release` enforces a full high/critical dependency audit before packaging.
- Version-specific compatibility remains macOS TraeCN `1.107.x`, backed by sanitized fixture replay and a fresh 2026-08-08 strict readiness run against installed TraeCN `1.107.1`. A separate user-authorized run sent exactly one short live prompt and returned `delegate-async: done`; it was not mock output. A real Codex CLI host then invoked the configured `traecn` MCP server, created task `task_1_mskicgl7_1dr1vgws79`, and the gateway collected `TRAECNCLAW_MCP_HOST_OK` with status `done`.
- The first Codex host attempt exposed two local defects before that success: unrelated legacy `_meta.progressToken` metadata switched the stdio process to the modern era, and a brand-new legacy client replayed retained task summaries. The protocol check now requires the explicit version metadata key, and new client IDs baseline retained events while returning IDs preserve durable missed-event delivery. A fresh Codex client against the retained live result emitted no history and durably acknowledged `evt_1`.
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
  documentation state on 2026-08-08. Coverage was 86.07% lines/statements,
  76.38% branches, and 76.40% functions. Generated configuration, Skill
  contracts, release scanning, lint, tests, mock system/UAT, and coverage all
  passed; `git diff --check` was also clean.
- **Release-package evidence:** `npm run test:release` passes for the clean
  0.5.6 revision. It builds both Skill and server archives, verifies the
  full dependency audit and manifest revision/sizes/SHA-256 values, installs
  under a temporary HOME, discovers the exact 20 tools, and completes a mock
  task. The generated
  `dist/traecnclaw-mcp-release.json` is the authoritative exact revision and
  artifact-byte record; `dist/` remains intentionally untracked.
- **Live readiness:** strict no-delegation UAT passed against TraeCN 1.107.1
  with the verified `traecn-1.107` adapter. A subsequent authorized live
  delegation completed with status `done`; no conversation was deleted. Codex
  then created durable task `task_1_mskicgl7_1dr1vgws79` through the configured
  MCP server, and the gateway collected terminal result
  `TRAECNCLAW_MCP_HOST_OK`. A separate fresh client baselined the retained event
  without replaying its summary.
- **Release/product completion:** 0.5.6 is complete for the selected channels.
  The private canonical Release and public mirror Release carry identical
  verified server/Skill artifacts, and ClawHub carries the matching Skill.
  Post-publication inspection passed. npm remains explicitly outside this
  release rather than a fragmented current channel.

## 0.5.6 completion milestone

The feature and documentation set is committed at `ba53f06`; generated version
surfaces begin the separate 0.5.6 release preparation at `bc6aee7`. The final
artifact revision is always the one recorded by the generated release manifest:

| Area | Owning files | Outcome |
| --- | --- | --- |
| Quickstart and first use | `scripts/quickstart.js`, `scripts/quickstart.test.js`, `src/config/runtime-schema.js`, `package.json`, `README.md`, `docs/configuration.md` | Bounded identity-aware CDP probe, import-safe tests, and exact logged-in-profile recovery command. |
| CLI request boundary | `scripts/traecn-cli.js`, `scripts/traecn-cli.test.js` | The intended 60-second client timeout is actually applied. |
| Task-history durability | `src/shared/task-history.js`, `src/shared/task-history.test.js`, `src/http/gateway.js`, `src/http/gateway.test.js`, `src/http/openapi.js`, `docs/MIGRATING-TO-0.5.md` | Checksummed schema 2 snapshots, atomic replacement, backup/quarantine/recovery, step-only persistence, zero-retention correctness, and status/OpenAPI health. |
| Terminal idempotency | `src/http/task-store.js`, `src/http/task-queue-service.js`, `src/http/task-orchestrator.js`, `src/http/handlers/unified-agent.js`, `src/http/gateway.js`, `src/http/openapi.js`, `src/config/runtime-schema.js` and focused tests | TaskStore schema 3 retains fingerprinted terminal responses for a configurable 24-hour default TTL, replays across restart, rejects semantic collisions, and reports retention health. |
| MCP-first onboarding | `skills/traecnclaw-mcp/scripts/setup-mcp.js`, its test, `package.json`, `README.md`, and MCP setup/distribution guides | Validates matching server discovery, prints resolved JSON, and safely creates a new mode-0600 configuration file without overwrite. |
| Codex host interoperability | `src/mcp/protocol.js`, `src/mcp/stdio-server.js`, `src/shared/task-event-store.js`, `src/http/openapi.js`, focused tests, and MCP documentation | Ignores unrelated progress metadata during legacy negotiation, baselines retained events for a new client ID, preserves returning-client replay, and passes a real Codex-to-TraeCN task plus retained-event isolation check. |
| Live contract and compatibility | `scripts/live-uat.js`, `scripts/uat-checklist.js`, `docs/COMPATIBILITY.md`, `docs/REAL-DOM-FINDINGS.md` | Live UAT follows the current MCP v5 surface and records fresh TraeCN 1.107.1 readiness evidence. |
| Release dependency security | `package-lock.json`, `package.json`, `scripts/coverage-audit.js`, `CHANGELOG.md`, `docs/DISTRIBUTION.md` | Pins patched `brace-expansion@5.0.9`, clears the high Dependabot advisory, and requires a full high/critical dependency audit before release packaging. |
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
- Legacy Codex request metadata compatibility plus new-client history
  baselining and returning-client durable event resume.
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

### C2 — Codex legacy metadata era misclassification

Codex sends `_meta.progressToken` on legacy `tools/list`. The stdio server
previously interpreted the presence of any `_meta` object as a modern request
and rejected the connection for switching eras after `initialize`.
`modernProtocolVersion` now recognizes only the explicit
`io.modelcontextprotocol/protocolVersion` key. A transcript regression pins the
Codex request shape, and the real Codex host subsequently discovered and called
`traecn_send_message` successfully.

### E1 — new legacy client replayed retained task history

The durable event store previously exposed no distinction between a new client
ID and a returning ID with a persisted acknowledgement. A first-time Codex
connection therefore received every retained task summary. Event batches now
include `clientKnown` and `acknowledgedCursor`; the legacy pump drains and
durably acknowledges retained history only for a new ID, while a returning ID
continues from its prior acknowledgement. Unit tests cover both branches. A
fresh real Codex client connected after live task completion, emitted no
historical notification, and established cursor `evt_1`.

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
Codex intended-host task and first-connection history-baseline check now pass;
no host-evidence item remains open for the selected 0.5.6 path.

### D1 — release channel synchronization: closed for 0.5.6

The immutable canonical `v0.5.6` tag identifies the revision recorded by the
release manifest. The private canonical Release preserves provenance; the
public mirror's `v0.5.6` Release carries the same server, Skill, and manifest
artifacts; and ClawHub publishes the matching 0.5.6 Skill. The mirror's
`SOURCE_REVISION` records that canonical source rather than pretending the
generated mirror commit is the implementation revision.

npm remains at 0.3.1 by deliberate channel selection. Do not describe it as a
current server, move historical tags, or rebuild an existing version from a
different revision. Any future npm or catalog release needs its own exact
provenance and post-publication inspection.

## Work not selected for 0.5.6

No required local implementation or selected release-channel item remains for
0.5.6. New work needs new failing evidence or an explicit product-scope choice.

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

Audits production and development dependencies at the high threshold, builds
Skill/server archives, verifies provenance and checksums, installs under a
temporary HOME, discovers all 20 tools, submits a mock task, subscribes, and
reads completion.

This does not prove a public asset exists or that a real TraeCN build works.
The gate passes for the current clean 0.5.6 source; rerun it after any committed
change before tagging or attaching assets.

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

The intended-host check also passed on 2026-08-08. Codex CLI negotiated the
legacy MCP lifecycle, called `traecn_send_message` once, and received accepted
task ID `task_1_mskicgl7_1dr1vgws79`; the live gateway later reported `done`
with result `TRAECNCLAW_MCP_HOST_OK`. A second new Codex client connected after
that event existed, received no historical content, and durably baselined
cursor `evt_1`.

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

The selected Codex host path completed steps 1-5 on 2026-08-08. Codex is an
initialization-based client in this run, so the accepted task was intentionally
read from the gateway after completion rather than described as a Tasks
subscription result.

### Release-package experience

Use only a version with actual downloadable assets. Install the matching server and Skill archives, start the mock gateway, and repeat MCP discovery/task completion. `npm run test:release` is the automated local equivalent.

## Questions for the maintainer

The release version, product entry point, terminal-idempotency TTL, canonical
provenance Release, and public mirror server channel are settled. Discuss only
scope that still changes the product:

1. Is macOS-only support acceptable after 0.5.6, or is Windows near-term?
2. Which non-Tasks host, if any, must receive an automatic completion wake-up?

## Recommended order

1. Preserve the 0.5.6 tag, manifest, public mirror, and ClawHub provenance. For
   any later catalog or npm work, select the channel explicitly and inspect it
   after publication before changing current-version claims.
2. Resume optional Gateway extraction, a named non-Tasks host adapter, or wider
   platform work only when that product scope is selected.
