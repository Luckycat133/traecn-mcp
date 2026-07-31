# Ownership boundary

The Agent receives focused tools for messages, tasks, workspace, models, mode,
settings, conversations, questions, and exceptional approvals. Each tool
performs one operation.

The gateway owns readiness, queue maintenance, waiting, polling, task
persistence, recovery, task-event acknowledgement, completion delivery,
routine questions, safe approvals, and keep/revert gates. These are not MCP
tools.

Safe approval means a strict read-only shell allowlist with no redirection,
substitution, network/process/package execution, project scripts, mutating
find/sed, or external hooks. Other commands require Agent review. Direct stops
are bound to the active Solo conversation; permanent deletion is limited to an
inactive exact-title match; unsafe approval is bound to the exact visible
command. These decisions are recorded in the local append-only audit log.

`traecn_send_message` accepts only `message` and optional `conversationId`.
Use the context tools only when the requested workspace, model, mode, or
conversation must change. New conversations are explicit; otherwise messages
remain in the selected conversation.

`traecn_get_task` accepts `taskId` and optional `detailLevel`. Use `result`
(the default) for the final answer, or `trace` when the visible execution
process is needed to investigate an unexpected result.

Settings are a second-level capability: list sections, list one section's
items, list dropdown options when needed, then use the exact toggle, option, or
text mutation tool. The gateway navigates Trae's UI and returns to chat.
