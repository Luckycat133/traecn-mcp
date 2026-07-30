# MCP surface

TRAECNclaw exposes one focused Agent surface. There are no tool profiles.

| Tool | Required input | Gateway route |
| --- | --- | --- |
| `traecn_send_message` | `message` | `POST /api/tasks/submit` |
| `traecn_get_task` | `taskId` | `GET /api/task/{taskId}` |
| `traecn_cancel_task` | `taskId` | `POST /api/task/{taskId}/cancel` |
| `traecn_open_workspace` | `path` | `POST /api/open-project` |
| `traecn_list_models` | none | `GET /api/models` |
| `traecn_select_model` | `model` | `POST /api/switch-model` |
| `traecn_select_mode` | `mode` | `POST /api/switch-mode` |
| `traecn_list_conversations` | none | `GET /api/conversations` |
| `traecn_create_conversation` | none | `POST /api/conversations/manage` |
| `traecn_select_conversation` | `conversationId` | `POST /api/conversations/manage` |
| `traecn_delete_conversation` | `conversationId` | `POST /api/conversations/manage` |
| `traecn_answer_question` | `answer` | `POST /api/interactions/resolve` |
| `traecn_decide_approval` | `decision` | `POST /api/interactions/resolve` |

`traecn_send_message` accepts only `message` and optional `conversationId`.
Set workspace, model, mode, and conversation through their focused tools. New
conversations are explicit and messages otherwise stay in the selected chat.

After message acceptance the gateway owns persistence, external and local
queues, recovery, completion checks, notifications, routine questions, safe
command approvals, and keep/revert gates. Agents do not wait, poll, acknowledge
events, run preflight, or recover work. `traecn_get_task` is an optional
explicit read, not a polling instruction.

Safe command cards are approved automatically. Ambiguous or risky approvals
are returned with compact details for `traecn_decide_approval`; unknown
questions are returned with options for `traecn_answer_question`.
