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

- Added the portable `.codex/skills/traecnclaw-mcp` Agent Skill for MCP-capable
  clients.
- Added `npm run pack:skill` to generate direct-download skill release
  artifacts and checksums under `dist/`.
- Added distribution and launch-kit documentation for public catalog
  submissions and social announcements.
- Added production documentation covering usage, development, deployment, environment configuration, and release acceptance checks.
- Added mock-mode system testing and documentation/OpenAPI UAT validation scripts.
- Added explicit OpenAPI coverage for settings read/write and self-update status endpoints.

### Changed

- Standardized stdio MCP public tool names under the `traecn_*` prefix and
  grouped the tool surface into `public`, `ops`, and `full` profiles.
- Improved gateway response headers, CORS handling, status version reporting, numeric environment parsing, and background queue polling lifecycle.
- Improved the built-in chat UI with safer DOM rendering, clearer error handling, responsive layout, token persistence, and status metadata.
- Updated OpenClaw plugin metadata to match registered tools.

### Fixed

- Fixed plugin client settings API paths to match gateway routes.
- Added `/api/delegate-async` compatibility for async delegation clients.
- Added mock queue status support so mock-mode delegate flows work through the async path.
- Fixed error leakage: `errorToBody` now returns a generic `'Internal server error'` message for bare `Error` instances instead of forwarding `err.message` (which could contain filesystem paths, CDP selector names, or other internals). Added `safeErrorMessage()` helper and applied it at all stored error sites (`task.error`, `batch.results[].error`, model probe results, settings handler errors). `TraeCNAutomationError` and `HttpError` continue to surface their purpose-built messages.
- Consolidated the dual per-task lock structures: `Gateway.taskLocks` is now a read-only alias for `taskQueueService.stateMachine.taskLocks`. Mutations go through `taskQueueService.tryAcquire/release/clearLocks`, making the previously dead abstraction real and preventing future callers (e.g. adopt-current-task, batch executor) from missing locks held by the polling loop.
- Added a startup warning when `TRAECN_GATEWAY_TOKEN` is unset and the gateway is bound to a non-loopback host — authenticated endpoints become open in that configuration.
- Gated `/openapi.json` behind `requiresAuth: true` to prevent unauthenticated API-surface reconnaissance. The chat UI diagnostics panel continues to work because it already sends the saved token on every request.

### Security

- Added timing-safe token comparison and removed the identifying `X-Powered-By` response header.
- Added security headers for JSON and HTML responses and response-size protection in the plugin HTTP client.
