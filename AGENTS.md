# TRAECNclaw

## Product and ownership

Node.js 22 CommonJS local macOS runtime for TraeCN. The gateway owns CDP/DOM control, task lifecycle and durable state; clients remain adapters. MCP Skill is the primary agent product, Web Control Console is the single human product, and CLI covers setup, operations, scripting and recovery. Distribution channels are not independent runtimes.

`src/config` owns config, `src/cdp` drivers, `src/http` gateway/lifecycle, `src/mcp` protocol, `src/shared` stores/utilities, and `src/skill` JavaScript compatibility. Public Skill: `skills/traecnclaw-mcp`; OpenClaw adapter: `integrations/openclaw-traecn-plugin`; public templates: `distribution/public-mirror`.

## Task routing

For substantive development, audit, packaging or distribution work, read [.codex/skills/traecnclaw-development/SKILL.md](.codex/skills/traecnclaw-development/SKILL.md) and its relevant reference. Its dated channel/PR snapshots are historical; confirm current state before making a present-tense claim. Use the public Skill only to operate TraeCN, never publish the maintainer Skill.

- MCP changes: `references/mcp-product-design.md` under the maintainer Skill.
- Product/channel scope: `references/project-audit.md` and `references/distribution-promotion-plan.md`.
- Glama operations: `references/glama-browser-runbook.md`.
- Accepted-task, restart and missing-completion diagnosis: `references/task-recovery.md` under the maintainer Skill.
- Test, packaging and live-evidence commands: [docs/agent-verification.md](docs/agent-verification.md).

## Fixed contracts

- Keep MCP contract v5 at exactly 20 ordered tools unless the user authorizes a migration. Preserve names, semantics, text/structured parity and task support; one tool represents one user intent.
- Do not add generic command, wait/poll, recovery, event-acknowledgement, process or proof tools, or duplicate lifecycle logic in clients.
- Keep normal web tasks separate from Advanced/Diagnostics. Add MCP resources/prompts/icons/Apps only for a concrete host/user need.
- Fix canonical source/templates and regenerate public mirrors. Publish the public mirror, never the private canonical repository. Reconcile existing listings; preserve source provenance and canonical install copy.
- Never direct current listings to `traecnclaw@0.3.1`. MCPB/Smithery Local covers local stdio; URL/cloud execution needs an actual supported HTTP product. Public releases, registries and generated install paths are separate evidence.
- Make compatibility claims only for the exact tested host, version, transport and channel. Promotion requests feedback, not coordinated upvotes.

## Implementation and configuration

Use CommonJS, `'use strict';`, two spaces and existing `*.test.js`/Node assert conventions. Extend the owning store/driver/service; characterize identities, persisted fields, events and responses before moving lifecycle logic. Update only affected contracts, API docs, release and channel metadata.

Use `src/config/runtime-schema.js` and sanitization helpers. Never commit credentials, raw TraeCN profiles, `.env`, `audit-logs`, `demo-output`, `logs`, `dist` or `node_modules`. Keep the gateway on loopback unless remote access is deliberately authenticated; never expose a tokenless gateway publicly.

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
