# TRAECNclaw product audit and acceptance guide

Use this reference for a broad audit, capability inventory, ownership decision,
or selection of a real acceptance path. Repository paths are relative to the
checkout root. Current channel evidence belongs in `docs/CHANNEL-LEDGER.md`;
its last-verified date limits every status claim. This guide does not create a
standing release or promotion queue.

## Establish the inventory

| Question | Authoritative evidence |
| --- | --- |
| What source/version is being changed? | `package.json`, current branch/HEAD, diff, `CHANGELOG.md`, and owning tests |
| What MCP capabilities exist? | `src/mcp/contract.js`, `tools.js`, `tool-metadata.js`, generated Skill contracts |
| Which TraeCN versions are characterized? | `src/trae-adapters` registry, sanitized fixtures, and strict live UAT for the exact running version |
| What do humans and operators use? | `src/http/web-console`, gateway routes, `scripts/traecn-cli.js`, Quickstart and setup |
| Which package/install identity is supported? | Source-owned package/Registry/Homebrew templates, generated artifacts, public provenance, and actual published install path |
| What is already released or externally pending? | Current GitHub tags/Releases/open work plus dated channel-ledger rows |

Resolve conflicts between prose and generated/runtime evidence before changing
install copy. Keep source, tests, local deployment, immutable Release bytes,
public mirror, registry/package, directory scan, and real host execution as
separate states. A source version or successful upload alone proves none of
the downstream states.

## Existing capability coverage

Inventory and retain every existing behavior relevant to the request. Use the
following acceptance matrix to find defects and gaps without adding a second
runtime or exposing internal mechanics as new tools.

| Capability | Behavior to preserve | Relevant acceptance |
| --- | --- | --- |
| Durable tasks | Exact instruction, context binding, stable IDs, queues, results/trace, cancellation, idempotency and restart replay | Owning store/orchestrator tests; real gateway with mock bridge; strict live path for desktop claims |
| Context and conversations | Workspace verification, model discovery/selection, Solo/IDE mode, explicit create/select, inactive identity-bound permanent deletion | CDP/adapter fixtures, MCP contract tests, relevant live UI path |
| Settings | Section/label/control discovery, dropdown options, type-specific writes, read-back and chat restoration | Settings-driver and MCP tests; exact real UI version when claimed |
| Exceptional interaction | User decisions, exact command/risk review, stale-card rejection, task identity and security audit | Interaction/review-policy/task tests; real requested interaction when in scope |
| MCP host | Ordered 20 tools, described schemas, accurate annotations, text/structured parity, errors, legacy notifications, Tasks/subscriptions, cancellation | Metadata, conformance and stdio tests; intended host discovery/call for host claims |
| Web Control Console | Readiness/context, instruction composer, active tasks, results/history, task-bound cancel/interaction/review, mock/live state, Advanced diagnostics | State/app/routes/WebSocket tests and responsive authenticated browser experience |
| CLI and service | Setup, doctor, Quickstart, service lifecycle, status/logs, scripting and recovery | CLI/setup/service tests, real operator flow, installed package checks when affected |
| REST/JavaScript/OpenClaw | Existing command/API compatibility through the gateway; no independent lifecycle | Client, Skill and plugin tests plus a representative adapter flow |
| Distribution | Deterministic safe archives/MCPB/npm, public provenance, Darwin/stdio boundaries, Homebrew and Registry metadata | Package/mirror/clean-room checks and exact target-channel installation |
| Promotion | Canonical narrative, architecture/use cases, limitations, demo/tutorial drafts | Reviewed real recordings and exact public payload/URLs when publication is authorized |

Normal web tasks stay separate from Advanced/Diagnostics. Tokens remain absent
from URLs and rendered fields; use session-only handling, authenticated
same-origin HTTP/WebSockets, safe DOM rendering, accessible focus, reduced
motion, and responsive layouts. Browser mock acceptance proves that experience
with its mock backend; record the running backend separately.

MCP expansion, profiles, generic shell/GUI tools, agent recovery tools,
marketplace-only resources/prompts/icons/apps, and cloud execution are optional
product migrations. They are not missing requirements solely because a
directory requests them. Read `mcp-product-design.md` before an MCP change.

## Ownership map

| Component | Owns |
| --- | --- |
| `src/config/runtime-schema.js` and config sanitizers | Runtime configuration and safe public projections |
| `src/cdp`, `src/trae-adapters` | UI drivers, verified selectors, version detection and sanitized fixtures |
| `src/http/task-orchestrator.js`, `task-store.js` | Task acceptance identity, semantic fingerprints, active/terminal replay persistence |
| `src/shared/task-event-store.js`, `task-history.js` | Durable completion events/cursors and diagnostic history |
| `src/http/completion-signal.js` | Persist completion before external delivery |
| `src/http/queue-state-machine.js`, `task-queue-service.js`, `recovery-helper.js` | Queue scheduling, locks, restart recovery |
| `src/http/route-table.js`, `handlers`, `driver-router.js` | Application routes and driver composition |
| `src/http/chat-ui.js`, `web-console` | Human presentation over the gateway |
| `src/mcp/contract.js`, `tools.js`, `tool-metadata.js`, `handler.js` | Tool order, definitions, validation, metadata and results |
| `src/mcp/protocol.js`, `stdio-server.js`, `task-extension.js` | Protocol eras, framing, subscriptions, cancellation and request lifetime |
| `src/client`, `src/skill`, `integrations/openclaw-traecn-plugin` | Client/API compatibility adapters |
| Operator scripts and `skills/traecnclaw-mcp/scripts` | Quickstart, doctor, service, CLI, live UAT and MCP setup/launcher |
| `distribution`, mirror/package scripts and release workflows | Public templates, generated distribution, packaging and provenance |

Before moving behavior, characterize identities, persisted fields, events,
errors and responses. Move callers with the owner, then remove the old path.
Keep compatibility entry points that remain public; delete only demonstrated
dead or superseded behavior.

## Audit classification and completion

- `implemented`: present in the owning source; attach the verification scope separately.
- `confirmed-bug`: reproducible behavior contradicts the existing contract.
- `missing-required`: an existing product promise or user requirement lacks an implementation.
- `selected-next`: explicitly chosen follow-up work with acceptance criteria.
- `optional-scope`: a possible extension that is outside the selected outcome.
- `blocked-external`: selected acceptance needs unavailable authentication, desktop/host access, ownership, credentials, payment, or an external service.
- `obsolete`: a superseded issue, duplicate path, or dated plan that no longer applies.

For broad optimization, prioritize confirmed user-visible failures,
required capability gaps, duplication with characterized callers, and unclear
Skill routing. Avoid speculative rewrites and universal rules derived from a
single historical failure. Complete unblocked selected work in dependency
order; do not convert every package channel or launch draft into engineering
scope.

A blocked row records the exact item, last check, why local tests cannot prove
it, permitted resume command/manual action, expected evidence, and next code
step. Test failures, complexity, or invisible private CI are not external
blockers. Preserve existing user authorization and ask only for missing
information or authority required by the actual next action.

## Experience paths

Use `docs/agent-verification.md` for current commands and choose the path
relevant to the changed surface:

- MCP: discover the exact tools in the intended host, submit authorized work, retain the ID, observe completion and read its result.
- Web: connect to the selected backend, exercise context/composer/task/result and the affected task-bound action; verify responsive and authenticated behavior when changed.
- CLI/setup: run help/setup/doctor or the changed operator command, inspect its persisted output and actual service state as applicable.
- Packaging: install the built or published artifact in a clean environment, check CLI/assets, discover 20 tools and run a representative mock task.
- Live compatibility: record exact TraeCN version, adapter, workspace and strict UAT. A non-delegating readiness run does not prove model-task completion.
- Channel/launch: inspect the public page and generated install path, or review the real media and exact authorized post payload.

Documentation-only work needs consistent contracts, working reference links,
and Skill validation; it does not require spending model quota. Static,
mock/system, clean-room, live desktop, real host and public-channel results
remain distinct evidence levels.

## Dated evidence, not current acceptance

On 2026-10-02, a read-only repository check found source version `0.6.0`;
GitHub listed `v0.6.0` as the latest non-draft, non-prerelease Release in both
`Luckycat133/TRAECNclaw` and `Luckycat133/traecnclaw-mcp-skill`. The canonical
open-PR query was empty. This check did not download assets, inspect other
channels, run an installed host, or exercise TraeCN.

The 2026-08-25 channel ledger records the 0.6.0 release/package/Registry,
Homebrew, ClawHub and Skills evidence, Smithery's generated Quick Start failure,
independent Claude Desktop host acceptance, directory review/indexing, and
unfinished real launch media. Read those dated rows for exact provenance and
resume steps, then refresh only what the current request needs. The former
0.5.9 snapshot and 0.6.0 candidate campaign are superseded by that ledger.

## Local engineering evidence, 2026-10-02

Scope: code and both Skills on `codex/optimize-code-skills`, based on
`6621edc59f97d61dffb9450399c6c6277b6abfe5`. Source remains version `0.6.0`;
the maintainer Skill metadata is `2.2.0`. The candidate is uncommitted and its
artifact manifest correctly records `sourceDirty: true`.

| Existing capability | Completed work and evidence |
| --- | --- |
| Task identity and lifecycle | Versioned semantic fingerprints retain v1 replay; cancellation and completion/attention candidates retain the original ID and captured result until task state and events are confirmed. Restart, writer-lock, cleanup and late-result regressions pass. |
| Review and followups | Manual review is honored; parent transition and child identity share a snapshot. A child waits for its confirmed parent. Repeated attention checkpoints retain their own `interactionRequestId`. Focused restart suite: 31 passed; independent isolated state/event/restart/followup/cancel scenarios: 38 passed. |
| MCP | All 20 ordered v5 tools remain. Framing recovery, protocol pinning, permissions, result parity, subscription cancellation and pending-state behavior pass conformance and smoke checks. Final Tasks suite: 23 passed; MCP server suite: 17 passed. |
| Context, settings, conversations and exceptional decisions | Existing adapter/driver, settings, command-review, identity/deletion and contract suites pass through `npm run verify`. Real UI acceptance remains tied to the exact desktop state below. |
| Web and JavaScript client | Connection epochs/abort handling prevent stale hydration; reconnect restores subscriptions; uncertain submissions reuse their identity. Unicode chunking, incomplete responses, abortable long polls and pending-state waits pass. Final browser run completes authenticated mock submission, manual review, result/replay, Advanced focus, disconnect cleanup and responsive layouts. |
| Shared stores and test infrastructure | History sorts across restarts and intersects cleanup filters; invalid filters fail without deletion; special event client IDs persist. Async tests are counted after settlement and unfinished process exits fail. Omitted existing shared tests are registered, and coverage exclusions are corrected with unchanged thresholds. |
| CLI, API and OpenClaw compatibility | Existing setup, doctor, operator, API/client and plugin suites pass; a clean installed candidate exposes the CLI and all 20 tools and completes representative mock tasks through legacy and modern MCP paths. |
| Skills and local packaging | Both Skill validators, contract/reference and launcher tests pass. The public launcher resolves symlinks to server-local configuration. Source templates/mirror checks pass; built Skill archives, scoped npm package and MCPB are locally verified. |

Verification at this historical checkpoint used macOS and Node.js `22.23.2`:

- `npm run verify`: PASS for that checkpoint's runtime, including static checks,
  syntax/ESLint, repository tests, system mock, UAT inventory and coverage.
  Coverage: lines `82.62%`, branches `72.48%`, functions `75.87%`; thresholds
  remain `60%`/`55%`/`55%`. Repeated coverage executions are not unique test counts.
- `npm run audit:all` and `npm run audit:prod`: PASS, zero vulnerabilities.
  The lockfile updates only the affected `brace-expansion` leaf to `5.0.12`.
- `npm run test:clean-room`: PASS for that checkpoint's runtime. It rebuilt
  the local artifacts and installs the public server and Skill into temporary
  isolated directories before exercising CLI and stdio discovery/tasks.
- `node scripts/verify-release.js --allow-dirty`: PASS for current revision,
  versions, artifact lengths and SHA-256 values. The normal `test:release`
  pipeline passed verify/audit/pack, then correctly refused its strict manifest
  gate because this working tree is uncommitted. Formal release acceptance
  remains pending a reviewed clean source revision.
- Playwright Chromium `151.0.7922.34`: PASS with a real Gateway using the mock
  bridge. Desktop `1440x1000`, tablet `820x1100`, mobile `390x844`, and a
  `720x500` CSS viewport representing 200% zoom show no horizontal overflow;
  desktop/mobile screenshots were visually reviewed and page errors are empty.

The manifest path is `dist/traecnclaw-mcp-release.json`. At that checkpoint the public server
candidate SHA-256 was
`8935606c49d2fca23986d82cdd51ad571964668ada7a0cc6fd214ffa3eae239e`;
public Skill tree SHA-256 is
`de0bf4e8cdb7dccc8bce8aa9c3f67ae4337717cb485873d0f775387978b44b90`.
These bytes are local candidates; public channels were not updated.

At this pre-login checkpoint live desktop acceptance was `blocked-external`. Strict non-delegating UAT
reported `ready:false`, `nextAction:login_traecn`, and session creation
`PROJECT_NOT_OPEN`. The final read-only `npm run inspect:verify` recognized
TraeCN `1.107.1`/`traecn-1.107` through CDP but found no composer or send
button in the current `更新日志 — TRAECNclaw` window. Complete login/onboarding,
open or focus the intended project/chat, then run `npm run inspect:verify`
and `node scripts/live-uat.js --strict --require-ready --require-verified-adapter`.
Only a subsequent real delegated task can verify current desktop execution.

Storage recovery guarantees apply to captured identities and bytes that can
be persisted. A pre-commit crash while storage stays unwritable cannot create
missing result bytes. Cross-process external stop/delivery and simultaneous
failures of independent stores do not have an exactly-once guarantee.


### Skill and scale follow-up, 2026-10-02

The user's follow-up selected both Skill behavior and runtime scale testing.
Two independent forward rounds exercised 12 realistic public-Skill requests;
29 request-phase argument shapes covered all 20 tools and passed revalidation
against the exported runtime validator. The decision traces are offline,
with zero real MCP/UI mutations. A separate scope/setup evaluation generated
reviewable configurations and exercised three real stdio discovery entries
on Node 24.13.0 with Gateway network access blocked. Node 22.23.2 launcher
regressions independently verify canonical and temporary `.codex/skills`
packages against the same 20-tool metadata.

Confirmed gaps fixed: generated output schemas; existing terminal replay
statuses/results/nullable errors in send-message metadata; stale discoverable
Skill instructions/resources; `.codex/skills` launcher depth; scope-heavy UI
prompt; benchmark state isolation, HTTP correctness and missing percentiles.
The complete project-local public Skill is now generated from its canonical
source and checked read-only by `verify:static`. Version synchronization also
regenerates that package. No new MCP tool or client-owned lifecycle was added.

The isolated HTTP benchmark ran 2000 requests per fresh process, three trials
at each concurrency, with a real loopback Gateway, Mock driver and owned CDP
HTTP fixture. All 18,000 responses passed validation. Per-metric medians:

| Concurrency | Requests/sec | Latency p95 ms | Sampled peak RSS MiB |
| ---: | ---: | ---: | ---: |
| 1 | 413.24 | 4.31 | 102.94 |
| 8 | 520.05 | 25.67 | 104.19 |
| 32 | 510.35 | 109.51 | 104.89 |

The 32-concurrency p95 range was 96.29–493.21 ms, including the slow third
trial. Background machine load and filesystem caches were uncontrolled; no
capacity/SLA, live model throughput or long-term leak guarantee is implied.
Reproduce with `npm run bench:gateway -- 2000 --concurrency 8 --json`.

Final owning-store scale profiles passed 6/6 at 100 and 1000 records,
including checksum/reload, IDs/results/pending states, TTL, bounded retention,
independent/future/prototype cursors, complete pagination, interaction IDs,
long-poll wake and history query/cleanup. Event-store cost was then isolated
without changing source: fsync dominated, but duplicate new-document encoding
also cost CPU. Only that encoding was optimized. Compact canonical JSON is
hashed and persisted once; old primary validation, backups, atomic rename,
all file/directory fsync and per-operation acknowledgement timing remain.

Three alternating before/after trials at 1000 retained events, 100 appends
and 3 acknowledgements reduced median CPU 1268.08 -> 1072.79 ms (15.40%),
wall 3095.81 -> 2857.29 ms (7.70%) and primary bytes 561245 -> 470381
(16.19%). Every profile kept 412 real fsync calls and 103 primary/backup
commits; both old and current readers passed reload. Small-input wall gains
were not established. Disabling fsync was attribution-only and was not shipped.

Final Node 22.23.2 `verify` and `test:clean-room` passed; candidate manifest
validation with `--allow-dirty` passed, and six affected npm-archive files were
compared byte-for-byte against final source. Frontmatter, generated schemas,
complete local package parity and the launcher/benchmark/durability regression
suites pass. Full evidence is in the [Skill and scale report](/Users/jack/.codex/visualizations/2026/10/02/01a0faec-98c3-7d01-b74f-13ac88558a0b/traecnclaw-skill-scale/report.md); exact run/source hashes and every trial are retained there. The candidate remains uncommitted and unpublished; the live
UI evidence above is historical to the earlier iteration, not a new live check.

### Pre-login live testing and shutdown checkpoint, 2026-10-02

This later iteration supersedes the runtime coverage and local server artifact
snapshot above. It preserves the earlier public Skill and HTTP benchmark
evidence; those forward cases and 18,000 requests were not repeated here.
The source is still uncommitted version `0.6.0` on the same baseline revision.

Real macOS testing connected a non-mock Gateway to TraeCN `1.107.1`,
Chrome `142.0.7444.235`, and adapter `traecn-1.107`. Actual readiness returned
`login_required`, missing composer/send button and IDE mode. Native UI confirmed
the login entry and personal/enterprise account selection. Web Console connected
and kept task submission disabled; conversation/history reads were empty.
Later native inspection reported a locked Mac. No real model task was sent.

Confirmed gaps fixed: strict UAT now gates before dependent UI operations and
reports current readiness fields; UAT cleans up the actual Gateway; event
waiters share one append listener and support per-client abort; HTTP long-poll
disconnects release owned listeners/timers; operator shutdown drains normal
responses then bounds stalled HTTP connections. The five-second grace starts
at the HTTP close stage and is not a total CDP/WebSocket shutdown guarantee.

That checkpoint's Node `22.23.2` verification passed:

- `npm run verify`: PASS; coverage lines `82.64%`, branches `72.62%`,
  functions `75.90%`, with unchanged thresholds. An earlier instrumented
  run failed four overly short Quickstart HTTP fixture deadlines; only those
  test overrides were removed, preserving the dedicated timeout case and
  production defaults. Both executions are retained in the evidence.
- Actual TCP/HTTP shutdown regressions `4/4`, event-store regressions `20/20`,
  UAT CLI regressions `9/9`; independent exception cleanup scenarios `10/10`
  leave no owned timeout/listener resources and preserve unrelated listeners.
- Real persisted event-store fanout: three rounds each at `32`, `100`, and
  `1000` clients, `3396` waits in total, split evenly between abort and delivery.
  Reload/checksum and resource cleanup pass. This is in-process event fanout,
  not real model throughput or a long-term leak/SLA test.
- `npm run test:clean-room`: PASS after these runtime changes, rebuilding and
  installing the candidate in isolation before CLI/20-tool/mock-task checks.
- `node scripts/verify-release.js --allow-dirty`: PASS. Server candidate
  SHA-256 is `574f537acba31da05a53427c6d29dd5084d1a0d38a0d9df21c1fcd7f1be021d2`;
  public Skill tree SHA-256 remains
  `de0bf4e8cdb7dccc8bce8aa9c3f67ae4337717cb485873d0f775387978b44b90`.
  This verifies local bytes, not a public release or a clean revision.

Live acceptance at this pre-login checkpoint was `blocked-external`: manual Mac unlock and TraeCN login
were required. Strict UAT was rerun and failed at readiness with the account
selection modal visible; its Gateway closed gracefully. A subsequent diagnostic
readiness request timed out and is retained as unresolved live evidence, not
attributed to an unproven cause. The earlier owned Gateway hung at HTTP close
and was stopped after its state/CDP cleanup; that failure was reproduced and
covered by the actual socket regressions above.

The historical resume path was to refresh native readiness and `npm run inspect:verify` after manual
unlock/login, running strict UAT with `--require-ready --require-verified-adapter`,
then execute the prepared isolated calculator task and check
its task ID, persisted result, file diff and independent assertions. Current
logs, fixture and hashes are in the [live test report](/Users/jack/.codex/visualizations/2026/10/02/01a0faec-98c3-7d01-b74f-13ac88558a0b/traecnclaw-live-uat/report.md).


### Post-login model and final candidate evidence, 2026-10-02/03

The user completed login and authorized normal TraeCN restart. In native Codex
stdio MCP on macOS, TraeCN 1.107.1 / traecn-1.107 / GLM-5.2 completed isolated
calculator task `task_1_mur6jvup_14i8m5qx47`: one user turn, no retry steps,
Gateway DONE, only calculator.js changed, independent Node 22.23.2 assertions
3/3 PASS and review gate clear. Default final text is 402 characters; explicit
current-task visible trace is 590 characters. After normal Gateway reload the
trace came from history with identical SHA-256
`5bfdc967d62f644a61f0a01af66ac30745c6041d410263321804d1ad00991ca3`; checksum validation passed.

Earlier attempts exposed false UI/CSS completion, review-stage collection,
notification-as-approval, new-chat virtualized identity, trace projections and
uncertain send retries. Those confirmed defects were fixed in their owners.
A duplicate-send attempt and two SEND_FAILED attempts remain failed normal
flows even though the model later produced the correct calculator result.
One blocked attempt was cancelled before any model submission.

Window preparation now checks renderer visibility and activates only the
existing macOS app; unresolved visibility is typed WINDOW_NOT_VISIBLE with
HTTP 409 and accurate MCP guidance. Historical completedAt declarations accept
existing epoch values and ISO date-time strings; the actual complete native
history response passes the official SDK validator. No MCP tool migration or
new client lifecycle was introduced.

Final Node 22.23.2 `npm run verify` PASS at 2026-10-02T17:12:13.751Z;
coverage lines 83.6%, branches 73.58%, functions 76.5%,
with unchanged 60/55/55 thresholds. Fresh `test:clean-room` and manifest
`--allow-dirty` checks PASS. All 170 canonical npm files match bytes;
public package.json, rendered README and LICENSE match their source-owned
public templates separately. Server SHA-256:
`137c0d5509ac564466582270f76eb0b2bf69fe608a020fa4e31ef2e44cc78d1d`;
Skill tree SHA-256: `90e4fd05d6f660043ad7ccce885dec0f3c43cf10ece6d97ba145e50a8c3d0c0c`.
The candidate is uncommitted and unpublished. Existing Skill/Mock HTTP/store
scale evidence above was preserved, not repeated for final metadata changes.

Strict non-delegating UAT earlier passed 19/19 at 2026-10-02T14:45:40.001Z,
before the subsequent driver fixes; do not label it final-source live coverage.
The user then selected offline delivery after the earlier lock-screen
interruption. A read-only console refresh did not return an explicit lock
flag; no desktop operability was inferred. Unlocked hidden-window activation
and original repository/IDE restoration remain unverified. Native host stdio needs a reload to live-test the updated
metadata and notification backoff; fresh-source fixtures pass. All owned Gateways stopped
and loopback 8788 is free; user TraeCN/CDP and unrelated processes are retained.
Current raw results, failures, hashes and resume steps are in the
[live test report](/Users/jack/.codex/visualizations/2026/10/02/01a0faec-98c3-7d01-b74f-13ac88558a0b/traecnclaw-live-uat/report.md).

### Unlocked final-source desktop acceptance, 2026-10-03

The user authorized resumed desktop testing. Final frozen source passed strict
non-delegating UAT 19/19 at 2026-10-03T00:37:45.285Z, with no skipped checks,
real TraeCN 1.107.1 CDP, verified traecn-1.107 adapter and 18 model setting
items. The earlier pre-driver-change UAT remains a separate historical result.
No new model task was submitted in this desktop acceptance run.

Native MCP create_conversation exercised a naturally hidden running renderer:
hidden/unfocused became visible/focused and the new conversation had zero user
turns. The existing real completed task's native trace still came from history
with the same 590-character SHA-256. Current native get_task metadata advertises
the number/string/null completedAt contract.

Fresh official SDK 2.0.0 legacy stdio clients connected to an isolated real
Gateway, discovered the same 20 ordered tools, and validated the actual history
payload using Standard Schema. Six actual HTTP 429 responses retried with
1005-1006 ms response-to-next-request gaps. Restoring the isolated rate policy
resumed HTTP 200 and the normal 25-second long-poll. A fresh modern Tasks peer
received the existing completed task snapshot, preserved text/structured parity,
and cancelled its subscription with a complete response; waiters and append
listeners returned to zero. This is live transport/history/notification
acceptance, not a new model completion or concurrent model load test.

Two external helper assumptions failed before the final pass: a Zod safeParse
API was assumed on the SDK Standard Schema validator, and the Tasks projection
was assumed to have one extra result layer. Both failed records and original
helpers are retained. Strict UAT first correctly rejected PROJECT_NOT_OPEN
while its cwd and the actual workspace differed. It passed after restoration.
Settings reads navigate the UI, so final cleanup ran after all UAT: the test
settings tab closed, actual Explorer root normalized to
/Users/jack/Documents/gh-repos/TRAECNclaw, and fresh DOM/native visual evidence
confirmed IDE and the original branch. No production mode-detection defect was
confirmed or patched from the intermediate SOLO view.

All 170 canonical package source files, 10 SDK-test owner files and four built
artifact hashes still match the previous final candidate. Production source,
timeouts and contract remain unchanged. All owned Gateway processes and ports
are closed, 8788 is free, and user TraeCN/CDP 9222 remains. The test's auxiliary
process panel is closed and login configuration is preserved.

Existing native-host connections were not actively reconnected: Computer Use
explicitly blocks the Codex app. Their aggregate log contains 501 HTTP 429
responses without producer process identities or arrival times, so it cannot
be attributed to one final-source notification pump. Fresh-source retry and
recovery passed as above; validating every existing host connection after a
supported host reconnect remains unverified. No unrelated stdio process was
terminated and no alternate UI control bypassed that tool restriction.
The updated [live report](/Users/jack/.codex/visualizations/2026/10/02/01a0faec-98c3-7d01-b74f-13ac88558a0b/traecnclaw-live-uat/report.md)
links the current raw evidence and preserves the complete offline checkpoint.


### Completion campaign candidate v6, 2026-10-03

At 2026-10-03T06:32Z, the final local candidate remains version 0.6.0,
uncommitted and unpublished on codex/optimize-code-skills. MCP v5 retains the
same 20 ordered tools. Current evidence is in the
[completion campaign report](/Users/jack/.codex/visualizations/2026/10/02/01a0faec-98c3-7d01-b74f-13ac88558a0b/traecnclaw-live-uat/completion-campaign/report.md);
the earlier desktop acceptance above is historical.

Real followup, Web/MCP one-send tasks, settings readback, absolute workspace
identity, permission inspection, sequential batch 2/2 and running batch
cancellation were exercised against TraeCN 1.107.1 / traecn-1.107 using an
official SDK v2 stdio client pinned to 2025-11-25. Per-record timestamps and
owner hashes limit each claim; these paths were not all rerun on the latest v6.

A real native command card exposed missing full-command recognition and
interaction binding. Exact atomic command decisions and fresh native identity
now have focused regressions. Denying the old already-cancelled task's card
clicked Skip, removed the card, preserved the test file SHA and resumed no
task. Fresh approve/deny original-task resumption still needs real acceptance.

Hidden-page RAF waits were bounded. The subsequent real list/create failure
showed scrollHeight-clientHeight=115 while actual bottom scrollTop=114.5;
a <=1px tolerance retains the 80-step incomplete-scan guard. Full system and
clean-room gates also exposed bypass of MockDriver.listSoloChats overrides.
Polymorphic dispatch and option forwarding fix that regression without
altering the Mock production owner. Latest DomDriver 174/0, MockDriver 26/0,
isolated source system-test, lint and diff checks pass. V5 failures and its
SIGTERM/exit143 partial soak remain preserved, not passed.

Final v6 npm run verify and clean-room installation exited zero. Coverage is
83.97 lines / 75.01 branches / 77.36 functions, thresholds unchanged at
60/55/55. Four local candidate artifact hashes match; npm has 115 matching
source files and MCPB has 113 matching runtime files, with only the official
selection's two .d.ts declarations excluded. The test-only captured HTML is
excluded. Both Skill archives and the discovered local Skill match all 15
canonical public Skill files; private maintainer material was not published.

Independent public-Skill forward planning covers six intentions plus a modern
review retest. Ten planned tool parameter sets and identity/one-send branches
grade PASS. A minimal full tasks/update review envelope was synchronized as a
whole public Skill package. Its actual source handler + TaskAdapter test passes
8/0 with a controlled client. Neither evidence is a full native host run.

The final v6 strict 900000ms mixed lifecycle soak is still running under the
frozen source with source Gateway HTTP, Mock model, owned loopback CDP fixture
and isolated durable stores. It prohibits real 9222/8788, native driver/GUI,
subprocess and other network access. Final PASS requires actual exit, drain,
third same-state reload, source/helper byte match and independent verifier.
The completed v4 900001ms / 13357 HTTP result predates the latest two sidebar
fixes and cannot replace that final v6 result.

The latest OS checks again report IOConsoleLocked and
CGSSessionScreenIsLocked. Manual unlock was requested; no native mutation
occurred while locked. Final v6 sidebar acceptance, fresh command decisions,
original task ID/single-send proof, original workspace/IDE restoration and
strict non-delegating UAT remain blocked by desktop access. Writable native
text settings had no safe reversible control; permanent native conversation
deletion lacks exact-target confirmation. Full native Codex/OpenClaw host
installation/reconnect, other TraeCN versions and public channels are untested.


At 2026-10-03T06:45Z, final v6 run, summary and independent verifier all
exited zero: exactly 900000ms mixed, 70 cycles, 13514 HTTP requests;
1263 accepted + 12 planned children + 80 batch canonical tasks =
1355 = 1241 done + 101 cancelled + 13 review rejected. All three reloads,
six checksums, 32-waiter single-listener accounting, final active zero,
149 frozen files and complete public Skill byte checks pass. Five owned
soak ports and its PID are released. The final SDK actor also awaited client
and Gateway close, exited zero and released its owned port. Source/helper
and old v4/v5 evidence bytes remain unchanged. Manifest:
runtime-scale/v6-final-long-manifest.json under the linked campaign;
SHA256 18545a9a80d19bbeeb1ddfe238ef7af4524c1fa6dc0a33dc5bc14e322d41efce.

The real acceptance items above remain incomplete: the 06:45Z root check
still reports both lock flags. No native mutation bypassed the lock. The
latest report records resumed-testing prerequisites and preserved own
command fixtures. The fast native active snapshot count/index describe
mounted rows; full history counts require a confirmed full-list scan.
Legacy batch group state is process-local; durable canonical children were
verified separately. Source remains dirty and no release was published.

### Cancellation and workflow restart regressions, 2026-10-17

The cancellation checkpoint now distinguishes a committed cancellation event
from a completed native stop. A submitted task interrupted while stopping
retains its original ID and pending cancellation, including when both state
and cancellation checkpoints exist. Retrying the original cancellation
reconnects through the gateway and verifies the stored native session ID
under the UI action lock. A missing binding, missing active conversation or
different session returns 409 without stopping or submitting work. Polling
does not automatically stop these unverified restored tasks.

Confirmed workflow-parent completion is saved with the child in the atomic
queue snapshot. It survives a crash before the debounced history flush and
history/event pruning. Earlier child snapshots migrate while parent completion
evidence is still available; an in-memory unconfirmed parent remains blocking.

Nine added regression scenarios exercise these boundaries with real queue,
history and event stores, actual gateway handlers/polling, and controlled
native-driver boundaries. Node 22.23.2 focused results: restart/retry 36/0,
workflow/history 7/0, task actions 14/0 and queue service 23/0. Independent
read-only follow-up found no remaining actionable issue in these two fixes.
Node 22.23.2 `npm run verify` exited zero: static checks, syntax/ESLint,
the complete test suite, mock gateway system integration, non-live UAT/contract
audits and the coverage rerun all passed. Coverage is 83.99% lines, 75.08%
branches and 77.36% functions, with the existing 60/55/55 thresholds unchanged.

Evidence logs are in
`/tmp/traecnclaw-recovery-fixes-20261017.b4HQi1/`, including the reproduced
pre-fix failures and final focused runs. These regressions do not supply new
real-desktop acceptance, scale-soak or release-artifact evidence; the older
dated campaign above remains historical.

### Branch closeout checks, 2026-10-17

An exact 132-file inventory covers the runtime, adapters, public and discovered
Skills, regression fixtures, required tests and affected documentation. The
independent read-only closeout found one missing API declaration: cancellation
recovery's 409 `task_cancellation_conflict`, now documented in OpenAPI. The
development MCP client and core are locked to 2.2.0 after resolving the audit
advisory; local Gemini prompt history and its writer lock are precisely ignored.

Fresh Node 22.23.2 `npm run verify` and `npm run test:clean-room` both exited
zero. Coverage remains 83.99% lines, 75.08% branches and 77.36% functions with
unchanged thresholds. `npm run audit:all` reports zero vulnerabilities and
`npm ls --all` confirms a consistent installed graph. The clean-room run rebuilt
the packages and exercised installed MCP discovery and mock task execution.
Local dirty-candidate manifest validation also passed. These checks add no
native-desktop or public-channel acceptance claim.

The exact file inventory, preserved earlier artifacts, full verification,
dependency audit and clean-room logs are under
`/var/folders/2v/6zk61fv17m79w4glmwb6flfc0000gp/T/traecnclaw-closeout-20261017.lh8ol93r/`.
