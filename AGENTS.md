# Repository Guidelines

## Project Structure & Product Surfaces

TraeCN MCP is a Node.js 22 CommonJS local runtime for controlling TraeCN on macOS. `src/config` owns runtime configuration, `src/cdp` owns CDP/DOM drivers, `src/http` owns the gateway and task lifecycle, `src/mcp` owns stdio protocol behavior, `src/shared` owns durable stores/utilities, and `src/skill` exposes the JavaScript compatibility API. The public Agent Skill lives in `skills/traecn-mcp`; OpenClaw is under `integrations/openclaw-traecn-plugin`; public distribution templates live in `distribution/public-mirror`.

Keep these roles distinct:

- **MCP Skill:** primary Agent product.
- **Web Control Console:** single human control product, including authenticated remote use.
- **CLI:** setup, doctor, service operations, scripting, recovery, logs, release checks, and live validation.
- **Local gateway:** shared runtime core; never duplicate its task/UI lifecycle in clients.
- **OpenClaw/REST/JavaScript API:** adapters and integration layers.
- **GitHub, ClawHub, Glama, skills.sh, Smithery, registries, directories, and catalogs:** discovery/install channels, not independent runtimes.

Do not commit local output such as `audit-logs`, `demo-output`, `logs`, `.env`, `dist`, or `node_modules`.

## Agent Skill

Use `skills/traecn-mcp` for operating TraeCN through the 20-tool MCP runtime.

## Subtraction and MCP Rules

- Keep MCP contract v5 at exactly 20 ordered tools unless an explicit migration is approved.
- Do not add wait, poll, recovery, event-acknowledgement, process, proof, or generic command tools.
- One tool represents one user intent; gateway mechanics remain internal.
- Preserve semantic parity between text and structured results.
- Improve titles, descriptions, output schemas, annotations, task support, and errors without changing names/order/behavior.
- Do not add resources, prompts, icons, or MCP Apps for marketplace scores alone.
- Do not grow CLI and web into two human products.
- Keep normal web tasks separate from Advanced/Diagnostics.
- Do not create cloud execution behavior merely for a marketplace.
- Do not claim untested platforms, TraeCN versions, hosts, transports, or package channels.

## Distribution and Promotion Rules

- Search for an existing listing before submitting; reconcile rather than duplicate.
- Publish verified source and artifacts in `Luckycat133/traecn-mcp`.
- Verify public download hashes and the actual channel install before recording a migration.
- Public source version, tag, public Release, ClawHub, Glama, skills.sh, Smithery, npm, Official Registry, PulseMCP, and Homebrew are separate facts.
- Never point current listings at npm `traecnclaw@0.3.1`.
- Use MCPB/Smithery Local for local stdio distribution; do not select Smithery URL mode without a real Streamable HTTP product.
- Do not imply Glama or another cloud container can transparently control the user's local Mac.
- Store canonical listing copy and provenance in source; do not improvise install claims in browser forms.
- A channel is verified only after inspecting its public page and testing its generated install path.
- Promotion must use real host/TraeCN evidence, honest macOS/version limitations, and requests for feedback rather than coordinated upvotes.

## Build, Test, and Experience Commands

- `npm ci`: install the exact lockfile graph.
- `npm run verify:static`: check versions, generated configuration, Skill contracts, and release scanning.
- `node scripts/public-mirror.test.js`: verify generated public distribution files.
- `npm run test:mcp-conformance`: test supported protocol eras with independent clients.
- `npm run test:trae-adapters`: replay sanitized TraeCN fixtures.
- `npm run test:system`: run the real gateway against the mock bridge.
- `npm run test:mcp-stdio-smoke`: spawn stdio MCP and verify discovery.
- `npm run verify`: repository-wide non-live gate.
- `npm run test:release`: verified artifacts and clean-room mock task.
- `npm run doctor`: diagnose local setup.
- `npm run inspect:verify`: inspect real TraeCN DOM/adapter state.
- `node scripts/live-uat.js --strict --require-ready --require-verified-adapter`: live readiness without delegation.
- `TRAECN_ENABLE_MOCK_BRIDGE=1 npm run start:gateway`: mock experience.
- `npm run start:gateway`: real gateway once TraeCN CDP is ready.

Run the nearest focused test first. Static audits prove declarations, mock tests prove process integration, clean-room tests prove built artifacts, only live UAT proves current TraeCN compatibility, and marketplace scores prove only their scan.

For MCP metadata work, add focused tests that validate titles, property descriptions, reusable output schemas against real results, annotations, `execution.taskSupport`, exact tool order, and text/structured equivalence.

For package/channel work, test the actual published MCPB/npm/Homebrew/directory install rather than only local files.

## Coding Style & Change Evidence

Use CommonJS (`require`, `module.exports`), keep `'use strict';`, follow two-space indentation and semicolon style, and use descriptive kebab-case filenames. Tests use matching `*.test.js` files with Node `assert` and `src/shared/test-runner.js`. Prefer injected stores, drivers, clocks, network probes, and process hooks.

Identify the owning component before editing. Characterize responses, persisted fields, events, task identity, and user-visible behavior before moving lifecycle logic. Delete old paths after callers migrate.

Update README, OpenAPI, compatibility evidence, generated contracts, changelog, marketplace metadata, launch copy, and release metadata only when affected. Pull requests should describe behavior/root cause, focused tests, wider gates, and the exact mock/live/web/package/marketplace experience exercised.

## Configuration

Never commit `.env`, tokens, authorization headers, passwords, cookies, or raw TraeCN profile data. Keep the gateway on loopback unless remote access is deliberately authenticated. For human remote web access, prefer a private network such as Tailscale or a deliberately configured HTTPS tunnel; never expose a tokenless gateway publicly. Use canonical environment names from `src/config/runtime-schema.js` and existing sanitization helpers.

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
