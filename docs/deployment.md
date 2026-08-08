# TRAECNclaw Deployment Guide

## Deployment Model

TRAECNclaw is designed as a local desktop companion service. It should run on the same machine as TraeCN and bind to `127.0.0.1` unless a controlled network deployment has been reviewed.

## Production Configuration

Use these settings for a local production profile:

```env
TRAECN_GATEWAY_HOST=127.0.0.1
TRAECN_GATEWAY_PORT=8788
TRAECN_GATEWAY_TOKEN=<generate-a-random-token>
TRAECN_ALLOWED_ORIGINS=http://127.0.0.1:8788
TRAECN_ENABLE_DEBUG_ENDPOINTS=0
TRAECN_ENABLE_MOCK_BRIDGE=0
TRAECN_REMOTE_DEBUGGING_PORT=9222
TRAECN_TERMINAL_IDEMPOTENCY_TTL_MS=86400000
```

Set selector overrides only after validating them with `npm run inspect:traecn`.

## Startup

Install dependencies:

```sh
npm ci --omit=dev
```

Start the gateway:

```sh
npm start
```

For the primary Agent path, validate the matching MCP server and generate the
host entry before reconnecting the host:

```sh
npm run --silent setup:mcp
```

For macOS and Windows desktop convenience, use `start-traecnapi.command` or `start-traecnapi.cmd` after reviewing the `.env` file.

For unattended local queue waiting on macOS, prefer the LaunchAgent wrapper so the
gateway survives the current terminal session:

```sh
npm run service:start
npm run service:status
```

This installs a user LaunchAgent at `~/Library/LaunchAgents/com.traecnclaw.gateway.plist`
and writes logs under `~/Library/Logs/TRAECNclaw/`. Stop it with:

```sh
npm run service:stop
```

The LaunchAgent path is also the recommended production path for async queue work because it now:

- reloads persisted active tasks from `~/Library/Application Support/TRAECNclaw/active-queue.json`
- retains fingerprinted terminal idempotency responses in the same checksummed
  TaskStore for 24 hours by default, preventing duplicate work after uncertain
  retries and gateway restarts
- avoids opening a fresh unauthenticated Trae profile by default
  (`TRAECN_QUICKSTART_PROFILE_MODE=existing`,
  `TRAECN_TRAE_RECOVERY_NEW_INSTANCE=0`)
- auto-relaunches Trae CN when CDP disappears if `TRAECN_AUTO_START_TRAE=1` and
  Trae is not already running
- exposes `POST /api/trae/restart-debug` for confirmed recovery when Trae is
  already running without CDP; this reuses the existing logged-in profile instead
  of creating an isolated profile
- lets external TraeCN model queues wait indefinitely by default; set
  `TRAECN_QUEUE_MAX_WAIT_MS` only when you want a local queue timeout

## Verification

Before release or local rollout, run:

```sh
npm run lint
npm test
npm run test:system
npm run test:uat
npm run audit:prod
npm run audit:all
```

`audit:prod` reports the shipped runtime dependency view. `audit:all` also
checks development tooling and is enforced by `npm run test:release` for a
public release.

Then verify with live TraeCN:

1. Start TraeCN with the configured remote debugging port.
2. Run `npm run inspect:traecn`.
3. Call `GET /api/status`.
4. Run `npm run --silent setup:mcp`, merge the entry into the intended host,
   and reconnect it.
5. Confirm the host discovers exactly 20 tools, then send one short task only
   when model quota and UI effects are acceptable.
6. Confirm a fresh `TRAECN_MCP_CLIENT_ID` does not receive retained historical
   task notifications, while its cursor is durably established for later
   reconnects.

## Security Controls

- Bind to `127.0.0.1` by default.
- Use `TRAECN_GATEWAY_TOKEN` for all protected endpoints.
- Restrict `TRAECN_ALLOWED_ORIGINS` instead of using `*` when browser clients are involved.
- Keep `TRAECN_ENABLE_DEBUG_ENDPOINTS=0` outside local diagnostics.
- Store `.env` outside version control and rotate tokens after sharing logs or screenshots.

## Logging and Operations

Gateway errors are returned as JSON and sensitive log keys are redacted. Check terminal output for startup errors, CDP connection failures, selector failures, queue polling errors, and forced shutdown notices.

When using `delegate-async`:

- `waitForQueue=true` means the gateway keeps the task in its own local background
  queue while TraeCN is visibly queued or busy. This is the preferred mode for
  unattended waiting.
- `waitForQueue=false` means the caller keeps ownership of the wait and receives
  immediate queue/running feedback instead of background persistence.
- `fallbackModels=[...]` or `autoModelFallback=true` lets the gateway actively
  probe alternate TraeCN models while the task waits. Probe results are persisted
  on the task as `modelProbeResults` with `lastModelProbeAt` and
  `nextModelProbeAt`, so callers can inspect progress without resending task
  context.
- `reviewRequired=true` with `autoContinue=false` stops the workflow at a
  gateway task checkpoint so a user can audit the result and explicitly
  continue via `traecn_resolve_task_review` (or the HTTP task-review route).

## Rollback

Stop the gateway, restore the previous repository revision, run `npm ci --omit=dev`, and restart with the previous `.env`. If selector changes caused the issue, remove selector overrides and rerun `npm run inspect:traecn`.

---

## Cloud Deployment (Render / Railway)

TRAECNclaw can be deployed to cloud platforms like **Render** or **Railway**. Since the core function relies on CDP (Chrome DevTools Protocol) to control a local Trae instance, cloud deployment requires additional network configuration to bridge the CDP connection.

> **Note**: The repository does not ship a `render.yaml` or `railway.json`
> blueprint. The instructions below describe the manual setup; create the
> blueprint file in your fork if you want one-click deploys.

### Architecture Overview

```
┌─────────────────┐         ┌──────────────────┐         ┌─────────────┐
│   Cloud Host    │  HTTP   │  Local Machine   │   CDP   │   Trae CN   │
│  (Render/Railway)│◄───────►│  (Tunnel/Proxy)  │◄────────►│  (Desktop)  │
│   traecnclaw    │         │  ngrok/localtunnel│        │             │
└─────────────────┘         └──────────────────┘         └─────────────┘
```

**Key Point**: The gateway runs in the cloud, but CDP must connect back to your local machine where Trae is running.

### Prerequisites

1. A local Trae instance running with remote debugging enabled:
   ```sh
   trae-cn --remote-debugging-port=9222
   ```
2. A tunnel service exposing your local port to the internet:
   ```sh
   npx localtunnel --port 9222
   # or
   ngrok http 9222
   ```

### Render Deployment

1. Fork or push this repository to GitHub.
2. In Render Dashboard, click **New +** → **Web Service**.
3. Connect your GitHub repository.
4. Set the build command to `npm ci --omit=dev` and the start command to `npm start`.
5. Set the following environment variables in Render Dashboard:
   - `TRAECN_GATEWAY_HOST`: `0.0.0.0`
   - `TRAECN_CDP_HOST`: Your tunnel URL (e.g., `https://abc123.loca.lt`)
   - `TRAECN_REMOTE_DEBUGGING_PORT`: `80` or `443` (depending on tunnel)
   - `TRAECN_GATEWAY_TOKEN`: A secure random token (required for a non-loopback bind)
6. Deploy and verify with `GET https://<your-service>.onrender.com/api/status`.

### Railway Deployment

1. Fork or push this repository to GitHub.
2. In Railway Dashboard, click **New Project** → **Deploy from GitHub repo**.
3. Select your repository.
4. Set environment variables in Railway Dashboard → Variables:
   - `TRAECN_GATEWAY_HOST`: `0.0.0.0`
   - `TRAECN_CDP_HOST`: Your tunnel URL
   - `TRAECN_REMOTE_DEBUGGING_PORT`: Tunnel port
   - `TRAECN_GATEWAY_TOKEN`: Secure random token
5. Deploy and verify health checks pass.

### Cloud Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `TRAECN_GATEWAY_HOST` | Yes | Set to `0.0.0.0` to accept external connections |
| `TRAECN_GATEWAY_PORT` / platform `PORT` | Yes | Gateway port; Render/Railway may inject the compatibility alias `PORT` |
| `TRAECN_GATEWAY_TOKEN` | Yes | Authentication token; startup fails closed without one on a non-loopback bind |
| `TRAECN_ALLOWED_ORIGINS` | No | CORS origins. Use `*` for development only |
| `TRAECN_CDP_HOST` | Yes (cloud) | Tunnel URL pointing to your local Trae CDP port |
| `TRAECN_REMOTE_DEBUGGING_PORT` | Yes (cloud) | Port of the tunnel (usually 80 or 443) |
| `TRAECN_ENABLE_MOCK_BRIDGE` | No | Set to `1` to run without a real Trae connection |

### Security Notes for Cloud

- **Never** expose your local Trae port directly to the internet. Always use a tunnel with authentication.
- Always set `TRAECN_GATEWAY_TOKEN` in production.
- Restrict `TRAECN_ALLOWED_ORIGINS` to your frontend domain.
- The `/api/status` endpoint is public (no auth required) for health checks.
- Enable HTTPS on your tunnel endpoint to encrypt CDP traffic.

### Mock Bridge Mode (No Trae Required)

For testing the gateway without a live Trae instance:

```env
TRAECN_ENABLE_MOCK_BRIDGE=1
```

This returns simulated responses for all CDP operations, useful for CI/CD or frontend development.
