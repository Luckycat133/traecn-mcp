---
name: traecnclaw-development
description: Audit, develop, test, package, distribute, or promote TRAECNclaw's local gateway, MCP Skill, Web Control Console, CLI, and adapters. Use for repository engineering and selected product or channel work; use traecnclaw-mcp to operate TraeCN.
license: MIT
metadata:
  author: TRAECNclaw
  version: "2.2.0"
---

# TRAECNclaw Development

Maintain the requested outcome using current source and executable evidence.
Preserve existing capabilities and ownership; remove duplication only after
its callers and behavior are characterized. The user's explicit scope and
existing authorization take precedence over suggested work below.

Repository paths in this Skill are relative to the checkout root. Read only
the reference required by the task:

- [task-recovery.md](references/task-recovery.md): accepted-task recovery, missing completion, duplicate-send risk, and host/runtime evidence.
- [project-audit.md](references/project-audit.md): capability coverage, ownership, audit classification, and acceptance paths.
- [mcp-product-design.md](references/mcp-product-design.md): the 20-tool contract, schemas, annotations, Tasks, errors, metadata, and MCP tests.
- [distribution-promotion-plan.md](references/distribution-promotion-plan.md): selected packaging, channel, canonical listing, and launch procedures.
- [glama-browser-runbook.md](references/glama-browser-runbook.md): Glama claim, sync, build inspection, and evidence.
- `docs/agent-verification.md`: maintained focused, repository, package, and live verification commands.

## Product and ownership

TRAECNclaw is one local macOS runtime using Node.js 22+ and CommonJS. Distribution
channels install that runtime; adapters keep its gateway ownership intact.

| Surface | Role |
| --- | --- |
| Gateway | Owns CDP/DOM control, task lifecycle, durable state, approvals, HTTP, and events |
| MCP Skill | Primary agent product; 20 focused tools over the gateway |
| Web Control Console | Single human product for local or authenticated private access |
| CLI | Setup, doctor, service, scripting, recovery, logs, and verification |
| OpenClaw, REST, JavaScript API | Thin adapters over the same application behavior |
| Releases, packages, registries, directories | Discovery and installation of the local product |

Extend the owning store, driver, service, or adapter. Characterize stable IDs,
persisted fields, events, and responses before moving lifecycle code; migrate
callers and remove the superseded path together. Use the ownership map in
`project-audit.md` when the owner is unclear.

## Select work from the request

For a scoped bug, feature, refactor, onboarding, MCP, web, package, or channel
change, reproduce the issue, implement it in its owner, and stop when its
acceptance criteria and relevant gates pass.

For a broad audit or optimization, inventory the existing capabilities first.
Classify findings as `implemented`, `confirmed-bug`, `missing-required`,
`selected-next`, `optional-scope`, `blocked-external`, or `obsolete`. An
implemented capability still needs evidence for the exact claim being made;
an optional feature or directory is not required work by default.

For a completion campaign, order confirmed defects, required gaps, and
explicitly selected work by dependency. Complete every unblocked selected item
and record exact resume actions for genuine external blockers. Continue after
the first green patch when the request covers more work. Do not revive a dated
release campaign or fixed channel order unless it remains relevant to the
current request. Create commits only when the user authorizes them.

For task acceptance, restart, notification or duplicate-send failures, use
[task recovery](references/task-recovery.md) to diagnose the owning layer before
creating another task or broadening the public tool contract.

## Establish current truth

- Read `AGENTS.md` and the affected source/tests or documentation. Inspect package metadata, history, changelog, PRs/issues, tags and Releases when needed for the current task. Preserve existing changes and continue a relevant branch/PR rather than creating duplicates.
- Run the nearest baseline test; for broad engineering run `npm run verify:static` early.
- When a release or public channel is in scope, compare source, tags, canonical/private provenance Releases, public mirror Releases, and the specific channel separately. Inspect the published page and generated install path before making a current claim.
- `docs/CHANNEL-LEDGER.md` is dated channel evidence. Skill snapshots and runbooks are historical evidence, not current status or a standing work queue. Recheck only the surfaces relevant to the requested outcome.
- Private CI visibility is not a code blocker: run its local equivalent. Treat live desktop, login, credentials, payment, or unavailable platforms as external only when needed for the selected acceptance path.

## Preserve the contracts

- Keep MCP contract v5 at exactly 20 ordered tools unless the user authorizes a migration. Preserve names, semantics, text/structured parity, schemas, and task support; one tool represents one user intent.
- `traecn_send_message` creates durable delegated work. Context tools are conditional, settings require discovery, and exceptional decisions remain bound to exact visible identities and existing authorization.
- Do not add agent-facing wait/poll, recovery, event acknowledgement, process, proof, generic command, or profile tools. Do not duplicate lifecycle logic in clients.
- Keep normal web tasks separate from Advanced/Diagnostics. CLI remains the operator interface. Add MCP resources, prompts, icons, or Apps only for a concrete host/user need.
- Make compatibility claims only for the exact tested host, version, transport, and channel. Static metadata, schema-inspection containers, and mock tasks cannot prove live TraeCN behavior.
- Keep the gateway on loopback unless remote access is deliberately authenticated. Use `src/config/runtime-schema.js` and sanitization helpers; exclude credentials, raw profiles, `.env`, logs, state, dependencies, and build outputs from commits.

## Distribution and promotion when selected

Fix canonical source/templates and regenerate public surfaces. Publish the
public mirror, never the private canonical repository; preserve source
provenance and canonical install copy. Search for existing listings and
reconcile them instead of duplicating submissions.

`skills/traecnclaw-mcp` owns the public Skill. After changing that package,
run `npm run sync:local-skill` to refresh the complete `.codex/skills` copy
used by Codex discovery; `npm run check:local-skill` detects drift without
writing. Update generated tool schemas with `npm run sync:skill-contracts`
before synchronizing the package when MCP metadata changes.

Never direct current listings to `traecnclaw@0.3.1`. MCPB and Smithery Local
serve local stdio; URL/cloud execution requires an actual supported HTTP
product. Package publication, Registry publication, and each generated install
path need independent evidence. Homebrew installs the operator/server layer
and must be paired with Skill/host setup.

Use the distribution reference for channel-specific dependencies and launch
copy. Glama uses its dedicated runbook. A browser-agent handoff receives the
exact public repository, canonical payload, package preflight, authorized
actions, and expected evidence; secrets stay local. Promotion asks for
feedback, uses reviewed real media and honest limitations, and measures trial
outcomes rather than directory count. Sending messages, posting, payment, and
publication remain within the user's actual authorization.

## Verify and finish

Select gates from `docs/agent-verification.md` for the changed surface:
focused test, relevant subsystem tests, broad non-live verification, and
release/installation checks when packaging is affected. Broaden or repeat
checks only for new changes, failures, required gates, or unresolved concerns.

For user-facing behavior, exercise the relevant path from `project-audit.md`.
Documentation-only changes need contract/link validation, not a model task.
A real desktop or target-host claim requires the corresponding real experience;
an unavailable check remains unverified with its exact resume step.

A completed change has characterized behavior, passing required checks,
synchronized affected generated surfaces, and preserved ownership,
durability, security, and provenance. Update the relevant audit/channel ledger
when its evidence changes. Report the files, actual tests and experience,
remaining uncertainty, and precise external blocker; do not substitute a mock
or historical result for a missing current check.
