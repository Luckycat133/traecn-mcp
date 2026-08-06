# Repository Guidelines

## Project Structure & Module Organization

TRAECNclaw is a Node.js 22 CommonJS project for a TraeCN automation gateway, MCP server, CLI, web UI, Agent Skill, and OpenClaw integration. Core code lives in `src/`: `config` owns runtime configuration, `cdp` owns CDP/DOM drivers, `http` owns the gateway and task lifecycle, `mcp` owns stdio protocol behavior, `shared` holds stores and utilities, and `skill` exposes the JavaScript API. OpenClaw code is in `integrations/openclaw-traecn-plugin`; scripts are in `scripts`; public runtime Skill files are in `skills/traecnclaw-mcp`.

Do not commit local output such as `audit-logs`, `demo-output`, `logs`, `.env`, `dist`, or `node_modules`.

## Repository Development Skill

Use `.codex/skills/traecnclaw-development/SKILL.md` for substantive development, audit, debugging, refactoring, compatibility, onboarding, packaging, testing, CI, release, or “finish the remaining project” requests. Its only current reference is `references/project-audit.md`, which records the latest capability audit, confirmed defects, test ladder, real experience paths, and maintainer decisions.

Use `skills/traecnclaw-mcp` only for operating TraeCN through the public 20-tool runtime MCP surface. Do not copy the maintainer Skill into the public Skill artifact.

For a broad repository audit, compare source version, tag, downloadable GitHub Release, public Skill metadata, and package publication separately. For a completion campaign, implement every unblocked local item rather than stopping after the first patch; isolate only genuine external dependencies such as a live TraeCN instance or publication credentials.

## Build, Test, and Experience Commands

- `npm ci`: install the exact lockfile dependency graph.
- `npm run verify:static`: check versions, generated configuration, Skill contracts, and release scanning.
- `npm run test:mcp-conformance`: test supported MCP protocol eras with independent clients.
- `npm run test:trae-adapters`: replay versioned sanitized TraeCN fixtures.
- `npm run test:system`: run the real gateway against the mock bridge.
- `npm run test:mcp-stdio-smoke`: spawn the stdio MCP server and verify discovery.
- `npm run verify`: run the repository-wide non-live gate.
- `npm run test:release`: build verified artifacts and complete a clean-room mock task.
- `npm run doctor`: diagnose Node, npm, gateway, CDP, and TraeCN setup.
- `npm run inspect:verify`: inspect the real TraeCN DOM/adapter surface.
- `node scripts/live-uat.js --strict --require-ready --require-verified-adapter`: run live readiness without sending a task.
- `TRAECN_ENABLE_MOCK_BRIDGE=1 npm run start:gateway`: start a five-minute mock experience.
- `npm run start:gateway`: start the real gateway once TraeCN CDP is ready.

Run the nearest focused test first. Static audits prove declarations, mock tests prove process integration, clean-room tests prove locally built artifacts, and only live UAT proves current TraeCN compatibility.

## Coding Style & Naming Conventions

Use CommonJS (`require`, `module.exports`), keep `'use strict';`, follow two-space indentation and semicolon style, and use descriptive kebab-case file names. Tests use matching `*.test.js` files with Node `assert` and `src/shared/test-runner.js`. Prefer injected stores, drivers, clocks, and process hooks for deterministic fault tests.

## Change and Evidence Rules

Identify the component that owns the behavior before editing. Characterize current responses, persisted fields, history steps, events, and task identity before moving lifecycle logic. Delete old paths after callers migrate; do not leave two live implementations.

Update README, OpenAPI, compatibility evidence, generated contracts, changelog, and release metadata only when affected. A public or release claim must identify the exact source revision and artifact; source version, tag, GitHub Release, npm, and ClawHub are not interchangeable.

Pull requests should describe behavior, root cause when applicable, focused tests, wider gates, and which mock/live/package experience was exercised. Several coherent milestone commits are acceptable for a completion campaign.

## Configuration

Never commit `.env`, tokens, authorization headers, passwords, cookies, or raw TraeCN profile data. Keep the gateway on loopback unless remote access is deliberately configured. Use canonical environment names from `src/config/runtime-schema.js` and existing sanitization helpers for logs and errors.
