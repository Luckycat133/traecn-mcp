# Ownership boundary

The Agent receives focused tools for messages, tasks, workspace, models, mode,
conversations, questions, and exceptional approvals. Each tool performs one
operation.

The gateway owns readiness, queue maintenance, waiting, polling, task
persistence, recovery, task-event acknowledgement, completion delivery,
routine questions, safe approvals, and keep/revert gates. These are not MCP
tools.

`traecn_send_message` accepts only `message` and optional `conversationId`.
Use the context tools only when the requested workspace, model, mode, or
conversation must change. New conversations are explicit; otherwise messages
remain in the selected conversation.
