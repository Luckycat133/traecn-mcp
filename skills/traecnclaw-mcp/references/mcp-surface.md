# TRAECNclaw MCP Surface

Reference for selecting exact tools, configuring MCP clients, or auditing docs against the server. Written for any MCP-capable agent.

## Server

- Entrypoint: `mcp-server.js` (repo root)
- Skill launcher: `scripts/start-mcp.js` — auto-locates and starts the server, inheriting stdio for JSON-RPC
- Local gateway default: `http://127.0.0.1:8788`
- Start via skill: `node scripts/start-mcp.js`
- Start via npm: `npm run mcp`
- Package bin: `traecnclaw-mcp`
- Transport: stdio JSON-RPC
- Live tool list from code:

```bash
node -e "console.log(require('./mcp-server').MCP_TOOLS.map(t => t.name).join('\n'))"
```

## Client config

Copy [`assets/mcp-client-config.json`](../assets/mcp-client-config.json) into your client's config and replace `SKILL_DIR` with the absolute path to this skill folder. Two entry points are provided:

**Option A (recommended): skill launcher**

```json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["SKILL_DIR/scripts/start-mcp.js"],
      "env": {
        "TRAECN_HOST": "127.0.0.1",
        "TRAECN_PORT": "8788",
        "TRAECN_GATEWAY_TOKEN": "",
        "TRAECN_MCP_TOOL_PROFILE": "public"
      }
    }
  }
}
```

**Option B (fallback): direct mcp-server.js path**

```json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/absolute/path/to/TRAECNclaw/mcp-server.js"],
      "env": {
        "TRAECN_HOST": "127.0.0.1",
        "TRAECN_PORT": "8788",
        "TRAECN_GATEWAY_TOKEN": "",
        "TRAECN_MCP_TOOL_PROFILE": "public"
      }
    }
  }
}
```

For agents using the published package globally, set `command: "traecnclaw-mcp"` when the bin is on `PATH`. Keep `TRAECN_HOST`, `TRAECN_PORT`, and `TRAECN_GATEWAY_TOKEN` explicit so the agent does not infer unsafe remote access.

OpenClaw may use its own `mcp.servers` config shape and plugin wrapper tools. Generic stdio MCP clients should use the tool names returned by `tools/list`; those names are consistently prefixed with `traecn_` but are not guaranteed to match OpenClaw wrapper names.

## Tool profiles

`tools/list` is profile-scoped. Set `TRAECN_MCP_TOOL_PROFILE` in the MCP server environment:

| Profile | Count | Purpose |
| --- | ---: | --- |
| `public` | 20 | Default for published agent integrations. High-signal task, review, settings, dialog, and workflow tools. |
| `ops` | 32 | Adds recovery, cleanup, Solo conversation control, and long-queue proof tools. |
| `full` | 36 | Adds every explicit compatibility shortcut and diagnostic tool. Use for audits or clients that need exact old surface parity. |

The full command catalog remains available through `traecn_list_commands` and `traecn_run_command`, so agents can still reach stable lower-level command IDs without making `tools/list` noisy.

`traecn_get_capabilities` also returns each visible MCP tool with `layer`, `profile`, `risk`, optional `alternative`, and MCP-style annotations. Use that metadata to choose tools instead of matching names heuristically.

## Tool selection

| Goal | Prefer |
| --- | --- |
| Discover capabilities | `traecn_get_capabilities` |
| Plan side-effecting ops | `traecn_plan_operation` or `traecn_preflight` with `command`/`params` |
| Status, readiness, queue, dialog summary | `traecn_preflight` (one call) |
| Short task | `traecn_run_task` after a clean `traecn_preflight` |
| Long or queued task | `traecn_queue_task` → `traecn_wait_task` / `traecn_poll_task` |
| Queue state in `public` | `traecn_preflight`; use `traecn_get_queue_status` only in `full` |
| Code review | `traecn_review_code` |
| Model / mode / chat | `traecn_switch_model`, `traecn_switch_mode`, `traecn_create_chat` |
| Settings (stdio MCP) | `traecn_get_settings`, `traecn_set_setting` |
| Dialog (public) | `traecn_get_dialog_status`, `traecn_respond_dialog` |
| Dismiss dialog | `traecn_dismiss_dialog` (`full` only; prefer `traecn_respond_dialog`) |
| Status / queue shortcut | `traecn_get_status`, `traecn_get_queue_status` (`full` only; prefer `traecn_preflight`) |
| Stable command catalog | `traecn_list_commands` + `traecn_run_command` |
| Unattended workflow | `traecn_run_unattended_workflow` (public); direct Solo/proof/cleanup tools only from the profile that exposes them |

## Tool catalog

Each tool is tagged with a proficiency tier to guide adoption:

- **基础** — covers ~80% of daily automation; safe to start here
- **进阶** — adds environment control and review workflows
- **专家** — adds unattended automation, recovery, and diagnostics

### Discovery and planning

- `traecn_get_capabilities` **基础** · `public`: compact command, endpoint, model, settings, and recommended call-order catalog. One call replaces manual endpoint discovery.
- `traecn_preflight` **基础** · `public`: compact status, readiness, queue, dialog, and optional command-plan summary. Call before any side-effecting operation.
- `traecn_list_commands` **进阶** · `public`: stable command catalog for generic command routing.
- `traecn_run_command` **进阶** · `public`: execute a stable command ID from `traecn_list_commands`.
- `traecn_plan_operation` **进阶** · `public`: side-effect, confirmation, and preflight plan without operating TraeCN.

### Task execution

- `traecn_run_task` **基础** · `public`: submit a task and try to wait for the final result. Typical latency 10–30s.
- `traecn_queue_task` **基础** · `public`: submit a background task and return a `taskId`. Non-blocking.
- `traecn_poll_task` **基础** · `public`: inspect a queued task once. Use for non-blocking status checks.
- `traecn_wait_task` **基础** · `public`: wait locally for terminal state or a review/approval decision point. Blocks until done or gate.
- `traecn_cancel_task` **基础** · `public`: cancel a tracked task.
- `traecn_adopt_current_task` **专家** · `ops`: bind local tracking to an existing active TraeCN task.
- `traecn_stop_generation` **专家** · `ops`: stop the current TraeCN generation.

### Review and dialogs

- `traecn_review_code` **进阶** · `public`: produce a findings-first review task from code, diff, files, and focus.
- `traecn_get_dialog_status` **进阶** · `public`: inspect pending TraeCN dialogs.
- `traecn_respond_dialog` **进阶** · `public`: approve, deny, confirm, answer, or auto-handle a dialog.
- `traecn_get_review_gate_status` **专家** · `ops`: inspect review-required task state.
- `traecn_resolve_review_gate` **专家** · `ops`: approve or reject a review gate.
- `traecn_dismiss_dialog` **专家** · `full`: dismiss the current dialog. Prefer `traecn_respond_dialog`.

### TraeCN control

- `traecn_switch_model` **进阶** · `public`: switch the active model with fuzzy matching (exact → prefix → substring).
- `traecn_switch_mode` **进阶** · `public`: switch between Solo and IDE modes.
- `traecn_create_chat` **进阶** · `public`: create a new chat.
- `traecn_open_project` **进阶** · `public`: open a project path in TraeCN.
- `traecn_get_settings` **进阶** · `public`: read settings from the current or named section.
- `traecn_set_setting` **进阶** · `public`: set a setting by label and value.
- `traecn_get_status` **专家** · `full`: check gateway and TraeCN connection state. Prefer `traecn_preflight`.
- `traecn_get_queue_status` **专家** · `full`: inspect model queue state. Prefer `traecn_preflight`.

### Solo and unattended workflow

- `traecn_run_unattended_workflow` **专家** · `public`: run an unattended initial task plus follow-up tasks with auto-continue checkpoints. One call drives a multi-step pipeline.
- `traecn_list_solo_chats` **专家** · `ops`: list real Solo-mode conversations.
- `traecn_switch_solo_chat` **专家** · `ops`: switch to a Solo conversation by index or visible text.
- `traecn_cleanup_queue_probe_chats` **专家** · `ops`: find and optionally delete accidental queue-probe Solo conversations.
- `traecn_get_cleanup_watch_status` **专家** · `ops`: inspect cleanup watcher lock, PID, and stale status.
- `traecn_start_long_queue_proof` **专家** · `ops`: guarded GLM long-queue proof, dry-run by default.
- `traecn_get_long_queue_proof_status` **专家** · `ops`: inspect proof status without sending another prompt.
- `traecn_cancel_long_queue_proof` **专家** · `ops`: cancel marker-scoped proof watcher or task tracking.
- `traecn_submit_solo_task` **专家** · `full`: submit into a real Solo conversation and track the result. Prefer `traecn_queue_task` or `traecn_run_unattended_workflow`.

### Proficiency progression

```text
基础 (7 tools, public profile)
  traecn_get_capabilities → traecn_preflight → traecn_run_task → traecn_queue_task
  → traecn_poll_task → traecn_wait_task → traecn_cancel_task
  │
  └─ Master these first. They cover discovery, single-task execution, and queue management.
     Typical call count per session: 2–5. Latency: 10–30s per task.

进阶 (12 tools, public profile)
  traecn_list_commands / traecn_run_command → traecn_plan_operation
  → traecn_switch_model → traecn_switch_mode → traecn_review_code
  → traecn_get_settings / traecn_set_setting → traecn_get_dialog_status / traecn_respond_dialog
  │
  └─ Adds environment control, code review, and dialog handling.
     Typical call count per session: 5–15. Latency: 15–45s per review cycle.

专家 (16 tools, ops + full profiles)
  traecn_run_unattended_workflow → traecn_resolve_review_gate → batch operations
  → Solo control → long-queue proof → cleanup → diagnostics
  │
  └─ Adds unattended automation, batch processing, and recovery.
     Typical call count per session: 1–3 (workflow handles the rest). Latency: 2–10min per pipeline.
```

## Names not to call on stdio MCP

These belong to older notes or the OpenClaw plugin compatibility layer. Do not call them on the stdio MCP server directly:

- `traecn_settings_action`
- `traecn_settings_read`
- `traecn_approve_dialog`

Use `traecn_get_settings`, `traecn_set_setting`, `traecn_switch_model`, and `traecn_respond_dialog` instead.

## Source docs

Read these repo docs only when deeper details are needed:

- `docs/MCP-SERVER-GUIDE.md`: client configuration and environment variables.
- `docs/openclaw-command-set.md`: OpenClaw command router names and examples.
- `docs/OPENCLAW-MCP-SETUP.md`: OpenClaw-specific setup and troubleshooting.
- `docs/development.md`: verification and unattended workflow development notes.

## Error recovery

When a tool call fails, the JSON-RPC error object carries `code: -32000` and a human-readable `message`. Common recovery patterns:

| Error message pattern | Cause | Recovery |
| --- | --- | --- |
| `connect ECONNREFUSED 127.0.0.1:8788` | Gateway not running | `npm run start:gateway` |
| `connect ECONNREFUSED 127.0.0.1:9222` | TraeCN CDP port closed | Restart TraeCN with `--remote-debugging-port=9222` |
| `Unauthorized` / `401` | `TRAECN_GATEWAY_TOKEN` mismatch | Ensure the token matches between gateway and MCP client config |
| `Task not found` | Task ID expired or already completed | Call `traecn_preflight` to re-discover active tasks |
| `Dialog timeout` | No dialog appeared within the wait window | Retry `traecn_respond_dialog` or inspect with `traecn_get_dialog_status` |
| `Model queue full` | External model provider throttling | Wait, switch model via `traecn_switch_model`, or cancel via `traecn_cancel_task` |
| `ENOENT: mcp-server.js` | Launcher cannot locate the server | Set `TRAECN_MCP_SERVER_PATH` env var to the absolute path |

### Retry strategy

1. Call `traecn_preflight` to get a compact snapshot of connection, queue, and dialog state.
2. If `connected: false`, run `npm run doctor` and restart the gateway.
3. If a dialog is blocking, resolve it with `traecn_respond_dialog` before retrying the original task.
4. If the model queue is full, either wait, switch models, or cancel — do not retry blindly.
5. For unattended workflows, rely on `traecn_run_unattended_workflow`'s built-in auto-continue checkpoints instead of manual retry loops.
