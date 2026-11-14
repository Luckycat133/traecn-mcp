# traecn-mcp task ownership and crash recovery

Scope: current gateway, queue state machine, TaskStore and RecoveryHelper. Preserve the cancellation, pending-persistence, follow-up parent markers and terminal replay already implemented. This document separates established behavior from the next design work.

## Four locks, four purposes

| Mechanism | Current scope | What it does not establish |
| --- | --- | --- |
| `QueueStateMachine.taskLocks` / `withLock` | One process, one task step | Durable ownership or exclusion across processes |
| Gateway UI action chain | Short serialized UI operations in one gateway | A workspace reservation for a native queue lasting hours |
| TaskStore PID/owner lock | One snapshot path, one writer | Exclusion between two gateways using different state paths but the same Trae window |
| Long-queue proof marker lock | One proof marker/observer registry | Exclusive ownership of a runtime across different markers |

A runtime/workspace lease is needed for the fourth, longer-lived concern; see [workspace design](live-proof-workspace.md). Do not hold an unresolved JavaScript mutex for the entire queue wait. Persist logical ownership and use short critical sections around UI mutations.

## Current crash window: R1

`Gateway._processQueuedTask` records an executing state, invokes `driver.sendMessage`, then sets `submittedToTrae`/`submittedAt` and persists again. `RecoveryHelper` restores executing tasks without the submitted flag as queued/unsubmitted.

A process can therefore die after Trae accepted the user turn but before the durable submitted checkpoint. Restoring the old snapshot can permit a second send. A passed durable HTTP acceptance test does not close this external-side-effect window. Check persistence return values on this path as part of the characterization; do not assume every `_persistActiveQueue()` call is a successful commit.

## Proposed dispatch protocol (not implemented by this doc change)

1. Under the shared context guard, verify the workspace/runtime/conversation and freeze the intended request.
2. Persist a submission-intent checkpoint before clicking Send: task ID, attempt ID, request fingerprint, native conversation identity, workspace key, runtime generation, observed model/mode, and native user-turn baseline.
3. If that persistence fails, do not send. Expose the existing persistence failure path.
4. Execute the native send once for that attempt. Capture native evidence of acceptance, then persist a receipt before reporting the task as confidently submitted.
5. On restart, acquire the runtime owner, verify context, and reconcile the intent against the exact native conversation and new user turns.
6. If one matching receipt is found, adopt it and only observe. If the full relevant history proves no send occurred, a controlled dispatch can proceed under the same operation identity.
7. If evidence is missing, ambiguous, or points to another context, stop automatic dispatch and report uncertainty. A timeout or temporarily empty DOM is not proof that no send occurred.

Use a persisted nested dispatch state rather than scattering booleans across clients. Handle legacy snapshots explicitly: an old executing/unsubmitted checkpoint may also be ambiguous and must not be advertised as safely resendable merely because it lacks the new field.

Without a native idempotency primitive, do not promise absolute exactly-once UI execution. The achievable default is no blind automatic resend, durable reconciliation and explicit ambiguous outcomes.

## Recovery of long native queues

- Once submission is confirmed, restore observation of the same task/conversation; do not create a new conversation or change model as an automatic retry.
- Preserve an absolute deadline when one exists. An unlimited native queue wait must remain unlimited across gateway restarts.
- An observer budget limits the evidence collector, not the native task. On expiry save an incomplete receipt and exit observation unless cancellation was separately requested.
- Preserve the workspace lease while native work is queued, generating, awaiting interaction or uncertain after a crash.
- A dead PID, stale proof lock or lease heartbeat expiry permits recovery arbitration, not the assumption that native work disappeared.
- Commit terminal state/result and the existing parent/follow-up ownership markers before releasing ownership. Preserve durable event delivery and terminal retry retention.

## Proof runner repairs

P1: `requestWithRetry` can repeat a POST after a lost response. Persist a unique proof attempt and idempotency key before the first request. Pass that same identity to an endpoint with characterized persistent deduplication. Merely adding a header to an endpoint that ignores it is not a fix. Same key/different semantic input must conflict.

P2: `executeProof` currently checks for an idle runtime before branching to `resumeTaskId`. Fresh-run preflight should require no competing owner; resume preflight must permit the exact existing owner, verify marker/request/workspace/model binding and perform no new POST. Unrelated work remains a conflict.

Different proof markers must not bypass shared runtime ownership. Do not infer model identity from text the prompt explicitly asked the model to echo.

## Deterministic fault matrix

| Fault point | Expected behavior |
| --- | --- |
| Intent snapshot fails | Zero native sends |
| Intent durable, before send | Reconcile the owned conversation before choosing a first send |
| Native accepted, receipt not durable | Recover/adopt or remain uncertain; never blindly send twice |
| Submitted checkpoint durable | Resume observation, stable task/native identity |
| Response lost after HTTP acceptance | Retry returns the same task ID with one native send |
| Terminal commit/event delivery interrupted | Retained result and existing event-recovery rules remain correct |
| Resume while own native task is queued | Observer resumes, zero extra POSTs |
| Resume against a different owner | Explicit conflict, zero UI mutation |
| Two gateways, different store paths, same native runtime | Only one mutation owner |

Use fake drivers and injected write failures first, then process-kill tests with isolated state. Run focused gateway polling/restart/TaskStore/proof tests and the relevant integration suite. Keep the user's prior green suite as baseline; new tests must demonstrate the specific previously uncovered window.
