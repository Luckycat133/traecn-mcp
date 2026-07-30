# TRAECNclaw MCP Surface

Use this reference to choose exact tools, configure a generic stdio MCP client, and recover failures without falling back to GUI control.

## Server and generated contracts

- Entrypoint: repository-root `mcp-server.js`
- Skill launcher: `scripts/start-mcp.js`
- Gateway default: `http://127.0.0.1:8788`
- Transport: stdio JSON-RPC with Content-Length framing
- Package bin: `traecnclaw-mcp`
- Exact generated tool schemas: [mcp-tool-contracts.json](mcp-tool-contracts.json)
- Schema-validated calls: [mcp-call-examples.json](mcp-call-examples.json)

Regenerate and check the contract after MCP changes:

```bash
npm run sync:skill-contracts
npm run check:skill-contracts
```

## Client configuration

Use [the launcher template](../assets/mcp-client-config.json) for source checkouts. It contains one enabled server. Replace `SKILL_DIR` with the absolute skill directory.

If the skill is installed outside the repository, add this environment entry to the launcher configuration:

```json
"TRAECN_MCP_SERVER_PATH": "/absolute/path/to/TRAECNclaw/mcp-server.js"
```

Alternatively use [the direct-path template](../assets/mcp-client-config.direct.json). Choose one template; registering both starts duplicate servers and leaves one dependent on a placeholder path.

For a globally installed package, use `"command":"traecnclaw-mcp"` when the bin is on `PATH`. Keep host, port, token, and profile explicit.

## Tool profiles

`TRAECN_MCP_TOOL_PROFILE` is read when the stdio server starts. Restart or reconnect the client after changing it.

| Profile | Current count | Purpose |
| --- | ---: | --- |
| `public` | 23 | Default task, event, review, settings, dialog, model, and workflow surface |
| `ops` | 35 | Public plus recovery, cleanup, Solo conversation, and proof operations |
| `full` | 39 | Ops plus every explicit diagnostic and compatibility shortcut |

Use `traecn_get_capabilities` for runtime counts and metadata. Profiles reduce discovery noise; they are not an authorization boundary.

## Discovery and planning

- `traecn_get_capabilities`: compact endpoint, command, profile, risk, and recommended-order catalog.
- `traecn_list_commands`: stable command IDs, including lower-level batch actions.
- `traecn_run_command`: invoke a stable command after checking its required fields.
- `traecn_plan_operation`: compute risk, side effects, confirmation, and preflight steps without changing TraeCN.
- `traecn_preflight`: summarize gateway, readiness, queue, dialog, and optional command-plan state.

Start side-effecting sequences with `traecn_preflight` or `traecn_plan_operation` and honor the returned result.

## Task execution

- `traecn_run_task`: submit a short task and wait when possible.
- `traecn_queue_task`: submit background work and return a `taskId`.
- `traecn_poll_task`: inspect one task once.
- `traecn_wait_task`: wait on one `taskId` until terminal or decision-required state.
- `traecn_list_task_events`: long-poll compact durable events for a stable IDE client cursor.
- `traecn_ack_task_event`: advance that cursor only after successful delivery.
- `traecn_resolve_task_review`: approve, continue, or reject a gateway task in `awaiting_review`.
- `traecn_cancel_task`: cancel a known tracked task.
- `traecn_adopt_current_task` (`ops`): recover tracking without resending a prompt.
- `traecn_stop_generation` (`ops`): stop current generation or queued model work.

Do not resubmit the same prompt merely because a wait timed out. Poll or wait on the same `taskId`, preflight current state, adopt only when the original task is visible, and cancel only a known target.

After MCP initialization, the stdio server emits standard
`notifications/message` records from the same durable inbox. Set a unique,
stable `TRAECN_MCP_CLIENT_ID` per IDE connection when the MCP client name is not
unique. Notifications carry only compact status and summary fields; retrieve a
full answer with `traecn_poll_task`. Displaying or inserting the notification in
a specific IDE chat depends on that IDE's MCP adapter.

## Code review and dialogs

- `traecn_review_code`: build a findings-first review from instruction, files, code, diff, and focus.
- `traecn_get_dialog_status`: inspect the actual pending question and available actions.
- `traecn_respond_dialog`: use `action:"auto"` for token-free local approval
  of read-only command chains. Risky or unknown commands return compact
  calling-agent review fields; approve, deny, confirm, answer, or dismiss after
  inspection without requesting human confirmation.
- `traecn_dismiss_dialog` (`full`): compatibility shortcut; prefer the public responder.

Model switching uses the dedicated MCP argument `name`, while the stable `switch_model` command uses its catalog field `model`. Do not transfer parameter names between the explicit MCP tool and the command catalog.

```json
{
  "name": "GLM-5.2",
  "waitForQueue": false
}
```

## Two distinct review mechanisms

### Gateway task checkpoint

This checkpoint belongs to TRAECNclaw's background workflow state machine.

1. Submit with `reviewRequired:true` and `autoContinue:false`.
2. Wait until `traecn_wait_task` returns `awaiting_review`.
3. Inspect the task result.
4. Call `traecn_resolve_task_review` with the same `taskId` and `decision` equal to `approve`, `continue`, or `reject`.
5. If approval returns `nextTaskId`, wait on that new task.

This complete path is available in `public`.

### TraeCN internal keep/revert gate

This is a TraeCN UI state exposed for operational recovery:

- Inspect: `traecn_get_review_gate_status` (`ops`).
- Resolve: `traecn_resolve_review_gate` (`ops`) with `action` equal to `keep_all`, `revert_all`, `keep`, or `discard`.

These tools do not approve a gateway `awaiting_review` task.

## Multi-step workflows

`traecn_run_unattended_workflow` accepts an initial `task`, `steps` or `followupTasks`, and the same queue/review controls as background delegation.

- Omit `autoContinue` or set it to `true` for automatic progression.
- Set `reviewRequired:true` and `autoContinue:false` for a human checkpoint after each reviewable step.
- Use object steps when a step needs its own `reviewRequired`, `autoContinue`, `includeProcessText`, or `completionChecks` value.
- The returned task ID identifies only the current step; approvals can return the next step's ID.

The name remains for compatibility, but explicit `autoContinue:false` now takes precedence instead of being overwritten.

For `traecn_submit_solo_task`, `projectPath` is an optional gateway guard. The
gateway compares it with the workspace path open in TraeCN and returns
`PROJECT_NOT_OPEN` on mismatch. It never expands the path into visible prompt
text, so callers can use the guard without spending model tokens.

## Batch operations

Batch execution belongs to the stable command catalog rather than the explicit MCP tool list:

1. Call `traecn_list_commands`.
2. Confirm the current `batch_submit`, `batch_status`, and `batch_cancel` definitions.
3. Call `traecn_run_command` with the chosen command and its catalog params.

JavaScript wrapper methods documented elsewhere are not callable stdio MCP tool names.

## TraeCN control

- `traecn_switch_model`: fuzzy model matching; required field `name`.
- `traecn_switch_mode`: switch `solo` / `ide`.
- `traecn_create_chat`: create a chat.
- `traecn_open_project`: open a local path. When TraeCN is already running,
  the default reuses the active window and verifies the exact path; pass
  `newInstance:true` only for a separate window.
- `traecn_get_settings` / `traecn_set_setting`: read or update settings.
- `traecn_get_status` and `traecn_get_queue_status` (`full`): compatibility diagnostics; prefer `traecn_preflight`.

## Long-queue proof and cleanup

- `traecn_start_long_queue_proof` (`ops`) is dry-run by default.
- A new quota-spending submission requires `execute:true` and `allowQuotaSpend:true` together.
- `traecn_get_long_queue_proof_status` (`ops`) reads evidence without sending a prompt.
- `traecn_cancel_long_queue_proof` (`ops`) cancels marker-scoped tracking.
- `traecn_cleanup_queue_probe_chats` (`ops`) should be run dry-first.
- `traecn_get_cleanup_watch_status` (`ops`) reads local watcher state.

Do not claim a live long-queue proof passed unless the acceptance evidence is complete.

## Layered troubleshooting

| Layer | Evidence | Recovery |
| --- | --- | --- |
| Client / stdio | MCP process fails, initialize fails, or `tools/list` is absent/empty | Check Node 22+, absolute command/args, stderr, Content-Length framing, and client restart |
| Tool profile | Tools list works but expected ops/full tool is absent | Change profile and restart/reconnect the MCP server |
| Gateway | Tools exist but a call reports `ECONNREFUSED 127.0.0.1:8788` | Start the gateway; tools/list does not depend on it |
| Authentication | HTTP 401 / unauthorized | Align gateway and client token values |
| CDP / TraeCN | Gateway responds but reports disconnected or CDP unavailable | Start TraeCN with port 9222 and run `npm run doctor` |
| Readiness | Connected but `ready:false` / `canDelegate:false` | Follow the returned readiness, queue, and dialog actions |
| Workflow | `queued`, `approval_required`, or `awaiting_review` | Keep the task ID, resolve the actual blocker, then wait again |

## Names not to call on stdio MCP

Older notes and OpenClaw wrappers may use names such as `traecn_settings_action`, `traecn_settings_read`, or `traecn_approve_dialog`. For stdio MCP use the names returned by `tools/list`, including `traecn_get_settings`, `traecn_set_setting`, `traecn_switch_model`, and `traecn_respond_dialog`.

## Validation boundary

- `npm run doctor` checks the local environment but may legitimately warn when gateway/CDP are offline.
- From a source checkout, `npm run test:mcp-stdio-smoke` checks stdio `initialize` and `tools/list` independently of the gateway.
- `npm test` covers the launcher, protocol smoke test, schema generation, and repository behavior.
- `npm run acceptance:audit -- --require-complete` is required before claiming live unattended readiness.
- Report measured latency with environment and sample count. Do not present example ranges as an SLA.
