# Ownership boundary

The Agent receives focused tools for messages, tasks, workspace, models, mode,
settings, conversations, questions, and exceptional approvals. Each tool
performs one operation.

The gateway owns readiness, queue maintenance, waiting, polling, task
persistence, recovery, task-event acknowledgement, completion delivery,
routine questions, safe approvals, and keep/revert gates. These are not MCP
tools.

`traecn_send_message` accepts only `message` and optional `conversationId`.
Use the context tools only when the requested workspace, model, mode, or
conversation must change. New conversations are explicit; otherwise messages
remain in the selected conversation.

Settings are a second-level capability: list sections, list one section's
items, list dropdown options when needed, then use the exact toggle, option, or
text mutation tool. The gateway navigates Trae's UI and returns to chat.
