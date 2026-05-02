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

## Rollback

Stop the gateway, restore the previous repository revision, run `npm ci --omit=dev`, and restart with the previous `.env`. If selector changes caused the issue, remove selector overrides and rerun `npm run inspect:traecn`.
