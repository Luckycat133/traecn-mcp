---
name: traecnclaw-mcp
description: Use when any MCP-capable AI agent needs to connect, configure, operate, test, or document TRAECNclaw's stdio MCP server for TraeCN automation, OpenClaw integration, unattended vibe workflows, settings/model/dialog control, code review delegation, or long-queue proof runs. Prefer this skill when an agent needs the real MCP tool surface rather than direct browser or GUI control.
---

# TRAECNclaw MCP

## Overview

Use TRAECNclaw through its real stdio MCP server, backed by the local HTTP gateway and TraeCN CDP automation. Keep this skill portable across agents: discover current capabilities from the server, call compact readiness tools before side effects, and verify claims with repo scripts or MCP responses.

## Agent Contract

- Treat this as a client-neutral skill for any agent that can read instructions and call stdio MCP tools.
- Do not depend on Codex-only tools, browser automation, Computer Use, or manual UI control when the MCP server can perform the operation.
- Use the MCP tool names returned by `tools/list`; the stdio MCP surface uses `traecn_*` names that may differ from OpenClaw wrapper names and stable command IDs.
- Prefer machine-readable outputs (`traecn_get_capabilities`, `traecn_preflight`, task status, proof status) over prose screenshots or manual observation.
- Keep generated client config examples editable by the caller: always use absolute paths for local checkouts and documented env vars for host, port, and token.
- Treat `tools/list` as profile-scoped. Default `public` exposes the common 20 tools; `TRAECN_MCP_TOOL_PROFILE=ops` exposes operational tools; `TRAECN_MCP_TOOL_PROFILE=full` exposes every explicit tool.

## Operating Workflow

1. Confirm Node 22+ is available and the gateway host can reach TraeCN.
2. For a source checkout, configure the MCP client with an absolute `mcp-server.js` path:

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

3. For a published package install, use the package-provided `traecnclaw-mcp` bin when it is on the agent host `PATH`; keep the same environment variables.
4. Choose a tool profile deliberately: `public` for general agents, `ops` for recovery/proof workflows, `full` for compatibility audits and low-level diagnostics.
5. Start the gateway separately when needed with `npm run start:gateway`; use `TRAECN_ENABLE_MOCK_BRIDGE=1 npm run start:gateway` only for mock-mode development.
6. Discover before acting: list MCP tools, call `traecn_get_capabilities`, then call `traecn_preflight` with the intended command and params.
7. For side-effecting operations, call `traecn_plan_operation` or `traecn_preflight` first and honor any confirmation, readiness, queue, or dialog result.
8. Use `traecn_list_commands` plus `traecn_run_command` when a client needs the stable command catalog rather than individual MCP tool names.

## Tool Selection

- Short tasks: use `traecn_run_task` after a clean `traecn_preflight`.
- Long or queued tasks: use `traecn_queue_task`, `traecn_wait_task`, and `traecn_poll_task`; use `traecn_preflight` for queue state in `public`, or `traecn_get_queue_status` only in `full`.
- Code review: use `traecn_review_code` as the first-class review action.
- Model and mode control: use `traecn_switch_model`, `traecn_switch_mode`, and `traecn_create_chat`.
- Settings through stdio MCP: use `traecn_get_settings` and `traecn_set_setting`.
- Dialogs: use `traecn_get_dialog_status` and `traecn_respond_dialog` in `public`; use `traecn_dismiss_dialog` only when running the `full` compatibility profile.
- Review gates, cleanup, and recovery: use the `ops` profile tools such as `traecn_get_review_gate_status`, `traecn_resolve_review_gate`, `traecn_restart_debug_session`, cleanup tools, and long-queue proof tools.
- Unattended workflows: use `traecn_run_unattended_workflow` in `public`; use direct Solo/proof/cleanup tools only from the profile that exposes them.
- Full current catalog and cross-agent config notes: read [references/mcp-surface.md](references/mcp-surface.md) when choosing an exact MCP tool or configuring a client.

## Profile Scale

- `public`: 20 tools. Use for default published agent integrations.
- `ops`: 32 tools. Use for recovery, cleanup, Solo conversation control, and long-queue proof work.
- `full`: 36 tools. Use for audits, compatibility checks, and clients that intentionally want every explicit shortcut.

## Validation

- Run `node -e "console.log(require('./mcp-server').MCP_TOOLS.map(t => t.name).join('\n'))"` to verify the live tool list from code.
- Run `npm run doctor` for local environment readiness.
- Run `npm test` for the maintained in-repo test sequence after behavior changes.
- Run `npm run acceptance:audit -- --require-complete` before claiming unattended end-to-end TraeCN workflow readiness.
- For release-style changes, run `npm run test:all` when practical.

## Safety Rules

- Keep the gateway bound to `127.0.0.1` unless remote access is intentionally required.
- Never commit `.env`, tokens, authorization headers, raw TraeCN profile data, `audit-logs`, `demo-output`, `logs`, or `node_modules`.
- Prefer MCP/HTTP/CLI surfaces over GUI-control paths when the MCP server can perform the operation.
- Treat live TraeCN dialog text, gateway health, cleanup state, and external model queue behavior as environment-specific until revalidated.
