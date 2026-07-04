# TRAECNclaw MCP Launch Kit

Use these drafts after the repository or release artifact is public.

## One-Line Positioning

TRAECNclaw MCP lets MCP-capable agents operate TraeCN through a local, auditable
stdio server instead of brittle screen control.

## Short Listing Copy

TRAECNclaw MCP is a portable Agent Skill and stdio MCP server for TraeCN desktop
automation. It gives Codex, OpenClaw, Claude Desktop, Cursor, Cline/Roo Code,
Windsurf, and other MCP-capable agents a structured tool surface for readiness
checks, task delegation, queue polling, model/mode switching, settings,
dialogs, code review, unattended workflows, and long-queue proof runs.

## X / Twitter

I just published TRAECNclaw MCP: a portable Agent Skill + stdio MCP server that
lets AI coding agents operate TraeCN through real tools instead of GUI control.

It supports readiness checks, task queues, model/mode switching, settings,
dialogs, code review delegation, and unattended workflow runs.

Repo: https://github.com/Luckycat133/TRAECNclaw

## LinkedIn

I have been working on TRAECNclaw MCP, a portable Agent Skill and stdio MCP
server for TraeCN automation.

The goal is simple: make TraeCN usable by any MCP-capable AI agent through a
clear, layered tool surface instead of screen automation. The public profile
keeps the default tool list small, while ops and full profiles expose recovery,
cleanup, Solo conversation control, diagnostics, and long-queue proof workflows.

It includes:

- `traecn_get_capabilities` and `traecn_preflight` for low-token discovery and readiness checks
- task run/queue/poll/wait tools
- model, mode, settings, and dialog controls
- code review delegation
- unattended workflow support
- a portable `.codex/skills/traecnclaw-mcp` skill folder for agent clients

Repo: https://github.com/Luckycat133/TRAECNclaw

## Reddit / Community Post

Title:

`TRAECNclaw MCP: a portable Agent Skill + stdio MCP server for TraeCN automation`

Body:

I built TRAECNclaw MCP to let MCP-capable coding agents operate TraeCN through a
real local tool interface.

It exposes a profile-scoped stdio MCP surface:

- `public`: 20 common tools for normal agent integrations
- `ops`: recovery, cleanup, Solo conversation control, and long-queue proof tools
- `full`: every explicit shortcut for compatibility and audits

The repo also includes a portable Agent Skill at
`.codex/skills/traecnclaw-mcp`, so agents can learn how to configure and use the
server without copy-pasting long prompts.

Use cases:

- delegate tasks into TraeCN
- queue and poll long-running work
- switch model/mode
- read/write settings
- handle dialogs
- run code review prompts
- run unattended workflows with evidence

Repo: https://github.com/Luckycat133/TRAECNclaw

## Chinese Post

我整理并发布了 TRAECNclaw MCP：一个面向 TraeCN 的本地 stdio MCP server +
可复用 Agent Skill。

它的目标是让 Codex、OpenClaw、Claude Desktop、Cursor、Cline/Roo Code、
Windsurf 等支持 MCP 的 agent，可以通过真实工具面操作 TraeCN，而不是依赖
脆弱的屏幕控制。

现在默认 public profile 只暴露 20 个常用工具，同时保留 ops/full 分层给恢复、
cleanup、Solo 对话、诊断和长队列 proof 使用。

包含能力：

- 能力发现和预检：`traecn_get_capabilities` / `traecn_preflight`
- 任务提交、排队、轮询、等待
- 模型/模式切换
- 设置读写
- 弹窗确认
- 代码审查委派
- 无人值守 workflow
- 可直接安装的 `.codex/skills/traecnclaw-mcp`

Repo: https://github.com/Luckycat133/TRAECNclaw

## Directory Submission Note

TRAECNclaw MCP is both a local stdio MCP server and a portable Agent Skill.
Please list the skill path as `.codex/skills/traecnclaw-mcp` and the server
entrypoint as `mcp-server.js` or the package bin `traecnclaw-mcp`.
