# Ownership boundary

The Agent receives focused tools for messages, tasks, workspace, models, mode,
settings, conversations, questions, and exceptional approvals. Each tool
performs one operation.

The gateway owns readiness, queue maintenance, waiting, polling, task
persistence, recovery, task-event acknowledgement, completion delivery,
routine non-command questions, and keep/revert gates. These are not MCP tools.

No shell command is approved automatically, including commands classified as
read-only. Every command requires Agent review and approval is bound to the
exact visible command, a risk acknowledgement, and an audit reason. Direct
stops are bound to the active Solo conversation; permanent deletion is limited
to an inactive exact-title match. These decisions are recorded in the local
append-only audit log.

`traecn_send_message` accepts only `message` and optional `conversationId`.
Use the context tools only when the requested workspace, model, mode, or
conversation must change. New conversations are explicit; otherwise messages
remain in the selected conversation.

`traecn_get_task` accepts `taskId` and optional `detailLevel`. Use `result`
(the default) for the final answer, or `trace` when the visible execution
process is needed to investigate an unexpected result.

Modern `2026-07-28` hosts may negotiate the separately versioned
`io.modelcontextprotocol/tasks` extension. An opted-in send returns the same
durable gateway identity as a Task; `tasks/get`, `tasks/update`, and
`tasks/cancel` operate it, while `subscriptions/listen` delivers exact-ID
`notifications/tasks` snapshots. This protocol adapter does not add tools to
contract v5. Hosts without the extension use the ordinary complete result and
an intentional `traecn_get_task` read.

Settings are a second-level capability: list sections, list one section's
items, list dropdown options when needed, then use the exact toggle, option, or
text mutation tool. The gateway navigates Trae's UI and returns to chat.
