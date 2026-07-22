# Changelog

All notable changes to this project are documented in this file.

## [v0.4.0] - 2026-06-12

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

## [Unreleased]

### Added

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
- Added `skills/traecnclaw-mcp/assets/mcp-client-config.json` template with
  Option A (skill launcher) and Option B (direct path) configs for all major
  MCP clients.
- Added `TASK_REQUIRED` factory method to `TraeCNSkillError` on `errors.js`.

### Changed

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
- Corrected misleading file-header comments on the historically unwired dead-code modules (`src/http/handlers/settings.js` and the config/dialog/preflight handler groups) to state that production traffic goes through the inline implementations in `gateway.js`.
- Updated the `lint` script to `node --check` the new modules (`queue-probe.js`, `task-notify.js`, `handlers/helpers.js`).
- Injected capability data sources (`openapi`/`prompt-layers`/`traecn-skill`) into `src/shared/capabilities.js` as parameters with lazy-require defaults, fixing a reverse-dependency layering violation (`shared` was requiring `http`/`skill`); `buildCapabilities` callers are unchanged.
- Split the six longest mixed-responsibility functions into single-purpose helpers: `gateway._ensureBackgroundPolling`, `delegate.handleDelegateAsync`, `traecn-cli.cmdCleanupQueue`, `config-manager.validate` (into 11 sequential `_validate*` steps), `response-poller._pollResponseState` (DOM-injection template extracted), and `response-collection.collectResponse`. Control flow and return/error values preserved.
- Unified entry-parameter naming across the skill layer and plugins: `opts`/`config` → `options` in `traecn-skill.js`, `index.js`, `simple-api.js`, and the three plugin factories; renamed the single-letter local alias `d` to `payload` in `traecn-skill.js` normalize helpers. The public `t/q/p/w/s` aliases in `simple-api.js` are intentionally preserved (API contract).
- Centralized CLI argument parsing and gateway connection config in `scripts/lib/cli-config.js`: removed five duplicated `readArg` definitions and the per-script `host`/`port`/`token` trios; each script's original resolution priority is preserved.
- Translated Chinese-language comments in `traecn-skill.js`, `shared/utils.js`, `shared/logger.js`, `shared/queue-probe.js`, `gateway.js`, and `batch-executor.js` to English; quoted Chinese examples inside comments and all Chinese string/regex literals (Trae CN UI text matching, user-facing messages) are preserved byte-for-byte.
- Removed redundant restating comments in `task-actions.js`, `settings-driver.js`, `discovery.js`, and `panel-capture.js`, and deleted a block of commented-out dead-code example calls in `skill/examples/layered-usage.js`.
- Extracted scattered magic numbers into named module constants: `MAX_TASK_TEXT_LENGTH` (task-actions.js, batch.js), `CDP_REQUEST_TIMEOUT_MS` (discovery.js), and `MAX_BATCH_TASKS` (batch.js). All values unchanged.

### Fixed

- Fixed plugin client settings API paths to match gateway routes.
- Added `/api/delegate-async` compatibility for async delegation clients.
- Added mock queue status support so mock-mode delegate flows work through the async path.
- Fixed error leakage: `errorToBody` now returns a generic `'Internal server error'` message for bare `Error` instances instead of forwarding `err.message` (which could contain filesystem paths, CDP selector names, or other internals). Added `safeErrorMessage()` helper and applied it at all stored error sites (`task.error`, `batch.results[].error`, model probe results, settings handler errors). `TraeCNAutomationError` and `HttpError` continue to surface their purpose-built messages.
- Consolidated the dual per-task lock structures: `Gateway.taskLocks` is now a read-only alias for `taskQueueService.stateMachine.taskLocks`. Mutations go through `taskQueueService.tryAcquire/release/clearLocks`, making the previously dead abstraction real and preventing future callers (e.g. adopt-current-task, batch executor) from missing locks held by the polling loop.
- Added a startup warning when `TRAECN_GATEWAY_TOKEN` is unset and the gateway is bound to a non-loopback host — authenticated endpoints become open in that configuration.
- Fixed `simple-api.js` `checkQueue` routing: was calling `layered.batch.checkQueue()`
  (nonexistent); now correctly calls `layered.dialog.checkQueue()`.
- Fixed `submitSoloChatTask` return type inconsistency in `simple-api.js`: the
  flat alias was stripping the result to a bare `taskId` string while
  `index.js`'s `advanced.submitSoloChatTask` returned the full object; both
  now return the full normalized result.

### Removed

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
