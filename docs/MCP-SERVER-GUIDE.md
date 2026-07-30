# TRAECNclaw MCP server

TRAECNclaw exposes a local stdio MCP server for operating TraeCN. The Agent
contract contains 20 focused tools; lower-level HTTP, CLI, proof, waiting, and
maintenance operations remain gateway or operator facilities.

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
separate direct UI action for the generation currently visible in TraeCN.

## Gateway ownership

The Agent does not preflight, choose sync versus background execution, wait,
poll, acknowledge events, recover tasks, clean queues, or operate keep/revert
controls. The gateway persists accepted tasks, maintains queues, resumes work,
auto-approves strictly safe cards, resolves file-review gates, and emits compact
MCP completion notifications.

`traecn_get_task` exists for explicit progress/result reads or clients that do
not display MCP logging notifications. It is not a required post-send step.

## Validation

```sh
npm run test:mcp-stdio-smoke
npm run check:skill-contracts
npm test
```

Generated schemas live in
`skills/traecnclaw-mcp/references/mcp-tool-contracts.json`.
