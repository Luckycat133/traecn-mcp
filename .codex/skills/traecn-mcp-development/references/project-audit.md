# traecn-mcp current audit

Reviewed 2026-11-14. Remote scope: `Luckycat133/traecn-mcp`, branch `docs/geo-optimization`, baseline commit `676b461445be34e14748a27eabd5f5e5ca434702`, tree `17acb5585e12c5e318e3376463cd1a596ab11e35`. Re-resolve the branch before implementing; this is a snapshot, not a claim about an unseen local worktree.

## Accepted test baseline

The maintainer reports PASS for `npm run check:local-skill`, `skill-contract.test.js`, and full `npm test`, including CDP DOM, check-in, model switching, Trae 1.107 adapter registry, MCP conformance and 52 CLI tests. Preserve those results as user-supplied local evidence. This review did not rerun them and has no attached local log/revision to bind to the remote SHA.

Independent repository evidence: `skills/traecnclaw-mcp` and `.codex/skills/traecnclaw-mcp` have the identical tree `d2baa6903b48ffe34dac4f89d63fa60d0caa732a`. `src/mcp/contract.js` still enforces v5 and 20 ordered tools. Equality proves that these checked-in copies agree, not that renamed packages/bins or an unobserved real task work.

## Naming completion

| Surface at the baseline | Finding | Required treatment |
| --- | --- | --- |
| Repository slug | `Luckycat133/traecn-mcp`, public | Canonical source and documentation identity |
| README | New display name, but links `skills/traecn-mcp/SKILL.md` and advertises `traecn-mcp` bins | Reconcile with actual files and installed artifact, not text-only replacement |
| Package manifest | `name=traecnclaw`, version `0.6.0`; old repository/homepage; bins `traecnclaw` and `traecnclaw-mcp` | Presentation URLs can migrate; package/bin compatibility needs an explicit tested transition |
| Runtime Skill | Both checked-in copies still named `traecnclaw-mcp` | Keep tested copies unchanged in this maintainer-doc change |
| MCP tool contract | `traecn_*`, v5, exact order | Correct stable interface, not leftover branding |
| Maintainer Skill | Old path/name and historical distribution assumptions | This update migrates it to `traecn-mcp-development`, including IDE symlinks and routing |
| State/service/registry identities | Legacy names may carry real installed state and ownership | Migrate or retain as documented aliases; never silently create an empty state store |

The README's new runtime-Skill path is absent from the inspected tree, and its new executable name is absent from the inspected `bin` map. Its check-in claims also need association with the maintainer's actual tested source; this remote `npm test` command does not list a check-in-named driver test. Do not infer that the local PASS is false or that those local changes are absent everywhere. First compare the tested local SHA/dirty diff to this branch, then reconcile the branch/docs. No arbitrary completion percentage is useful here.

## Implemented reliability to retain

- Durable acceptance, active/terminal replay and checksummed recoverable task storage.
- In-process task claims and UI action serialization.
- Recovery of submitted tasks without normal resubmission; identity-guarded collection.
- Pending cancellation/persistence checkpoints and follow-up parent completion markers.
- Event/history persistence and independent protocol/adapter tests.

These are not a new backlog. The source findings below are narrow gaps not established by a general green-suite claim.

## Findings and next acceptance tests

| ID | Evidence in current source | Assessment / next step |
| --- | --- | --- |
| R1 | Background polling dispatch in `src/http/gateway.js` persists executing, calls native `sendMessage`, then marks/persists `submittedToTrae`; `RecoveryHelper` requeues executing/unsubmitted tasks | High-confidence ambiguous-send crash window. Inject death after native accept but before submitted checkpoint; require no second native send |
| P1 | Proof `requestWithRetry` retries network failures; `submitProof` sends POST without a stable operation key | Retry can duplicate work after a lost response. Persist proof attempt/key before POST and use an endpoint that enforces it |
| P2 | `executeProof` runs clean/idle preconditions before selecting `resumeTaskId` | Resuming its own active queued task can be rejected. Split fresh-run preflight from exact-owner resume preflight |
| W1 | `handleOpenProject` executes reuse-window switching without an active-task ownership guard; task/file locks are not workspace leases | Add shared runtime/workspace ownership at the application boundary and test every mutation path |
| P3 | Proof prompt asks the model to emit marker and model name | Echoed model name is insufficient evidence. Capture requested and UI-observed model separately with native identity and result |

R1/P1/P2/W1 are static control-flow findings, not a claim that a duplicate or wrong-workspace incident was observed live. The proposed fixes are not implemented by this documentation update.

## Scope of this update

Changed: maintainer Skill, its references, IDE discovery links, repository routing and verification guidance. Unchanged: runtime sources, package/lockfile, public/local runtime Skill copies, MCP contract, release tags and external listings. No real model task was sent.

Historical evidence is preserved in Git, including prior GLM-5.2 and Trae 1.107 reports and local-log references. See the [pre-update audit](https://github.com/Luckycat133/traecn-mcp/blob/676b461445be34e14748a27eabd5f5e5ca434702/.codex/skills/traecnclaw-development/references/project-audit.md). Those reports remain historical evidence for their own source/environment; they are not proof of every crash window on this branch.

## Next work

Follow [task recovery](task-recovery.md), then [live proof/workspaces](live-proof-workspace.md). Reconcile distribution via [the migration plan](distribution-promotion-plan.md). Consult `docs/CHANNEL-LEDGER.md` for per-channel records, but inspect their dates/source revisions before treating them as current. Do not copy its historical version table into this file again.
