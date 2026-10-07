---
name: traecnclaw-development
description: Audit, design, develop, test, simplify, distribute, and promote TRAECNclaw. Use for the local gateway, public MCP Skill, human Web Control Console, operator CLI, TraeCN adapters, marketplaces, package channels, launch campaigns, CI, architecture, or completing selected engineering work. Do not use merely to operate TraeCN through MCP.
license: MIT
metadata:
  author: TRAECNclaw
  version: "2.2.0"
---

# TRAECNclaw Development

Act as the repository maintainer. Reconstruct current truth from source and executable evidence, then complete the requested engineering, product, distribution, or promotion outcome without reopening settled work.

Read only the references relevant to the task:

- [references/task-recovery.md](references/task-recovery.md): missing completion, accepted-task recovery, duplicate-send risk, and host/runtime evidence.

- [references/project-audit.md](references/project-audit.md): current product state, selected work, tests, and experience paths.
- [references/mcp-product-design.md](references/mcp-product-design.md): public MCP contract, metadata, schemas, annotations, task support, errors, and quality tests.
- [references/distribution-promotion-plan.md](references/distribution-promotion-plan.md): package, registry, directory, browser-Agent, launch, and measurement plan.
- [references/glama-browser-runbook.md](references/glama-browser-runbook.md): exact Glama registration, claim, sync, score, and build-inspection procedure.

## Product model

TRAECNclaw is one local macOS runtime with distinct surfaces:

1. **Local gateway — runtime core.** Runs beside TraeCN and owns CDP/DOM control, task lifecycle, durability, approvals, HTTP APIs, and WebSocket events.
2. **MCP Skill — primary Agent product.** The focused 20-tool contract is the normal way for agents to operate TraeCN.
3. **Web Control Console — human product.** One responsive interface for a person to observe and control their own TraeCN locally or through an authenticated private connection.
4. **CLI — operator/developer tool.** Setup, doctor, service lifecycle, scripting, recovery, logs, release checks, and live UAT; not a second human chat product.
5. **OpenClaw, REST, and JavaScript API — adapters.** Preserve thin integration layers over the same gateway application behavior.
6. **GitHub Release, ClawHub, Glama, skills.sh, Smithery, registries, directories, and catalogs — distribution.** They help users discover or install the local product; they are not independent runtimes.

## Deliberate subtraction

- Keep MCP contract v5 at exactly 20 ordered tools unless an explicit migration is approved.
- Do not add Agent-facing wait, poll, recovery, event-acknowledgement, process, proof, or generic command tools.
- Do not duplicate task, conversation, setting, approval, or recovery logic in clients.
- Do not grow CLI and web into competing human products.
- Keep normal web flows separate from Advanced/Diagnostics details.
- Do not create a cloud execution architecture merely to satisfy a marketplace.
- Do not claim Windows, another TraeCN version, another IDE, Streamable HTTP, npm, MCPB, Registry, or hosted support before that exact scope is selected and proven.
- Do not chase directory count while public install instructions are stale or contradictory.

## Select the mode

### Scoped engineering

Use when one bug, feature, refactor, test, onboarding, web-console, MCP, package, or channel target is named. Reproduce it, implement it in the owning component, add executable evidence, synchronize affected surfaces, and stop when its acceptance criteria pass.

### Repository or product audit

Use when asked what remains, what is broken, how the MCP should work, which product forms exist, where to distribute, or how to promote. Inspect live source and public channels and classify findings as:

- `implemented`
- `confirmed-bug`
- `missing-required`
- `selected-next`
- `optional-scope`
- `blocked-external`
- `obsolete`

Do not convert every possible feature or directory into required work.

### Completion campaign

Use when asked to finish all selected work. Build a dependency-ordered ledger, implement every unblocked `confirmed-bug`, `missing-required`, and explicitly `selected-next` item as coherent changes; create commits only when the user authorizes them, and continue after each green patch. Stop only when no local selected item remains, relevant gates pass, and every external blocker has exact resume steps and expected evidence.

### Browser-Agent channel handoff

Before giving work to a browser Agent:

1. finish repository/package preflight;
2. provide the exact public repository, canonical listing copy, and no secrets;
3. identify actions requiring separate authorization, payment, publication, or account scopes;
4. require evidence using the report format in the relevant runbook;
5. fix findings in canonical source/templates, not generated public Skill bytes.

Glama uses its dedicated runbook. Other directories and launch platforms use `distribution-promotion-plan.md`.

## Establish current truth

Before substantial work:

1. Read `AGENTS.md`, this Skill, and the affected source/tests or documentation. Inspect package metadata, recent history, PRs/issues, changelog, tags, and Releases when needed to resolve the current task.
2. For distribution or current channel claims, compare the affected canonical source, tags, Releases, packages, and directories separately. Unrelated local work does not require a survey of every channel.
3. Continue matching branches/PRs rather than creating duplicates.
4. Run the nearest baseline test; for broad work run `npm run verify:static` early.
5. Treat invisible private CI as missing evidence, not a code blocker; run local equivalent gates.
6. Treat live TraeCN, browser login, package credentials, payment, and unavailable platforms as external only when genuinely required.

At the 2026-08-21 review, source line 0.5.6 is publicly distributed through the public mirror and ClawHub. Glama preparation is in PR #21 and public-mirror PR #7. Recheck before making a current claim.

## Architecture owners

- `src/mcp/contract.js`: frozen public tool names/order.
- `src/mcp/tools.js`, `src/mcp/tool-metadata.js`, `src/mcp/handler.js`: public tool definitions, schemas, annotations, validation, and results.
- `src/mcp/protocol.js`, `src/mcp/stdio-server.js`, `src/mcp/task-extension.js`: protocol eras, framing, Tasks/subscriptions, cancellation, and request lifetime.
- `src/http/task-orchestrator.js`: task acceptance identity, semantic fingerprints, and active/terminal idempotency replay.
- `src/http/task-store.js`: active tasks and terminal replay persistence.
- `src/shared/task-event-store.js`: completion events and client cursors.
- `src/shared/task-history.js`: durable diagnostic history.
- `src/http/completion-signal.js`: durable completion event followed by external delivery.
- `src/http/queue-state-machine.js`, `src/http/task-queue-service.js`, `src/http/recovery-helper.js`: queue and restart support.
- `src/http/route-table.js`, `src/http/handlers/*`: application HTTP composition.
- `src/http/chat-ui.js` and related assets: human Web Control Console presentation.
- `src/trae-adapters`: versioned TraeCN detection and fixtures.
- `src/config/runtime-schema.js`: canonical runtime configuration.
- setup/operator scripts: Quickstart, doctor, CLI, service, live UAT, and `setup:mcp`.
- `distribution/public-mirror/*`, package scripts, mirror generator, release workflows: public distribution and provenance.
- maintainer Skill references: selected product/channel strategy and browser-Agent procedures.

Extend the existing owner and delete the previous path after moving callers.

## Select current work

Use the current request, current source/tests and the affected issue or release state to choose work. `references/project-audit.md` and earlier channel plans are dated evidence, not a standing instruction to resume promotion, submit listings, publish packages, or rebuild unrelated surfaces. Reconcile completed milestones before choosing the next one.

For task acceptance, restart, notification or duplicate-send failures, use [task recovery](references/task-recovery.md). Diagnose the owning layer before creating another task or broadening the public tool contract.

## MCP design rules

Follow `mcp-product-design.md`. In particular:

- one tool equals one user intent;
- `traecn_send_message` is the only normal durable work-creation tool;
- context tools are called only when necessary;
- settings use discovery before mutation;
- irreversible/exceptional tools remain identity-bound and explicit;
- text and `structuredContent` remain semantically equivalent;
- output schemas must validate real results;
- annotations and `execution.taskSupport` describe characterized behavior rather than using broad defaults;
- resources, prompts, icons, or MCP Apps require a named host/user need, not marketplace score pressure.

## Distribution rules

Follow `distribution-promotion-plan.md`.

- Public GitHub mirror and ClawHub have historical verification records; recheck the exact release and install path before making a current claim.
- Glama, skills.sh, AwesomeSkills.dev, MCP.Directory, MCPB/Smithery, the Official Registry, PulseMCP, Homebrew, curated lists, and secondary directories are separate milestones with separate evidence.
- The Official Registry requires a current public installation method; never point it at npm 0.3.1.
- Smithery uses the local MCPB flow unless a real Streamable HTTP product is selected.
- Homebrew installs the Mac operator/server layer; pair it with Skill/host setup.
- Search for existing listings before submitting and reconcile rather than duplicate.
- Store canonical listing copy and provenance in source; do not improvise descriptions or install commands in browser forms.
- A channel is not verified until its public page and generated install path are inspected after publication.

## Promotion rules

- Lead Chinese promotion with the TRAE official community and a real Bilibili demo.
- Lead global promotion with GitHub/YouTube; use Show HN only when users can try the project easily.
- Defer Product Hunt until Web Control Console and onboarding form a coherent human product.
- Ask for feedback, never coordinated upvotes.
- Use one canonical launch narrative and honest limitations; do not mass-post identical copy.
- Measure aggregate public installs, downloads, setup failures, and real task evidence rather than directory count.
- MCP contributor communities are for technical collaboration, not unsolicited launch marketing.

## Verification ladder

Start with the affected behavior and expand for risk, failures, or changed contracts. This is an evidence ladder, not a requirement to run every level for every task. Preserve full protocol/package/release gates when those contracts are affected; documentation-only changes use focused content checks.

1. `node path/to/focused.test.js`
2. subsystem tests such as MCP conformance, adapters, system, stdio smoke, mirror, MCPB, package, or web tests
3. `npm run verify:static`
4. `npm run verify`
5. `npm run test:release`
6. doctor, inspect, and strict live UAT for current TraeCN behavior
7. real target-host installation/call for host claims
8. public listing, package, registry, marketplace, or launch evidence for the exact channel claimed

Static checks prove declarations. Mock tests prove process integration. Clean-room tests prove built packages. Only live UAT proves current TraeCN desktop behavior. Marketplace scores prove their scan, not local execution.

## Real experience requirement

For user-facing work, exercise at least one relevant path from `project-audit.md`:

- real MCP host task and completion;
- local or authenticated remote Web Control Console;
- CLI setup/doctor/live validation;
- Release/MCPB/Homebrew clean installation;
- directory registration and generated install test;
- launch post/video feedback loop.

Report the exact path. Never label mock, Docker schema inspection, or directory metadata as a real TraeCN task.

## External blockers

Record the blocked item, why repository tests cannot prove it, exact command/manual action, expected evidence, and the next code step. Browser login, ownership approval, package credentials, payment, live desktop access, and unavailable platforms may be external. Complexity, test failures, or invisible CI are not.

## Completion standard

Before finishing:

1. the requirement or defect has executable evidence;
2. focused and relevant wider tests pass;
3. the affected real experience works or is precisely externally blocked;
4. generated/public surfaces are synchronized when affected;
5. no ownership, durability, protocol, compatibility, product-surface, or provenance invariant is weakened;
6. the current audit/channel ledger is updated;
7. the final report states changes, tests, experience evidence, channel state, and remaining uncertainty.

Do not stop at analysis when a safe local change is possible. Do not stop after the first patch when the request covers the selected remaining work.
