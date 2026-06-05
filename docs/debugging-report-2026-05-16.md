# Debugging Report - 2026-05-16

## Scope

Followed the documented local development workflow:

- Installed dependencies with `npm install`.
- Started the gateway with `npm run start:gateway`.
- Exercised the full mock-mode HTTP gateway and built-in chat UI at `http://127.0.0.1:8788/`.
- Captured API responses, browser console output, browser page errors, and local network requests.
- Ran the release gate with `npm run test:all` and `npm run audit:prod`.

The local `.env` enables `TRAECN_ENABLE_MOCK_BRIDGE=1`, so this pass validates the complete local gateway workflow without requiring the TraeCN desktop application.

## Issues Found And Fixed

### `npm run start:gateway` crashed after startup

Steps to reproduce:

1. Run `npm run start:gateway`.
2. Observe the process fail after logging background polling startup.

Observed error:

```text
[TRAECNclaw] Failed to start gateway: server.address is not a function
```

Root cause:

`startGateway()` returns `{ server, gateway }`, but `scripts/start-gateway.js`, `scripts/quickstart.js`, `scripts/test-chat-ui.js`, and `scripts/system-test.js` still treated the return value as a raw `http.Server`.

Fix:

Updated those callers to destructure `{ server }`. Also loaded `.env` in helper scripts that start the gateway directly so documented environment configuration is honored.

Validation:

`npm run start:gateway` now starts the full gateway and serves the chat UI at `http://127.0.0.1:8788/`.

### Mock mode crashed for several feature endpoints

Steps to reproduce:

1. Start the gateway with `TRAECN_ENABLE_MOCK_BRIDGE=1`.
2. Request `/api/detect-mode`, `/api/switch-model`, `/api/settings/read`, `/api/settings/read-all`, `/api/settings/set`, `/api/settings/switch-tab`, or `/api/settings/back-to-chat`.

Observed error:

```text
Cannot read properties of null (reading 'send')
```

Root cause:

`MockDriver` inherited live DOM implementations for mode detection, model switching, and settings operations. Those implementations call CDP through `client.send`, but mock mode constructs the driver with `client = null`.

Fix:

Added mock implementations for:

- mode detection and switching
- model switching
- approval dialog status/actions
- settings tab navigation, read, read-all, set, and back-to-chat behavior

Validation:

The full local API probe returned no unexpected 5xx responses, and `scripts/system-test.js` now covers these endpoints.

### OpenAPI document did not match the implemented gateway

Steps to reproduce:

1. Inspect `/openapi.json`.
2. Compare it with the routes in `src/http/gateway.js`.

Observed behavior:

- `info.version` reported `0.2.0` while `package.json` is `0.3.0`.
- Several implemented routes were absent from the spec.
- `/api/settings/action` was documented but is not implemented by the gateway.

Root cause:

The OpenAPI generator had not been updated with newer gateway routes.

Fix:

The spec now uses `package.json` for its version, documents the broader runtime/config/mode/queue/task/batch/dialog route surface, adds aliases for `/api/settings`, and removes the unimplemented `/api/settings/action` route.

Validation:

`scripts/uat-checklist.js` now asserts key route coverage, verifies the version matches `package.json`, and ensures `/api/settings/action` is not documented.

## Browser UI Verification

Tested the built-in chat UI with Playwright:

- Loaded `/` successfully.
- Status panel showed `Mode: Mock`.
- Sent a task through the form.
- Observed network calls:
  - `GET /`
  - `GET /api/status`
  - `POST /api/sessions`
  - `POST /api/sessions/{sessionId}/delegate`
- Assistant message rendered `Mock response from TraeCN`.
- Browser console messages: none.
- Browser page errors: none.
- Mobile viewport overflow check at `390x844`: no horizontal overflow detected.

## Validation Commands

```sh
npm install
npm run start:gateway
npm run test:all
npm run audit:prod
```

Results:

- `npm install`: completed, 0 vulnerabilities.
- `npm run test:all`: passed.
- `npm run audit:prod`: passed, 0 vulnerabilities.
