# TraeCN 设置操作指南

本文件保留为中文速查。可发布、跨 agent 的规范 skill 已迁移到
`.codex/skills/traecnclaw-mcp/SKILL.md`，使用 TRAECNclaw 的真实 stdio MCP
工具面，而不是旧的设置动作包装器。

## 当前推荐工具

优先通过 MCP 调用：

- `traecn_get_capabilities`: 低 token 能力发现
- `traecn_preflight`: 状态、就绪度、队列、弹窗、确认计划的一次性预检
- `traecn_plan_operation`: 有副作用操作前生成确认和风险计划
- `traecn_get_settings`: 读取当前或指定设置栏目
- `traecn_set_setting`: 按 label 写入设置
- `traecn_switch_model`: 切换模型
- `traecn_switch_mode`: 切换 Solo/IDE 模式
- `traecn_get_dialog_status` / `traecn_respond_dialog`: 处理确认弹窗
- `traecn_list_commands` / `traecn_run_command`: 使用稳定命令目录和通用命令入口

默认 `TRAECN_MCP_TOOL_PROFILE=public` 只暴露 20 个常用工具。需要恢复、
cleanup、Solo 对话或长队列证明时改用 `ops`；需要完整兼容面时改用 `full`。
`traecn_dismiss_dialog`、`traecn_get_status`、`traecn_get_queue_status`、
`traecn_submit_solo_task` 属于 `full` 兼容工具，默认客户端优先用
`traecn_preflight`、`traecn_respond_dialog`、`traecn_queue_task` 或
`traecn_run_unattended_workflow`。

## 设置读写流程

1. 调用 `traecn_preflight`，确认 gateway、TraeCN UI、队列和弹窗状态可操作。
2. 用 `traecn_get_settings` 读取目标 section。
3. 对写操作先调用 `traecn_plan_operation` 或带 command/params 的 `traecn_preflight`。
4. 用 `traecn_set_setting` 写入 label/value/section。
5. 再调用 `traecn_get_settings` 或 `traecn_preflight` 验证结果。

示例：

```json
{
  "tool": "traecn_get_settings",
  "arguments": {
    "section": "mcp"
  }
}
```

```json
{
  "tool": "traecn_set_setting",
  "arguments": {
    "section": "模型",
    "label": "默认模型",
    "value": "GLM-5.2"
  }
}
```

## 模型切换

模型切换使用 `traecn_switch_model`，不要通过设置面板模拟点击：

```json
{
  "tool": "traecn_switch_model",
  "arguments": {
    "name": "glm",
    "waitForQueue": true
  }
}
```

## stdio MCP 不要使用的名称

以下名称不是当前 stdio MCP server 的工具名；它们可能属于早期草稿或
OpenClaw 插件兼容层：

- `traecn_settings_action`
- `traecn_settings_read`
- `traecn_switch_model`

如需完整工具目录，运行：

```bash
node -e "console.log(require('./mcp-server').MCP_TOOLS.map(t => t.name).join('\n'))"
```

无人值守能力的最终验证仍以以下命令为准：

```bash
npm run acceptance:audit -- --require-complete
```
