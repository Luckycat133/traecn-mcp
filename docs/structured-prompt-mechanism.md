# Structured Layered Prompt Mechanism

TRAECNclaw uses a deterministic prompt layering mechanism to help OpenClaw and
MCP clients control Trae CN accurately while keeping the architecture extensible.

## Layer Order

Prompts are composed in this fixed order:

1. `identity`: role, objective, and operating stance.
2. `safety`: command boundaries, validation, and approval policy.
3. `capability`: activated Trae CN core capabilities.
4. `context`: project, session, mode, model, task, queue, and batch state.
5. `workflow`: ordered action plan for the selected command.
6. `command`: original user command and raw parameters.
7. `output`: response contract and continuation rules.

The implementation lives in
`src/skill/prompt-layers.js`. OpenClaw command routing composes this prompt for
`delegate` and `delegate_async` unless callers pass `useLayeredPrompt: false`.

## Capability Activation

The mechanism explicitly activates these core abilities per command profile:

- Natural language understanding: preserve intent, constraints, and language.
- Instruction execution: translate intent into deterministic app operations.
- Multi-task handling: maintain ordered sub-tasks, task IDs, and batch state.
- Context retention: carry project/session/mode/model/queue/dialog state.
- Reliability: validate inputs, use typed routes, and report recoverable errors.

## Skills Best Practices

Skill modules should follow progressive disclosure:

- Put only trigger conditions and the core workflow in `SKILL.md`.
- Move detailed references into a `references/` folder.
- Put deterministic or fragile operations in `scripts/`.
- Keep command names stable and typed; avoid free-form UI control when a route
  exists.
- Add regression tests for every new command or skill layer.

## MCP Best Practices

TRAECNclaw maps the architecture to MCP primitives:

- `tools`: executable, typed app actions such as `delegate` or `switch_model`.
- `prompts`: reusable templates such as `traecn_layered_command`.
- `resources`: discoverable context such as command catalogs and architecture
  docs.

The prompt layer module exposes:

- `getMcpCapabilities()`
- `listMcpPrompts()`
- `getMcpPrompt(name, args)`
- `listMcpResources()`
- `readMcpResource(uri)`

These helpers are intentionally dependency-free so a future MCP server can use
them directly while preserving the same command semantics used by OpenClaw.

## Extension Rules

To add a new command:

1. Add the command to `integrations/openclaw-traecn-plugin/lib/command-set.js`.
2. Add or update its profile in `src/skill/prompt-layers.js`.
3. Add a typed OpenClaw schema in `openclaw.plugin.json` when exposed directly.
4. Add unit tests for parameter validation and route mapping.
5. Update `docs/openclaw-command-set.md` if users should call it directly.

To add a new skill module:

1. Keep the hot-path instructions concise.
2. Export deterministic helpers from `src/skill`.
3. Add MCP prompt/resource descriptors only when they improve discovery.
4. Preserve backward-compatible aliases unless intentionally deprecated.

## Stability Contract

- Existing command names are stable.
- New commands must be additive by default.
- Prompt layer order is stable and covered by tests.
- Callers may opt out of prompt wrapping with `useLayeredPrompt: false`.
- Risky app actions must remain explicit and auditable.
