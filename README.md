# TRAECNclaw

> Status: Core Canonical Active
>
> **TRAECNclaw is the canonical source repository.** Packages, the Agent Skill, OpenClaw metadata, and GitHub Releases are generated and versioned from this repository.

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
- [Distribution](#distribution)
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
- `TRAECN_AUTO_START_TRAE`: defaults to `0`; set it to `1` only when the gateway should relaunch Trae CN after CDP disappears.
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

Any MCP-capable agent can connect through the bundled stdio server. The
recommended entry point is the skill launcher, which auto-locates
`mcp-server.js` from the repo root:

```json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/absolute/path/to/skills/traecnclaw-mcp/scripts/start-mcp.js"],
      "env": {
        "TRAECN_HOST": "127.0.0.1",
        "TRAECN_PORT": "8788",
        "TRAECN_GATEWAY_TOKEN": "",
        "TRAECN_MCP_TOOL_PROFILE": "public"
      }
    }
  }
}
```

Alternatively, point directly at `mcp-server.js`:

```json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/absolute/path/to/TRAECNclaw/mcp-server.js"],
      "env": {
        "TRAECN_HOST": "127.0.0.1",
        "TRAECN_PORT": "8788",
        "TRAECN_GATEWAY_TOKEN": "",
        "TRAECN_MCP_TOOL_PROFILE": "public"
      }
    }
  }
}
```

A ready-to-copy single-entry launcher template is at
`skills/traecnclaw-mcp/assets/mcp-client-config.json`; the direct fallback is
kept separately at `skills/traecnclaw-mcp/assets/mcp-client-config.direct.json`.

The MCP server exposes a profile-scoped tool surface. By default,
`TRAECN_MCP_TOOL_PROFILE=public` lists the 23 common tools:
`traecn_preflight`, `traecn_run_task`, `traecn_queue_task`,
`traecn_poll_task`, `traecn_list_task_events`, `traecn_ack_task_event`,
`traecn_resolve_task_review`, `traecn_review_code`, settings/dialog/model controls,
`traecn_run_unattended_workflow`, and the generic `traecn_run_command` catalog
for full command coverage. Use `TRAECN_MCP_TOOL_PROFILE=ops` for recovery,
cleanup, Solo conversation control, and long-queue proof tools; use `full` for
compatibility audits and every explicit shortcut.

When TraeCN is already running, `traecn_open_project` reuses the active window
by default through TraeCN's bundled CLI, reconnects CDP, and verifies the exact
workspace path before returning success. Pass
`{"projectPath":"/absolute/project/path","newInstance":true}` only when a
separate window is wanted. If the requested project is already open, the
gateway returns immediately without reloading the window.

### Agent Skill Distribution

The portable cross-agent skill lives at `skills/traecnclaw-mcp`. It
teaches agents how to configure the stdio MCP server, choose the right profile,
and prefer MCP tools over GUI control.

Install the skill globally for Codex-compatible clients:

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/traecnclaw-mcp "${CODEX_HOME:-$HOME/.codex}/skills/"
```

Build release artifacts for direct download:

```sh
npm run pack:skill
```

This writes `dist/traecnclaw-mcp-skill.tgz`, a zip artifact when `zip` is
available, and `dist/traecnclaw-mcp-release.json` with checksums. See
[Distribution](docs/DISTRIBUTION.md) for catalog submission fields.

### Layered Architecture

TraeCNSkill uses a layered architecture for selective loading and minimal context:

- **Basic Layer** (90% scenarios): core functions including `runTask`, `switchModel`, `checkStatus`, `queueTask`, `pollTask`, `waitTask`, `reviewCode`, `preflight`
- **Review Layer**: structured code review prompts through `reviewCode`
- **Advanced Layer**: Project management, mode switching, Solo chat control
- **Config Layer**: Settings management
- **Dialog Layer**: Dialog handling
- **Batch Layer**: Batch operations

### Documentation

Complete skill documentation:

- [MCP Server Guide](docs/MCP-SERVER-GUIDE.md)
- [OpenClaw Command Set](docs/openclaw-command-set.md)
- [Structured Prompt Mechanism](docs/structured-prompt-mechanism.md)

## API

The OpenAPI schema is served at `/openapi.json` (requires the same auth token as other authenticated endpoints). Primary endpoints:

- `GET /api/capabilities`
- `GET /api/status`
- `POST /api/preflight`
- `POST /api/sessions`
- `POST /api/sessions/{sessionId}/delegate`
- `POST /api/delegate`
- `POST /api/delegate-async`
- `POST /api/task/{taskId}/review`
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

Agents should call `GET /api/capabilities` or MCP `traecn_get_capabilities` first for a compact command, endpoint, token strategy, model, settings, and confirmation catalog. Before side-effecting operations, call `POST /api/preflight` or MCP `traecn_preflight` once to combine status, current `surface` (`setup` vs `workspace`), readiness, queue, dialog, and optional command-plan state. For a dry confirmation-only check, call `POST /api/confirm/plan` or MCP `traecn_plan_operation`. Fetch `/openapi.json` only when full request/response schemas are needed.

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
The stdio server also long-polls a durable, per-client task-event inbox after
MCP initialization and emits compact standard `notifications/message` events.
Set a stable, unique `TRAECN_MCP_CLIENT_ID` for each IDE connection when the
derived MCP client name is not unique. Events are acknowledged only after the
stdio write succeeds, survive gateway restarts, and contain only status plus a
short summary; fetch the full result with `traecn_poll_task`. An IDE that does
not display MCP logging notifications can call `traecn_list_task_events` and
`traecn_ack_task_event` explicitly. Injection into a particular chat remains
an IDE-adapter capability, not something the gateway can guarantee.
Each submitted Solo task is rebound by task-specific visible text rather than
by its transient sidebar index. If that identity cannot be found, collection
waits instead of reading another conversation. Progress labels below 100%, such
as `任务完成 16%`, remain non-terminal.

When TraeCN pauses on an inline command card, call
`traecn_get_dialog_status` and inspect `type`, `question`, and `buttons`.
`{"action":"auto"}` uses a local classifier and consumes no model tokens:
read-only command chains are approved immediately. Write, network, privilege,
process-control, and unknown commands return `approvalDecision:"agent_review"`
with `commandRisk`, `riskReasons`, and the command for compact calling-agent
review; the gateway does not request human confirmation. After approval,
`traecn_respond_dialog` with `{"action":"approve"}` maps to the visible
`运行` button.

For a single local process that waits quietly until completion, use MCP
`traecn_wait_task`, OpenClaw `traecn_delegate`, or the CLI. Add `--detach` when the wait should continue under a
local `screen` session after the calling agent releases context:

```sh
traecnclaw wait task_123 --poll-ms 30000 --timeout-ms 0 --log queue-evidence.jsonl --quiet -o json
traecnclaw wait task_123 --detach --log queue-evidence.jsonl
```

By default, external TraeCN model queues do not expire locally; set
`maxQueueWaitMs` (or `queueMaxWaitMs`) only when a caller explicitly wants a
queue timeout.

For the guarded GLM-5.2 acceptance proof, agents can use the same control flow
through MCP/OpenClaw commands or the CLI:

```sh
traecnclaw proof status
traecnclaw proof start --marker TRAECN_GLM52_CLEAN_1
traecnclaw proof start --execute --detach --allow-quota-spend --marker TRAECN_GLM52_CLEAN_1
traecnclaw proof cancel --marker TRAECN_GLM52_CLEAN_1
```

`proof status` only reads local proof files and detached watcher state.
`proof start` is a dry-run unless `--execute` is passed, and new real TraeCN
submissions still require `--allow-quota-spend`; use the dry-run first to verify
cleanup, preflight readiness, evidence paths, and that no local task is active
before a quota-consuming TraeCN submission.

Use `traecnclaw cleanup-queue --status --json`, MCP
`traecn_get_cleanup_watch_status`, or OpenClaw `traecn_cleanup_watch_status` to
inspect the local queue-probe cleanup watcher without touching TraeCN. The
watcher is singleton-locked, so repeat detached starts return
`alreadyRunning: true` instead of creating extra background cleanup processes.

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
npm run check:skill-contracts
npm run test:mcp-stdio-smoke
npm test
npm run test:system
npm run test:uat
npm run test:live
npm run test:all
npm run audit:prod
```

`npm run check:skill-contracts` verifies that generated MCP schemas, validated
examples, and single-entry client templates match the live server.
`npm run test:mcp-stdio-smoke` runs the standalone Content-Length
`initialize`/`tools/list` protocol check without requiring the gateway.
`npm test` runs unit and integration tests, including that smoke test and the
skill launcher checks. Default CI uses mock and local test
surfaces and never spends TraeCN quota. `test:system` starts the gateway in mock
mode and verifies the HTTP flow. `test:uat` verifies documentation, OpenAPI
coverage, and the machine-readable acceptance audit required for release
acceptance. `npm run acceptance:audit` prints the current
requirement-by-requirement status; add `-- --require-complete` before declaring
the full unattended TraeCN goal complete. Use `npm run test:all` for the
release-style lint, test, system, UAT, and coverage sequence.
`test:live` runs safe real Trae CN/CDP smoke checks when a live remote-debugging endpoint is available; otherwise it reports `SKIP` and exits successfully. Use `node scripts/live-uat.js --strict` when a live desktop instance is required, `--require-ready` when the UI must be logged in and automation-ready, and `--cleanup-queue-probes` when accidental `wait for Trae queue` Solo chats should be stopped, deleted, and rechecked to `matched: 0`. `--strict` fails if those queue-probe chats remain. Add `--delegate` only when sending a real test prompt is acceptable. `--delegate` is readiness-gated and fails with diagnostics instead of sending a prompt to an unready UI.
`npm run proof:long-queue` is the guarded GLM-5.2 proof runner. It defaults to dry-run, verifies preflight readiness, refuses to start when queue-probe Solo chats or local tasks remain, and prints the exact evidence paths. Add `-- --execute --detach --allow-quota-spend` only when a real long-queue TraeCN submission is explicitly approved; execute mode automatically stops/deletes accidental queue-probe Solo chats and requires consecutive clean dry-runs before submitting. Tune that gate with `-- --cleanup-stabilize-checks <n> --cleanup-stabilize-delay-ms <ms> --cleanup-max-attempts <n>`. Re-running with the same marker resumes the existing task from the evidence log instead of submitting again; add `-- --force-new` only when an intentional new submission is acceptable. Use `npm run proof:status`, MCP `traecn_get_long_queue_proof_status`, OpenClaw `traecn_long_queue_proof_status`, CLI `traecnclaw proof status`, or `npm run proof:cancel -- --marker <id>` to inspect or stop detached proof runs without creating another TraeCN conversation.

## Security

Bind the gateway to `127.0.0.1`, set `TRAECN_GATEWAY_TOKEN` before exposing protected endpoints to browser or tool clients, and configure `TRAECN_ALLOWED_ORIGINS` when using the chat UI from a browser origin other than the gateway. Set `TRAECN_ENFORCE_OPERATION_CONFIRMATION=1` in production to require a matching confirmation plan ID for high-risk settings and dialog operations. Logs redact common sensitive keys such as tokens, passwords, secrets, credentials, and authorization values.

## Distribution

All release surfaces share the version in `package.json`. Run
`npm run check:versions` before release. Pushing a matching `v*` tag runs
lint, unit/integration tests, the mock system test, packages the Skill and npm
tarball, generates `SHA256SUMS`, and creates a GitHub Release. Quota-consuming
live acceptance is intentionally excluded.

Before public distribution, make the repository or release artifact public,
verify the skill with `quick_validate.py`, run the maintained test suite, and
scan the current tree and git history for secrets. Public catalog submissions
should point to `skills/traecnclaw-mcp` for the skill and `mcp-server.js`
or `traecnclaw-mcp` for the server entrypoint.

## Documentation

- [Compatibility Matrix](docs/COMPATIBILITY.md)
- [Development Guide](docs/development.md)
- [Deployment Guide](docs/deployment.md)
- [Distribution Guide](docs/DISTRIBUTION.md)
- [MCP Server Guide](docs/MCP-SERVER-GUIDE.md)
- [OpenClaw MCP Setup Guide](docs/OPENCLAW-MCP-SETUP.md)
- [OpenClaw Command Set](docs/openclaw-command-set.md)
- [Structured Prompt Mechanism](docs/structured-prompt-mechanism.md)
- [First Login Runbook](docs/FIRST-LOGIN-RUNBOOK.md)
- [Real DOM Findings](docs/REAL-DOM-FINDINGS.md)

## Maintainers

Repository maintainers for `Luckycat133/TRAECNclaw`.

## License

MIT
