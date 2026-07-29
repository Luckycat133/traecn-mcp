---
name: traecnclaw-mcp
description: Use when an MCP-capable agent must connect, configure, operate, test, or document TRAECNclaw's stdio MCP server for TraeCN automation, OpenClaw integration, unattended vibe workflows, settings/model/dialog control, code review delegation, or long-queue proof runs. Prefer this skill whenever the agent needs the real MCP tool surface instead of direct browser/GUI control.
license: MIT
compatibility: Requires Node.js 22+, a running TraeCN IDE instance with CDP remote debugging on port 9222, and the local TRAECNclaw HTTP gateway on 127.0.0.1:8788. Use `npm run doctor` to verify readiness.
metadata:
  author: TRAECNclaw
  version: "0.4.0"
---

# TRAECNclaw MCP

Drive TraeCN through its real stdio MCP server, backed by the local HTTP gateway and CDP automation. Client-neutral: works for any agent that can call stdio MCP tools.

## When to use

The skill organizes TraeCN automation into three proficiency tiers. Each tier builds on the previous one — start at **Fundamental** and advance as your workflow demands more autonomy.

| Tier | Capabilities | Typical tools | Use case |
| --- | --- | --- | --- |
| **Fundamental** · covers ~80% of daily tasks | Discover capabilities; preflight before acting; run a task and get text back; queue long tasks; poll or wait for completion; cancel stale tasks | `traecn_get_capabilities`, `traecn_preflight`, `traecn_run_task`, `traecn_queue_task`, `traecn_poll_task`, `traecn_wait_task`, `traecn_cancel_task` | "分析这个项目的架构" → preflight + run_task → get a structured summary in ~2 calls |
| **Intermediate** · adds environment control | Switch model with fuzzy matching; toggle Solo/IDE mode; read/write settings; resolve confirmation dialogs; delegate code review | `traecn_switch_model`, `traecn_switch_mode`, `traecn_get_settings`, `traecn_set_setting`, `traecn_respond_dialog`, `traecn_review_code` | "切换到 GLM-5.2 并审查 auth 模块安全性" → model switch + findings-first review |
| **Advanced** · adds unattended automation | Run multi-step vibe workflows with auto-continue; long-queue proof runs; batch task execution with per-task error isolation; resolve review gates; MCP client configuration for any agent | `traecn_run_unattended_workflow`, `traecn_start_long_queue_proof`, `batch.runTasks`, `traecn_resolve_review_gate`, `traecn_plan_operation` | "修复登录页样式 → 补充快照测试 → 更新 CHANGELOG" → 3-step unattended pipeline with review gates |

**Scope rule:** Do NOT use this skill for direct browser automation or GUI clicking when an MCP tool exists. Prefer the MCP surface whenever the server can perform the operation — it is faster, more reliable, and leaves an auditable JSON-RPC trail.

## Workflow

1. Confirm Node 22+ and the gateway can reach TraeCN.
2. Discover before acting: `tools/list` → `traecn_get_capabilities` → `traecn_preflight` with the intended command/params.
3. For side effects, honor the `traecn_preflight` or `traecn_plan_operation` result (confirmation, readiness, queue, dialog) before operating.
4. Use `traecn_list_commands` + `traecn_run_command` only when a client needs the stable command catalog rather than per-tool MCP names.
5. Start the gateway separately: `npm run start:gateway` (or `TRAECN_ENABLE_MOCK_BRIDGE=1 npm run start:gateway` for mock mode).
6. For exact tool names, profiles, and MCP client config JSON, read [references/mcp-surface.md](references/mcp-surface.md).

## Start the MCP server

Use the bundled launcher so the server inherits stdio for JSON-RPC:

```bash
node scripts/start-mcp.js
```

The launcher auto-locates `mcp-server.js` from the repo root. Set `TRAECN_MCP_SERVER_PATH` to override. For MCP client config templates (Cursor, Claude Desktop, Cline, Windsurf), copy [assets/mcp-client-config.json](assets/mcp-client-config.json) and replace `SKILL_DIR` with the absolute path to this skill folder.

## Profile choice

`TRAECN_MCP_TOOL_PROFILE` scopes `tools/list`:

| Profile | Tools | Use |
| --- | ---: | --- |
| `public` | 20 | Default for published agent integrations |
| `ops` | 32 | Recovery, cleanup, Solo control, long-queue proof |
| `full` | 36 | Audits, compatibility checks, every explicit shortcut |

The full command catalog stays reachable via `traecn_list_commands` / `traecn_run_command` regardless of profile.

## Application examples

### Fundamental: single-shot task execution

```text
Goal: get a project architecture summary
Calls: 2 (preflight + run_task)
Latency: ~10–30s depending on model

1. traecn_preflight({ command: 'delegate', params: { task: '分析架构' } })
   → verify connected: true, queue: ready
2. traecn_run_task({ task: '分析这个项目的架构', projectPath: '/workspace/my-project' })
   → returns { ok: true, text: '<structured summary>', elapsed: 12000 }
```

### Intermediate: model-aware code review

```text
Goal: review auth module security with a specific model
Calls: 3 (switch_model + review_code + get_dialog_status)
Latency: ~15–45s

1. traecn_switch_model({ model: 'glm' })          → fuzzy-matches GLM-5.2
2. traecn_review_code({
     instruction: '审查 auth 模块的安全性',
     files: ['src/shared/mcp-auth.js'],
     focus: ['safety', 'tests']
   })                                               → findings-first review task
3. If a confirmation dialog appears:
   traecn_get_dialog_status() → traecn_respond_dialog({ action: 'trust' })
```

### Advanced: unattended multi-step workflow

```text
Goal: fix login page → add snapshot tests → update changelog (unattended)
Calls: 1 (run_unattended_workflow handles the rest)
Latency: 2–10min depending on step complexity

1. traecn_run_unattended_workflow({
     task: '修复登录页样式',
     steps: ['补充快照测试', '更新 CHANGELOG'],
     reviewRequired: true
   })
   → returns { taskId, queued: true }
2. traecn_wait_task(taskId) → blocks until terminal state or review gate
3. If review gate triggers: traecn_resolve_review_gate({ decision: 'approve' })
```

## Safety rules

- Keep the gateway bound to `127.0.0.1` unless remote access is intentionally required.
- Never commit `.env`, tokens, auth headers, raw TraeCN profile data, `audit-logs/`, `demo-output/`, `logs/`, or `node_modules/`.
- Prefer MCP/HTTP/CLI surfaces over GUI-control paths whenever the MCP server can perform the operation.
- Treat live dialog text, gateway health, cleanup state, and external model queue behavior as environment-specific until revalidated.

## Troubleshooting

| Symptom | Likely cause | Recovery |
| --- | --- | --- |
| `[traecnclaw-mcp] mcp-server.js not found.` | Skill installed outside the repo without `TRAECN_MCP_SERVER_PATH` | Set `TRAECN_MCP_SERVER_PATH` to the absolute path of `mcp-server.js` |
| `[traecnclaw-mcp] Failed to load mcp-server.js:` | Node version < 22 or missing dependencies | Run `npm install` in the repo root; verify `node --version` ≥ 22 |
| `[traecnclaw-mcp] Failed to set working directory:` | Repo root removed or permissions changed | Reinstall the repo; ensure the process has read/execute access |
| MCP client shows no tools | Wrong `TRAECN_MCP_TOOL_PROFILE` or gateway not running | Start gateway (`npm run start:gateway`), then restart the MCP client |
| `traecn_preflight` returns `connected: false` | TraeCN IDE not running or CDP port closed | Start TraeCN with `--remote-debugging-port=9222`; run `npm run doctor` |
| Tasks stuck in `queued` | Model queue full or TraeCN unresponsive | Use `traecn_get_queue_status` (profile `full`) or `traecn_preflight` to inspect; cancel with `traecn_cancel_task` |
| Dialog blocking task flow | Pending confirmation dialog in TraeCN | Call `traecn_get_dialog_status` then `traecn_respond_dialog` with the appropriate action |
| Process lingers after client disconnect | SIGTERM not forwarded by client | The launcher now handles `SIGINT`/`SIGTERM`; if the issue persists, kill the process manually |

## Validation

- `npm run doctor` — local environment readiness.
- `npm test` — maintained in-repo test sequence.
- `npm run acceptance:audit -- --require-complete` — before claiming unattended end-to-end readiness.
- `npm run test:all` — release-style changes when practical.
- `node -e "console.log(require('./mcp-server').MCP_TOOLS.map(t => t.name).join('\n'))"` — verify live tool list from code.
