# OpenClaw and MCP setup

TRAECNclaw supports two integrations:

- The compact stdio MCP server is the preferred Agent interface.
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
        "TRAECN_HOST": "127.0.0.1",
        "TRAECN_PORT": "8788",
        "TRAECN_GATEWAY_TOKEN": ""
      }
    }
  }
}
```

The six tools are `traecn_submit`, `traecn_get_task`, `traecn_cancel_task`,
`traecn_list_conversations`, `traecn_manage_conversation`, and
`traecn_resolve_interaction`.

Submit example:

```json
{
  "message": "Inspect the current repository for correctness and safety issues.",
  "model": "GLM-5.2",
  "mode": "solo",
  "workspace": "/absolute/path/to/repository"
}
```

The gateway returns `taskId`, maintains any queue, and pushes completion through
MCP logging notifications. The caller does not need wait, polling, recovery,
preflight, proof, cleanup, or review-gate tools.

## OpenClaw plugin

The plugin under `integrations/openclaw-traecn-plugin` exposes existing
OpenClaw-specific commands for deployment compatibility and operator workflows.
Its broader command catalog does not change the six-tool MCP contract.

Configure the plugin with the same gateway host, port, and optional token. Keep
the gateway bound to loopback unless remote access is secured.

## Approval behavior

The gateway handles strictly safe command cards without an Agent call. It keeps
generated file changes by default and reverts only when the collected state
contains a clear fatal automation failure. Questions and unsafe approvals are
returned as exceptional interactions for `traecn_resolve_interaction`.

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
