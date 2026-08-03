# TRAECNclaw MCP server

TRAECNclaw exposes a local stdio MCP server for operating TraeCN. The Agent
contract contains 20 focused tools; lower-level HTTP, CLI, proof, waiting, and
maintenance operations remain gateway or operator facilities.

## Protocol compatibility

Version 0.5.3 is a dual-era stdio server:

| MCP revision | Lifecycle | TRAECNclaw behavior |
| --- | --- | --- |
| `2026-07-28` | Stateless requests with `_meta` | `server/discover`, strict per-request version checks, `resultType`, cache hints, server identity metadata, and an optional Tasks extension |
| `2025-11-25` | `initialize` handshake | Focused tools plus legacy logging notifications |
| `2024-11-05` | `initialize` handshake | Compatibility mode for existing clients |

Standard stdio framing is newline-delimited JSON-RPC. The server can still
decode and answer the `Content-Length` framing used by older TRAECNclaw
clients, but new integrations should send one compact JSON object per line.
MCP contract version 5 names the frozen TRAECNclaw tool surface; it is separate
from the date-based MCP protocol revision.

## Configure

```json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/absolute/path/to/TRAECNclaw/mcp-server.js"],
      "env": {
        "TRAECN_GATEWAY_HOST": "127.0.0.1",
        "TRAECN_GATEWAY_PORT": "8788",
        "TRAECN_GATEWAY_TOKEN": ""
      }
    }
  }
}
```

Start the gateway separately with `npm run start:gateway`.

## Tool groups

| Group | Tools |
| --- | --- |
| Work | `traecn_send_message`, `traecn_get_task`, `traecn_cancel_task`, `traecn_stop_generation` |
| Context | `traecn_open_workspace`, `traecn_list_models`, `traecn_select_model`, `traecn_select_mode` |
| Settings | `traecn_list_setting_sections`, `traecn_list_settings`, `traecn_list_setting_options`, `traecn_set_setting_toggle`, `traecn_select_setting_option`, `traecn_set_setting_text` |
| Conversations | `traecn_list_conversations`, `traecn_create_conversation`, `traecn_select_conversation`, `traecn_delete_conversation` |
| Exceptional interactions | `traecn_answer_question`, `traecn_decide_approval` |

Each tool performs one operation. For example, open a workspace, select a
model, and send a message as separate calls only when those context changes are
needed:

```json
{"path":"/absolute/path/to/repository"}
{"model":"GLM-5.2"}
{"message":"Review the repository and report findings first."}
```

`traecn_send_message` accepts only `message` and optional `conversationId`.
Workspace paths are never inserted into the model prompt. New conversations
are explicit; sending without a conversation ID uses the selected conversation.

Settings use progressive discovery rather than one generic command: list the
visible sections, inspect one section, and list a dropdown's choices only when
needed. Use the mutation tool matching the returned `controlType`. The gateway
opens Trae settings, performs the UI operation, serializes concurrent UI work,
and returns to chat automatically.

`traecn_cancel_task` targets one gateway task. `traecn_stop_generation` is a
separate direct UI action for untracked work: supply the active Solo
`conversationId`, acknowledge that it may belong to another origin, and give a
short audit reason. The gateway verifies that the ID is still active before it
clicks stop.

Conversation deletion is permanent and cannot target the active conversation.
It requires the exact listed title and `acknowledgePermanentDeletion:true`.
Unsafe-command approval requires the exact visible command,
`acknowledgeRisk:true`, and an audit reason; the gateway rechecks the card to
prevent stale approval. These high-impact operations use `delegate` permission
and are recorded in the local append-only security audit log.

## Gateway ownership

The Agent does not preflight, choose sync versus background execution, wait,
poll, acknowledge events, recover tasks, clean queues, or operate keep/revert
controls. The gateway persists accepted tasks, maintains queues, resumes work,
returns every command card for explicit review, and resolves file-review gates.

Legacy initialization-based clients receive compact MCP logging notifications.
The `2026-07-28` protocol does not allow those free-floating notifications;
modern clients use the separately negotiated Tasks extension described below,
or make an intentional `traecn_get_task` read when their host does not support
extensions. Do not use a tight Agent polling loop.

`traecn_get_task` exists for explicit progress/result reads and modern clients
that cannot receive legacy logging notifications. It is not a required
immediate post-send step. The optional `detailLevel` is `result` by default,
which returns only the final answer. Set it to `trace` when detailed visible
execution steps are needed to investigate an unexpected result.

## Modern Tasks extension

`server/discover` advertises `io.modelcontextprotocol/tasks`. The upstream
extension is independently versioned and still published as a draft; the core
`2026-07-28` revision and TRAECNclaw contract version 5 remain separate.

A client opts in on each request through
`_meta.io.modelcontextprotocol/clientCapabilities.extensions`. For an opted-in
`traecn_send_message`, the server returns the same durable gateway identity as
a `resultType: "task"` handle. The extension adds protocol methods, not tools:

| Method | Behavior |
| --- | --- |
| `tasks/get` | Returns the complete current task state and final `CallToolResult` when terminal. |
| `tasks/update` | Supplies a response to an outstanding `input_required` approval or review request. |
| `tasks/cancel` | Cooperatively cancels the corresponding gateway task. |
| `subscriptions/listen` | Subscribes to exact task IDs and streams full `notifications/tasks` snapshots over stdio. |

Respect `pollIntervalMs` when polling. Prefer a task-ID subscription when the
host implements it: the acknowledgement and every notification carry
`io.modelcontextprotocol/subscriptionId`, and reconnecting produces a fresh
snapshot before durable event replay. On deliberate server shutdown, the
listen request receives the standard empty, correlated result so official SDK
clients classify the close as graceful. A client that does not opt in always
receives the ordinary complete tool result shape and can continue using the
focused `traecn_get_task` tool. Streamable HTTP transport is not exposed.

## Validation

```sh
npm run test:mcp-stdio-smoke
npm run test:mcp-conformance
npm run check:skill-contracts
npm test
```

The conformance command uses `@modelcontextprotocol/client` 2.x for independent
2024, 2025, and pinned `2026-07-28` sessions. A separate transcript peer covers
the legacy Content-Length compatibility path, malformed JSON recovery,
JSON-RPC error codes, argument rejection, and connection-era pinning.

Generated schemas live in
`skills/traecnclaw-mcp/references/mcp-tool-contracts.json`.
