# TRAECNclaw Development Guide

## Architecture

TRAECNclaw is split into four layers:

- `src/config`: `.env` loading and quickstart configuration.
- `src/cdp`: CDP discovery, WebSocket client, DOM driver, settings driver, and mock driver.
- `src/http`: REST gateway, OpenAPI generation, and built-in chat UI.
- `integrations/openclaw-traecn-plugin`: OpenClaw tool and slash command registration.

The production path is `OpenClaw -> HTTP gateway -> CDP WebSocket -> TraeCN DOM`. The CLI path is available through `traecn_chat` for fire-and-forget actions.

## Local Development

```sh
npm install
cp .env.example .env
npm run lint
npm test
```

Use mock mode for gateway work that should not require TraeCN:

```sh
TRAECN_ENABLE_MOCK_BRIDGE=1 npm run start:gateway
```

Run the doctor before debugging local setup issues:

```sh
npm run doctor
```

The doctor reports PASS/WARN/FAIL checks for Node.js, npm, `.env`, gateway host and port, mock bridge mode, CDP remote debugging, `/api/status`, and the `/Applications/Trae CN.app` install path. Only critical setup failures, such as an unsupported Node.js version or invalid port configuration, return a non-zero exit code; missing live TraeCN/CDP state is a warning so mock-mode development can continue.

Verify live TraeCN selectors when TraeCN is running with a remote debugging port:

```sh
npm run inspect:verify
```

The verify mode loads `.env`, refuses CDP endpoints that do not look like TraeCN, checks composer/send/response/new-chat/mode selectors, and exits non-zero when the current TraeCN UI no longer matches the configured selector set.

If Trae CN is already open without remote debugging, prefer restarting it with
the existing logged-in profile and the debug port enabled:

```sh
TRAECN_QUICKSTART_PROFILE_MODE=existing npm run start:traecn -- --force-new --use-existing-profile
```

The default profile mode is `existing`, so `--force-new` does not add an
isolated `--user-data-dir` unless you explicitly pass `--use-isolated-profile`
or set `TRAECN_QUICKSTART_PROFILE_MODE=isolated`.

For disposable selector experiments, use an isolated profile deliberately:

```sh
TRAECN_QUICKSTART_PROFILE_MODE=isolated npm run start:traecn -- --force-new --use-isolated-profile
```

For unattended queue verification, keep the gateway under `launchd` so queued tasks survive terminal exits and gateway restarts:

```sh
TRAECN_ENABLE_MOCK_BRIDGE=0 TRAECN_REMOTE_DEBUGGING_PORT=9334 TRAECN_QUICKSTART_PROFILE_MODE=existing npm run service:start
```

With the current defaults the gateway will also:

- leave Trae CN closed when CDP disappears; opt in to relaunch with `TRAECN_AUTO_START_TRAE=1`
- keep active queue waits indefinitely by default; set
  `TRAECN_QUEUE_MAX_WAIT_MS` only when a local queue timeout is required
- persist active async queue state to `~/Library/Application Support/TRAECNclaw/active-queue.json` on macOS
- refuse to open an isolated unauthenticated Trae profile when the normal app is
  already running without CDP; use `restart_trae_debug` or
  `POST /api/trae/restart-debug` with explicit confirmation to restart the
  existing logged-in profile with remote debugging.

## Testing Strategy

- Unit tests cover small utilities, environment parsing, error classes, CDP client behavior, and mock driver behavior.
- Integration tests cover CDP discovery scoring, DOM driver configuration, gateway utility behavior, and plugin client requests.
- System tests start a real local gateway in mock mode and verify authentication, session creation, delegation, response headers, and route compatibility.
- UAT checks verify release documentation, OpenAPI endpoint coverage, and the machine-readable acceptance audit.
- `npm run acceptance:audit` reports current completion evidence as JSON. It exits successfully for `passed`, `partial`, or `missing` status so it can run in normal UAT; add `-- --require-complete` to make partial/missing requirements fail before claiming the full unattended TraeCN goal is complete.
- Live UAT checks a real Trae CN CDP endpoint with safe read-only gateway calls when available. It reports `SKIP` by default if CDP is not reachable; use `node scripts/live-uat.js --strict` when a real desktop instance is required. Add `--require-ready` to fail unless the logged-in Trae CN UI is automation-ready. Add `--cleanup-queue-probes` to stop/delete accidental `wait for Trae queue` Solo chats and verify `matched: 0`; strict runs fail if those chats remain. Add `--delegate` only when sending a real prompt is acceptable. Use `traecnclaw cleanup-queue --status --json` to inspect the singleton cleanup watcher without contacting TraeCN.
- `npm run proof:long-queue` prepares the remaining GLM-5.2 queue-drain proof without sending a prompt. It writes the marker, evidence log path, final JSON path, and readiness summary. Add `-- --execute --detach --allow-quota-spend` only for an explicitly approved quota-consuming proof run; the runner switches to GLM-5.2, submits an owned marker task, waits unattended, keeps queue-probe cleanup in the wait loop, and automatically stop/deletes accidental queue-probe Solo chats before submission. Execute mode requires consecutive clean dry-runs before submitting; tune it with `-- --cleanup-stabilize-checks <n> --cleanup-stabilize-delay-ms <ms> --cleanup-max-attempts <n>`. Re-running with the same marker resumes the existing task from the evidence log instead of submitting again; add `-- --force-new` only for an intentional new submission. Use `npm run proof:status`, CLI `traecnclaw proof status`, MCP `traecn_get_long_queue_proof_status`, or OpenClaw `traecn_long_queue_proof_status` for detached proof inspection; use `npm run proof:cancel -- --marker <id>`, CLI `traecnclaw proof cancel`, MCP `traecn_cancel_long_queue_proof`, or OpenClaw `traecn_long_queue_proof_cancel` for cancellation.

Recommended release gate:

```sh
npm run test:all
npm run acceptance:audit
npm run proof:long-queue
npm run test:live
node scripts/live-uat.js --strict --require-ready --cleanup-queue-probes
npm run audit:prod
```

## Coding Standards

- Keep Node.js code in CommonJS to match the existing project.
- Use environment variables through `getEnvWithFallback` to preserve `TRAECN_*` and legacy `TRAE_*` compatibility.
- Use `parsePositiveInt` for numeric environment values so invalid config cannot become `NaN`.
- Keep the gateway local by default and add explicit tests for every public route change.
- Do not log raw tokens, authorization headers, passwords, secrets, credentials, or other sensitive values.

## Adding API Endpoints

1. Implement the handler in `src/http/gateway.js`.
2. Add or update a plugin client method in `integrations/openclaw-traecn-plugin/lib/traecnapi-client.js` when OpenClaw needs it.
3. Update `src/http/openapi.js`.
4. Add unit, integration, or system coverage depending on behavior.
5. Update `README.md`, the relevant maintained guide under `docs/`, and `CHANGELOG.md` when user-visible behavior changes.

## DOM Selector Updates

Run:

```sh
npm run inspect:traecn
```

Copy stable selectors into `.env` using the `TRAECN_COMPOSER_SELECTORS`, `TRAECN_SEND_BUTTON_SELECTORS`, `TRAECN_RESPONSE_SELECTORS`, `TRAECN_NEW_CHAT_SELECTORS`, and `TRAECN_MODE_TAB_SELECTORS` variables. Prefer specific selectors before generic fallbacks.
