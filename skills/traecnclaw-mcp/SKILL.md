---
name: traecnclaw-mcp
description: Use when an MCP-capable agent must connect, configure, operate, test, or document TRAECNclaw's stdio MCP server for TraeCN automation, OpenClaw integration, reviewed or unattended multi-step workflows, settings/model/dialog control, code review delegation, queue recovery, or long-queue proof runs. Prefer this skill whenever the agent needs the real MCP tool surface instead of direct browser or GUI control.
license: MIT
compatibility: Requires Node.js 22+, a running TraeCN IDE instance with CDP remote debugging on port 9222 for live operations, and the local TRAECNclaw HTTP gateway on 127.0.0.1:8788. Use `npm run doctor` to verify readiness.
metadata:
  author: TRAECNclaw
  version: "0.5.0"
---

# TRAECNclaw MCP

Drive TraeCN through the real stdio MCP server backed by the local HTTP gateway and CDP automation. Discover the current tool surface before acting, preflight side effects, and keep gateway task checkpoints distinct from TraeCN's internal keep/revert gate.

## Start here

1. Confirm Node.js 22+ and run `npm run doctor` from the repository.
2. Copy [assets/mcp-client-config.json](assets/mcp-client-config.json), replace `SKILL_DIR` with this skill folder's absolute path, and keep only its single `traecn` server entry.
3. If the launcher cannot locate the repository, add `TRAECN_MCP_SERVER_PATH` to that entry's `env` with the absolute path to `mcp-server.js`. Alternatively use the separate [direct-path template](assets/mcp-client-config.direct.json); do not enable both entries.
4. Start the gateway separately with `npm run start:gateway`. Use `TRAECN_ENABLE_MOCK_BRIDGE=1 npm run start:gateway` only for mock development; mock success is not live TraeCN evidence.
5. Restart or reconnect the MCP client after changing `TRAECN_MCP_TOOL_PROFILE`.
6. Discover before acting: `tools/list` → `traecn_get_capabilities` → `traecn_preflight` with the intended stable command and params.

## Profiles

Profile counts are derived from the current server and guarded by tests:

| Profile | Tools | Use |
| --- | ---: | --- |
| `public` | 23 | Normal task, event, review, settings, dialog, model, and workflow operations |
| `ops` | 35 | Adds recovery, cleanup, Solo control, and long-queue proof tools |
| `full` | 39 | Adds every explicit diagnostic and compatibility shortcut |

Profiles control discovery noise, not authorization. Calls still require the configured gateway and MCP permissions.

## Choose the operation

- Short task: `traecn_preflight` → `traecn_run_task`.
- Long task: `traecn_preflight` → `traecn_queue_task` → `traecn_wait_task` or `traecn_poll_task`; keep using the same `taskId` instead of resubmitting.
- IDE completion delivery: rely on compact stdio `notifications/message` when the client displays MCP logging; otherwise use `traecn_list_task_events` and acknowledge successful delivery with `traecn_ack_task_event`. Fetch full results by `taskId` only when needed.
- Code review: `traecn_switch_model` when needed, then `traecn_review_code` with findings-first instructions.
- Workspace selection: `traecn_open_project` reuses and verifies the active
  TraeCN window by default; pass `newInstance:true` only for a separate window.
- Fully automatic multi-step workflow: `traecn_run_unattended_workflow`; omit `autoContinue` or set it to `true`.
- Human-reviewed multi-step workflow: call the same workflow tool with `reviewRequired:true` and `autoContinue:false`, wait for `awaiting_review`, then use `traecn_resolve_task_review`.
- Batch commands: call `traecn_list_commands`, verify the stable `batch_submit` command, then use `traecn_run_command`. Do not treat JavaScript SDK helpers as stdio MCP tools.
- Exact schemas: search [generated MCP contracts](references/mcp-tool-contracts.json) for the tool name. Copy validated examples from [MCP call examples](references/mcp-call-examples.json).

`projectPath` is an optional gateway workspace guard, not prompt content. An
agent may pass it without spending model tokens: the gateway compares it with
the workspace path open in TraeCN, rejects a mismatch as `PROJECT_NOT_OPEN`,
and sends only the original task text. Omit it only when no workspace guard is
needed.

## Correct call contracts

Switch models with the dedicated MCP field `name`:

```json
{"name":"GLM-5.2","waitForQueue":false}
```

For a reviewed workflow, submit and wait:

```json
{
  "task": "修复登录页样式",
  "steps": ["补充快照测试", "更新 CHANGELOG"],
  "reviewRequired": true,
  "autoContinue": false
}
```

```json
{"taskId":"TASK_ID","pollMs":5000,"timeoutMs":600000}
```

When the task reaches `awaiting_review`, approve or reject that gateway checkpoint:

```json
{"taskId":"TASK_ID","decision":"approve","notes":"Reviewed generated changes"}
```

The response may return `nextTaskId`; wait on that new ID for the next step. Valid decisions are `approve`, `continue`, and `reject`.

## Do not mix the two review mechanisms

| Mechanism | Status/tool | Resolver contract | Profile |
| --- | --- | --- | --- |
| Gateway task checkpoint | `traecn_wait_task` reports `awaiting_review` | `traecn_resolve_task_review({taskId, decision, notes?})` | `public` |
| TraeCN internal keep/revert gate | `traecn_get_review_gate_status` | `traecn_resolve_review_gate({action})`, where action is `keep_all`, `revert_all`, `keep`, or `discard` | `ops` |

The second mechanism controls TraeCN's own UI review state; it does not approve a gateway workflow checkpoint.

## Safety and recovery

- Keep the gateway on `127.0.0.1` unless remote access is intentionally secured.
- Never commit `.env`, tokens, authorization headers, raw TraeCN profiles, `audit-logs/`, `demo-output/`, `logs/`, or `node_modules/`.
- Call `traecn_plan_operation` or `traecn_preflight` before side effects and honor readiness, confirmation, queue, and dialog results.
- Inspect a dialog with `traecn_get_dialog_status` before choosing a `traecn_respond_dialog` action.
- Treat an active inline command card as a dialog. Use `action:"auto"` first:
  the local classifier approves read-only chains without model tokens. If it
  returns `approvalDecision:"agent_review"`, review only the compact command
  and reason codes, then use `action:"approve"` or `action:"deny"`; do not
  request human confirmation.
- Keep long-queue proof in dry-run by default. A new quota-spending submission requires both `execute:true` and `allowQuotaSpend:true` and the `ops` profile.
- Treat queued, `awaiting_review`, timed-out, and mock results as non-terminal unless the returned status proves completion.
- Treat completion percentages below 100 as non-terminal, even when the label contains `任务完成`.
- Do not fall back to GUI control when an MCP or HTTP surface exists.

## Troubleshooting order

| Symptom | Diagnose first | Recovery |
| --- | --- | --- |
| MCP client cannot initialize or shows no tools | Client config, absolute launcher path, Node 22+, stderr, stdio framing | Run the bundled launcher test and Content-Length smoke test; restart the MCP client |
| `tools/list` works but gateway calls return `ECONNREFUSED 127.0.0.1:8788` | Gateway process | Start the gateway; tool discovery itself does not require it |
| HTTP 401 / unauthorized | Gateway token mismatch | Make client and gateway tokens match, then reconnect |
| Gateway responds but `connected:false` / CDP unavailable | TraeCN process and port 9222 | Start TraeCN with remote debugging and run `npm run doctor` |
| `ready:false`, dialog, or queue busy | Preflight readiness/dialog/queue fields | Resolve the concrete blocker, wait, switch model, or cancel the known task ID |
| Launcher cannot find `mcp-server.js` | Skill installed outside the repository | Set absolute `TRAECN_MCP_SERVER_PATH` or use the direct-path template |

## Validation

- `npm run check:skill-contracts` — verify generated schemas and examples match the live MCP implementation.
- `node skills/traecnclaw-mcp/scripts/start-mcp.test.js` — launcher unit tests.
- From a source checkout, run `npm run test:mcp-stdio-smoke` for a standalone Content-Length `initialize` + `tools/list` smoke test; it does not require the gateway.
- `npm test` — maintained repository suite, including the skill contract and launcher tests.
- `npm run acceptance:audit -- --require-complete` — required before claiming unattended live end-to-end readiness.
- `npm run test:all` — release-style validation when practical.

Read [references/mcp-surface.md](references/mcp-surface.md) for the full operating map and recovery detail. Latency is environment- and model-dependent; examples are not an SLA.
