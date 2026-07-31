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
4. Call `traecn_get_task` only for an explicit query. Its default `detailLevel: "result"` returns the final answer; use `detailLevel: "trace"` only when the visible execution process is needed for diagnosis or traceability. Cancel a known task with `traecn_cancel_task`. For untracked visible work, list conversations and call `traecn_stop_generation` with the active conversation ID, explicit untracked-work acknowledgement, and an audit reason; the gateway rejects a mismatched conversation.
5. For settings, list sections, list one section's items, optionally list a dropdown's choices, then call the matching toggle, option, or text tool. The gateway operates the Trae UI and restores chat.
6. Use `traecn_answer_question` or `traecn_decide_approval` only for an exceptional interaction returned by the gateway. Approve only with the exact visible command, a risk acknowledgement, and an audit reason; the gateway rejects stale command cards.

The gateway maintains queues, recovers persisted work, auto-approves only a
strict read-only shell allowlist, and resolves file-review gates with keep by
default or revert for clear fatal automation failures. High-impact approvals,
stops, and permanent inactive-conversation deletions are scoped and written to
the local append-only security audit log. Delete only when the current user
request explicitly names or unambiguously identifies the inactive conversation;
re-read its listed ID and exact title because deletion cannot be restored. This
does not add a separate confirmation round trip. Never put a workspace path
into the model message.

Read [references/mcp-surface.md](references/mcp-surface.md) for exact ownership
boundaries. The distributable skill and generated schemas live under
`skills/traecnclaw-mcp/`.

## Safety

- Keep the gateway on loopback unless remote access is secured.
- Never expose `.env`, tokens, authorization headers, or TraeCN profile data.
- Treat mock and non-terminal results as incomplete.
- Do not recreate removed low-level MCP tools through generic commands.
