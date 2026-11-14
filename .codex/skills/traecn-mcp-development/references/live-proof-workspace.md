# Real GLM-5.2 receipts and workspace protection

This is the next implementation/acceptance design, not a record of a task run. The current docs update sends no real prompt. Historical GLM-5.2 reports remain valid within their recorded revision/environment; a new branch claim needs its own receipt.

## Before a real run

Finish the deterministic dispatch/retry/resume tests in [task recovery](task-recovery.md). Use an isolated disposable workspace and a known state directory. Keep the user's logged-in Trae profile; do not change accounts, create competing runtimes or erase queues for a clean-looking report.

Record the local tested Git SHA and dirty file hashes, installed artifact hash, Node version, gateway PID/start time, Trae application version, adapter family, CDP Browser/User-Agent, profile/runtime identity and native target attachment generation. Application version, editor/engine version and `traecn-1.107` adapter family are separate fields.

Read the current script's options and dry-run output. Useful existing non-submitting entry points are `npm run proof:status` and `npm run proof:long-queue` without execute flags. Do not invent a new CLI command before it is implemented. No fresh run should automatically fall back from GLM-5.2 to another model.

## Evidence levels: report separately

| Level | Claim | Required evidence |
| --- | --- | --- |
| E0 | Local Skill/contract/tests agree | Supplied PASS results plus revision/log association when available |
| E1 | Real desktop is ready | Exact runtime, workspace, adapter, mode and available UI model selection; no mock |
| E2 | One real GLM-5.2-selected task completes | One native user turn, stable task/conversation IDs, selected-model UI evidence and native/result agreement |
| E3 | Actual long queue observed | Native queue observations and measured queue-entry to generation-start interval |
| E4 | Gateway crash recovery preserves ownership | Pre/post checkpoint, same task/conversation, no extra native user turn, eventual result |
| E5 | Workspace switching cannot redirect owned work | A-busy/B-switch conflict, manual-drift pause, and B allowed after A's durable completion |

Each level is `PASS`, `FAIL`, `NOT_OBSERVED` or `BLOCKED`, with a reason. A quick successful answer is E2, not E3. Sleeps, fake queue text and model statements about themselves do not establish E3. A UI-selected model proves selection/label evidence, not an independently attested proprietary backend identity.

## One useful task, one attempt

Prefer a bounded read-only task over a disposable fixture containing a random run nonce and deterministic content. Ask for a verifiable answer grounded in that fixture, not a promise to be the requested model. Validate the nonce, expected answer and exact native final turn independently of response length/completion phrases.

Freeze requestedModel, observedSelectedModel, mode, real workspace key, taskId, native conversation ID, attempt ID, request fingerprint and pre-send native user-turn boundary. Capture model selection before send and after any reconnection. If model fallback occurs, label the run accordingly rather than calling it a GLM-5.2 pass.

Persist the attempt/key before POST; use the same key on an uncertain retry. Resuming an existing task verifies its ownership and sends no new task. Do not use a reused default marker as the only identity across runs.

For queue evidence, predeclare the interval used to label a queue as long, record actual timestamps and native queue state transitions, and report `NOT_OBSERVED` when unavailable. No repeated paid probes merely to obtain a long wait.

For the first real crash test, kill only the proof-owned gateway after a confirmed durable native receipt, leaving Trae running. Recover with the same state and verify one original native submission. The narrow post-send/pre-checkpoint window is first proven deterministically with injected drivers, not by repeatedly gambling with real model requests.

## Receipt bundle

Suggested ignored output directory: `logs/proofs/<runId>/`.

```text
manifest.json          source/artifact/runtime/model/context identities
request.json           frozen input, attempt/key and fingerprint
checkpoints.jsonl      durable intent, native receipt, restart and transitions
events.jsonl           timestamped observations and cursor identities
snapshots/             minimal native DOM/text evidence at transitions
screenshots/           selected model, real queue, final turn when needed
final.native.txt       normalized native final answer
final.mcp.json         matching gateway/MCP task result
checks.json            independent E0..E5 verdicts and reasons
SHA256SUMS             bundle integrity, not proof of truth by itself
```

Record wall-clock UTC and process-local monotonic durations; do not compare monotonic values across processes. Include the last verified state when interrupted. Strip credentials and unrelated content, retaining enough native identity to correlate evidence. Do not commit raw profiles or full private conversations.

Adaptive observation should use existing events when available, plus bounded reads with backoff/Retry-After. It must not repeatedly click the model or conversation menus, steal UI focus or spin tight Agent polling loops.

## Multi-workspace v1: one mutation owner per native runtime

Choose serialization before attempting several independent Trae windows in parallel. A gateway-wide short mutex alone is insufficient: A's native queue can remain active long after its original HTTP handler returns.

Persist an ownership record with:

```text
runtimeId / profile identity
workspaceKey / canonical roots
ownerTaskId / nativeConversationId
submissionAttemptId
contextGeneration / ownerEpoch
acquiredAt / lastVerifiedAt
state / releaseReason
```

Use realpath-aware workspace identity. Equal folder names do not mean equal workspaces; symlink aliases may represent the same workspace. Preserve case semantics. For a multi-root workspace, bind the workspace file plus normalized root identities. A CDP target ID is an attachment identity that may change on restart, not the sole durable workspace identity.

All mutation paths consult one application guard: MCP workspace/model/mode/conversation tools, web routes, operator CLI/REST, reuse-window project opening, internal preparation, approvals and send/collect transitions. Do not rely on disabled web controls.

### Switching rules

- Same verified workspace and unchanged context: idempotent no-op; do not reopen its window.
- Different workspace while an owner is queued/running/awaiting interaction/reconciling: return a conflict with the blocking task and next action; do not switch or cancel it implicitly.
- Pending work for B may wait behind A without mutating A's context.
- Reads and exact-owner cancellation remain available. UI-backed reads still use appropriate short serialization.
- Release or transfer ownership only after the current terminal checkpoint and parent/follow-up semantics are durable.
- Human manual context changes cannot be prevented by a gateway mutex. Detect them, invalidate the context generation and pause native mutation/collection until the original binding is reconciled.
- Old asynchronous callbacks check the current epoch before side effects or collection. Do not overwrite the user's newly selected workspace just to hide drift.
- A second gateway using another persistence path must not acquire the same native runtime for mutation. Runtime ownership is not merely a snapshot-file lock.

Suggested internal outcomes such as `WORKSPACE_BUSY` and `CONTEXT_CHANGED` are design names, not claims of existing public codes. Implement their mappings through current error/result schemas and keep the 20-tool surface unchanged.

## Acceptance matrix

Test A queued -> B switch through MCP, web, CLI/REST and internal preparation: conflict and zero B mutation. Repeat for generating, approval wait, cancellation checkpoint and uncertain submission. Then complete A durably: B switch and verified readback succeed.

Also test same-title/different-path workspaces; same-path symlink aliases; a multi-root project; target recreation; browser reconnect; a manual workspace change; stale callbacks; two gateways with distinct stores; and recovery of an owned queued task. Bind results to A even when B contains similar messages. First prove with injected clocks/drivers, then capture a small authorized real scenario from a second client.
