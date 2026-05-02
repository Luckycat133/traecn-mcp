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

## Testing Strategy

- Unit tests cover small utilities, environment parsing, error classes, CDP client behavior, and mock driver behavior.
- Integration tests cover CDP discovery scoring, DOM driver configuration, gateway utility behavior, and plugin client requests.
- System tests start a real local gateway in mock mode and verify authentication, session creation, delegation, response headers, and route compatibility.
- UAT checks verify release documentation and OpenAPI endpoint coverage.

Recommended release gate:

```sh
npm run test:all
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
5. Update `README.md`, `docs/user-manual.md`, and `CHANGELOG.md` when user-visible behavior changes.

## DOM Selector Updates

Run:

```sh
npm run inspect:traecn
```

Copy stable selectors into `.env` using the `TRAECN_COMPOSER_SELECTORS`, `TRAECN_SEND_BUTTON_SELECTORS`, `TRAECN_RESPONSE_SELECTORS`, `TRAECN_NEW_CHAT_SELECTORS`, and `TRAECN_MODE_TAB_SELECTORS` variables. Prefer specific selectors before generic fallbacks.
