# MCP surface

## External contract

TRAECNclaw exposes one six-tool MCP surface. There are no `public`, `ops`, or
`full` discovery profiles.

| Tool | Required input | Gateway endpoint |
| --- | --- | --- |
| `traecn_submit` | `message` | `POST /api/tasks/submit` |
| `traecn_get_task` | `taskId` | `GET /api/task/:taskId` |
| `traecn_cancel_task` | `taskId` | `POST /api/task/:taskId/cancel` |
| `traecn_list_conversations` | none | `GET /api/conversations` |
| `traecn_manage_conversation` | `action` | `POST /api/conversations/manage` |
| `traecn_resolve_interaction` | `action` | `POST /api/interactions/resolve` |

Use [mcp-tool-contracts.json](mcp-tool-contracts.json) for generated schemas and
[mcp-call-examples.json](mcp-call-examples.json) for validated calls.

## Gateway-owned mechanics

After `traecn_submit`, the gateway owns:

- connection and readiness checks;
- opening and verifying the requested workspace;
- mode and model switching;
- conversation targeting;
- local/external queue maintenance;
- waiting, polling, durable event acknowledgement, and IDE notification;
- persisted-task recovery and active-task reconciliation;
- safe command-card approval;
- automatic keep/revert review-gate decisions;
- follow-up continuation and completion checks.

These are implementation facilities, not Agent tools. Operator HTTP, CLI, and
test surfaces may retain lower-level controls without publishing them through
MCP discovery.

## Result behavior

`traecn_submit` returns only acceptance state and `taskId`. Completion is pushed
as a compact MCP logging notification. `traecn_get_task` returns status plus the
full result only when explicitly requested.

An interaction is surfaced only when automatic handling would exceed the safe
local policy. The returned task/dialog fields provide the question, command,
risk, and available choices; resolve it with `traecn_resolve_interaction`.
