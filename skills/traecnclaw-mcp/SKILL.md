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

- Need to run, queue, poll, or cancel TraeCN tasks
- Switch model or Solo/IDE mode, read/write TraeCN settings
- Handle confirm dialogs or review gates
- Run unattended vibe workflows or long-queue proofs
- Configure any MCP client (Cursor, Claude Desktop, Cline, Windsurf, Codex)

Do NOT use this skill for direct browser automation or GUI clicking when an MCP tool exists.

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

## Safety rules

- Keep the gateway bound to `127.0.0.1` unless remote access is intentionally required.
- Never commit `.env`, tokens, auth headers, raw TraeCN profile data, `audit-logs/`, `demo-output/`, `logs/`, or `node_modules/`.
- Prefer MCP/HTTP/CLI surfaces over GUI-control paths whenever the MCP server can perform the operation.
- Treat live dialog text, gateway health, cleanup state, and external model queue behavior as environment-specific until revalidated.

## Validation

- `npm run doctor` — local environment readiness.
- `npm test` — maintained in-repo test sequence.
- `npm run acceptance:audit -- --require-complete` — before claiming unattended end-to-end readiness.
- `npm run test:all` — release-style changes when practical.
- `node -e "console.log(require('./mcp-server').MCP_TOOLS.map(t => t.name).join('\n'))"` — verify live tool list from code.
