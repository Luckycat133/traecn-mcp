# Compact MCP surface

The Agent-facing tools are:

- `traecn_submit`
- `traecn_get_task`
- `traecn_cancel_task`
- `traecn_list_conversations`
- `traecn_manage_conversation`
- `traecn_resolve_interaction`

The gateway owns connection/readiness checks, workspace opening, mode/model
selection, queueing, waiting, polling, event acknowledgement, result delivery,
recovery, safe card approval, review-gate resolution, and workflow follow-ups.

Operator HTTP, CLI, OpenClaw, acceptance, and proof facilities are not MCP
Agent tools. See `skills/traecnclaw-mcp/references/mcp-tool-contracts.json` for
the generated schemas.
