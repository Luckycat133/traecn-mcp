# TRAECNclaw Deployment Guide

## Deployment Model

TRAECNclaw is designed as a local desktop companion service. It should run on the same machine as TraeCN and bind to `127.0.0.1` unless a controlled network deployment has been reviewed.

## Production Configuration

Use these settings for a local production profile:

```env
HOST=127.0.0.1
PORT=8788
TRAECN_GATEWAY_TOKEN=<generate-a-random-token>
TRAECN_ALLOWED_ORIGINS=http://127.0.0.1:8788
TRAECN_ENABLE_DEBUG_ENDPOINTS=0
TRAECN_ENABLE_MOCK_BRIDGE=0
TRAECN_REMOTE_DEBUGGING_PORT=9222
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
```

Then verify with live TraeCN:

1. Start TraeCN with the configured remote debugging port.
2. Run `npm run inspect:traecn`.
3. Call `GET /api/status`.
4. Create a session with `POST /api/sessions`.
5. Delegate a short task with `POST /api/sessions/{sessionId}/delegate`.

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
- `reviewRequired=true` stops the workflow at the review gate so a user can audit
  the result and explicitly continue any follow-up tasks.

## Rollback

Stop the gateway, restore the previous repository revision, run `npm ci --omit=dev`, and restart with the previous `.env`. If selector changes caused the issue, remove selector overrides and rerun `npm run inspect:traecn`.

---

## Cloud Deployment (Render / Railway)

TRAECNclaw can be deployed to cloud platforms like **Render** or **Railway**. Since the core function relies on CDP (Chrome DevTools Protocol) to control a local Trae instance, cloud deployment requires additional network configuration to bridge the CDP connection.

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
2. In Render Dashboard, click **New +** → **Blueprint**.
3. Connect your GitHub repository.
4. Render will auto-detect `render.yaml` and configure the service.
5. Set the following environment variables in Render Dashboard:
   - `TRAECN_CDP_HOST`: Your tunnel URL (e.g., `https://abc123.loca.lt`)
   - `TRAECN_REMOTE_DEBUGGING_PORT`: `80` or `443` (depending on tunnel)
   - `TRAECN_GATEWAY_TOKEN`: A secure random token (auto-generated if not set)
6. Deploy and verify with `GET https://<your-service>.onrender.com/api/status`.

**Configuration**: See [`render.yaml`](../render.yaml)

### Railway Deployment

1. Fork or push this repository to GitHub.
2. In Railway Dashboard, click **New Project** → **Deploy from GitHub repo**.
3. Select your repository. Railway auto-detects `railway.json`.
4. Set environment variables in Railway Dashboard → Variables:
   - `TRAECN_CDP_HOST`: Your tunnel URL
   - `TRAECN_REMOTE_DEBUGGING_PORT`: Tunnel port
   - `TRAECN_GATEWAY_TOKEN`: Secure random token
5. Deploy and verify health checks pass.

**Configuration**: See [`railway.json`](../railway.json)

### Cloud Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HOST` | Yes | Set to `0.0.0.0` to accept external connections |
| `PORT` | Yes | Render/Railway provide this dynamically |
| `TRAECN_GATEWAY_TOKEN` | Recommended | Authentication token. Leave empty to disable auth (not recommended for production) |
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
