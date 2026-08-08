# Runtime configuration

> Generated from `src/config/runtime-schema.js`. Run `npm run sync:config-docs` after changing the schema.

Canonical variables and defaults:

<!-- BEGIN GENERATED: runtime defaults -->
| Variable | Default | Meaning |
| --- | --- | --- |
| `TRAECN_GATEWAY_HOST` | `127.0.0.1` | Gateway bind host. A non-loopback value requires TRAECN_GATEWAY_TOKEN. |
| `TRAECN_GATEWAY_PORT` | `8788` | Gateway HTTP port. |
| `TRAECN_GATEWAY_TOKEN` | empty (loopback only) | Bearer token. Optional only while the gateway binds to loopback. |
| `TRAECN_GATEWAY_TIMEOUT_MS` | `30000` | Timeout used by MCP and CLI gateway clients. |
| `TRAECN_CDP_HOST` | `127.0.0.1` | Host exposing the TraeCN Chrome DevTools Protocol endpoint. |
| `TRAECN_REMOTE_DEBUGGING_PORT` | `9222` | Single CDP port used by launch, discovery, quickstart, doctor, and services. |
| `TRAECN_QUICKSTART_PROFILE_MODE` | `existing` | Reuse the logged-in profile by default; isolated is for disposable testing. |
| `TRAECN_AUTO_START_TRAE` | `0` | Opt in to automatic TraeCN launch/recovery. quickstart also accepts --launch-trae. |
| `TRAECN_RESPONSE_TIMEOUT_MS` | `1800000` | Maximum response-collection window (30 minutes). |
| `TRAECN_QUEUE_WAIT_TIMEOUT_MS` | `60000` | Timeout for one low-level queue wait operation; it is not the total task lifetime. |
| `TRAECN_QUEUE_PER_TASK_TIMEOUT_MS` | `600000` | Deadline-extension window while a task remains in an external model queue. |
| `TRAECN_QUEUE_MAX_WAIT_MS` | empty (unlimited) | Optional total local queue cap. Empty means external queues may wait indefinitely. |
| `TRAECN_TERMINAL_IDEMPOTENCY_TTL_MS` | `86400000` | Retention window for terminal task idempotency replays (24 hours). |
| `TRAECN_ENABLE_MOCK_BRIDGE` | `0` | Use the mock bridge for tests that do not require a live TraeCN instance. |
<!-- END GENERATED: runtime defaults -->

Canonical names take precedence over compatibility aliases. New configuration should use only the canonical names.

| Canonical variable | Compatibility aliases |
| --- | --- |
| `TRAECN_GATEWAY_HOST` | `TRAECN_HOST`, `HOST`, `TRAE_GATEWAY_HOST`, `TRAE_HOST` |
| `TRAECN_GATEWAY_PORT` | `TRAECN_PORT`, `PORT`, `TRAE_GATEWAY_PORT`, `TRAE_PORT` |
| `TRAECN_GATEWAY_TOKEN` | `TRAE_GATEWAY_TOKEN` |
| `TRAECN_GATEWAY_TIMEOUT_MS` | `TRAE_GATEWAY_TIMEOUT_MS`, `TRAECN_TIMEOUT` |
| `TRAECN_CDP_HOST` | `TRAE_CDP_HOST` |
| `TRAECN_REMOTE_DEBUGGING_PORT` | `TRAE_REMOTE_DEBUGGING_PORT`, `TRAECN_QUICKSTART_REMOTE_DEBUGGING_PORT`, `TRAE_QUICKSTART_REMOTE_DEBUGGING_PORT` |
| `TRAECN_QUICKSTART_PROFILE_MODE` | `TRAE_QUICKSTART_PROFILE_MODE` |
| `TRAECN_AUTO_START_TRAE` | `TRAE_AUTO_START_TRAE`, `TRAECN_AUTOSTART` |
| `TRAECN_RESPONSE_TIMEOUT_MS` | `TRAE_RESPONSE_TIMEOUT_MS` |
| `TRAECN_QUEUE_WAIT_TIMEOUT_MS` | `TRAE_QUEUE_WAIT_TIMEOUT_MS` |
| `TRAECN_QUEUE_PER_TASK_TIMEOUT_MS` | `TRAE_QUEUE_PER_TASK_TIMEOUT_MS` |
| `TRAECN_QUEUE_MAX_WAIT_MS` | `TRAE_QUEUE_MAX_WAIT_MS` |
| `TRAECN_TERMINAL_IDEMPOTENCY_TTL_MS` | `TRAE_TERMINAL_IDEMPOTENCY_TTL_MS` |
| `TRAECN_ENABLE_MOCK_BRIDGE` | `TRAE_ENABLE_MOCK_BRIDGE` |

Queue semantics: `TRAECN_QUEUE_WAIT_TIMEOUT_MS` bounds one low-level UI wait, while an empty `TRAECN_QUEUE_MAX_WAIT_MS` leaves the gateway-managed task alive for an external model queue. These settings are not two competing total-task deadlines.

Idempotency semantics: a stable `Idempotency-Key` owns an accepted task across
restart. After the task becomes terminal, its fingerprint and terminal response
remain replayable for `TRAECN_TERMINAL_IDEMPOTENCY_TTL_MS` (24 hours by
default); a different request using the same key is rejected instead of being
submitted.

Startup semantics: `npm run quickstart` performs a bounded TraeCN-identity CDP check before starting the gateway. It launches TraeCN only with `--launch-trae` or `TRAECN_AUTO_START_TRAE=1`. If TraeCN is already running without debug access, quit it and run `TRAECN_QUICKSTART_PROFILE_MODE=existing npm run start:traecn -- --force-new --use-existing-profile`.

Security: the gateway refuses to bind a non-loopback address unless `TRAECN_GATEWAY_TOKEN` is non-empty.
