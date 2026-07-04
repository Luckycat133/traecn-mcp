# Repository Guidelines

## Project Structure & Module Organization

TRAECNclaw is a Node.js 22 CommonJS project for a TraeCN automation gateway, MCP server, and OpenClaw integration. Core code lives in `src/`: `config` handles environment setup, `cdp` owns CDP/DOM drivers, `http` implements the REST gateway, `shared` holds utilities, and `skill` exposes the API. OpenClaw plugin code is in `integrations/openclaw-traecn-plugin`. Scripts live in `scripts`, docs in `docs`, and skill notes in `skills`. Do not commit local output such as `audit-logs`, `demo-output`, `logs`, `.env`, or `node_modules`.

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npm run start:gateway`: start only the local HTTP gateway.
- `TRAECN_ENABLE_MOCK_BRIDGE=1 npm run start:gateway`: run gateway work without a live TraeCN instance.
- `npm run mcp`: start the stdio MCP server from `mcp-server.js`.
- `npm run doctor`: check Node, npm, `.env`, gateway, CDP, and TraeCN.
- `npm run lint`: run `node --check` against key files.
- `npm run lint:eslint`: run ESLint v9.
- `npm test`: run the maintained in-repo test sequence.
- `npm run acceptance:audit -- --require-complete`: fail unless unattended workflow evidence is complete.

## Coding Style & Naming Conventions

Use CommonJS (`require`, `module.exports`) and keep `'use strict';` in JavaScript files. Follow existing two-space indentation and semicolon style; run `npm run format:check` or `npm run format` when touching broad files. Prefer descriptive kebab-case file names such as `task-queue-service.js`; tests use the matching `*.test.js` suffix. Read environment values through helpers such as `getEnvWithFallback` and `parsePositiveInt`.

## Testing Guidelines

Tests are plain Node scripts using `assert` and `src/shared/test-runner.js`, not an external framework. Place focused tests next to the module they cover, for example `src/http/route-table.test.js`. Add route or OpenAPI coverage for gateway changes, plugin client tests for OpenClaw-facing changes, and mock-mode tests when live TraeCN is not required. Use `npm run test:all` before release-style changes.

## Commit & Pull Request Guidelines

Git history uses concise Conventional Commit-style subjects: `fix(http): ...`, `feat(cdp): ...`, `refactor(gateway): ...`, and `docs(...): ...`. Keep commits scoped and mention the subsystem. Pull requests should include a behavior summary, verification commands, issue or task context, and screenshots only for visible chat UI changes. Update `README.md`, `docs/`, and `CHANGELOG.md` when installation, configuration, API behavior, or workflows change.

## Security & Configuration Tips

Never commit `.env`, tokens, authorization headers, passwords, or raw TraeCN profile data. Keep the gateway bound to `127.0.0.1` unless remote access is required. When logging or returning errors, use existing sanitization helpers.
