---
name: traecnclaw-mcp
description: Operate TraeCN through TRAECNclaw's focused stdio MCP tools. Use when an MCP-capable agent must send work, choose a workspace/model/mode/conversation, inspect or cancel a task, manage conversations, or resolve an exceptional question or unsafe approval. Queueing, waiting, recovery, notifications, safe approvals, and keep/revert gates are gateway-managed.
license: MIT-0
metadata:
  author: TRAECNclaw
  version: "0.4.4"
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

Compose focused tools around user intent. Do not call preflight, wait, poll,
event acknowledgement, recovery, cleanup, proof, process, or generic command
operations from the agent loop; the gateway owns those mechanics.

## Setup

1. Run `npm run doctor` in the repository.
2. Configure the client from [assets/mcp-client-config.json](assets/mcp-client-config.json), replacing `SKILL_DIR` with this folder's absolute path. Use [assets/mcp-client-config.direct.json](assets/mcp-client-config.direct.json) when directly referencing the repository server.
3. Start the gateway with `npm run start:gateway`, then reconnect the MCP client.
4. Use mock mode only for development; never cite mock output as live TraeCN evidence.

## Choose only necessary context

- Call `traecn_open_workspace` only when the requested folder is not already open.
- Call `traecn_list_models` when the available choices matter; then call `traecn_select_model` once.
- Call `traecn_select_mode` only when the task requires a different Solo/IDE mode.
- Call `traecn_list_conversations` to read the current mode and stable conversation IDs.
- Use `traecn_create_conversation`, `traecn_select_conversation`, or `traecn_delete_conversation` for exactly one conversation operation.

These tools change TraeCN context. Never repeat workspace paths in the model
message.

## Send and track work

Call `traecn_send_message` with the exact message and, when concurrency makes
the target ambiguous, an explicit `conversationId`. It returns only the
accepted `taskId` and status.

Do not wait or poll after sending. The stdio server delivers compact task
notifications and acknowledges them internally. Call `traecn_get_task` only
for an intentional status/result read. Use `traecn_cancel_task` when the user
wants work stopped; the gateway decides whether to remove queued work or stop
active generation.

## Resolve exceptional interactions

The gateway automatically approves strictly safe command cards, answers known
mechanical scope questions, and keeps generated changes unless a clear fatal
automation failure requires revert.

If a task reports an unresolved interaction:

- Use `traecn_answer_question` for a returned question and one of its offered answers.
- Use `traecn_decide_approval` only after checking the returned command and risk. Approve work inside the user's authorized scope; deny anything outside it.

## Safety

- Keep the gateway on `127.0.0.1` unless remote access is secured.
- Never expose `.env`, tokens, authorization headers, or TraeCN profile data.
- Treat mock results and non-terminal task states as incomplete.
- Do not recreate removed low-level tools through shell, generic commands, or GUI control.

Read [references/mcp-surface.md](references/mcp-surface.md) only for exact
schemas, notification behavior, and gateway ownership boundaries.
