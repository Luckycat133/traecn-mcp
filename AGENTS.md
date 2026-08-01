# Repository Guidelines

## Project Structure & Module Organization

TRAECNclaw is a Node.js 22 CommonJS project for a TraeCN automation gateway, MCP server, and OpenClaw integration. Core code lives in `src/`: `config` handles environment setup, `cdp` owns CDP/DOM drivers, `http` implements the REST gateway, `shared` holds utilities, and `skill` exposes the API. OpenClaw plugin code is in `integrations/openclaw-traecn-plugin`. Scripts live in `scripts`, docs in `docs`, and skill notes in `skills`. Do not commit local output such as `audit-logs`, `demo-output`, `logs`, `.env`, or `node_modules`.

## Repository Development Skill

For substantive repository development, debugging, refactoring, compatibility, packaging, CI, or release work, use `.codex/skills/traecnclaw-development/SKILL.md`. It records the current architecture, development priorities, focused playbooks, evidence standards, and settled 0.5.x work. Use `skills/traecnclaw-mcp` only for operating TraeCN through the public runtime MCP surface.

## Build, Test, and Development Commands

- `npm install`: install dependencies.
- `npm run start:gateway`: start only the local HTTP gateway.
- `TRAECN_ENABLE_MOCK_BRIDGE=1 npm run start:gateway`: run gateway work without a live TraeCN instance.
- `npm run mcp`: start the stdio MCP server from `mcp-server.js`.
- `npm run doctor`: check Node, npm, `.env`, gateway, CDP, and TraeCN.
- `npm run lint`: run `node --check` against key files.
- `npm run lint:eslint`: run ESLint.
- `npm test`: run the maintained in-repo test sequence.
- `npm run verify:static`: check versions, generated configuration, Skill contracts, and release scanning.
- `npm run contract:audit -- --no-live`: inspect contract and evidence inventory without claiming behavioral execution.
- `npm run verify`: run the default repository-wide CI and release gate.

## Coding Style & Naming Conventions

Use CommonJS (`require`, `module.exports`) and keep `'use strict';` in JavaScript files. Follow existing two-space indentation and semicolon style; run `npm run format:check` or `npm run format` when touching broad files. Prefer descriptive kebab-case file names such as `task-queue-service.js`; tests use the matching `*.test.js` suffix. Read environment values through helpers such as `getEnvWithFallback` and `parsePositiveInt`.

## Testing Guidelines

Tests are plain Node scripts using `assert` and `src/shared/test-runner.js`, not an external framework. Place focused tests next to the module they cover, for example `src/http/route-table.test.js`. Add route or OpenAPI coverage for gateway changes, plugin client tests for OpenClaw-facing changes, and mock-mode tests when live TraeCN is not required. Run the nearest focused test first, use `npm run verify` for repository-wide or release-facing work, and keep contract audit, mock/system tests, live UAT, clean-room installation, and fault injection as distinct evidence layers.

## Commit & Pull Request Guidelines

Git history uses concise Conventional Commit-style subjects: `fix(http): ...`, `feat(cdp): ...`, `refactor(gateway): ...`, and `docs(...): ...`. Keep commits scoped and mention the subsystem. Pull requests should include a behavior summary, verification commands, issue or task context, and screenshots only for visible chat UI changes. Update `README.md`, `docs/`, and `CHANGELOG.md` when installation, configuration, API behavior, or workflows change.

## Security & Configuration Tips

Never commit `.env`, tokens, authorization headers, passwords, or raw TraeCN profile data. Keep the gateway bound to `127.0.0.1` unless remote access is required. When logging or returning errors, use existing sanitization helpers.
