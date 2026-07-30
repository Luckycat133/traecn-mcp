---
name: traecnclaw-mcp
description: Use when an MCP-capable agent must operate TRAECNclaw or TraeCN. Submit work, select a model/mode/workspace/conversation, inspect or cancel a task, manage conversations, or resolve an exceptional interaction through the compact MCP surface. The gateway owns preflight, queues, waiting, polling, recovery, safe approvals, and keep/revert decisions.
---

# TRAECNclaw MCP

Use the real stdio MCP server. Do not replace it with browser or GUI control.

## Workflow

1. Ensure the local gateway is running and `tools/list` returns six tools.
2. Call `traecn_submit` with the exact user message and optional `model`, `mode`, `workspace`, `conversationId`, or `steps`.
3. Return after receiving `taskId`. Do not wait, poll, acknowledge events, recover tasks, or probe queues; the gateway persists the task and the stdio server pushes completion notifications.
4. Call `traecn_get_task` only for an explicit status or result query.
5. Use `traecn_list_conversations` and `traecn_manage_conversation` for conversation operations.
6. Use `traecn_resolve_interaction` only when the gateway surfaces an exceptional question or unsafe approval.

The gateway opens and verifies `workspace` without adding it to the model
message. It selects model/mode, maintains queues, recovers persisted work,
auto-approves safe cards, and resolves file-review gates with keep by default or
revert for clear fatal automation failures.

Read [references/mcp-surface.md](references/mcp-surface.md) for exact ownership
boundaries. The distributable skill and generated schemas live under
`skills/traecnclaw-mcp/`.

## Safety

- Keep the gateway on loopback unless remote access is secured.
- Never expose `.env`, tokens, authorization headers, or TraeCN profile data.
- Treat mock and non-terminal results as incomplete.
- Do not recreate removed low-level MCP tools through generic commands.
