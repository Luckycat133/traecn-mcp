# Development roadmap and acceptance

## Review baseline and evidence

Reviewed remote `main` at `a37f6bed01931dd7fd984f3ca40d431d425451cc`, with source
version 0.7.0. The owner reports passing full CLI, CDP-driver, and MCP protocol
conformance tests locally. That report is not an independently rerun result
and was not accompanied here by a local commit SHA or logs.

The remote tree contains an operator Skill and its full generated mirror,
not a distinct development Skill. This change adds the development Skill and
routes repository guidance to it. It corrects current development-guide
branding, the shared-client implementation location, and the selector workflow;
it does not certify every old-brand occurrence as removed.

Existing durable queues, recovery, cancellation, review continuations, protocol
era support, and Web Console reconnect handling must be treated as existing
features to preserve and verify, not greenfield work. Consult current code and
tests before declaring any scenario below uncovered.

This is a proposed implementation order, not authorization to publish, migrate
user data, operate the installed desktop, or spend model quota.

## P0 — Close the naming migration without breaking compatibility

**Deliverable:** a small, testable identity policy and the remaining
presentation-only cleanup. Audit current help, errors, docs, metadata, launch
configuration, generated mirror, and release templates. Add a narrow old-name
exception inventory with file/consumer/reason/test/removal criteria rather
than a global case-insensitive replacement or a broad allowlist.

The public README provenance template still names the old project, and its
validator currently requires that spelling. Change that presentation sentence
and its validation together. Likewise, migrate the direct-client sample path
and its exact assertion in `skill-contract.test.js` together, including the
generated mirror. Do not change old release digests or the package and Registry
identifiers as a side effect. Inspect other maintained docs
separately; archived/versioned evidence is not stale current prose.

**Acceptance:** canonical product and developer entry names are coherent;
new accidental product-facing legacy labels fail a focused check; exact
compatibility exceptions still work; every Skill link/symlink resolves; the
complete runtime Skill mirror matches; source package publication remains
protected. Naming-only changes preserve CLI dispatch, clean stdio, contract
v5 names/order, configuration precedence, and stored task identity.

Run targeted identity/launcher/Skill tests and `verify:static`. Run CLI and
stdio smoke when executable or installation text/metadata changes. Do not
claim a public channel migration merely from these checks.

## P1 — Prove upgrades, restart continuity, and recovery from failed migration

**Deliverable:** extend existing clean-room/release tests with old-install to
new-artifact scenarios where coverage is absent. Use disposable service and
state roots; never rewrite the user's live state or restart an installed
TraeCN instance as a packaging-test side effect.

Exercise queued/running/input-required/review/cancelled/terminal task samples,
existing host configuration and symlinked launchers, old environment aliases,
notification cursors, and linked workflow tasks. Include both old and new
state locations present, interrupted migration, repeated invocation, and an
uncertain submission response. Confirm state continuity without a duplicate
prompt or a second service. No automatic content merge on ambiguous state.

**Acceptance:** the installed artifact, not just source code, starts both CLI
and stdio correctly; exactly 20 tools are discoverable; IDs and terminal
outcomes survive upgrade/restart; an explicit rollback or forward-recovery
procedure has executed against fixtures. Unsupported downgrades are clearly
reported. Bind evidence to source SHA, artifact hash, old/new version, command,
and observed result. Test real public install channels separately when
publishing or claiming channel compatibility is in scope.

## P1 — Maintain a real desktop acceptance matrix

**Deliverable:** a compact sanitized matrix for the actual supported TraeCN
versions, modes/windows, and MCP hosts. Start with the environment the owner
already has; do not invent a newer supported version or broaden the platform
claim beyond verified macOS behavior.

Cover existing mode/window variants, native conversation identity, deferred
empty drafts, workspace switching, model picker and Auto state, settings
control types, exact command approval/question binding, review continuation,
visible stop versus task cancellation, and reconnect/restart. Select meaningful
scenarios instead of an unbounded Cartesian product.

**Acceptance:** record product/app version, adapter ID, macOS, host/protocol,
source SHA, commands/actions, and observed postconditions. Readiness checks and
sanitized fixture replay remain separate from real generation success. Mark
unavailable environments as not tested; mark unavailable capabilities explicitly.
Use an authorized owned task for any real send/stop/delete or quota-consuming
scenario, and record its effect rather than just a click or accepted status.

Reuse passing CLI/CDP/conformance evidence for unchanged code; investigate new
or missing cross-surface scenarios instead of rerunning everything without a
reason. Update `docs/COMPATIBILITY.md` only with evidence actually obtained.

## P2 — Improve task usability on the existing surfaces

**Deliverable:** refine the existing Web Control Console and operator recovery
path from observed friction. Prioritize distinguishing disconnected, queued,
waiting for input/review, cancelled, failed, and completed states; show the
specific recovery action and task identity without exposing protocol mechanics
to normal users. Keep Advanced diagnostics separate.

**Acceptance:** on the same gateway task, web/CLI/MCP agree on state and final
result. Reconnect restores the correct subscription and does not double-submit.
Review and approvals target the current interaction. Do not create a parallel
CLI dashboard or broaden MCP tools merely to expose internal queue controls.

## P2 — Extract architecture only when a concrete change needs it

`src/http/gateway.js` is large, but there are already task, queue, store,
recovery, and completion modules. Choose a bounded owner extraction only when
new work demonstrates coupling or duplicated behavior. Characterize responses,
event order, authorization, state writes, and shutdown behavior first.

**Acceptance:** the same contract and scenario tests pass before/after; callers
use one owner; migrated duplicate paths are removed without breaking retained
compatibility exports. Do not rewrite the gateway wholesale, replace CDP with
vision automation, or add a second orchestrator as a refactoring shortcut.

## Completion record for each slice

Record scope and base/result commits; changed owner and compatibility surface;
executed commands, exit status, and evidence location; static/mock/artifact/live/
host/channel tier; remaining risk and recovery procedure where relevant.
Separate owner-reported evidence from newly executed tests. Never relabel a
skipped live check, prepared artifact, open PR, or published metadata as an
end-to-end runtime success.
