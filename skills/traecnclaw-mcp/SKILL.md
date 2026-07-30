---
name: traecnclaw-mcp
description: Operate TraeCN through TRAECNclaw's compact stdio MCP server. Use when an MCP-capable agent must submit work to TraeCN, choose a model/mode/workspace/conversation, inspect a known task, manage conversations, cancel work, or resolve an exceptional question or unsafe approval. Queueing, waiting, polling, recovery, preflight, safe approvals, and keep/revert gates are gateway-managed and must not be reproduced by the agent.
license: MIT-0
metadata:
  author: TRAECNclaw
  version: "0.4.3"
  openclaw:
    requires:
      bins:
        - node
    envVars:
      - name: TRAECN_MCP_SERVER_PATH
        required: false
        description: Optional absolute path to the trusted TRAECNclaw mcp-server.js entry point.
      - name: TRAECN_HOST
        required: false
        description: Optional gateway host override; keep loopback unless remote access is secured.
      - name: TRAECN_PORT
        required: false
        description: Optional gateway port override.
      - name: TRAECN_GATEWAY_TOKEN
        required: false
        description: Optional gateway secret; never print or persist it.
      - name: TRAECN_MCP_CLIENT_ID
        required: false
        description: Stable client identifier for automatic compact task notifications.
---

# TRAECNclaw MCP

Use the six MCP tools directly. Do not call gateway preflight, wait, polling,
event-acknowledgement, recovery, model-test, cleanup, or proof operations from
the agent loop; the gateway owns those mechanics.

## Setup

1. Run `npm run doctor` in the repository.
2. Configure the client from [assets/mcp-client-config.json](assets/mcp-client-config.json), replacing `SKILL_DIR` with this folder's absolute path. If discovery fails, set `TRAECN_MCP_SERVER_PATH` to the absolute `mcp-server.js` path or use [assets/mcp-client-config.direct.json](assets/mcp-client-config.direct.json).
3. Start the gateway with `npm run start:gateway`, then reconnect the MCP client.
4. Use mock mode only for development; never cite mock output as live TraeCN evidence.

## Tools

| Tool | Use |
| --- | --- |
| `traecn_submit` | Submit a message plus optional model, mode, workspace, conversation, and follow-up steps. |
| `traecn_get_task` | Explicitly query a known task when the user asks for progress or automatic notification is unavailable. |
| `traecn_cancel_task` | Cancel queued work or stop active generation; the gateway chooses the mechanism. |
| `traecn_list_conversations` | Read conversations for the current TraeCN mode. |
| `traecn_manage_conversation` | Create, select, or delete a conversation. |
| `traecn_resolve_interaction` | Handle only a question or unsafe approval the gateway returns as requiring attention. |

## Submit work

Send the exact user task as `message`. Put control data in fields, never in the
message:

```json
{
  "message": "Review the current repository. Report findings first.",
  "model": "GLM-5.2",
  "mode": "solo",
  "workspace": "/absolute/path/to/repository",
  "conversationId": "solo:UmV2aWV3IEFQSQ",
  "steps": ["Run focused tests"]
}
```

The gateway opens and verifies `workspace` before submission; it never inserts
the path into the model prompt. Every accepted submission returns a `taskId`
and is gateway-managed even when TraeCN is initially idle.

Do not wait or poll after submission. The stdio server delivers compact task
notifications and acknowledges them internally. Use `traecn_get_task` only for
an intentional status/result read.

## Interactions and review gates

The gateway automatically approves strictly classified safe command cards,
answers known mechanical scope questions, and resolves TraeCN file review gates.
It keeps changes by default and selects revert only for clear fatal automation
failures such as repository corruption or unsafe write failure.

If a task reports `approval_required`, use `traecn_resolve_interaction` only
after inspecting the returned compact question/command/risk fields. Do not ask
for redundant human confirmation when the action is already within the user's
authorized task scope. Deny or leave pending anything outside that scope.

## Conversations

Call `traecn_list_conversations` to obtain stable gateway IDs such as
`solo:UmV2aWV3IEFQSQ`. Pass
one to `traecn_submit` or use `traecn_manage_conversation` with `select`.
Conversation mode details remain gateway implementation concerns.

## Safety

- Keep the gateway on `127.0.0.1` unless remote access is secured.
- Never expose `.env`, tokens, authorization headers, or TraeCN profile data.
- Treat mock results, non-terminal task states, and percentages below 100 as incomplete.
- Let `traecn_cancel_task` decide whether to remove queued work or stop generation.
- Do not recreate removed compatibility tools through generic commands or GUI control.

## Validation

- `npm run check:skill-contracts`
- `npm run test:mcp-stdio-smoke`
- `npm test`
- `npm run test:all` for release changes

Read [references/mcp-surface.md](references/mcp-surface.md) only when exact
schemas, notification behavior, or gateway ownership boundaries are needed.
