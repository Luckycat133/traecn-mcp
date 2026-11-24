# TraeCN MCP Documentation

Navigation index for all documentation in `docs/`. For quick start, daily check-in, and project overview, see the root [README.md](../README.md).

## Setup, Configuration & Operations

- [MCP-SERVER-GUIDE.md](MCP-SERVER-GUIDE.md) — Focused stdio MCP server guide (20 tools, host config formats, protocol compatibility)
- [OPENCLAW-MCP-SETUP.md](OPENCLAW-MCP-SETUP.md) — Integration setup for the stdio MCP server and the OpenClaw plugin
- [openclaw-command-set.md](openclaw-command-set.md) — Production command surface for `integrations/openclaw-traecn-plugin`
- [configuration.md](configuration.md) — Canonical runtime environment variables and defaults (generated from `src/config/runtime-schema.js`)
- [deployment.md](deployment.md) — Local/networked gateway deployment model and background service operation
- [FIRST-LOGIN-RUNBOOK.md](FIRST-LOGIN-RUNBOOK.md) — Manual first-time TraeCN login runbook (中文)

## Architecture, Verification & Compatibility

- [development.md](development.md) — Component boundaries, ownership, and local development guide
- [structured-prompt-mechanism.md](structured-prompt-mechanism.md) — Deterministic layered prompt mechanism for TraeCN control
- [agent-verification.md](agent-verification.md) — Verification matrix and evidence selection for repository changes
- [COMPATIBILITY.md](COMPATIBILITY.md) — Observed TraeCN version, platform, and adapter compatibility matrix
- [REAL-DOM-FINDINGS.md](REAL-DOM-FINDINGS.md) — Real TraeCN desktop DOM findings (v0.4.0 baseline and Trae CN 3.4.15, 中文)

## Upgrades, Distribution & Launch

- [MIGRATING-TO-0.5.md](MIGRATING-TO-0.5.md) — Upgrade guide from 0.3.x to 0.5.x (MCP contract v5, config, persistence, security boundaries)
- [DISTRIBUTION.md](DISTRIBUTION.md) — Publication surfaces, release artifacts, and verification boundaries
- [CHANNEL-LEDGER.md](CHANNEL-LEDGER.md) — Public distribution channel verification ledger (target 0.6.0)
- [LAUNCH-KIT.md](LAUNCH-KIT.md) — Prepared 0.6.0 launch material (gated on verified rows in `CHANNEL-LEDGER.md`)

## Design Specs & Implementation Plans (`superpowers/`)

- [superpowers/specs/2026-08-24-web-control-console-v1-design.md](superpowers/specs/2026-08-24-web-control-console-v1-design.md) — Web Control Console v1 design specification (2026-08-24)
- [superpowers/plans/2026-08-24-web-control-console-v1-implementation.md](superpowers/plans/2026-08-24-web-control-console-v1-implementation.md) — Web Control Console v1 implementation plan (2026-08-24)
