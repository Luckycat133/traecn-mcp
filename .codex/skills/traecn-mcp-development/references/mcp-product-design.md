# traecn-mcp: stable MCP contract

The source of truth is `src/mcp/contract.js`, not a marketing page or this document. The reviewed branch enforces contract version 5 and the following exact order:

```text
traecn_send_message
traecn_get_task
traecn_cancel_task
traecn_stop_generation
traecn_open_workspace
traecn_list_models
traecn_select_model
traecn_select_mode
traecn_list_setting_sections
traecn_list_settings
traecn_list_setting_options
traecn_set_setting_toggle
traecn_select_setting_option
traecn_set_setting_text
traecn_list_conversations
traecn_create_conversation
traecn_select_conversation
traecn_delete_conversation
traecn_answer_question
traecn_decide_approval
```

## Keep the working design

- One user intent per tool. Three task tools, seven context tools, six setting tools and four exceptional interaction/action tools.
- MCP names keep their `traecn_` prefix during project naming migration.
- Queue waits, retries, event acknowledgement, proof runs, UI targeting and process recovery remain gateway/host mechanics, not more tools.
- Existing title, output-schema, annotation, result-parity and conformance work is already present; characterize before changing it, do not repeat an obsolete metadata milestone.
- Runtime Skill copy equality and contract tests are supplied PASS evidence. Do not edit one copy independently.

## Task and context semantics

`traecn_send_message` accepts one durable task. An accepted task identity is distinct from a native Trae conversation or user turn. Context selection can precede submission, but the gateway must freeze and validate the execution context at acceptance/preparation; it cannot assume a previous selection remains unchanged forever.

`traecn_cancel_task` is task-scoped. `traecn_stop_generation` operates on a specifically identified visible conversation. Do not treat the two as synonyms or turn a queue observer timeout into either operation.

Questions and approvals must resolve the exact pending interaction associated with the task/context. An old card, mismatched command or changed context must produce an actionable failure, not a click on the newest visible card.

Settings discovery precedes mutation. Read-only MCP annotations describe user-visible behavior, not a guarantee that enumerating UI state never changes focus; serialize any UI probing needed to avoid corrupting an in-flight mutation.

## Recovery without an accidental contract fork

Submission intent, reconciliation and workspace lease phases are internal fields first. Map them to existing public status/error envelopes until a separately reviewed contract change is necessary. Do not add a status enum, tool, required argument, profile or protocol assumption merely to make a test pass.

Use existing machine-readable errors and preserved text/structured equivalence. A proposed `WORKSPACE_BUSY` or ambiguous-submission code needs implementation, mapping and tests before documentation calls it available. The current 20 names alone do not prove all schemas are unchanged; compare the generated contract as well.

## Regression focus

- Exact 20 names/order and synchronized generated schemas.
- Existing JSON-RPC and tool-execution error separation across negotiated protocol eras.
- Durable receipt before accepted, stable retry identity, retained terminal replay.
- Native ambiguous-send reconciliation without duplicate UI submission.
- No foreign conversation/workspace result after reconnect or context drift.
- Workspace guard is shared by MCP, web, CLI, REST and internal preparation.
- Existing subscription closure, initial snapshot/history baseline and event cursor behavior remains covered.

Use current package scripts and focused files. For protocol/schema changes run `npm run test:mcp-conformance`, `npm run check:skill-contracts` and the stdio smoke in addition to the changed subsystem. Do not replace established SDK transcripts with hand-written mock claims.
