# TRAECNclaw MCP product design standard

Use this document when changing the public MCP server, runtime Skill, host
compatibility, onboarding, or marketplace metadata. The goal is not to maximize
tool count. The goal is to let an Agent operate TraeCN completely at the level
of user intent while the local gateway owns fragile UI and lifecycle mechanics.

## Product promise

TRAECNclaw should let an Agent reliably perform this workflow:

```text
inspect or select context when necessary
  -> submit one user instruction
  -> release the Agent turn
  -> survive queueing, reconnect, and gateway restart
  -> surface only exceptional questions or approvals
  -> return the exact task result
  -> cancel or stop only the intended work
```

The Agent should not need to understand CDP selectors, queue probes, persistence
files, event cursors, process recovery, UI locks, or polling loops.

## Public contract decision

MCP contract version 5 remains exactly 20 ordered tools. Treat the names and
order in `src/mcp/contract.js` as a compatibility boundary.

Do not add a tool merely because an internal HTTP endpoint or CLI command
exists. A new tool is justified only when all of these are true:

1. It represents a distinct user intent that the existing tools cannot express.
2. The gateway cannot perform it automatically as part of an existing intent.
3. It is useful to more than one real host or workflow.
4. Its permissions and failure semantics can be explained clearly.
5. A migration plan, contract version change, host tests, Skill update, and
   marketplace rescan are in scope.

Waiting, polling, event acknowledgement, recovery, process control, queue
maintenance, proofs, and generic command dispatch remain non-tools.

## Tool groups and progressive disclosure

### Core task flow

- `traecn_send_message`
- `traecn_get_task`
- `traecn_cancel_task`

These should dominate normal Agent usage. `traecn_send_message` is the only tool
that creates durable delegated work. `traecn_get_task` is an intentional later
read or diagnostic read, not a busy-poll primitive.

### Context selection

- `traecn_open_workspace`
- `traecn_list_models`
- `traecn_select_model`
- `traecn_select_mode`
- `traecn_list_conversations`
- `traecn_create_conversation`
- `traecn_select_conversation`

Call context tools only when the requested state differs or ambiguity must be
resolved. Do not repeat the workspace path in the model message after opening
it.

### Settings

- `traecn_list_setting_sections`
- `traecn_list_settings`
- `traecn_list_setting_options`
- `traecn_set_setting_toggle`
- `traecn_select_setting_option`
- `traecn_set_setting_text`

Settings are advanced, UI-backed capabilities. Discovery precedes mutation;
never guess a section, label, or dropdown option.

### Exceptional interaction and irreversible action

- `traecn_stop_generation`
- `traecn_delete_conversation`
- `traecn_answer_question`
- `traecn_decide_approval`

These exist because the gateway cannot safely infer the user's choice. Their
inputs must remain tightly bound to visible identity, exact command/title, and
the already-authorized task scope.

## Canonical Agent workflows

### Normal task

```text
traecn_send_message
  -> receive durable task ID or MCP Task handle
  -> use host Tasks subscription when supported
  -> otherwise make one intentional later traecn_get_task call
```

### Context change plus task

```text
traecn_open_workspace      only when required
traecn_list_models         only when choices matter
traecn_select_model        at most once
traecn_select_mode         only when mode differs
traecn_send_message
```

### Conversation-specific work

```text
traecn_list_conversations
  -> create or select exactly one conversation
  -> traecn_send_message with conversationId when concurrency is ambiguous
```

### Exceptional approval

```text
task becomes input_required / approval_required
  -> Agent reads exact command and risk reasons
  -> traecn_decide_approval with exact command, acknowledgement, and reason
  -> gateway revalidates the visible card before acting
```

## Metadata quality milestone

The current tool names and semantics are sound, but marketplace and host quality
can improve without changing contract version or tool count. Implement the
following as one characterized metadata milestone.

### Human-readable titles

Every tool should have a concise `title`, for example:

| Tool | Recommended title |
| --- | --- |
| `traecn_send_message` | Send TraeCN Task |
| `traecn_get_task` | Get TraeCN Task |
| `traecn_cancel_task` | Cancel TraeCN Task |
| `traecn_stop_generation` | Stop Visible Generation |
| `traecn_open_workspace` | Open TraeCN Workspace |
| `traecn_list_models` | List TraeCN Models |
| `traecn_select_model` | Select TraeCN Model |
| `traecn_select_mode` | Select TraeCN Mode |
| `traecn_list_conversations` | List TraeCN Conversations |
| `traecn_create_conversation` | Create TraeCN Conversation |
| `traecn_select_conversation` | Select TraeCN Conversation |
| `traecn_delete_conversation` | Delete TraeCN Conversation |

Settings and interaction tools follow the same pattern. Titles are display
metadata; names remain unchanged.

### Descriptions

Each description should answer, in as few sentences as possible:

1. What user intent does the tool perform?
2. When should the Agent call it?
3. What important side effect or boundary applies?
4. What stable identity or result does it return?

Avoid repeating parameter descriptions or implementation details. Include a
clear negative instruction only when it prevents a common misuse, such as not
using `traecn_get_task` for tight polling or not using
`traecn_stop_generation` when a gateway task ID exists.

### Input schemas

- Keep `additionalProperties: false`.
- Give every property an operational description.
- Add lengths, patterns, enums, and formats when the gateway already enforces
  them.
- Do not encode secrets or user-specific paths as examples.
- Keep stable IDs explicitly tied to the listing tool that produced them.
- Validate conditional requirements in production code and document them in
  descriptions until the supported JSON Schema dialect can express them
  portably.

### Output schemas

Replace the generic `additionalProperties: true` output declaration with a
small set of reusable schemas that match actual `structuredContent`.
Recommended families:

- `TaskAcceptedResult`
- `TaskSnapshotResult`
- `ListResult`
- `SelectionResult`
- `MutationResult`
- `InteractionResult`
- `ErrorResult`

The schema may retain extensibility with well-defined common fields, but it must
not promise fields the handler does not return. When an output schema is
declared, every success and error path must be validated in tests.

Common result fields should be consistent where applicable:

```text
success
status
message
taskId
conversationId
changed
retryable
code
nextAction
```

Continue returning serialized JSON in text content for compatibility while
keeping it semantically equivalent to `structuredContent`.

### Tool annotations

Annotations must describe real behavior rather than applying one default to
every tool.

- Read/list/get operations: `readOnlyHint: true`, `idempotentHint: true`.
- Pure local selections and setting assignments may be idempotent when repeating
  the same arguments produces the same state; confirm with tests before marking.
- Conversation creation and message submission are not idempotent unless the
  protocol path supplies and enforces a durable idempotency identity.
- Cancellation, visible stop, approval, and permanent deletion retain accurate
  destructive hints.
- `openWorldHint` should be false for operations confined to the local TraeCN
  instance and its visible state. Keep it true only when the delegated work may
  interact beyond that closed local state.

Tool annotations are hints, never authorization. Existing confirmation and
revalidation rules remain the source of truth.

### Task support

Declare task execution support explicitly:

- `traecn_send_message`: `execution.taskSupport: "optional"` for protocol eras
  and hosts that negotiate the supported task capability or extension.
- All other contract-v5 tools: `"forbidden"` unless executable evidence proves
  a genuine asynchronous tool need.

Keep the independently negotiated Tasks extension behavior separate from the
20-tool contract. Do not claim universal host support.

### Icons

Icons are optional. Add them only when there is a stable public, license-cleared
asset and the release/package path can include it reproducibly. A missing icon
is preferable to an external hotlink or inconsistent marketplace branding.

## Error design

Use protocol errors for malformed JSON-RPC envelopes, unknown methods/tools, or
invalid protocol negotiation. Use tool execution errors for valid calls that
cannot complete because of runtime state, permissions, stale identity, or TraeCN
behavior.

Tool execution errors should be actionable and structured:

```json
{
  "code": "TRAE_NOT_READY",
  "message": "TraeCN is running but the chat composer is not ready.",
  "retryable": true,
  "nextAction": "Open a project/chat window, then retry once."
}
```

Do not leak tokens, authorization headers, local profile data, raw DOM, or
unredacted command output. Preserve stable public error codes across adapters.

## Resources, prompts, and MCP Apps

Do not add MCP resources or prompts merely to increase capability counts.
The public Agent Skill already provides procedural guidance, while task results
return the data needed for the current workflow.

Add a resource only when a real host benefits from addressable, reusable data
that should not be a tool call, such as a task result or diagnostic artifact
with a stable URI. Add a prompt only when a real user-facing workflow cannot be
expressed clearly through the Skill.

MCP Apps or inline UI may be evaluated later for task/approval visualization,
but they must not replace the Web Control Console or create a second task
lifecycle. Require a named host, prototype, and user evidence first.

## Quality tests

Add a focused metadata/contract test that fails when:

- the ordered 20-tool names change unexpectedly;
- any tool lacks a title or clear description;
- an input property lacks a description;
- an output schema does not validate representative success and error results;
- task support is missing or wrong;
- read-only/destructive/idempotent/open-world annotations contradict the
  characterized behavior;
- text and structured results differ semantically;
- two tools have materially overlapping intent;
- removed profiles or lifecycle tools reappear.

Continue to run:

```sh
npm run test:mcp-conformance
npm run test:mcp-stdio-smoke
npm run check:skill-contracts
npm run test:system
npm run verify
```

For a release-facing metadata change, also run the real intended host and the
marketplace rescans being claimed.

## Glama and directory optimization

Do not rewrite tools solely to chase a score. Treat marketplace findings as
signals:

- fix unclear purpose, missing parameter semantics, inconsistent output, or
  overlap when the finding is correct;
- reject requests that would expand tools, weaken local-first boundaries, or
  misrepresent cloud execution;
- record the before/after score and exact canonical change;
- regenerate the public mirror instead of editing generated Skill bytes.

## MCP design completion criteria

The next metadata milestone is complete when:

1. The 20-tool names/order and runtime behavior are unchanged.
2. Titles, descriptions, schemas, annotations, and task support are accurate.
3. Representative outputs validate against declared schemas.
4. Codex and at least one additional relevant host discover and call the server.
5. Glama/Smithery/other selected inspections show the intended 20 tools.
6. The runtime Skill teaches the minimal normal flow and advanced capabilities
   without exposing internal lifecycle mechanics.
7. Full repository and release gates pass.

## Primary references

- MCP tools specification: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- MCP schema reference: https://modelcontextprotocol.io/specification/2025-11-25/schema
- MCP Tasks extension: https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks
- MCPB specification/tooling: https://github.com/modelcontextprotocol/mcpb
