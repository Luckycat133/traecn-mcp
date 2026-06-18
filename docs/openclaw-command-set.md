# OpenClaw TraeCN Command Set

This document describes the production command surface exposed by
`integrations/openclaw-traecn-plugin`.

## Recommended Tools

Use these two tools first when integrating OpenClaw with TraeCN:

- `capabilities`: returns a compact agent-facing catalog of commands, HTTP
  endpoints, MCP surfaces, known models, settings sections, and token-saving
  call order.
- `preflight`: returns status, readiness, queue, dialog, and optional command
  confirmation state in one compact response.
- `traecn_command_set`: returns the supported preset commands and their required
  parameters.
- `traecn_command`: executes one preset command through the local TraeCNclaw
  gateway.

The command router keeps OpenClaw prompts stable while gateway routes evolve.
Prefer it over hard-coding HTTP paths in OpenClaw-side prompts or workflows.
For `delegate` and `delegate_async`, the router applies the structured layered
prompt mechanism by default. Pass `useLayeredPrompt: false` only when the caller
needs to send the raw task text unchanged.

## Core Commands

| Command | Purpose | Required params |
| --- | --- | --- |
| `capabilities` | Return compact agent capability catalog | none |
| `preflight` | Return compact live preflight state and optional command plan | none |
| `confirm_plan` | Build side-effect, risk, and preflight plan without operating TraeCN | `command` |
| `restart_trae_debug` | Confirmed restart of Trae CN with existing logged-in profile and CDP enabled | none |
| `status` | Check gateway and automation status | none |
| `readiness` | Check whether TraeCN UI automation targets are ready | none |
| `new_chat` | Create and switch to a new TraeCN chat | none |
| `delegate` | Send a task and wait for the final response | `task` |
| `delegate_async` | Submit an async task and manage polling externally | `task` |
| `task_status` | Query an async task | `taskId` |
| `cancel_task` | Cancel a queued async task | `taskId` |
| `switch_mode` | Switch between `solo` and `ide` modes | `mode` |
| `switch_model` | Switch the active model | `model` |
| `queue_status` | Check if the model is queued or busy | none |
| `open_project` | Open a project in TraeCN | `projectPath` |
| `settings_read` | Read current or selected settings section | none |
| `settings_read_all` | Read all settings sections | none |
| `settings_set` | Change a setting by label | `label`, `value` |
| `settings_navigate` | Navigate to a settings section | `section` |
| `settings_back` | Return from settings to chat | none |
| `dialog_status` | Inspect pending dialogs | none |
| `approve_dialog` | Approve, deny, or auto-handle a dialog | none |
| `dismiss_dialog` | Dismiss the current dialog | none |
| `batch_submit` | Submit a group of tasks | `tasks` |
| `batch_status` | Check batch progress | `batchId` |
| `batch_cancel` | Cancel a batch | `batchId` |

## Examples

```json
{
  "command": "preflight",
  "params": {
    "command": "delegate_async",
    "params": {
      "task": "分析当前项目并提出三个可执行改进建议"
    }
  }
}
```

When `preflight.nextAction` is
`restart_traecn_with_debug_existing_profile`, first plan or call the confirmed
recovery command:

```json
{
  "command": "restart_trae_debug",
  "params": {
    "confirmationPhrase": "restart-trae-cn-with-debug-existing-profile"
  }
}
```

```json
{
  "command": "delegate",
  "params": {
    "task": "分析当前项目并提出三个可执行改进建议",
    "includeProcessText": false,
    "waitForQueue": true,
    "autoModelFallback": true,
    "modelProbeIntervalMs": 60000
  }
}
```

```json
{
  "command": "delegate_async",
  "params": {
    "task": "全面审查当前仓库并输出 findings-first 结果",
    "reviewRequired": true,
    "waitForQueue": true,
    "fallbackModels": ["GLM-5.2", "Kimi-K2.6", "DeepSeek-V4-Flash"]
  }
}
```

```json
{
  "command": "settings_set",
  "params": {
    "section": "模型",
    "label": "默认模型",
    "value": "GLM-5.2"
  }
}
```

```json
{
  "command": "batch_submit",
  "params": {
    "strategy": "sequential",
    "maxConcurrency": 1,
    "tasks": [
      { "task": "检查 README 是否过期" },
      { "task": "总结 src/http/gateway.js 的公开接口" }
    ]
  }
}
```

## Production Notes

- Start with `preflight` before sending tasks to a live TraeCN UI; fall back to
  `status` and `readiness` only when debugging a specific probe.
- Use `delegate_async` plus `wait_task` for long-running or queued work; use
  `task_status` only for one-off checks.
- Add `fallbackModels` or `autoModelFallback=true` when OpenClaw should let the
  gateway probe alternate models in the background instead of keeping the caller
  in a token-consuming wait loop.
- Use `dialog_status` before `approve_dialog` when OpenClaw needs to explain a
  pending confirmation to the user.
- Use `settings_navigate`, `settings_read`, and `settings_set` instead of the
  older unimplemented `/api/settings/action` path.
- Keep the gateway bound to `127.0.0.1` and configure
  `TRAECN_GATEWAY_TOKEN` when OpenClaw or browsers can reach the gateway.
