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
- TraeCN started with remote debugging on the canonical port `9222`
- OpenClaw when using the plugin in `integrations/openclaw-traecn-plugin`

## Installation

```sh
npm install
cp .env.example .env
```

Edit `.env` for your TraeCN installation path, CDP port, gateway token, and selectors if TraeCN DOM discovery reports custom values.

Upgrading from 0.3.x: read [the 0.5.0 migration guide](docs/MIGRATING-TO-0.5.md)
before replacing MCP configuration.

## Configuration

These defaults are generated from `src/config/runtime-schema.js`; `.env.example`,
the configuration API, doctor, and runtime consumers use the same source.

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
| `TRAECN_ENABLE_MOCK_BRIDGE` | `0` | Use the mock bridge for tests that do not require a live TraeCN instance. |
<!-- END GENERATED: runtime defaults -->

`TRAECN_ALLOWED_ORIGINS`, `TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH`, and
`TRAECN_*_SELECTORS` remain optional advanced settings; see `.env.example`.

## Usage

Check the existing TraeCN/CDP session, then start the gateway:

```sh
npm run quickstart
```

`quickstart` does not launch TraeCN by default. Launch it explicitly first, or
opt in for this invocation:

```sh
npm run start:traecn
npm run quickstart -- --launch-trae
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
TRAECN_ENABLE_MOCK_BRIDGE=0 TRAECN_REMOTE_DEBUGGING_PORT=9222 TRAECN_QUICKSTART_PROFILE_MODE=existing npm run service:start
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
        "TRAECN_GATEWAY_HOST": "127.0.0.1",
        "TRAECN_GATEWAY_PORT": "8788",
        "TRAECN_GATEWAY_TOKEN": ""
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
        "TRAECN_GATEWAY_HOST": "127.0.0.1",
        "TRAECN_GATEWAY_PORT": "8788",
        "TRAECN_GATEWAY_TOKEN": ""
      }
    }
  }
}
```

A ready-to-copy single-entry launcher template is at
`skills/traecnclaw-mcp/assets/mcp-client-config.json`; the direct fallback is
kept separately at `skills/traecnclaw-mcp/assets/mcp-client-config.direct.json`.

The MCP server exposes 20 focused tools grouped by intent:

- Work: `traecn_send_message`, `traecn_get_task`, `traecn_cancel_task`,
  `traecn_stop_generation`
- Context: `traecn_open_workspace`, `traecn_list_models`,
  `traecn_select_model`, `traecn_select_mode`
- Settings: list UI sections and settings, list dropdown choices, then use one
  dedicated toggle, option, or text mutation tool
- Conversations: `traecn_list_conversations`, `traecn_create_conversation`,
  `traecn_select_conversation`, `traecn_delete_conversation`
- Exceptional interactions: `traecn_answer_question`,
  `traecn_decide_approval`

`traecn_send_message` accepts only the message and an optional stable
conversation ID. Workspace, model, mode, and conversation changes are explicit
single-purpose operations. The gateway still owns queues, persistence,
recovery, routine approvals, file-review gates, and completion notifications.
Settings commands operate Trae's visible UI and return to chat automatically.

### Agent Skill Distribution

The portable cross-agent skill lives at `skills/traecnclaw-mcp`. It
teaches agents how to use the focused server while leaving execution mechanics
to the gateway.

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
- `POST /api/tasks/submit`
- `GET /api/conversations`
- `POST /api/conversations/manage`
- `POST /api/interactions/resolve`
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

MCP agents call focused context tools only when a requested selection must
change, then use `traecn_send_message`. The gateway performs readiness, queue,
recovery, waiting, notification, and routine approval work internally.
Operator integrations can still inspect `GET /api/capabilities`,
`POST /api/preflight`, or `/openapi.json` when diagnosing the gateway itself.

For unattended local waiting on macOS, start the gateway as a LaunchAgent:

```sh
npm run service:start
npm run service:status
```

Every MCP message is gateway-managed. The Agent releases its context after
receiving `taskId`; the gateway persists the task, maintains the queue, restores
interrupted work, and sends completion notifications.
The stdio server long-polls a durable, per-client task-event inbox after
MCP initialization and emits compact standard `notifications/message` events.
Set a stable, unique `TRAECN_MCP_CLIENT_ID` for each IDE connection when the
derived MCP client name is not unique. Events are acknowledged only after the
stdio write succeeds, survive gateway restarts, and contain only status plus a
short summary; fetch the full result with `traecn_get_task` only when needed.
Event cursors and acknowledgements are internal and never consume Agent tool
calls. Injection into a particular chat remains an IDE-adapter capability.
Each submitted Solo task is rebound by task-specific visible text rather than
by its transient sidebar index. If that identity cannot be found, collection
waits instead of reading another conversation. Progress labels below 100%, such
as `任务完成 16%`, remain non-terminal.

Inline command cards are approved without model tokens only when every shell
segment matches the strict read-only allowlist. Redirection, substitution,
network/process/package commands, project scripts, mutating find/sed, and
external ripgrep/Git hooks are rejected from automatic approval. Unsafe or
unknown cards surface through `traecn_decide_approval`, which revalidates the
exact visible command and requires a risk acknowledgement plus audit reason.
TraeCN file-review gates keep changes by default and revert only on clear fatal
automation failures.

`traecn_stop_generation` is scoped to the supplied active Solo conversation
and requires an untracked-work acknowledgement and audit reason. Permanent
conversation deletion is limited to an inactive exact-title match and has no
gateway recovery path. These actions and automatic command approvals are
written to the local append-only audit log, enabled by default with sensitive
field redaction and 30-day retention.

The CLI retains detached wait and proof commands for maintainers and acceptance
testing; these are not MCP Agent tools:

```sh
traecnclaw wait task_123 --poll-ms 30000 --timeout-ms 0 --log queue-evidence.jsonl --quiet -o json
traecnclaw wait task_123 --detach --log queue-evidence.jsonl
```

By default, external TraeCN model queues do not expire locally; set
`maxQueueWaitMs` (or `queueMaxWaitMs`) only when a caller explicitly wants a
queue timeout.

For the guarded GLM-5.2 acceptance proof, use the CLI:

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

Use `traecnclaw cleanup-queue --status --json` or OpenClaw
`traecn_cleanup_watch_status` to
inspect the local queue-probe cleanup watcher without touching TraeCN. The
watcher is singleton-locked, so repeat detached starts return
`alreadyRunning: true` instead of creating extra background cleanup processes.

## Testing

```sh
npm run verify
npm run contract:audit -- --no-live
npm run test:live
npm run audit:prod
```

`npm run verify` is the default CI and local release gate. It checks versions,
generated configuration and Skill contracts, the public-release scan, syntax,
ESLint, unit/integration behavior, mock HTTP system behavior, UAT inventories,
and coverage. It never spends TraeCN quota.

`npm run contract:audit` inventories contract declarations and already-recorded
evidence. It does not execute the behaviors it lists, so a passing contract
audit is not a substitute for `npm test`, `test:system`, or Live UAT.
`acceptance:audit` remains a compatibility alias. Use `--require-complete` only
to require every existing evidence item; it still does not create Live
evidence.

`test:live` runs safe real Trae CN/CDP smoke checks when a live remote-debugging endpoint is available; otherwise it reports `SKIP` and exits successfully. Use `node scripts/live-uat.js --strict` when a live desktop instance is required, `--require-ready` when the UI must be logged in and automation-ready, and `--cleanup-queue-probes` when accidental `wait for Trae queue` Solo chats should be stopped, deleted, and rechecked to `matched: 0`. `--strict` fails if those queue-probe chats remain. Add `--delegate` only when sending a real test prompt is acceptable. `--delegate` is readiness-gated and fails with diagnostics instead of sending a prompt to an unready UI.
`npm run proof:long-queue` is the guarded GLM-5.2 proof runner. It defaults to dry-run, verifies readiness, refuses to start when queue-probe Solo chats or local tasks remain, and prints the exact evidence paths. Add `-- --execute --detach --allow-quota-spend` only when a real long-queue TraeCN submission is explicitly approved. Re-running with the same marker resumes its evidence instead of submitting again. Use `npm run proof:status`, OpenClaw `traecn_long_queue_proof_status`, CLI `traecnclaw proof status`, or `npm run proof:cancel -- --marker <id>` to inspect or stop proof runs. Proof commands remain operator/test facilities, not MCP tools.

## Security

Bind the gateway to `127.0.0.1`, set `TRAECN_GATEWAY_TOKEN` before exposing protected endpoints to browser or tool clients, and configure `TRAECN_ALLOWED_ORIGINS` when using the chat UI from a browser origin other than the gateway. Set `TRAECN_ENFORCE_OPERATION_CONFIRMATION=1` in production to require a matching confirmation plan ID for high-risk settings and dialog operations. Logs redact common sensitive keys such as tokens, passwords, secrets, credentials, and authorization values.

## Distribution

All release surfaces share the version in `package.json`. Run
`npm run version:patch` for the default compatible release, or deliberately
choose `version:minor`/`version:major`; these commands update `package.json`
without creating a tag and synchronize every distribution surface. Run
`npm run verify` before release. While the project is below `1.0.0`, use patch increments
(`0.4.0` → `0.4.1`) for compatible fixes and additive automation, minor
increments only for a deliberately larger compatibility milestone, and major
increments only for an explicitly documented breaking contract. The checked-in
Verify workflow runs the same non-quota gate on pushes and pull requests.
Tagging, artifact upload, npm publication, marketplace submission, and GitHub
Release creation remain explicit maintainer actions; the repository does not
claim they happened merely because a version was changed.

Before public distribution, make the repository or release artifact public,
run `npm run verify`, synchronize the public mirror to the exact tagged commit,
and scan git history for secrets. Public catalog submissions
should point to `skills/traecnclaw-mcp` for the skill and `mcp-server.js`
or `traecnclaw-mcp` for the server entrypoint.

## Documentation

- [Compatibility Matrix](docs/COMPATIBILITY.md)
- [0.5.0 Migration Guide](docs/MIGRATING-TO-0.5.md)
- [Runtime Configuration](docs/configuration.md)
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
