# Repository Guidelines

## Project Structure & Product Surfaces

traecn-mcp is a Node.js 22 CommonJS local runtime for controlling TraeCN on macOS. `src/config` owns runtime configuration, `src/cdp` owns CDP/DOM drivers, `src/http` owns the gateway and task lifecycle, `src/mcp` owns stdio protocol behavior, `src/shared` owns durable stores/utilities, and `src/skill` exposes the JavaScript compatibility API. OpenClaw is under `integrations/openclaw-traecn-plugin`; distribution templates live in `distribution/`.

MCP is the primary Agent interface, the web console is the human interface, and CLI is for setup, operations and scripts. They share the same gateway. Do not create a second task lifecycle in a client or expand platforms without actual test evidence.

Do not commit local output such as `audit-logs`, `demo-output`, `logs`, `.env`, `dist`, or `node_modules`.

## Repository Development Skill

Use `.codex/skills/traecn-mcp-development/SKILL.md` for repository development, audit, naming migration, recovery, workspace protection, packaging and distribution. `.agents/skills/traecn-mcp-development` and `.claude/skills/traecn-mcp-development` are symlinks to that maintained source.

Load only the relevant reference: `project-audit.md`, `mcp-product-design.md`, `task-recovery.md`, `live-proof-workspace.md`, `distribution-promotion-plan.md` or `glama-browser-runbook.md`.

The runtime operating Skill is separate. At the reviewed remote baseline it remains `skills/traecnclaw-mcp`, mirrored exactly at `.codex/skills/traecnclaw-mcp`; these are compatibility identifiers, not the preferred product brand. Resolve actual current paths before editing. Do not copy the maintainer Skill into public artifacts or change one runtime copy independently.

## Compatibility and Task Rules

- Preserve MCP contract v5 and its exact 20 ordered `traecn_*` tools. No wait, poll, proof, recovery or generic command tools.
- Preserve schemas, result parity, protocol negotiation, terminal replay and task identity.
- Distinguish accepted HTTP request identity from native UI submission. An uncertain post-send crash requires reconciliation, not a blind retry.
- Distinguish in-process locks, file-writer locks, short UI mutexes and long-lived runtime/workspace ownership.
- A task waiting in Trae's native queue still owns its execution context. Route all context mutation through the same application guard.
- Keep cancellation/persistence checkpoints and follow-up parent completion markers already implemented.
- Project renaming must not silently replace package IDs, installed bins, environment variables, service labels or state directories. Preserve or explicitly migrate compatibility aliases.

## Tests and Evidence

Use `docs/agent-verification.md`. Accept maintainer-supplied passing tests as a baseline, label evidence provenance, and reconcile local and remote revisions before attributing a result to a commit. Documentation-only edits need focused name/link/symlink checks, not a model task or an automatic full-suite rerun.

Runtime changes need a failing regression and focused owner tests. Cross-cutting lifecycle/protocol changes need relevant integration and repository gates. Packaging/release changes need clean installed-artifact checks. Mock, schema inspection, live readiness, real generation, observed long queue and crash recovery are different claims.

## Distribution and Promotion

The canonical repository is public `Luckycat133/traecn-mcp`; do not repeat the historical assumption that source is private and only a mirror can be submitted. Existing package/channel slugs and historical releases may retain old identifiers. Reconcile rather than duplicate listings; update current source/visible names without rewriting immutable provenance. Treat each dated channel record independently.

Keep README, `llms.txt`, generated setup, actual files and installed commands consistent. Do not advertise an absent runtime-Skill path or bin. Promotion uses real evidence; do not add marketing to MCP task results or fabricate installs, model identity or long-queue success.

## Coding Style & Change Evidence

Use CommonJS, `'use strict';`, two-space indentation and descriptive kebab-case filenames. Tests use Node `assert` and the existing runner. Prefer injected stores, clocks, drivers and process hooks for fault tests.

Preserve unrelated work. Characterize responses, persisted fields, events and native ownership before moving lifecycle logic. Delete migrated duplicate paths after callers switch. Report actual changes, actual validation, supplied evidence and outstanding findings separately.

## Configuration

Use canonical runtime-schema environment names and existing redaction helpers. Never commit credentials, raw profiles or unrelated private task contents. A documentation audit does not authorize paid model tasks, native cancellation, workspace changes or publication.
