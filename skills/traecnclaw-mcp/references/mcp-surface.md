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

### Discovery and planning

- `traecn_get_capabilities`: compact command, endpoint, model, settings, and recommended call-order catalog.
- `traecn_list_commands`: stable command catalog for generic command routing.
- `traecn_run_command`: execute a stable command ID from `traecn_list_commands`.
- `traecn_plan_operation`: side-effect, confirmation, and preflight plan without operating TraeCN.
- `traecn_preflight`: compact status, readiness, queue, dialog, and optional command-plan summary.

### Task execution

- `traecn_run_task`: submit a task and try to wait for the final result.
- `traecn_queue_task`: submit a background task and return a `taskId`.
- `traecn_poll_task`: inspect a queued task once.
- `traecn_wait_task`: wait locally for terminal state or a review/approval decision point.
- `traecn_adopt_current_task`: bind local tracking to an existing active TraeCN task. `ops`.
- `traecn_cancel_task`: cancel a tracked task.
- `traecn_stop_generation`: stop the current TraeCN generation. `ops`.

### Review and dialogs

- `traecn_review_code`: produce a findings-first review task from code, diff, files, and focus.
- `traecn_get_review_gate_status`: inspect review-required task state. `ops`.
- `traecn_resolve_review_gate`: approve or reject a review gate. `ops`.
- `traecn_get_dialog_status`: inspect pending TraeCN dialogs.
- `traecn_respond_dialog`: approve, deny, confirm, answer, or auto-handle a dialog.
- `traecn_dismiss_dialog`: dismiss the current dialog. `full`; prefer `traecn_respond_dialog`.

### TraeCN control

- `traecn_get_status`: check gateway and TraeCN connection state. `full`; prefer `traecn_preflight`.
- `traecn_switch_model`: switch the active model with fuzzy matching.
- `traecn_switch_mode`: switch between Solo and IDE modes.
- `traecn_create_chat`: create a new chat.
- `traecn_open_project`: open a project path in TraeCN.
- `traecn_get_settings`: read settings from the current or named section.
- `traecn_set_setting`: set a setting by label and value.
- `traecn_get_queue_status`: inspect model queue state. `full`; prefer `traecn_preflight`.

### Solo and unattended workflow

- `traecn_list_solo_chats`: list real Solo-mode conversations. `ops`.
- `traecn_switch_solo_chat`: switch to a Solo conversation by index or visible text. `ops`.
- `traecn_submit_solo_task`: submit into a real Solo conversation and track the result. `full`; prefer `traecn_queue_task` or `traecn_run_unattended_workflow`.
- `traecn_run_unattended_workflow`: run an unattended initial task plus follow-up tasks with auto-continue checkpoints.
- `traecn_cleanup_queue_probe_chats`: find and optionally delete accidental queue-probe Solo conversations. `ops`.
- `traecn_get_cleanup_watch_status`: inspect cleanup watcher lock, PID, and stale status. `ops`.
- `traecn_start_long_queue_proof`: guarded GLM long-queue proof, dry-run by default. `ops`.
- `traecn_get_long_queue_proof_status`: inspect proof status without sending another prompt. `ops`.
- `traecn_cancel_long_queue_proof`: cancel marker-scoped proof watcher or task tracking. `ops`.

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
