# OpenClaw and MCP setup

TRAECNclaw supports two integrations:

- The focused stdio MCP server is the preferred Agent interface.
- The OpenClaw plugin retains broader operator commands for existing OpenClaw deployments.

Do not infer the MCP tool list from OpenClaw plugin commands. They serve
different audiences.

## Requirements

- Node.js 22 or later
- TraeCN with CDP remote debugging enabled
- TRAECNclaw gateway on `127.0.0.1:8788`

Verify the environment:

```sh
npm install
npm run doctor
npm run start:gateway
```

## MCP client

Use the skill launcher:

```json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/absolute/path/to/TRAECNclaw/skills/traecnclaw-mcp/scripts/start-mcp.js"],
      "env": {
        "TRAECN_GATEWAY_HOST": "127.0.0.1",
        "TRAECN_GATEWAY_PORT": "8788",
        "TRAECN_GATEWAY_TOKEN": ""
      }
    }
  }
}
```

The MCP surface contains focused work, context, conversation, question, and
approval and UI-backed settings tools. See
[MCP Server Guide](MCP-SERVER-GUIDE.md) for the 20 names.

Send example after any required context-selection calls:

```json
{
  "message": "Inspect the current repository for correctness and safety issues."
}
```

The gateway returns `taskId`, maintains any queue, and pushes completion through
MCP logging notifications. The caller does not need wait, polling, recovery,
preflight, proof, cleanup, or review-gate tools.

## OpenClaw plugin

The plugin under `integrations/openclaw-traecn-plugin` exposes existing
OpenClaw-specific commands for deployment compatibility and operator workflows.
Its broader command catalog does not change the focused MCP contract.

Configure the plugin with the same gateway host, port, and optional token. Keep
the gateway bound to loopback unless remote access is secured.

## Approval behavior

The gateway handles only a documented strict read-only command allowlist without an Agent call. It keeps
generated file changes by default and reverts only when the collected state
contains a clear fatal automation failure. Questions and unsafe approvals are
returned for `traecn_answer_question` or `traecn_decide_approval`.

High-impact tools remain focused but policy-backed: direct stop is bound to the
active Solo conversation and requires an untracked-work acknowledgement;
permanent deletion requires an inactive exact-title match; unsafe approval
requires exact-command revalidation. Each records a concise reason in the local
append-only audit log instead of adding a separate confirmation tool.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| MCP initializes with no tools | Absolute launcher path and Node.js version |
| Gateway request returns `ECONNREFUSED` | `npm run start:gateway` |
| HTTP 401 | Client and gateway token values |
| CDP unavailable | TraeCN remote-debugging process and configured port |
| Workspace cannot switch | Requested absolute path and TraeCN binary discovery |
| Completion notification missing | MCP logging support and `TRAECN_MCP_CLIENT_ID` uniqueness |

Run `npm run test:mcp-stdio-smoke` for protocol discovery and
`npm run check:skill-contracts` for schema/example consistency.
