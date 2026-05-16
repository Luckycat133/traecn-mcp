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
- TraeCN started with a remote debugging port, usually `--remote-debugging-port=9222`
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
- `TRAECN_ENABLE_MOCK_BRIDGE`: set to `1` for local system tests without TraeCN.
- `TRAECN_*_SELECTORS`: optional DOM selector overrides discovered with `npm run inspect:traecn`.

## Usage

Start TraeCN and the gateway:

```sh
npm run quickstart
```

Start only the gateway:

```sh
npm run start:gateway
```

Open the built-in chat UI at:

```text
http://127.0.0.1:8788/
```

Export the OpenAPI document:

```sh
node scripts/export-openapi.js
```

## Skill Module

### Quick Start

```javascript
const { runTask, switchModel } = require('traecnclaw');

await switchModel('glm');
const result = await runTask('分析项目代码');
```

### Layered Architecture

TraeCNSkill uses a 5-layer architecture for selective loading and minimal context:

- **Basic Layer** (90% scenarios): 5 core functions
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

## API

The OpenAPI schema is served at `/openapi.json`. Primary endpoints:

- `GET /api/status`
- `POST /api/sessions`
- `POST /api/sessions/{sessionId}/delegate`
- `POST /api/delegate`
- `POST /api/delegate-async`
- `POST /api/new-chat`
- `POST /api/switch-mode`
- `POST /api/switch-model`
- `GET /api/queue-status`
- `GET /api/settings/read`
- `POST /api/settings/set`

## Testing

```sh
npm run lint
npm test
npm run test:system
npm run test:uat
npm run audit:prod
```

`npm test` runs unit and integration tests. `test:system` starts the gateway in mock mode and verifies the HTTP flow. `test:uat` verifies documentation and OpenAPI coverage required for release acceptance.

## Security

Bind the gateway to `127.0.0.1`, set `TRAECN_GATEWAY_TOKEN` before exposing protected endpoints to browser or tool clients, and configure `TRAECN_ALLOWED_ORIGINS` when using the chat UI from a browser origin other than the gateway. Logs redact common sensitive keys such as tokens, passwords, secrets, credentials, and authorization values.

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
