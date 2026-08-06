# TRAECNclaw project audit, tests, and real experience

This file replaces the historical development guide and rolling roadmap. It is a current operational document, not a changelog. Re-read the repository before trusting any status below.

## Audit snapshot

Observed on 2026-08-07:

- `package.json`, `main`, and tag `v0.5.5` identify source version `0.5.5`.
- The latest downloadable GitHub Release is still `v0.5.4`; do not tell users that a `0.5.5` release archive is available until it actually exists.
- `package.json` is still private and the npm package is not an established public installation channel.
- The public MCP contract remains version 5 with exactly 20 ordered tools.
- The runtime has durable active-task and completion-event stores, persistent active-task idempotency, modern Tasks/subscriptions, release-manifest verification, clean-room mock installation, a first `TaskOrchestrator` boundary, and central route composition.
- Version-specific live compatibility remains macOS TraeCN `1.107.x`, backed by historical `1.107.1` evidence plus fixture replay. The current installed TraeCN build has not yet been proven by a fresh strict live run.
- Open PR #19 was created from the `0.5.4` baseline and is superseded by any newer audit/Skill branch unless it is rebased and reconciled deliberately.

Revalidate with:

```sh
git status --short
git log --oneline --decorate -20
node -p "require('./package.json').version"
git rev-parse main
git rev-list -n1 "v$(node -p "require('./package.json').version")"
gh release view --json tagName,assets,publishedAt 2>/dev/null || true
gh pr list --state open 2>/dev/null || true
gh issue list --state open 2>/dev/null || true
```

## What is already implemented

Do not rebuild these without a failing regression:

- Atomic, checksummed active-task snapshots with backup, quarantine, crash recovery, health, and single-writer ownership.
- Atomic, checksummed completion-event snapshots with backup, quarantine, cursor rollback, pruning-aware cursors, and recovery health.
- Durable acceptance before HTTP `202`.
- Active-task idempotency replay after gateway restart.
- Exact task/conversation result ownership and guarded response collection.
- Modern MCP Tasks, exact-ID subscriptions, graceful cancellation, and official-client conformance coverage.
- Frozen MCP contract v5 with 20 focused tools and no profiles.
- Clean-room Skill/server packaging and release-manifest verification.
- First `TaskOrchestrator` extraction: candidate construction, acceptance, rollback, history mirror, and active-task idempotency lookup.
- Versioned Trae adapter registry with verified `1.107` macOS fixture replay and explicit degraded fallback.
- Built-in HTTP UI, CLI, OpenClaw adapter, stdio MCP server, metrics, doctor, inspect tooling, mock system tests, and live UAT tooling.

## Confirmed code defects or weak guarantees

### Q1 — quickstart CDP probe is not production-grade

Owner: `scripts/quickstart.js`.

Current behavior:

- the raw `http.get()` probe has no request timeout and may hang indefinitely;
- any JSON returned by `/json/version` is accepted, even if the endpoint belongs to Chrome or another Electron app rather than TraeCN;
- the script itself has no direct behavior test; existing quickstart tests cover configuration helpers instead;
- when TraeCN is already running without CDP, quickstart exits after the failed probe rather than offering one integrated restart-with-debug path.

Acceptance criteria:

- extract an injectable CDP probe with a bounded timeout;
- reject non-2xx, invalid JSON, and non-TraeCN browser identity;
- produce one actionable recovery message for “TraeCN running without debug”;
- add script-level tests for success, timeout, wrong product, invalid JSON, and connection refusal;
- keep auto-launch opt-in.

### C1 — CLI request timeout option is ignored

Owner: `scripts/traecn-cli.js` and `src/client/traecnapi-client.js`.

`apiRequest()` constructs `TraeCNApiClient` with `timeoutMs: 60000`, while the client constructor reads `options.timeout`. The CLI therefore uses the client default instead of its intended timeout.

Acceptance criteria:

- pass the canonical option name or make the client accept both names consistently;
- add a focused constructor/CLI regression test;
- keep runtime-schema names separate from in-process constructor options.

### H1 — task history is less durable than active tasks and events

Owner: `src/shared/task-history.js`.

Current behavior:

- persistence overwrites the primary JSON file directly, without checksum, temporary commit, backup, or quarantine;
- `recordStep()` marks the store dirty but does not schedule `_persist()`, so a step recorded after the previous debounce completed may remain memory-only until another mutation or graceful shutdown;
- load failure only warns and starts with an empty in-memory history.

This does not normally lose an accepted task or terminal event, but it can lose diagnostic/history evidence and makes replay less trustworthy.

Acceptance criteria:

- make `recordStep()` schedule persistence;
- either reuse a shared atomic JSON primitive or give history equivalent temp/backup/quarantine semantics;
- expose write/load health if history is presented as durable evidence;
- add interrupted-write, corrupt-primary, step-only persistence, and restart tests.

## Important limitations that require a product decision

### I1 — terminal idempotency ownership is not durable across restart

Active tasks persist their idempotency key. Once a task becomes terminal it is removed from the active queue. The current restart test deliberately expects `resolveIdempotentTask()` to return `null` for that completed task.

Consequence: an uncertain retry arriving after completion and gateway restart can create duplicate work.

Choose one semantic:

1. **Active-only idempotency** — document that callers must not retry after terminal ownership expires.
2. **Terminal replay ledger** — persist a bounded key -> request fingerprint -> terminal task/result mapping for a TTL.

Recommended design if option 2 is chosen:

- require a request fingerprint in addition to the key;
- reject key reuse with different meaningful input;
- retain terminal ownership for a configured TTL;
- return the original terminal status/result rather than `accepted`;
- test restart, expiry, intentional repeated identical work, and key collision.

### M1 — automatic completion depends on host capability

Modern hosts that implement the draft Tasks extension can subscribe. Hosts without it receive the accepted task and must intentionally read it later. There is no universal automatic wake-up across every MCP host.

Do not add Agent-facing wait/poll tools. Add a host adapter only for a named host that needs it, or keep the current explicit-read fallback.

### P1 — the primary product entry point is not decided

The repository supports four entry points:

- MCP Skill / ClawHub;
- CLI;
- built-in web UI;
- OpenClaw plugin.

They are all valid, but onboarding and documentation are spread across them. Pick one primary path and treat the others as secondary/operator paths.

Recommended default:

- product path: MCP Skill;
- developer/live validation path: CLI;
- diagnostics path: web UI;
- ecosystem adapter: OpenClaw.

### D1 — source, tag, and published artifacts are out of sync

At the audit snapshot, source/tag is `0.5.5` but the latest GitHub Release is `0.5.4`. npm publication is not established. Treat `0.5.5` as source-only until its exact artifacts are built and published.

Do not repair this by editing version text again. Either publish verified `0.5.5` artifacts or move forward to a later version and publish that exact final commit.

## Features not completed

### Required before broad public promotion

- Fresh strict live UAT against the currently installed TraeCN version.
- A published server artifact and Skill artifact that match the advertised version.
- A clean public installation path: public GitHub Release, npm, MCPB, or another exact-version channel.
- One documented primary onboarding path.
- Real-host verification for the intended MCP client, not only the protocol test client.

### Valuable next engineering work

- Q1 quickstart hardening.
- C1 CLI timeout correction.
- H1 history persistence hardening.
- Decide and implement I1 terminal idempotency semantics.
- Continue one lifecycle-transition extraction at a time from `Gateway` only after characterization tests.
- Add a real human-facing first-run/setup command if MCP Skill becomes the primary product path.

### Conditional or optional

Do not call these missing unless the product scope chooses them:

- Windows support.
- A second TraeCN version adapter.
- Streamable HTTP MCP transport.
- MCPB/npm/official Registry publication.
- Additional MCP tools.
- A generic multi-IDE adapter.

## Test ladder

### 1. Fast static confidence

```sh
npm ci
npm run verify:static
```

This checks versions, generated configuration, Skill contracts, and release scanning. It does not prove runtime behavior.

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

Run the nearest focused file first after a change.

### 3. Mock runtime integration

```sh
npm run test:system
npm run test:mcp-stdio-smoke
```

This proves the real HTTP/MCP processes against the mock bridge, not TraeCN DOM compatibility.

### 4. Full repository gate

```sh
npm run verify
```

Use for repository-wide changes and before merging a reliability/refactor milestone.

### 5. Release and clean-room gate

```sh
npm run test:release
```

This builds the Skill and server archive, verifies provenance/checksums, installs under a temporary HOME, discovers all 20 tools, submits a mock task, subscribes, and reads completion.

It still does not prove that a downloadable GitHub/ClawHub asset exists or that a real TraeCN build works.

### 6. Live readiness without spending a task

```sh
npm run doctor
npm run inspect:verify
node scripts/live-uat.js --strict --require-ready --require-verified-adapter
```

Expected evidence:

- CDP endpoint identifies TraeCN;
- readiness is true;
- `GET /api/status.traeAdapter` reports the exact version/platform and `verified: true`;
- queue, dialog, capabilities, and selector checks pass;
- no mock bridge.

### 7. Live task experience

Run only when sending a real TraeCN prompt is acceptable:

```sh
node scripts/live-uat.js \
  --strict \
  --require-ready \
  --require-verified-adapter \
  --delegate \
  --delegate-task "请只回复 TRAECNCLAW_LIVE_OK"
```

For the background/review path, add `--exercise-background-workflow` and inspect the returned task ID, review state, continuation, and final result.

## How to experience the project

### Five-minute mock experience

Terminal 1:

```sh
npm ci
TRAECN_ENABLE_MOCK_BRIDGE=1 npm run start:gateway
```

Then open:

```text
http://127.0.0.1:8788/
```

Or from Terminal 2:

```sh
node scripts/traecn-cli.js status
node scripts/traecn-cli.js delegate "Return MOCK_EXPERIENCE_OK"
```

Confirm:

- status says mock mode;
- a task ID is created;
- the task reaches completion;
- the UI shows history/status;
- this result is labelled mock and is not used as live compatibility evidence.

### Source-checkout live experience

1. Quit any non-debug TraeCN instance if necessary.
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

4. Experience one real task:

```sh
node scripts/traecn-cli.js status
node scripts/traecn-cli.js delegate "请只回复 TRAECNCLAW_REAL_OK"
```

5. Inspect `http://127.0.0.1:8788/`, `/api/status`, and the exact task result.

### MCP experience

1. Keep the gateway running.
2. Copy `skills/traecnclaw-mcp/assets/mcp-client-config.json` into the target host and replace `SKILL_DIR`.
3. Restart the host.
4. Call `traecn_list_models`, optionally select one context item, then call `traecn_send_message`.
5. Verify the same durable task ID appears in the gateway and host.
6. If the host supports Tasks, verify subscription completion; otherwise perform one intentional `traecn_get_task` read later.

### Release-package experience

Only use a version that actually has downloadable assets. Install the server archive into a dedicated prefix, install the matching Skill archive, start the mock gateway, and run the same MCP discovery/task flow. `npm run test:release` is the automated local version of this flow.

## Questions for the maintainer

Discuss these before changing product semantics, but not before ordinary bug fixes:

1. Should `0.5.5` be published now, or should the next public artifact wait for fresh live UAT?
2. Which entry point is primary: MCP Skill, CLI, web UI, or OpenClaw?
3. Should idempotency survive terminal completion and restart? If yes, what TTL is acceptable?
4. Is macOS-only support acceptable for the next public milestone, or is Windows a near-term requirement?
5. Is a universal completion wake-up required for hosts without the Tasks extension, and which host must be supported first?
6. Will the repository/package become public, or is distribution intentionally limited to invited users?

## Recommended order

1. Fix Q1 and C1 because they directly affect first use.
2. Run the live readiness gate on the actual installed TraeCN and update compatibility evidence.
3. Decide I1 and P1.
4. Harden H1 if history/replay is a product promise.
5. Publish one exact verified version and test it from the downloadable artifact.
6. Resume architecture extraction only after the real experience path is stable.
