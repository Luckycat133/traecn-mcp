# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog v1.1.0](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

<!-- Future changes go here. -->

## [0.5.5] - 2026-08-05

### Added

- Added deterministic fault-injection and regression tests for task restart,
  retry, and reconnection boundaries in `src/http/task-restart-retry.test.js`.
  Coverage includes restart before Trae submission, after durable accept,
  after Trae submission, during result collection, and after a terminal
  event; idempotency replay after restart; TaskStore write-failure rollback
  with history `failTask` and no stored replay; TaskEventStore cursor
  independence across restart; pruning cursor safety across tasks; and
  long-poll wake after restart with a future cursor.

### Changed

- Extracted idempotency-key replay resolution from
  `Gateway._checkIdempotency` into `TaskOrchestrator.resolveIdempotentTask`,
  consolidating task-identity ownership in the orchestrator boundary. The
  HTTP layer now delegates the active-queue lookup to the orchestrator while
  retaining the in-memory idempotency cache. HTTP 202 status codes, response
  shapes, terminal-status mapping, history, persistence, and
  completion-event semantics are unchanged.

## [0.5.4] - 2026-08-04

### Added

- Added an injectable `TaskOrchestrator` boundary for candidate task
  construction and durable acceptance, including rollback coverage when the
  active TaskStore is unavailable.
- Added `npm run verify:release-manifest` and a tag-triggered GitHub workflow
  that verifies source provenance, versions, artifact sizes, and SHA-256
  checksums before uploading release assets.

### Changed

- Made extracted HTTP handler modules the source of truth for their route
  metadata; the Gateway route table now composes those slices and retains only
  Gateway-owned configuration, settings, confirmation, and debug routes.

### Fixed

- Accepted acknowledgements for valid completion-event cursors after their
  events have been pruned, and reset unknown future cursors so later events do
  not stall a client or long-poll subscription permanently.

## [0.5.3] - 2026-08-03

### Added

- Added checksummed TaskEventStore schema 2 snapshots, durable temporary-file
  replacement, last-known-good backups, corrupt-file quarantine, legacy schema
  migration, interrupted-write recovery, and event-store persistence health in
  `GET /api/status`.

### Fixed

- Rolled back completion-event appends and client cursor acknowledgements when
  persistence fails. Failed acknowledgements now return HTTP 503, and
  `CompletionSignal` does not continue outbound delivery when its durable event
  was not recorded.
- Calculated completion-event pagination from the effective acknowledged or
  requested cursor, including empty pages after an exhausted cursor.
- Preserved fresh malformed TaskStore locks during their metadata-write grace
  period while allowing stale locks left by a crashed creator to be reclaimed.
- Propagated gateway failures from MCP `tasks/cancel` instead of reporting false
  success, while retaining idempotent success for a confirmed terminal race.
- Closed modern MCP subscription requests exactly once on cancellation or
  shutdown, rejected null and duplicate request IDs, baselined prior durable
  events before the current snapshot, and retried partial initial snapshots
  without duplicate delivery.

### Security

- Removed `TRAECN_MCP_SERVER_PATH` from the public Skill launcher so an
  environment-controlled value cannot select arbitrary JavaScript for the
  launcher to execute. Server discovery now uses only the repository entry
  point, the installed `traecnclaw/mcp` package export, or the
  `traecnclaw-mcp` executable on `PATH`.
- Declared `TRAECN_GATEWAY_TOKEN` as the Skill's primary credential while
  retaining machine-readable declarations for every supported optional
  environment variable, and added contract coverage for secret-handling
  guidance and metadata drift.

## [0.5.2] - 2026-08-01

### Added

- Added an npm-compatible complete server archive to `npm run pack:skill`, with
  its exact version, size, and SHA-256 recorded in the release manifest.
- Added a clean-room release test that installs the portable Skill and server
  package under a temporary HOME, discovers the exact 20-tool MCP contract,
  submits one mock task, and reads its completed result.
- Added TaskStore health to `/api/status`, an exclusive active-store writer
  lock with stale-owner recovery, and deterministic ENOSPC, EACCES, EROFS,
  interrupted-write, and competing-process coverage.
- Added the separately negotiated `io.modelcontextprotocol/tasks` adapter for
  modern `2026-07-28` clients. Opted-in sends return durable Task handles;
  `tasks/get`, `tasks/update`, `tasks/cancel`, and exact-ID
  `subscriptions/listen` delivery reuse the gateway task and event stores
  without changing the frozen 20-tool contract.
- Added a versioned Trae adapter registry, read-only product/version and mode
  detection, a verified macOS TraeCN 1.107 profile, degraded unknown-version
  fallback, status handshake, and sanitized workflow fixture replay.
- Added an independent MCP conformance matrix using the official TypeScript
  client 2.x for 2024, 2025, and pinned 2026 sessions, plus a raw transcript
  client for legacy Content-Length framing and protocol error recovery.

### Changed

- Extracted durable event recording, WebSocket broadcast, OpenClaw messages,
  and task webhooks from `Gateway` into one injected `CompletionSignal`.

### Fixed

- Extended the portable Skill launcher to resolve an installed `traecnclaw`
  package or a `traecnclaw-mcp` executable on `PATH` after checking explicit
  and repository-local server paths.
- Kept unified mock submissions inside `MockDriver` for model and conversation
  discovery instead of accidentally entering DOM handlers without a CDP client.
- Made task acceptance atomic with the first durable queue snapshot. An
  unwritable or already-owned TaskStore now rolls the candidate back and returns
  `TASK_STORE_UNAVAILABLE` as HTTP 503 instead of returning a false 202.
- Persisted `Idempotency-Key` ownership with active tasks so an uncertain retry
  after a gateway restart resolves to the original task instead of submitting
  duplicate work.
- Made tool output schemas valid object schemas for official clients,
  implemented the advertised legacy `ping` and `logging/setLevel` methods,
  rejected malformed JSON-RPC request envelopes, and terminated modern
  subscriptions with the standard graceful-close result.

## [0.5.1] - 2026-07-31

### Added

- Added `detailLevel` to `traecn_get_task`: `result` (the default) returns the
  final Trae answer, while `trace` returns the visible execution process for
  diagnosis and audit tracing when it is still available.

### Fixed

- Made settings navigation reliable in Solo and IDE layouts, including narrow
  panes with a collapsed sidebar and editor-tab variants. Native CDP mouse
  input is now used for controls that ignore synthetic DOM clicks.
- Restricted settings extraction to visible rows and settings-owned tables,
  added support for usage, agent, and index/document card layouts, refreshed
  the 16-section fallback, and retries lazy pages once before returning an
  explicit `SETTINGS_CONTENT_UNAVAILABLE` error.

## [0.5.0] - 2026-07-31

### Added

- Added dual-era MCP support for the stable `2026-07-28` stateless protocol,
  including `server/discover`, per-request version metadata, typed results,
  cache hints, and server identity metadata while retaining legacy
  `2025-11-25` and `2024-11-05` initialization.
- Added structured tool results and permissive JSON output schemas alongside
  text content for old clients.
- Added a single checksummed TaskStore schema with durable temporary writes,
  atomic replacement, last-known-good backups, corrupt-file quarantine, legacy
  snapshot migration, and forced-process-kill recovery tests.
- Added a generated core runtime configuration schema shared by code,
  `.env.example`, README defaults, doctor, and `/api/config/schema`.
- Added release-surface scanning for local user paths, removed MCP profile
  configuration, and stale 0.3.x install instructions.
- Added an explicit 0.3.x to 0.5.0 migration guide and executable release
  verification inputs.

### Changed

- Froze MCP contract version 5 at exactly 20 ordered, single-intent tools and
  made contract drift fail during module loading and generated Skill checks.
- Made `quickstart` describe its real behavior: it checks an existing TraeCN
  CDP session and starts the gateway, while TraeCN launch remains explicit or
  opt-in. `start:traecn` now performs the explicit launch its name promises.
- Standardized the gateway at `127.0.0.1:8788`, CDP at `127.0.0.1:9222`, the
  existing TraeCN profile, a 30-minute response window, and unlimited external
  queue waiting unless a local maximum is configured.
- Made the capabilities endpoint report MCP contract version and tool count
  without profile metadata.

### Fixed

- Replaced the non-standard default `Content-Length` stdio framing with MCP's
  newline-delimited JSON-RPC framing while preserving bidirectional
  compatibility for existing TRAECNclaw clients using the former format.
- Stopped echoing arbitrary client protocol versions during legacy
  initialization and return the standard unsupported-version error for modern
  requests.
- Corrected Monaco MarkerSeverity values `1`, `2`, `4`, and `8` to map to
  hint, info, warning, and error.
- Replaced first-token Git branch guessing with explicit parsing backed by
  realistic TraeCN status-bar fixtures.
- Routed every active-queue persistence and restore call through TaskStore,
  removing the competing Gateway file writer.
- Aligned ConfigManager response-timeout validation with the canonical
  30-minute default and one-hour schema maximum.

### Removed

- Removed the obsolete MCP profile exports, environment selection path, and
  generated profile documentation.
- Removed the public `createQueuedTask` service placeholder that always threw
  at runtime.

### Security

- Gateway startup and doctor now fail closed when a non-loopback bind has no
  authentication token.
- Corrupt or checksum-mismatched queue snapshots are retained in quarantine
  and recovered from a validated backup rather than silently restoring zero
  tasks.

## [0.4.7] - 2026-07-30

### Security

- Made the permanent-deletion example require an explicit current user request,
  repeat the no-recovery warning, and direct the Agent to re-read the exact
  listed conversation ID and title without adding a confirmation round trip.
- Added a contract regression check so destructive examples cannot silently
  lose their authorization prerequisite or irreversible-action warning.

## [0.4.6] - 2026-07-30

### Security

- Bound direct generation stops to the verified active Solo conversation and
  required an explicit untracked-work acknowledgement plus audit reason.
- Made conversation deletion an inactive-target-only permanent operation with
  exact-title verification, irreversible-deletion acknowledgement, elevated
  `delegate` permission, and durable audit evidence.
- Revalidated the exact visible command before approving unsafe or ambiguous
  cards and required a risk acknowledgement plus authorization reason.
- Reduced automatic command approval to a strict read-only allowlist and
  blocked project scripts, mutating find/sed forms, ripgrep preprocessors, Git
  external hooks, shell writes, network access, and process control.
- Enabled append-only security audit records for automatic command approvals,
  direct stops, conversation deletion, and exceptional approval decisions.

## [0.4.5] - 2026-07-30

### Added

- Added a separate `traecn_stop_generation` UI action instead of treating all
  stop requests as task cancellation.
- Added progressively discovered Trae settings tools for visible sections,
  section items, dropdown choices, boolean toggles, dropdown selection, and
  text input.

### Changed

- Expanded the focused MCP surface from 13 to 20 single-intent tools. Settings
  remain a second-level capability and do not expose one generic command tool.
- Advanced the capabilities contract to version 4 for the UI-backed settings
  and separate generation-stop surface.
- Settings operations now serialize access to the Trae UI and return to chat
  automatically after Agent-facing reads or writes.

## [0.4.4] - 2026-07-30

### Added

- Added focused MCP tools for workspace opening, live model discovery and
  selection, mode selection, individual conversation operations, question
  answers, and exceptional approval decisions.
- Added live TraeCN model-list discovery and stable-title conversation deletion.

### Changed

- Split the overloaded six-tool contract into 13 single-intent tools.
  `traecn_send_message` now accepts only a message and optional conversation
  identifier; context changes use their dedicated tools. The capabilities
  contract version is now 3.
- Sending without an explicit conversation now stays in the selected
  conversation. Creating a conversation is always an explicit operation.
- Kept readiness, queueing, persistence, waiting, recovery, notifications,
  routine approvals, and keep/revert decisions entirely gateway-managed.

## [0.4.3] - 2026-07-30

### Added

- Added the unified `traecn_submit`, `traecn_get_task`, conversation, cancel,
  and exceptional-interaction MCP contract, backed by gateway-owned task and
  conversation endpoints.
- Added automatic workspace opening and verification, requested model/mode
  preparation, and conversation targeting to gateway-managed submissions.

### Changed

- Reduced MCP discovery from 39 profile-dependent tools to one six-tool
  surface. Every accepted submission is persisted and managed in the
  background, including queue maintenance, recovery, event delivery, safe
  approval handling, and follow-up continuation.
- Changed TraeCN file-review handling to keep generated changes automatically
  by default and revert them only when the collected state contains a clear
  fatal automation failure.
- Rewrote the portable Skill and MCP setup documentation around gateway
  ownership and automatic completion notifications.

### Removed

- Removed Agent-facing command catalogs, preflight/planning, sync-versus-queue
  choices, wait/poll/event acknowledgement, review shortcuts, workflow
  shortcuts, recovery/process controls, Solo-specific controls, cleanup/proof
  tools, settings shortcuts, and `ops`/`full` discovery profiles. Their needed
  mechanics remain internal or operator-facing rather than MCP tools.
- Removed the redundant long-form OpenClaw/MCP tool catalog and obsolete
  profile configuration examples.

### Fixed

- Fixed workspace selection so a requested folder is opened and verified by
  the gateway instead of being rejected or repeated inside the model message.
- Fixed task cancellation ownership so the single MCP cancel operation lets
  the gateway choose between removing queued work and stopping active
  generation.

## [0.4.2] - 2026-07-30

### Changed

- Declared ClawHub runtime requirements and optional environment variables in
  the portable Skill metadata, with the public MCP profile as the default.
- Clarified that automatic dialog approval is restricted to the gateway's
  read-only allowlist; risky, unknown, destructive, or privilege-affecting
  actions must remain within the user's explicitly authorized task scope.
- Excluded maintainer-only tests and the contract generator from the ClawHub
  artifact while keeping them in the source repository and npm test gate.

## [0.4.1] - 2026-07-30

### Added

- Added a persistent, per-client task-event inbox with long-poll and
  acknowledgement HTTP/MCP APIs, plus compact stdio MCP logging notifications
  that replay after reconnect without retransmitting full task results.
- Added the portable `skills/traecnclaw-mcp` Agent Skill for MCP-capable
  clients.
- Added `npm run pack:skill` to generate direct-download skill release
  artifacts and checksums under `dist/`.
- Added distribution and launch-kit documentation for public catalog
  submissions and social announcements.
- Added production documentation covering usage, development, deployment, environment configuration, and release acceptance checks.
- Added mock-mode system testing and documentation/OpenAPI UAT validation scripts.
- Added explicit OpenAPI coverage for settings read/write and self-update status endpoints.
- Added `skills/traecnclaw-mcp/scripts/start-mcp.js` launcher so MCP clients
  can start the server through the skill itself (auto-locates `mcp-server.js`,
  overridable via `TRAECN_MCP_SERVER_PATH`).
- Added separate launcher and direct-server MCP client templates at
  `skills/traecnclaw-mcp/assets/mcp-client-config.json` and
  `skills/traecnclaw-mcp/assets/mcp-client-config.direct.json`.
- Added `TASK_REQUIRED` factory method to `TraeCNSkillError` on `errors.js`.
- Added the public `traecn_resolve_task_review` MCP tool and stable
  `review_task` command so `awaiting_review` workflow checkpoints can be
  approved or rejected entirely through stdio MCP.
- Added generated MCP schema contracts, validated call examples, and a real
  Content-Length launcher smoke test for the portable Agent Skill.
- Added `npm run test:mcp-stdio-smoke` as a standalone, gateway-independent
  MCP `initialize` and `tools/list` verification command.

### Changed

- Changed the release from `0.5.0` to the conservative `0.4.1` patch line and
  made `package.json` the canonical version source, with synchronized package,
  Skill, and OpenClaw distribution manifests.
- Added explicit patch/minor/major version commands and documented when each
  increment is appropriate before `1.0.0`.
- Aligned the ESLint configuration with the repository's CommonJS runtime,
  removing Node's module-type reparsing warning.
- Changed `traecn_open_project` to reuse the active TraeCN window by default
  through the bundled CLI, reconnect CDP, and verify the exact workspace path;
  `newInstance:true` remains available for a separate window.
- Changed automatic command approvals to a local, token-free two-stage policy:
  fully read-only command chains run automatically, while write, network,
  privilege, process-control, and unknown commands return compact risk codes
  for calling-agent review without requesting human confirmation.
- Standardized stdio MCP public tool names under the `traecn_*` prefix and
  grouped the tool surface into `public`, `ops`, and `full` profiles.
- Improved gateway response headers, CORS handling, status version reporting, numeric environment parsing, and background queue polling lifecycle.
- Improved the built-in chat UI with safer DOM rendering, clearer error handling, responsive layout, token persistence, and status metadata.
- Updated OpenClaw plugin metadata to match registered tools.
- Consolidated `mcp-server.js` tool metadata: `TOOL_METADATA` is now the
  single source of truth; `PUBLIC_MCP_TOOL_NAMES`, `OPS_MCP_TOOL_NAMES`, and
  `DESTRUCTIVE_MCP_TOOLS` are derived from it instead of maintained in
  parallel.
- Repointed `package.json` `exports["./errors"]` from the deleted
  `ai-errors.js` to the canonical `errors.js`.
- Updated lint script to check `errors.js` instead of the deleted `ai-errors.js`.
- Extracted the queue-probe predicate helpers (6 functions) from `src/shared/utils.js` into a dedicated `src/shared/queue-probe.js` module; `utils.js` re-exports them so all 61 existing `require` sites keep working unchanged.
- Extracted the four task-completion notification functions (`notifyOpenClaw`, `formatResult`, `formatReviewRequiredMessage`, `sendTaskWebhook`) from the top of `src/http/gateway.js` into a new `src/http/task-notify.js` module, and removed the duplicated `notifyOpenClaw`/`formatResult` definitions in `src/http/handlers/delegate.js` in favor of the shared module (an optional `logPrefix` parameter keeps both sides' error-log prefixes unchanged).
- Derived `DEFAULT_CONFIG` in `src/shared/config-manager.js` from `CONFIG_SCHEMA` via the module-private `buildDefaultConfig()` instead of maintaining default values in two places by hand; the derived result is deep-equal to the previous handwritten values.
- Added `src/http/handlers/helpers.js` exporting `rejectBadRequest`, `hasDriverCapability`, and `requireDriverCapability`, consolidating 28 copies of the parameter-validation and driver-capability-guard boilerplate across 10 handlers; error messages are preserved byte-for-byte and the helpers take named options objects to avoid positional-argument drift.
- Documented `src/http/gateway.js` with a file-level docstring (gateway responsibilities and handlers layering), replaced scattered magic numbers with named constants (`MAX_TASK_TEXT_LENGTH`, `IDEMPOTENCY_KEY_TTL_MS`, `GZIP_MIN_BYTES`), and added "why" comments for the CIDR mask bit arithmetic, the 120-character completion threshold, and the 35000 ms settings-read timeout. No external behavior changes.
- Removed the historically-unwired dead-code handler modules (`src/http/handlers/config.js`, `dialog.js`, `settings.js`, `preflight.js`); production traffic was already served by the inline implementations in `gateway.js`, so the deletion is zero-behavior-change. (Their file-header comments were corrected in a prior pass; now moot.)
- Updated the `lint` script to `node --check` the new modules (`queue-probe.js`, `task-notify.js`, `handlers/helpers.js`).
- Injected capability data sources (`openapi`/`prompt-layers`/`traecn-skill`) into `src/shared/capabilities.js` as parameters with lazy-require defaults, fixing a reverse-dependency layering violation (`shared` was requiring `http`/`skill`); `buildCapabilities` callers are unchanged.
- Split the six longest mixed-responsibility functions into single-purpose helpers: `gateway._ensureBackgroundPolling`, `delegate.handleDelegateAsync`, `traecn-cli.cmdCleanupQueue`, `config-manager.validate` (into 11 sequential `_validate*` steps), `response-poller._pollResponseState` (DOM-injection template extracted), and `response-collection.collectResponse`. Control flow and return/error values preserved.
- Unified entry-parameter naming across the skill layer and plugins: `opts`/`config` → `options` in `traecn-skill.js`, `index.js`, `simple-api.js`, and the three plugin factories; renamed the single-letter local alias `d` to `payload` in `traecn-skill.js` normalize helpers. The public `t/q/p/w/s` aliases in `simple-api.js` are intentionally preserved (API contract).
- Centralized CLI argument parsing and gateway connection config in `scripts/lib/cli-config.js`: removed five duplicated `readArg` definitions and the per-script `host`/`port`/`token` trios; each script's original resolution priority is preserved.
- Translated Chinese-language comments in `traecn-skill.js`, `shared/utils.js`, `shared/logger.js`, `shared/queue-probe.js`, `gateway.js`, and `batch-executor.js` to English; quoted Chinese examples inside comments and all Chinese string/regex literals (Trae CN UI text matching, user-facing messages) are preserved byte-for-byte.
- Removed redundant restating comments in `task-actions.js`, `settings-driver.js`, `discovery.js`, and `panel-capture.js`, and deleted a block of commented-out dead-code example calls in `skill/examples/layered-usage.js`.
- Extracted scattered magic numbers into named module constants: `MAX_TASK_TEXT_LENGTH` (task-actions.js, batch.js), `CDP_REQUEST_TIMEOUT_MS` (discovery.js), and `MAX_BATCH_TASKS` (batch.js). All values unchanged.

### Fixed

- Fixed the acceptance audit after queue-probe and MCP modules were split, and
  promoted its previously orphaned regression test into the default test gate.
- Fixed task `projectPath` handling at the gateway boundary. The path is now an
  optional workspace guard: guarded submissions fail with `PROJECT_NOT_OPEN`
  when another folder is open, and the gateway sends only the original task
  text instead of injecting redundant path instructions into the model prompt.
- Fixed inline TraeCN command approvals so active out-of-sandbox command cards
  are reported by `traecn_get_dialog_status` and
  `traecn_respond_dialog({action:"approve"})` can click `运行`.
- Fixed background Solo task isolation by preferring task-specific text
  identities and refusing stale sidebar-index fallback when a textual identity
  exists. A newer conversation can no longer be collected as an older task
  merely because it moved into that task's former list position.
- Fixed partial progress such as `任务完成 16%` being classified as a terminal
  result; percentages below 100 remain in progress.
- Fixed `traecn_open_project` and the stable `open_project` command so the
  optional `newInstance` flag reaches the gateway, allowing a project to open
  in a separate TraeCN window when TraeCN is already running. The OpenClaw
  runtime and manifest now expose the same option.
- Fixed plugin client settings API paths to match gateway routes.
- Added `/api/delegate-async` compatibility for async delegation clients.
- Added mock queue status support so mock-mode delegate flows work through the async path.
- Fixed error leakage: `errorToBody` now returns a generic `'Internal server error'` message for bare `Error` instances instead of forwarding `err.message` (which could contain filesystem paths, CDP selector names, or other internals). Added `safeErrorMessage()` helper and applied it at all stored error sites (`task.error`, `batch.results[].error`, model probe results, settings handler errors). `TraeCNAutomationError` and `HttpError` continue to surface their purpose-built messages.
- Consolidated the dual per-task lock structures: `Gateway.taskLocks` is now a read-only alias for `taskQueueService.stateMachine.taskLocks`. Mutations go through `taskQueueService.tryAcquire/release/clearLocks`, making the previously dead abstraction real and preventing future callers (e.g. adopt-current-task, batch executor) from missing locks held by the polling loop.
- Added a startup warning when `TRAECN_GATEWAY_TOKEN` is unset and the gateway is bound to a non-loopback host — authenticated endpoints become open in that configuration.
- Fixed reviewed workflows so explicit `autoContinue=false` is preserved
  instead of being overwritten by the unattended workflow wrapper.
- Fixed the OpenClaw manifest command enum so the stable `review_task` command
  advertised by the runtime can be selected by manifest-validating clients.
- Fixed the Agent Skill's model-switch and review examples, split duplicate MCP
  client entries into separate templates, and corrected no-tools diagnostics.
- Fixed `simple-api.js` `checkQueue` routing: was calling `layered.batch.checkQueue()`
  (nonexistent); now correctly calls `layered.dialog.checkQueue()`.
- Fixed `submitSoloChatTask` return type inconsistency in `simple-api.js`: the
  flat alias was stripping the result to a bare `taskId` string while
  `index.js`'s `advanced.submitSoloChatTask` returned the full object; both
  now return the full normalized result.

### Removed

- Removed the orphaned optimization-metrics script tied to a deleted report,
  the unused `trae-cn chat` wrapper, and the unreferenced duplicate project
  structure guide. Existing gateway, MCP, CLI, and development documentation
  remain the maintained entry points.
- Removed the duplicate repo-local Codex Skill copy from the npm tarball; the
  complete canonical `skills/traecnclaw-mcp` package now ships with its assets,
  scripts, examples, and generated contracts.
- Removed completed process documents, historical audit logs, and redundant
  API/architecture guides that had drifted behind the maintained README, MCP,
  OpenClaw, and structured-prompt documentation.
- Removed dead code `src/skill/config.js` (74 lines, zero references).
- Removed dead code `src/skill/ai-errors.js` (375 lines, only referenced by
  examples; had circular `require('./index')` calls). Export path
  `./errors` now points to the canonical `errors.js`.
- Removed `escapeJsString` from `src/shared/utils.js` and its test (unused).
- Removed deprecated `slashCommands` export from the OpenClaw plugin
  (`integrations/openclaw-traecn-plugin/index.js`). Slash commands are
  declared in `openclaw.plugin.json` since OpenClaw 2026.4; the runtime array
  was dead code. Updated `index.test.js` accordingly.
- Gated `/openapi.json` behind `requiresAuth: true` to prevent unauthenticated API-surface reconnaissance. The chat UI diagnostics panel continues to work because it already sends the saved token on every request.

### Security

- Added timing-safe token comparison and removed the identifying `X-Powered-By` response header.
- Added security headers for JSON and HTML responses and response-size protection in the plugin HTTP client.

## [0.4.0] - 2026-06-12

Additive release: nine new CDP drivers, HTTP driver gateway, and live UAT. No behavior break; all 538+ pre-existing tests still pass alongside 100+ new driver test cases.

### Added

- Added nine new CDP drivers: `CommandPaletteDriver`, `EditorDriver` (with accept/reject AI edit via the `.icube-apply-action-container`), `FileDriver` (open/close/save plus `readDisk` / `writeDisk` / `mkdirDisk` / `listTreeDisk` / `renameDisk`), `TerminalDriver` (toggle/send/snapshot plus `sendCtrlC` / `sendCtrlD` / `sendCtrlL` / `sendCtrlZ`), `GitDriver` (status/commit/push/pull/branch/stash plus `commitWithMessage` and `execGit` CLI fallback), `SearchDriver` (findInFiles/readResults/collapseAll), `DiagnosticsDriver` (readAll/readModelMarkers/count/hover), `SnapshotDriver` (dom/text/layout/pageHash/screenshot), and `ExtensionDriver` (list/install/uninstall plus marketplace search and CLI fallback).
- Exposed the nine new drivers via `DomDriver` getters: `.palette`, `.editor`, `.file`, `.terminal`, `.git`, `.search`, `.diagnostics`, `.snapshot`, `.extension`.
- Added HTTP gateway endpoints `POST /api/editor`, `/api/file`, `/api/terminal`, `/api/git`, `/api/search`, `/api/diagnostics`, `/api/snapshot`, `/api/extension`, and `/api/command`, all dispatching a unified `{action, ...args}` body through the new `DriverRouter` in `src/http/driver-router.js` (explicit per-driver action spec mapping param names to positional arguments).
- Added HTTP-friendly action aliases on `SnapshotDriver`: `text`, `dom`, `layout`, `screenshotEl`.
- Added `docs/REAL-DOM-FINDINGS.md` documenting the actual class names and selectors probed via CDP from a real TraeCN 1.107.1 instance.
- Added `scripts/live-uat-v040.js`, an end-to-end live TraeCN smoke test driving the editor through the new driver stack.
- TraeCNClaw can now drive TraeCN end-to-end without Peekaboo or any screen-automation tool (the first OAuth login still requires the user).

### Changed

- Fixed `TraeCNAutomationError` signature across all drivers to the documented `(message, code, details)` form.
- Hardened `CommandPaletteDriver` to retry `Cmd+Shift+P` up to three times with 600 ms waits before reporting failure, eliminating the known first-open palette race on a fresh editor window.

### Tests

- Added 10 new test files with ~100+ new driver test cases; all green.
- All 538+ pre-existing tests continue to pass (638+ total).
- `scripts/live-uat-v040.js` reports 24/25 pass; the single failure is a documented first-attempt `terminal.newTerminal` palette race that the new retry path resolves on the second attempt.
