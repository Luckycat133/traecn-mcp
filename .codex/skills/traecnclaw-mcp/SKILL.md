---
name: traecnclaw-mcp
description: Use when an MCP-capable agent must operate TRAECNclaw or TraeCN. Send or stop work, select a workspace/model/mode/conversation, inspect or change Trae settings through its UI, manage conversations, or resolve an exceptional question or approval through focused MCP tools. The gateway owns preflight, queues, waiting, polling, recovery, notifications, safe approvals, and keep/revert decisions.
---

# TRAECNclaw MCP

Use the real stdio MCP server. Do not replace it with browser or GUI control.

## Workflow

1. Change context only when needed with `traecn_open_workspace`, `traecn_list_models` plus `traecn_select_model`, `traecn_select_mode`, and the focused conversation tools.
2. Call `traecn_send_message` with the exact message and optional stable `conversationId`.
3. Return after receiving `taskId`. Do not wait, poll, acknowledge events, recover tasks, or probe queues; the gateway persists work and pushes completion notifications.
4. Call `traecn_get_task` only for an explicit query. Cancel a known task with `traecn_cancel_task`; stop the currently visible Trae generation with `traecn_stop_generation`.
5. For settings, list sections, list one section's items, optionally list a dropdown's choices, then call the matching toggle, option, or text tool. The gateway operates the Trae UI and restores chat.
6. Use `traecn_answer_question` or `traecn_decide_approval` only for an exceptional interaction returned by the gateway.

The gateway maintains queues, recovers persisted work, auto-approves safe
cards, and resolves file-review gates with keep by default or revert for clear
fatal automation failures. Never put a workspace path into the model message.

Read [references/mcp-surface.md](references/mcp-surface.md) for exact ownership
boundaries. The distributable skill and generated schemas live under
`skills/traecnclaw-mcp/`.

## Safety

- Keep the gateway on loopback unless remote access is secured.
- Never expose `.env`, tokens, authorization headers, or TraeCN profile data.
- Treat mock and non-terminal results as incomplete.
- Do not recreate removed low-level MCP tools through generic commands.
