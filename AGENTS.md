# Repository Guidelines

## Project Structure & Product Surfaces

traecn-mcp is a Node.js 22 CommonJS local runtime for controlling TraeCN on macOS. `src/config` owns runtime configuration, `src/cdp` owns CDP/DOM drivers, `src/http` owns the gateway and task lifecycle, `src/mcp` owns stdio protocol behavior, `src/shared` owns durable stores/utilities, and `src/skill` exposes the JavaScript compatibility API. OpenClaw is under `integrations/openclaw-traecn-plugin`; distribution templates live in `distribution/`.

MCP is the primary Agent interface, the web console is the human interface, and CLI is for setup, operations and scripts. They share the same gateway. Do not create a second task lifecycle in a client or expand platforms without actual test evidence.

Do not commit local output such as `audit-logs`, `demo-output`, `logs`, `.env`, `dist`, or `node_modules`.

## Repository Development Skill

Use `.codex/skills/traecn-mcp-development/SKILL.md` for repository development, audit, naming migration, recovery, workspace protection, packaging and distribution. `.agents/skills/traecn-mcp-development` and `.claude/skills/traecn-mcp-development` are symlinks to that maintained source.

Load only the relevant reference: `project-audit.md`, `mcp-product-design.md`, `task-recovery.md`, `live-proof-workspace.md`, `distribution-promotion-plan.md` or `glama-browser-runbook.md`.

The runtime operating Skill is separate. At the reviewed remote baseline it remains `skills/traecnclaw-mcp`, mirrored exactly at `.codex/skills/traecnclaw-mcp`; these are compatibility identifiers, not the preferred product brand. Resolve actual current paths before editing. Do not copy the maintainer Skill into public artifacts or change one runtime copy independently.

## Compatibility and Task Rules

- Preserve MCP contract v5 and its exact 20 ordered `traecn_*` tools. No wait, poll, proof, recovery or generic command tools.
- Preserve schemas, result parity, protocol negotiation, terminal replay and task identity.
- Distinguish accepted HTTP request identity from native UI submission. An uncertain post-send crash requires reconciliation, not a blind retry.
- Distinguish in-process locks, file-writer locks, short UI mutexes and long-lived runtime/workspace ownership.
- A task waiting in Trae's native queue still owns its execution context. Route all context mutation through the same application guard.
- Keep cancellation/persistence checkpoints and follow-up parent completion markers already implemented.
- Project renaming must not silently replace package IDs, installed bins, environment variables, service labels or state directories. Preserve or explicitly migrate compatibility aliases.

## Tests and Evidence

Use `docs/agent-verification.md`. Accept maintainer-supplied passing tests as a baseline, label evidence provenance, and reconcile local and remote revisions before attributing a result to a commit. Documentation-only edits need focused name/link/symlink checks, not a model task or an automatic full-suite rerun.

Runtime changes need a failing regression and focused owner tests. Cross-cutting lifecycle/protocol changes need relevant integration and repository gates. Packaging/release changes need clean installed-artifact checks. Mock, schema inspection, live readiness, real generation, observed long queue and crash recovery are different claims.

## Distribution and Promotion

The canonical repository is public `Luckycat133/traecn-mcp`; do not repeat the historical assumption that source is private and only a mirror can be submitted. Existing package/channel slugs and historical releases may retain old identifiers. Reconcile rather than duplicate listings; update current source/visible names without rewriting immutable provenance. Treat each dated channel record independently.

Keep README, `llms.txt`, generated setup, actual files and installed commands consistent. Do not advertise an absent runtime-Skill path or bin. Promotion uses real evidence; do not add marketing to MCP task results or fabricate installs, model identity or long-queue success.

## Coding Style & Change Evidence

Use CommonJS, `'use strict';`, two-space indentation and descriptive kebab-case filenames. Tests use Node `assert` and the existing runner. Prefer injected stores, clocks, drivers and process hooks for fault tests.

Preserve unrelated work. Characterize responses, persisted fields, events and native ownership before moving lifecycle logic. Delete migrated duplicate paths after callers switch. Report actual changes, actual validation, supplied evidence and outstanding findings separately.

## Configuration

Use canonical runtime-schema environment names and existing redaction helpers. Never commit credentials, raw profiles or unrelated private task contents. A documentation audit does not authorize paid model tasks, native cancellation, workspace changes or publication.

<!-- agent-workflow:v1:start -->
## 通用执行约定（2026-09-13）

- 将行动请求执行到可验证结果；用上下文补齐常规细节，只有答案会实质改变结果时才澄清。新消息用于调整当前目标，不因阶段完成而反复询问是否继续。
- 系统/开发者限制优先；用户明确授权高于通用 Skill 默认流程。本块统一通用工作流，保留本项目的产品基线、兼容性、发布、凭据和计费专用门禁。缺少必要授权时先完成可审查的前置工作；已有同范围授权不重复索取。
- 只加载当前任务相关的入口、技能和必要片段；历史日志不是当前状态。规则导致暂停或偏离时，给出准确文件、条款和原因，不把自己的推断说成硬门。
- 默认用简洁段落报告结果和必要证据。独立子任务在工具与权限允许、且能明显节省时间时并行，先分配文件所有权；小任务不强行委派，不默默创建用户侧边栏任务。
- 验证覆盖实际改动和风险；小型文档或可逆改动不自动触发全产品测试。协议、发布、数据迁移等仍执行项目相应门禁。通过后停止重复检查；失败、新改动或未解决风险才扩大测试。
- 分开报告已改、已验证、未执行与阻塞；操作发起不等于结果完成。保留用户工作，未经当前任务授权不提交、推送、发布或改变模型/账户配置。

维护：只同步此标记块；各工具专用正文保留，不强求整份入口相同。项目若明确规定完整镜像，仍保持完整镜像。仅在规则更新或交付涉及规则时检查入口/副本一致性。
<!-- agent-workflow:v1:end -->
