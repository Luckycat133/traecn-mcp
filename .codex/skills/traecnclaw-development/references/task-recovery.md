# Task acceptance and completion recovery

Use for an accepted task with missing output, restart recovery, duplicate sends, or a host that does not receive completion. This is maintainer diagnosis; ordinary operation still follows the public `skills/traecnclaw-mcp` contract.

## Find the failed boundary

| Boundary | Source and focused evidence |
|---|---|
| Acceptance, request identity and semantic replay | `src/http/task-orchestrator.js` and its test |
| Active/terminal persistence and restart reconciliation | `src/http/task-store.js`, `src/http/task-restart-retry.test.js` |
| Durable event before notification | `src/http/completion-signal.js`, `src/shared/task-event-store.js` and their tests |
| Host protocol, Tasks and subscription delivery | `src/mcp/task-extension.js`, `src/mcp/stdio-server.js` and their tests |
| Actual Trae adapter behavior | `src/trae-adapters/`, `scripts/inspect-traecn.js`, `scripts/live-uat.js` |

Start with the returned task ID, request/idempotency identity, conversation/workspace, persisted status, final result and event cursor. A transport timeout does not establish that acceptance failed. Inspect the original identity before considering a resend; do not create a new conversation or generic queue-probe message to discover status.

Legacy clients and Tasks-aware clients have different delivery paths. Check negotiated capabilities and the exact client/task identity rather than treating a missing legacy notification as failed model work. Stable client IDs resume unacknowledged events; a new client baseline is not evidence that no old task exists.

`CompletionSignal.emit` records a durable event before external delivery. In the current implementation, a webhook error is logged and the returned `delivered` flag can still be true. Therefore that flag alone does not prove a webhook consumer received the result. Verify durable storage and actual consumer receipt separately; do not change delivery semantics as part of a documentation-only diagnosis.

## Prove the repaired scope

Exercise the failed boundary with its existing test first. For restart/idempotency fixes, cover accepted-but-response-lost and terminal replay without a second physical send. Mock gateway success proves integration, not current TraeCN UI compatibility. Use current adapter/readiness evidence when live compatibility is the claim; running a model task needs the current task's authorization.

Keep recovery within the existing 20-tool public contract. Do not add a second polling loop, auto-resubmit paid work, restart unrelated processes, or activate old promotion/automation tasks to make a status read appear healthy.
