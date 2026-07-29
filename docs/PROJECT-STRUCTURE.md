# 项目目录结构规范

本文档定义 TRAECNclaw 项目的目录结构规范、模块划分标准和代码组织原则。所有团队成员在新增文件、重构模块或调整依赖关系时必须遵循本规范。

## 1. 顶层目录结构

```
TRAECNclaw/
├── src/                    # 源代码（核心业务逻辑）
│   ├── capabilities.js     # API 能力声明（横跨 http 和 skill 的聚合层）
│   ├── server.js           # HTTP 服务器入口
│   ├── cdp/                # CDP/DOM 自动化驱动层
│   ├── client/             # HTTP 客户端与命令定义（v0.5+ 从 integrations 迁移）
│   ├── config/             # 环境与启动配置
│   ├── http/               # HTTP 网关层（路由、处理器、队列）
│   ├── mcp/                # MCP 服务器模块（工具定义、元数据、处理器、传输层）
│   ├── shared/             # 跨模块共享基础设施（日志、配置、工具）
│   └── skill/              # Skill API 层（对外暴露的编程接口）
├── integrations/           # 外部集成
│   └── openclaw-traecn-plugin/  # OpenClaw 插件
├── scripts/                # 运维脚本与审计工具
├── docs/                   # 项目文档
├── skills/                 # Skill 分发产物（SKILL.md 等）
├── mcp-server.js           # MCP 服务器入口（薄包装，实现在 src/mcp/）
└── package.json
```

## 2. 模块划分标准

### 2.1 `src/shared/` — 共享基础设施层

**职责：** 提供全项目复用的底层工具，不包含任何业务逻辑。

**允许依赖：** 仅 Node.js 内置模块和本目录内部模块。`config-manager.js` 可引用 `src/config/env.js`。

**包含内容：**
- `utils.js` — 通用工具函数（env 解析、日志脱敏、队列探测判断）
- `logger.js` — 统一日志器
- `config-manager.js` — 配置文件加载、校验、热重载
- `secret-vault.js` — 敏感值加密存储
- `task-history.js` — 任务历史记录存储
- `metrics.js` — 指标收集
- `audit-logger.js` — 审计日志
- `api-key-manager.js` — API 密钥管理
- `operation-confirmation.js` — 操作确认计划生成
- `request-context.js` — 请求上下文（异步本地存储）
- `http-body.js` — HTTP 请求体读取工具
- `mcp-auth.js` — MCP 认证
- `context-logger.js` — 上下文日志器
- `models.js` — 已知模型与设置区域常量
- `test-runner.js` / `test-helpers.js` — 测试基础设施

**禁止：** 引用 `cdp/`、`http/`、`skill/` 或 `capabilities.js`。这是防止循环依赖的关键防线。

### 2.2 `src/config/` — 环境与启动配置

**职责：** 环境变量加载、快速启动引导。

**允许依赖：** `shared/`。

**包含内容：**
- `env.js` — 环境变量加载与 fallback
- `quickstart.js` — TraeCN 进程发现与启动引导

### 2.3 `src/client/` — HTTP 客户端与命令定义层

**职责：** 提供 TraeCN API HTTP 客户端和命令集定义，作为 skill 层和 http 层之间的通信桥梁。

**允许依赖：** `shared/`、`skill/`（仅 prompt-layers 和 review）、`capabilities.js`。

**包含内容：**
- `traecnapi-client.js` — TraeCN API HTTP 客户端（从 `integrations/openclaw-traecn-plugin/lib/` 迁移）
- `command-set.js` — 命令集定义与执行（从 `integrations/openclaw-traecn-plugin/lib/` 迁移）

**设计理由：** 核心客户端库原位于 `integrations/` 目录，导致 `src/skill/` 和 `mcp-server.js` 对 integrations 产生反向依赖。迁移到 `src/client/` 后，`integrations/` 通过薄重导出层引用此模块，依赖方向正确。

### 2.4 `src/cdp/` — CDP/DOM 自动化驱动层

**职责：** 通过 Chrome DevTools Protocol 与 TraeCN Electron 实例通信，执行 DOM 自动化操作。

**允许依赖：** `shared/`、`config/`、本目录内部模块。

**包含内容：**
- `client.js` — CDP WebSocket 客户端
- `discovery.js` — CDP 端点发现与连接
- `browser-dom.js` — DOM 查询与操作基础
- `dom-driver.js` — DOM 自动化驱动（协调各 handler）
- `dom-handlers/` — DOM 操作处理器（按功能拆分）
  - `answer-question.js`、`dialogs.js`、`messaging.js`、`mode-detection.js`
  - `model.js`、`panel-capture.js`、`response-collection.js`
  - `restricted-mode.js`、`review-gate.js`、`setup.js`、`solo-chat.js`
- 各功能驱动：`settings-driver.js`、`editor-driver.js`、`file-driver.js`
  `terminal-driver.js`、`git-driver.js`、`search-driver.js`
  `diagnostics-driver.js`、`snapshot-driver.js`、`extension-driver.js`
  `command-palette-driver.js`、`mock-driver.js`
- `trae-control.js` — TraeCN 进程控制（启动、恢复）
- `health-watcher.js` — CDP 健康监控
- `errors.js` — CDP 层错误类
- `driver-config.js` — 驱动配置

**禁止：** 引用 `http/`、`skill/` 或 `capabilities.js`。

### 2.5 `src/http/` — HTTP 网关层

**职责：** 提供 REST API 和 WebSocket 接口，路由请求到 CDP 驱动或任务队列。

**允许依赖：** `cdp/`、`shared/`、`config/`、`capabilities.js`、`client/`、本目录内部模块。

**包含内容：**
- `gateway.js` — HTTP 服务器主入口，路由分发
- `route-table.js` — 路由表定义与处理器映射
- `request-gate.js` — 速率限制、CORS、认证、URL 脱敏
- `error-mapping.js` — 错误到 HTTP 状态码的映射
- `task-queue-service.js` — 任务队列服务
- `queue-state-machine.js` — 队列状态机
- `batch-executor.js` — 批量任务执行器
- `websocket-handler.js` — WebSocket 连接处理
- `driver-router.js` — CDP 驱动路由分发
- `recovery-helper.js` — CDP 恢复辅助
- `openapi.js` — OpenAPI 规范生成
- `chat-ui.js` — 调试用 Chat UI
- `notifications.js` — OpenClaw 回调通知
- `handlers/` — HTTP 请求处理器（按业务域拆分）
  - `status.js`、`tasks.js`、`delegate.js`、`sessions.js`
  - `solo-chat.js`、`trae-control.js`、`queue.js`
  - `task-actions.js`、`batch.js`、`project.js`
  - `driver-dispatch.js`

### 2.6 `src/mcp/` — MCP 服务器模块

**职责：** MCP 协议服务器实现，包含工具定义、元数据管理、请求处理、stdio 传输层。

**允许依赖：** `skill/`、`client/`、`capabilities.js`、`shared/`、本目录内部模块。

**包含内容：**
- `index.js` — 模块入口，统一导出所有子模块
- `tools.js` — MCP 工具定义、schema 声明、工具辅助函数
- `tool-metadata.js` — 工具元数据、profile 管理、注解、profile 查询
- `handler.js` — `callTool` 实现、`createMcpHandlers` 请求处理器
- `stdio-server.js` — stdio 传输层、消息读写、服务器启动

**设计理由：** 原 `mcp-server.js`（917 行）拆分为 4 个专注子模块，`mcp-server.js` 退化为薄包装入口。各子模块职责清晰：tools 定义工具契约，tool-metadata 管理 profile 和可见性，handler 处理运行时调用，stdio-server 处理传输。

**禁止：** 直接引用 `cdp/` 或 `http/`。MCP 层通过 `client/` 和 `skill/` 间接访问网关和 CDP 能力。

### 2.7 `src/skill/` — Skill API 层

**职责：** 对外暴露的编程接口，供 AI agent 和 SDK 消费者使用。

**允许依赖：** `shared/`、`client/`、本目录内部模块。

**包含内容：**
- `index.js` — Skill API 入口（分层加载架构）
- `traecn-skill.js` — TraeCNSkill 主类
- `simple-api.js` — 简化 API（单例模式）
- `errors.js` — Skill 层错误类
- `review.js` — 代码审查任务构建
- `prompt-layers.js` — MCP prompt/resource 定义
- `examples/` — 使用示例

**禁止：** 直接引用 `cdp/` 或 `http/`。Skill 层通过 `client/traecnapi-client.js`（HTTP 客户端）与网关通信，不直接操作 CDP。

### 2.8 `src/capabilities.js` — 能力聚合层

**职责：** 聚合 `http/openapi.js` 和 `skill/` 的元数据，构建 API 能力声明。

**允许依赖：** `http/openapi.js`、`skill/`。

**设计理由：** 此文件从 `shared/` 移出至 `src/` 根目录，以打破 `shared/` → `http/`/`skill/` → `shared/` 的循环依赖。它是一个薄聚合层，不属于任何单一模块。

### 2.9 `src/server.js` — 服务器入口

**职责：** 加载环境配置，启动 HTTP 网关。

**允许依赖：** `config/`、`shared/`、`http/`。

### 2.10 `mcp-server.js` — MCP 服务器入口

**职责：** stdio MCP 服务器，向 AI agent 暴露 TraeCN 工具。作为薄包装层，所有实现已迁移到 `src/mcp/`。

**允许依赖：** `src/mcp/`、`src/shared/mcp-auth.js`。

### 2.11 `integrations/openclaw-traecn-plugin/` — OpenClaw 插件

**职责：** OpenClaw 平台集成插件。`lib/` 下的 `command-set.js` 和 `traecnapi-client.js` 为薄重导出层，实际实现位于 `src/client/`。

**允许依赖：** `src/client/`、`src/capabilities.js`、`src/skill/`。

**包含内容：**
- `index.js` — 插件入口（直接引用 `src/client/`）
- `openclaw.plugin.json` — 插件清单
- `lib/command-set.js` — 薄重导出 → `src/client/command-set.js`
- `lib/traecnapi-client.js` — 薄重导出 → `src/client/traecnapi-client.js`

### 2.12 `scripts/` — 运维脚本与审计工具

**职责：** 提供项目运维、质量审计、端到端验证等命令行工具。

**允许依赖：** `src/` 下所有模块、`integrations/`、`package.json`。脚本文件为独立 Node 进程，不参与模块间依赖检查。

**按用途分类：**

| 类别 | 文件 | 用途 |
|------|------|------|
| **审计与验证** | `acceptance-audit.js`、`acceptance-audit.test.js` | 验收审计，验证项目功能完整性 |
| | `coverage-audit.js`、`coverage-gate.js` | 覆盖率审计与门禁 |
| | `uat-checklist.js` | UAT 检查清单，确保发布就绪 |
| **端到端测试** | `live-uat.js` | 实时 UAT 测试，验证网关与 CDP 集成 |
| | `long-queue-proof.js`、`long-queue-proof.test.js` | 长队列证明，验证排队和结果取回 |
| | `system-test.js` | 系统级集成测试 |
| **CLI 工具** | `traecn-cli.js`、`traecn-cli.test.js` | 统一 CLI 入口，提供 capabilities/preflight/plan 等命令 |
| | `trae-chat.js` | TraeCN 交互式聊天工具 |
| | `inspect-traecn.js` | TraeCN 进程检查与诊断 |
| **网关管理** | `gateway-service.js`、`start-gateway.js` | 网关服务管理与启动 |
| | `start-traecn.js`、`stop-traecn.js` | TraeCN 进程生命周期管理 |
| | `quickstart.js` | 快速启动引导 |
| **指标与导出** | `collect-metrics.js` | 指标收集 |
| | `bench-gateway.js` | 网关性能基准测试 |
| | `export-openapi.js` | OpenAPI 规范导出 |
| **开发工具** | `doctor.js` | 环境诊断工具 |
| | `check-versions.js` | 版本一致性检查 |
| | `package-skill.js` | Skill 打包工具 |
| | `test-chat-ui.js` | Chat UI 测试工具 |

**命名规范：**
- 可执行脚本使用 `.js` 后缀，通过 `node scripts/<name>.js` 运行
- 测试文件添加 `.test.js` 后缀
- 通过 `package.json` 的 `scripts` 字段注册快捷命令

## 3. 依赖方向规则

依赖必须严格遵循以下自底向上的层次关系，**禁止逆向依赖**：

```
Layer 0 (最低层): src/shared/         → 仅依赖 Node.js 内置模块
Layer 1:          src/config/         → 依赖 shared/
Layer 2:          src/cdp/            → 依赖 shared/、config/
Layer 2:          src/client/         → 依赖 shared/、skill/（仅 prompt-layers、review）、capabilities.js
Layer 3:          src/http/           → 依赖 cdp/、shared/、config/、capabilities.js、client/
Layer 3:          src/skill/          → 依赖 shared/、client/
Layer 3:          src/mcp/            → 依赖 skill/、client/、capabilities.js、shared/
Layer 4 (聚合层): src/capabilities.js → 依赖 http/openapi、skill/
Layer 5 (入口):   src/server.js       → 依赖 config/、shared/、http/
                  mcp-server.js       → 依赖 src/mcp/、src/shared/mcp-auth.js
```

**循环依赖检查清单：**
- `shared/` 不得引用 `cdp/`、`http/`、`skill/`、`client/`、`mcp/`、`capabilities.js`
- `cdp/` 不得引用 `http/`、`skill/`、`client/`、`mcp/`、`capabilities.js`
- `client/` 不得引用 `cdp/`、`http/`、`mcp/`（仅引用 `shared/`、`skill/` 的 prompt-layers 和 review）
- `skill/` 不得引用 `cdp/`、`http/`、`mcp/`（通过 `client/traecnapi-client.js` HTTP 调用通信）
- `mcp/` 不得引用 `cdp/`、`http/`（通过 `client/` 和 `skill/` 间接访问）
- `capabilities.js` 不得引用 `shared/`（它从 `shared/` 移出正是为了打破此循环）

## 4. 代码组织原则

### 4.1 文件命名

- 使用 **kebab-case**：`task-queue-service.js`、`error-mapping.js`
- 测试文件与源文件同名，添加 `.test.js` 后缀：`gateway.test.js`
- 类型声明文件使用 `.d.ts` 后缀：`simple-api.d.ts`
- 一个文件一个职责，避免超过 500 行的单文件

### 4.2 模块导出

- 使用 CommonJS：`const { foo } = require('./bar')` / `module.exports = { foo }`
- 文件首行保持 `'use strict';`
- 导出对象使用解构风格，保持导入侧可读性

### 4.3 测试组织

- 单元测试放在被测模块同级目录：`src/http/route-table.test.js`
- 测试使用 `src/shared/test-runner.js` 提供的 `createRunner` 工厂
- 每个 `*.test.js` 文件是独立 Node 进程，通过 `npm test` 的 `&&` 链串联
- 测试文件必须在 `summary()` 后调用 `process.exit(1)`（当 `failed > 0` 时）
- 新增路由或 OpenAPI 端点时，同步更新 `scripts/coverage-audit.js` 的断言

### 4.4 处理器拆分

- HTTP 处理器按业务域拆分到 `src/http/handlers/` 目录
- 每个处理器文件导出一个函数集合，由 `route-table.js` 统一注册
- 处理器不得包含业务逻辑，仅做请求解析、调用服务层、格式化响应

### 4.5 DOM Handler 拆分

- DOM 操作处理器按交互场景拆分到 `src/cdp/dom-handlers/` 目录
- 各 handler 接收 `dom-driver` 上下文，返回操作结果
- 新增 DOM 交互场景时，在 `dom-driver.js` 中注册新 handler

### 4.6 配置管理

- 环境变量通过 `src/config/env.js` 的 `getEnvWithFallback` 读取
- 运行时配置通过 `ConfigManager` 管理，支持文件加载、热重载、环境变量覆盖
- 敏感值通过 `secret-vault.js` 加密存储，不得明文记录到日志

## 5. 新增文件检查清单

新增文件时，确认以下事项：

- [ ] 文件放置在正确的模块目录（参照第 2 节）
- [ ] 文件命名遵循 kebab-case（参照第 4.1 节）
- [ ] 依赖方向不违反层次规则（参照第 3 节）
- [ ] 如有测试，测试文件放在同级目录并注册到 `package.json` 的 `test` 脚本
- [ ] 如需发布，文件路径加入 `package.json` 的 `files` 数组
- [ ] 如新增路由或 API 端点，更新 `coverage-audit.js` 断言和 OpenAPI 规范
- [ ] 运行 `npm run lint && npm test` 确认无回归
