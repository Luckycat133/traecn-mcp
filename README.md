# TRAECNclaw

Local HTTP bridge, OpenClaw tool integration, and AI Skill module for TraeCN desktop automation. TRAECNclaw connects OpenClaw to TraeCN through a local REST gateway, Chrome DevTools Protocol (CDP), and DOM automation so tools can create chats, delegate tasks, switch modes, inspect readiness, and read TraeCN responses.

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Skill Module](#skill-module)
- [API](#api)
- [Testing](#testing)
- [Security](#security)
- [Documentation](#documentation)
- [Maintainers](#maintainers)
- [License](#license)

## Requirements

- Node.js 22 or newer
- TraeCN desktop application
- TraeCN started with a remote debugging port, usually `--remote-debugging-port=9222` or a quickstart port such as `9334`
- OpenClaw when using the plugin in `integrations/openclaw-traecn-plugin`

## Installation

```sh
npm install
cp .env.example .env
```

Edit `.env` for your TraeCN installation path, CDP port, gateway token, and selectors if TraeCN DOM discovery reports custom values.

## Configuration

Important environment variables:

- `HOST` and `PORT`: local gateway bind address. Use `127.0.0.1` for local-only operation.
- `TRAECN_GATEWAY_TOKEN`: optional bearer token required by protected endpoints.
- `TRAECN_ALLOWED_ORIGINS`: comma-separated browser origins allowed by CORS.
- `TRAECN_REMOTE_DEBUGGING_PORT`: TraeCN CDP port.
- `TRAECN_QUICKSTART_PROFILE_MODE`: `existing` by default so live automation reuses your logged-in Trae CN profile instead of a fresh isolated one. Set `isolated` only for disposable test profiles.
- `TRAECN_TRAE_RECOVERY_NEW_INSTANCE`: defaults to `0`; keep it disabled to avoid opening a new unauthenticated Trae window during gateway recovery.
- `TRAECN_AUTO_START_TRAE`: defaults to `1`; when the gateway loses CDP it will try to relaunch Trae CN and reconnect automatically.
- `TRAECN_QUEUE_MAX_WAIT_MS`: optional. Leave unset to let external TraeCN model queues wait indefinitely in the local gateway; set it only when you want a local queue timeout.
- `TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH`: optional path for persisted async queue state. By default macOS uses `~/Library/Application Support/TRAECNclaw/active-queue.json`.
- `TRAECN_ENABLE_MOCK_BRIDGE`: set to `1` for local system tests without TraeCN.
- `TRAECN_*_SELECTORS`: optional DOM selector overrides discovered with `npm run inspect:traecn`.

## Usage

Start TraeCN and the gateway:

```sh
npm run quickstart
```

If CDP is unavailable because Trae CN is already running without a debug port,
use the confirmed recovery command. It quits Trae CN, then starts it again with
the existing logged-in profile and CDP enabled:

```sh
curl -s -X POST http://127.0.0.1:8788/api/trae/restart-debug \
  -H 'Content-Type: application/json' \
  -d '{"confirmationPhrase":"restart-trae-cn-with-debug-existing-profile"}'
```

For manual startup after quitting Trae CN yourself, start a debug-enabled
instance against the existing logged-in profile:

```sh
TRAECN_QUICKSTART_PROFILE_MODE=existing npm run start:traecn -- --use-existing-profile
```

Start only the gateway:

```sh
npm run start:gateway
```

For unattended queue waiting on macOS, prefer the LaunchAgent wrapper. It persists background queued tasks and reloads them after the gateway restarts:

```sh
TRAECN_ENABLE_MOCK_BRIDGE=0 TRAECN_REMOTE_DEBUGGING_PORT=9334 TRAECN_QUICKSTART_PROFILE_MODE=existing npm run service:start
npm run service:status
```

Open the built-in chat UI at:

```text
http://127.0.0.1:8788/
```

The chat UI includes a Dev Console panel for gateway status, CDP ownership, mode/readiness, queue/dialog state, recent task history, and OpenAPI contract checks.

Diagnose local setup:

```sh
npm run doctor
```

Verify TraeCN DOM selector compatibility when TraeCN is running with remote debugging enabled:

```sh
npm run inspect:verify
```

Export the OpenAPI document:

```sh
node scripts/export-openapi.js
```

## Skill Module

### Quick Start

```javascript
const { preflight, runTask, reviewCode, switchModel } = require('traecnclaw');

const pf = await preflight({ command: 'delegate_async', params: { task: '分析项目代码' } });
await switchModel('glm');
const result = await runTask('分析项目代码');

const review = await reviewCode({
  instruction: '审查登录模块改动',
  files: ['src/auth.js'],
  diff: '...'
});
```

### MCP Server

Any MCP-capable agent can connect through the bundled stdio server:

```json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/absolute/path/to/TRAECNclaw/mcp-server.js"],
      "env": {
        "TRAECN_HOST": "127.0.0.1",
        "TRAECN_PORT": "8788",
        "TRAECN_GATEWAY_TOKEN": ""
      }
    }
  }
}
```

The MCP server exposes `preflight`, `run_task`, `queue_task`, `poll_task`, `review_code`, settings/dialog/model controls, and the generic `traecn_command` catalog for full command coverage.

### Layered Architecture

TraeCNSkill uses a 5-layer architecture for selective loading and minimal context:

- **Basic Layer** (90% scenarios): 5 core functions
- **Review Layer**: structured code review prompts through `reviewCode`
- **Advanced Layer**: Project management, mode switching
- **Config Layer**: Settings management
- **Dialog Layer**: Dialog handling
- **Batch Layer**: Batch operations

### Documentation

Complete skill documentation:

- [Layered Architecture Guide](docs/LAYERED-ARCHITECTURE.md)
- [AI Usage Guide](docs/AI-USAGE-GUIDE.md)
- [MCP Server Guide](docs/MCP-SERVER-GUIDE.md)
- [Quick Reference](docs/QUICK-REFERENCE.md)
- [OpenClaw Command Set](docs/openclaw-command-set.md)
- [Structured Prompt Mechanism](docs/structured-prompt-mechanism.md)

## API

The OpenAPI schema is served at `/openapi.json`. Primary endpoints:

- `GET /api/capabilities`
- `GET /api/status`
- `POST /api/preflight`
- `POST /api/sessions`
- `POST /api/sessions/{sessionId}/delegate`
- `POST /api/delegate`
- `POST /api/delegate-async`
- `POST /api/confirm/plan`
- `POST /api/new-chat`
- `POST /api/switch-mode`
- `POST /api/switch-model`
- `GET /api/queue-status`
- `GET /api/settings/read`
- `GET /api/settings/read-all`
- `POST /api/settings/set`
- `POST /api/settings/switch-tab`
- `POST /api/settings/back-to-chat`
- `GET /openapi.json`
- MCP stdio tools through `mcp-server.js`

Agents should call `GET /api/capabilities` or MCP `traecn_capabilities` first for a compact command, endpoint, token strategy, model, settings, and confirmation catalog. Before side-effecting operations, call `POST /api/preflight` or MCP `preflight` once to combine status, current `surface` (`setup` vs `workspace`), readiness, queue, dialog, and optional command-plan state. For a dry confirmation-only check, call `POST /api/confirm/plan` or MCP `plan_operation`. Fetch `/openapi.json` only when full request/response schemas are needed.

For unattended local waiting on macOS, start the gateway as a LaunchAgent:

```sh
npm run service:start
npm run service:status
```

With `delegate-async`, use `waitForQueue=true` to keep tasks in the gateway's own
background queue while TraeCN is visibly queued, and add `reviewRequired=true`
when you want the result to pause for user review before any follow-up tasks run.
Add `fallbackModels` or `autoModelFallback=true` when the gateway should actively
probe alternate models while the task waits. The agent can then release its
context after receiving `taskId`; the local gateway persists the queue, refreshes
`modelProbeResults`, and sends webhook/OpenClaw notifications when the task
reaches review or completion.
By default, external TraeCN model queues do not expire locally; set
`maxQueueWaitMs` (or `queueMaxWaitMs`) only when a caller explicitly wants a
queue timeout.

```json
{
  "task": "审查当前项目并输出 findings-first 结果",
  "waitForQueue": true,
  "reviewRequired": true,
  "autoModelFallback": true,
  "modelProbeIntervalMs": 60000
}
```

## Testing

```sh
npm run lint
npm test
npm run test:system
npm run test:uat
npm run test:live
npm run audit:prod
```

`npm test` runs unit and integration tests. `test:system` starts the gateway in mock mode and verifies the HTTP flow. `test:uat` verifies documentation and OpenAPI coverage required for release acceptance.
`test:live` runs safe real Trae CN/CDP smoke checks when a live remote-debugging endpoint is available; otherwise it reports `SKIP` and exits successfully. Use `node scripts/live-uat.js --strict` when a live desktop instance is required, `--require-ready` when the UI must be logged in and automation-ready, and `--delegate` only when sending a real test prompt is acceptable. `--delegate` is readiness-gated and fails with diagnostics instead of sending a prompt to an unready UI.

## Security

Bind the gateway to `127.0.0.1`, set `TRAECN_GATEWAY_TOKEN` before exposing protected endpoints to browser or tool clients, and configure `TRAECN_ALLOWED_ORIGINS` when using the chat UI from a browser origin other than the gateway. Set `TRAECN_ENFORCE_OPERATION_CONFIRMATION=1` in production to require a matching confirmation plan ID for high-risk settings and dialog operations. Logs redact common sensitive keys such as tokens, passwords, secrets, credentials, and authorization values.

## Documentation

- [User Manual](docs/user-manual.md)
- [Development Guide](docs/development.md)
- [Deployment Guide](docs/deployment.md)
- [Layered Architecture Guide](docs/LAYERED-ARCHITECTURE.md)
- [AI Usage Guide](docs/AI-USAGE-GUIDE.md)
- [MCP Server Guide](docs/MCP-SERVER-GUIDE.md)
- [Quick Reference](docs/QUICK-REFERENCE.md)

## Maintainers

Repository maintainers for `firerlAGI/TRAECNclaw`.

## License

MIT
