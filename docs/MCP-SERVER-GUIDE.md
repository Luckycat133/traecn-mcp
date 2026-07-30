# TRAECNclaw MCP server

TRAECNclaw exposes a local stdio MCP server for delegating work to TraeCN. The
Agent contract contains six tools; lower-level HTTP, CLI, proof, and maintenance
operations remain operator facilities.

## Configure

```json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/absolute/path/to/TRAECNclaw/mcp-server.js"],
      "env": {
        "TRAECN_HOST": "127.0.0.1",
        "TRAECN_PORT": "8788",
        "TRAECN_GATEWAY_TOKEN": ""
      }
    }
  }
}
```

Start the gateway separately:

```sh
npm run start:gateway
```

## Tool contract

| Tool | Purpose |
| --- | --- |
| `traecn_submit` | Accept work and let the gateway manage preparation, execution, and delivery. |
| `traecn_get_task` | Read one known task on demand. |
| `traecn_cancel_task` | Cancel queued work or stop active generation. |
| `traecn_list_conversations` | List conversations for the current mode. |
| `traecn_manage_conversation` | Create, select, or delete a conversation. |
| `traecn_resolve_interaction` | Resolve an exceptional question or unsafe approval. |

Example:

```json
{
  "message": "Review the repository and report findings first.",
  "model": "GLM-5.2",
  "mode": "solo",
  "workspace": "/absolute/path/to/repository",
  "steps": ["Run focused tests"]
}
```

`workspace` is control data. The gateway opens and verifies it, then sends only
`message` to TraeCN.

## Gateway ownership

The Agent does not preflight, choose sync versus background execution, wait,
poll, acknowledge events, recover tasks, or operate keep/revert controls. The
gateway persists every accepted task, maintains external queues, switches
model/mode, targets conversations, auto-approves strictly safe cards, resolves
file-review gates, and emits compact MCP completion notifications.

`traecn_get_task` exists for explicit user-requested progress checks or clients
that do not display MCP logging notifications. It is not a required step after
submission.

## Validation

```sh
npm run test:mcp-stdio-smoke
npm run check:skill-contracts
npm test
```

Generated schemas are in
`skills/traecnclaw-mcp/references/mcp-tool-contracts.json`.
