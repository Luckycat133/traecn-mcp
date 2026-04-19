# TRAECNclaw 插件开发计划（v3）

> 基于 TraeClaw（[github.com/firerlAGI/TraeClaw](https://github.com/firerlAGI/TraeClaw)）架构，适配 TraeCN（字节跳动国内版 Trae）
> 核心机制：CDP + DOM 自动化（主路径），`trae-cn` CLI 辅助（补充路径）

***

## 一、项目概述

### 1.1 目标

将 TraeClaw 项目适配到 TraeCN，使 OpenClaw 能够通过 TRAECNclaw 连接 TraeCN 桌面端，实现：

* **CDP 自动化（主路径）**：通过 Chrome DevTools Protocol 控制 TraeCN 浏览器实例，写入输入框、点击发送、轮询等待并读取 AI 回复文本

* **CLI 辅助（补充路径）**：通过 `trae-cn chat` 命令快速触发简单任务（不返回结果）

### 1.2 核心数据流

```
OpenClaw
  ↓ HTTP (localhost:8788)
TRAECNclaw HTTP Gateway
  ↓ CDP WebSocket (localhost:9222)
TraeCN 桌面应用
  ↓ DOM 读写
Chat UI（输入框 / 发送按钮 / AI 回复区域）
```

**关键洞察**：`trae-cn chat` 是 fire-and-forget（不回传 stdout），但 **CDP + DOM 读取** 可以拿到 AI 的实际回复文本。这正是 TraeClaw 架构的核心价值。

### 1.3 TraeClaw 原架构（已验证）

| 层级          | 文件                                   | 职责                                        | 复用程度     |
| ----------- | ------------------------------------ | ----------------------------------------- | -------- |
| CDP 发现层     | `src/cdp/discovery.js`               | 通过 HTTP+WS 连接到 Trae CDP 端口                | 需适配      |
| CDP 通信层     | `src/cdp/client.js`                  | 纯 WebSocket 通信，无业务逻辑                      | **直接复用** |
| DOM 操作层     | `src/cdp/browser-dom.js`             | 通用 DOM 查询/操作辅助函数                          | **直接复用** |
| DOM 驱动层     | `src/cdp/dom-driver.js`              | 写输入框、点发送、轮询等待、AI 回复读取                     | 需适配      |
| HTTP 网关     | `src/http/gateway.js`                | REST API（`/api/status`、`/api/sessions` 等） | 需适配      |
| 聊天 UI       | `src/http/chat-ui.js`                | 前端聊天界面                                    | 需适配      |
| OpenAPI 文档  | `src/http/openapi.js`                | API 文档生成                                  | 需适配      |
| OpenClaw 插件 | `integrations/openclaw-trae-plugin/` | 注册 `trae_delegate` 等工具和 `/Trae` 命令        | 需适配      |

***

## 二、TraeCN 与 Trae 的差异分析

### 2.1 已知差异

| 差异点       | Trae（国际版）                | TraeCN（国内版）                      |
| --------- | ------------------------ | -------------------------------- |
| 应用名称      | Trae                     | Trae CN                          |
| macOS 路径  | `/Applications/Trae.app` | `/Applications/Trae CN.app`（待确认） |
| CLI 命令    | `trae`                   | `trae-cn`                        |
| AI 模型     | Claude、GPT 等             | doubao-1.5-pro、DeepSeek R1/V3    |
| CDP 调试端口  | 9222                     | 待探测（预计相同）                        |
| CDP 标题关键词 | "Trae"                   | 待探测（可能为 "Trae" 或 "Trae CN"）      |

### 2.2 DOM 选择器差异（待探测）

| 选择器用途           | Trae（国际版）默认值                                                                                                                                                                                                                                                | TraeCN（国内版） |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 输入框 (composer)  | `.chat-input-v2-input-box-editable`, `textarea`, `[contenteditable='true']`, `input[type='text']`                                                                                                                                                           | **需探测**     |
| 发送按钮 (send)     | `button.chat-input-v2-send-button`, `button[data-testid*='send']`, `button[aria-label*='Send']`, `button[type='submit']`                                                                                                                                    | **需探测**     |
| 回复区域 (response) | `.assistant-chat-turn-content`, `.agent-plan-items.assistant-chat-turn-element`, `.icd-open-folder-card-desc`, `[data-message-author-role='assistant']`, `[data-testid*='assistant']`, `[data-role='assistant']`, `[data-author='assistant']`, `.assistant` | **需探测**     |
| 活动指示 (activity) | `.chat-content-container`, `.chat-list-wrapper`                                                                                                                                                                                                             | **需探测**     |
| 新建对话 (new chat) | `a.codicon-icube-NewChat`                                                                                                                                                                                                                                   | **需探测**     |
| 模式切换 (mode tab) | `.icube-mode-tab-item`, `[class*='icube-mode-tab-item']`                                                                                                                                                                                                    | **需探测**     |

> **说明**：Trae 国际版的选择器已包含回退链（从精确到通用）。TraeCN 的选择器需通过阶段 2 的探测确定，可能部分相同、部分不同。

### 2.3 `trae-cn` CLI 辅助定位

```
trae-cn chat [options] [prompt]

Options:
  -m --mode <mode>     ask | edit | agent（默认 agent）
  -a --add-file        添加文件作为上下文
  --maximize           最大化聊天窗口
  -r --reuse-window    复用上次窗口
  -n --new-window      打开新窗口
```

| 场景         | 适用路径        | 原因        |
| ---------- | ----------- | --------- |
| 快速触发简单编辑任务 | CLI 辅助      | 不需读取回复    |
| 打开特定文件/项目  | CLI 辅助      | 仅触发操作     |
| 读取 AI 回复内容 | **CDP 主路径** | CLI 不返回结果 |
| 复杂多轮对话     | **CDP 主路径** | 需要完整交互    |
| 编辑结果验证     | **CDP 主路径** | 需要读取输出    |

> **注意**：`trae-cn chat` CLI 的存在和可用性需在阶段 2 一并验证。

***

## 三、实施步骤

### 阶段 1：项目脚手架与基础配置

**目标**：建立可编译、可运行的项目骨架

**步骤 1.1：初始化项目结构**

```
TRAECNclaw/
├── .env.example
├── .gitignore
├── package.json
├── start-traecnapi.command            # macOS 启动脚本
├── start-traecnapi.cmd                # Windows 启动脚本
├── src/
│   ├── server.js                      # 入口，加载 env + 启动网关
│   ├── config/
│   │   ├── env.js                     # .env 文件解析（直接复用）
│   │   ├── env.test.js
│   │   ├── quickstart.js              # 快速启动配置（需适配）
│   │   └── quickstart.test.js
│   ├── cdp/
│   │   ├── errors.js                  # 错误类定义（需适配）
│   │   ├── client.js                  # CDP WebSocket 通信（直接复用）
│   │   ├── discovery.js               # CDP 目标发现（需适配）
│   │   ├── discovery.test.js
│   │   ├── browser-dom.js             # DOM 操作辅助函数（直接复用）
│   │   ├── dom-driver.js              # DOM 自动化驱动（需适配）
│   │   ├── dom-driver.test.js
│   │   └── mock-driver.js             # Mock 驱动（需适配）
│   └── http/
│       ├── chat-ui.js                 # 聊天前端 UI（需适配）
│       ├── gateway.js                 # HTTP 网关（需适配）
│       ├── gateway.test.js
│       └── openapi.js                 # OpenAPI 文档（需适配）
├── integrations/
│   └── openclaw-traecn-plugin/
│       ├── index.js                   # 插件入口（需适配）
│       ├── index.test.js
│       ├── openclaw.plugin.json       # 插件描述（需适配）
│       ├── package.json
│       └── lib/
│           ├── traecnapi-client.js     # API 客户端（需适配）
│           └── traecnapi-client.test.js
└── scripts/
    ├── quickstart.js                  # 快速启动（需适配）
    ├── quickstart.test.js
    ├── start-traecn.js                # 启动 TraeCN 应用
    ├── start-gateway.js               # 启动 HTTP 网关
    ├── inspect-traecn.js              # 🔑 TraeCN CDP + DOM 探测
    ├── export-openapi.js
    └── test-chat-ui.js
```

**步骤 1.2：创建 package.json**

```json
{
  "name": "traecnclaw",
  "version": "0.1.0",
  "private": true,
  "description": "Local HTTP bridge and OpenClaw tool integration for TraeCN powered by CDP and DOM automation.",
  "homepage": "https://github.com/firerlAGI/TRAECNclaw",
  "repository": { "type": "git", "url": "https://github.com/firerlAGI/TRAECNclaw.git" },
  "license": "MIT",
  "keywords": ["traecn", "trae-cn", "electron", "cdp", "automation", "openclaw", "api"],
  "engines": { "node": ">=22" },
  "scripts": {
    "start": "node src/server.js",
    "quickstart": "node scripts/quickstart.js",
    "start:traecn": "node scripts/start-traecn.js",
    "start:gateway": "node scripts/start-gateway.js",
    "inspect:traecn": "node scripts/inspect-traecn.js",
    "test": "node src/config/env.test.js && node src/cdp/discovery.test.js && node src/cdp/dom-driver.test.js && node src/http/gateway.test.js",
    "lint": "node --check src/server.js && node --check src/cdp/discovery.js && node --check src/cdp/dom-driver.js && node --check src/http/gateway.js"
  }
}
```

**步骤 1.3：创建 .env.example**

```env
# TraeCN 启动配置
TRAECN_BIN=                                       # macOS: /Applications/Trae CN.app
TRAECN_ARGS=
TRAECN_REMOTE_DEBUGGING_PORT=9222
TRAECN_PROJECT_PATH=
TRAECN_QUICKSTART_USE_ISOLATED_PROFILE=1
TRAECN_QUICKSTART_REMOTE_DEBUGGING_PORT=9333

# CDP 目标选择
TRAECN_CDP_HOST=127.0.0.1
TRAECN_CDP_TARGET_TITLE_CONTAINS=Trae
TRAECN_CDP_TARGET_URL_CONTAINS=

# DOM 选择器（待阶段 2 探测后填入）
TRAECN_COMPOSER_SELECTORS=
TRAECN_SEND_BUTTON_SELECTORS=
TRAECN_RESPONSE_SELECTORS=
TRAECN_ACTIVITY_SELECTORS=
TRAECN_NEW_CHAT_SELECTORS=
TRAECN_MODE_TAB_SELECTORS=
TRAECN_SEND_TRIGGER=button

# 响应采集
TRAECN_RESPONSE_POLL_INTERVAL_MS=350
TRAECN_RESPONSE_IDLE_MS=1200
TRAECN_RESPONSE_TIMEOUT_MS=30000
TRAECN_POST_ACTION_DELAY_MS=350
TRAECN_SESSION_PREPARE_TIMEOUT_MS=5000

# HTTP 网关
HOST=127.0.0.1
PORT=8788
TRAECN_GATEWAY_TOKEN=
TRAECN_ALLOWED_ORIGINS=
TRAECN_RATE_LIMIT_WINDOW_MS=60000
TRAECN_RATE_LIMIT_MAX_REQUESTS=60
TRAECN_ENABLE_DEBUG_ENDPOINTS=0
TRAECN_ENABLE_MOCK_BRIDGE=0
```

***

### 阶段 2：TraeCN CDP 可行性验证与选择器探测 🔑

> **这是整个项目成败的关键先行阶段。** 如果 TraeCN 不暴露 CDP 或 DOM 结构完全不可访问，后续所有 CDP 适配工作都无法进行。

**步骤 2.1：验证 TraeCN CDP 可用性**

1. 启动 TraeCN，打开 Chat 面板
2. 尝试 `curl http://127.0.0.1:9222/json/version` — 验证 CDP 端口是否开放
3. 尝试 `curl http://127.0.0.1:9222/json/list` — 列出所有可用 CDP target
4. 检查 target 列表中是否包含 Chat 相关的页面（标题含 "Trae" 或 "Trae CN"）
5. 验证 `trae-cn chat` CLI 是否可用

**步骤 2.2：开发** **`scripts/inspect-traecn.js`** **探测工具**

功能：

* 自动连接 TraeCN CDP 端口

* 列出所有可用的 CDP target（含 id、title、url）

* 对每个非 devtools 的 page target，执行 DOM 扫描：

  * 查找所有 `textarea`、`[contenteditable]`、`input[type='text']` 元素（输入框候选）

  * 查找所有 `button` 元素（发送按钮候选）

  * 查找所有包含 "assistant" / "reply" / "response" 类名的元素（回复区域候选）

  * 查找所有包含 "NewChat" / "new-chat" / "新建" 的元素（新建对话候选）

  * 查找所有包含 "mode" / "solo" / "ide" 的标签元素（模式切换候选）

* 输出结构化的探测报告（JSON 格式）

* 提供交互式选择器验证模式

**步骤 2.3：确定 TraeCN 默认选择器**

基于探测结果，确定以下选择器并写入 `dom-driver.js` 默认常量和 `.env.example`：

| 选择器类型              | 探测目标            |
| ------------------ | --------------- |
| 输入框 (composer)     | 可编辑文本区域         |
| 发送按钮 (send button) | 发送/提交按钮         |
| 回复区域 (response)    | AI 助手回复内容容器     |
| 活动指示 (activity)    | 对话活动/进度指示器      |
| 新建对话 (new chat)    | 新建对话按钮/链接       |
| 模式切换 (mode tab)    | SOLO/IDE 模式切换标签 |

**步骤 2.4：选择器兼容性策略**

* TraeCN 专用选择器优先，通用选择器回退

* 保留 Trae 国际版选择器作为最终回退

* 所有选择器支持环境变量完全覆盖

* 在 readiness 检查和诊断端点中报告实际匹配的选择器

**⏸ 判定门（Go / No-Go）**

| 判定结果        | 条件                                      | 后续动作                                |
| ----------- | --------------------------------------- | ----------------------------------- |
| ✅ **继续**    | CDP 可连接 + Chat target 可见 + 关键 DOM 元素可定位 | 进入阶段 3                              |
| ⚠️ **部分继续** | CDP 可连接但部分选择器无法定位                       | 用环境变量手动配置，进入阶段 3                    |
| ❌ **暂停**    | CDP 连接失败或 Chat target 不可见               | 评估替代方案（Accessibility API / OS 级自动化） |

***

### 阶段 3：CDP 层适配（自动化执行层）

> **前置条件**：阶段 2 已完成，TraeCN CDP 可用且选择器已确定。

**步骤 3.1：适配 discovery.js**

| 适配项                 | TraeClaw 原值                      | TRAECNclaw 适配值                                                          |
| ------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| 默认 CDP Host 环境变量    | `TRAE_CDP_HOST`                  | `TRAECN_CDP_HOST`（回退 `TRAE_CDP_HOST`）                                   |
| 默认 CDP Port 环境变量    | `TRAE_REMOTE_DEBUGGING_PORT`     | `TRAECN_REMOTE_DEBUGGING_PORT`（回退 `TRAE_REMOTE_DEBUGGING_PORT`）         |
| 默认标题关键词             | `TRAE_CDP_TARGET_TITLE_CONTAINS` | `TRAECN_CDP_TARGET_TITLE_CONTAINS`（回退 `TRAE_CDP_TARGET_TITLE_CONTAINS`） |
| `scoreTarget` 加分关键词 | `"trae"`                         | 增加 `"trae cn"`、`"traecn"`                                               |

**步骤 3.2：适配 client.js**

* 纯 CDP WebSocket 通信层，与具体应用无关

* **无需修改**，直接复用

**步骤 3.3：适配 browser-dom.js**

* 通用 DOM 查询/操作辅助函数，选择器通过配置参数注入

* **无需修改**，直接复用

**步骤 3.4：适配 dom-driver.js**

| 适配项                    | 说明                                                          |
| ---------------------- | ----------------------------------------------------------- |
| 默认选择器常量                | 根据阶段 2 探测结果替换 `DEFAULT_*_SELECTORS`                         |
| 环境变量前缀                 | `TRAECN_COMPOSER_SELECTORS` 等（回退 `TRAE_COMPOSER_SELECTORS`） |
| `sanitizeActivityText` | 增加 TraeCN 特有的中文活动文本模式（如豆包/DeepSeek 的进度提示）                   |
| 回退逻辑                   | 保留所有现有回退逻辑                                                  |

**步骤 3.5：适配 errors.js**

* 错误类名：`TraeAutomationError` → `TraeCNAutomationError`（保留 `TraeAutomationError` 作为别名导出，确保向后兼容）

* 错误消息中 "Trae" → "TraeCN"

**步骤 3.6：适配 mock-driver.js**

* Mock 数据中 "Trae" → "TraeCN"

* Mock target 标题改为 "Mock TraeCN Window"

***

### 阶段 4：HTTP 网关层适配

**步骤 4.1：适配 gateway.js**

| 适配项                  | TraeClaw 原值                   | TRAECNclaw 适配值                                      |
| -------------------- | ----------------------------- | --------------------------------------------------- |
| 服务名称                 | `trae-cdp-http-bridge`        | `traecn-cdp-http-bridge`                            |
| 默认监听端口               | `8787`（`PORT` 环境变量）           | `8788`（`PORT` 环境变量）                                 |
| Token 环境变量           | `TRAE_GATEWAY_TOKEN`          | `TRAECN_GATEWAY_TOKEN`（回退 `TRAE_GATEWAY_TOKEN`）     |
| Auth Header 环境变量     | `TRAE_AUTH_HEADER`            | `TRAECN_AUTH_HEADER`（回退 `TRAE_AUTH_HEADER`）         |
| Allowed Origins 环境变量 | `TRAE_ALLOWED_ORIGINS`        | `TRAECN_ALLOWED_ORIGINS`（回退 `TRAE_ALLOWED_ORIGINS`） |
| Rate Limit 环境变量      | `TRAE_RATE_LIMIT_*`           | `TRAECN_RATE_LIMIT_*`（回退 `TRAE_RATE_LIMIT_*`）       |
| Debug 环境变量           | `TRAE_ENABLE_DEBUG_ENDPOINTS` | `TRAECN_ENABLE_DEBUG_ENDPOINTS`（回退）                 |
| Mock 环境变量            | `TRAE_ENABLE_MOCK_BRIDGE`     | `TRAECN_ENABLE_MOCK_BRIDGE`（回退）                     |

**安全机制（与 TraeClaw 保持一致）**：

* Bearer Token 认证（`Authorization: Bearer <token>` 或 `X-TraeCN-Token` 头）

* 速率限制（默认 60 次/分钟）

* CORS 来源校验

* 仅监听回环地址（127.0.0.1 / ::1）

* 请求体大小限制（1MB）

* 敏感数据脱敏（日志中不暴露 token、password、secret 等）

* 审计日志（可配置开关）

* 幂等性支持（`Idempotency-Key` 头）

**步骤 4.2：适配 chat-ui.js**

* UI 标题：`Trae Bridge Chat` → `TraeCN Bridge Chat`

* 侧边栏文案适配 TraeCN

* localStorage key：`trae_bridge_token` → `traecn_bridge_token`

* API 路径保持一致（`/api/status`、`/api/sessions` 等）

**步骤 4.3：适配 openapi.js**

* 文档标题：`Trae CDP HTTP Bridge` → `TraeCN CDP HTTP Bridge`

* 描述适配 TraeCN

* 服务器 URL 默认端口改为 8788

***

### 阶段 5：配置层适配

**步骤 5.1：适配 env.js**

* 通用 .env 文件解析器，与具体应用无关

* **无需修改**，直接复用

**步骤 5.2：适配 quickstart.js**

* 环境变量前缀适配：`TRAECN_QUICKSTART_*`（回退 `TRAE_QUICKSTART_*`）

* TraeCN 应用启动路径适配

* macOS 应用包解析适配 TraeCN 路径（`Trae CN.app`）

***

### 阶段 6：OpenClaw 插件层适配

**步骤 6.1：创建 openclaw\.plugin.json**

| 配置项              | 值                                                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| 插件 ID            | `traecnclaw`                                                                                        |
| 插件名称             | `TraeCNclaw`                                                                                        |
| 版本               | `0.1.0`                                                                                             |
| 描述               | Delegate IDE tasks from OpenClaw to a local TraeCNclaw instance that drives the TraeCN desktop app. |
| 默认 baseUrl       | `http://127.0.0.1:8788`                                                                             |
| 默认 quickstart 命令 | `start-traecnapi.command`（macOS）/ `start-traecnapi.cmd`（Windows）                                    |

**步骤 6.2：适配 index.js（插件入口）**

工具注册：

| 工具名                   | 描述                                  | 参数                                                                                     | <br />                         |
| --------------------- | ----------------------------------- | -------------------------------------------------------------------------------------- | :----------------------------- |
| `traecn_status`       | 检查 TraeCNclaw 网关是否可达、TraeCN 自动化是否就绪 | `allowAutoStart: boolean`                                                              | <br />                         |
| `traecn_new_chat`     | 创建新的 TraeCN 对话并切换 UI                | `allowAutoStart: boolean`                                                              | <br />                         |
| `traecn_delegate`     | 委托 IDE 任务到 TraeCN 桌面端               | `task: string`（必填）, `projectPath`, `sessionId`, `allowAutoStart`, `includeProcessText` | <br />                         |
| `traecn_switch_mode`  | 切换 TraeCN SOLO/IDE 模式               | \`mode: "solo"                                                                         | "ide"`（必填）, ` allowAutoStart\` |
| `traecn_open_project` | 在 TraeCN 中打开指定项目                    | `projectPath: string`（必填）                                                              | <br />                         |
| `traecn_update_self`  | 更新 TraeCNclaw 插件                    | `force: boolean`                                                                       | <br />                         |

斜杠命令：

| 命令                     | 说明                      | 示例                              |
| ---------------------- | ----------------------- | ------------------------------- |
| `/TraeCN <任务>`         | 新建对话并委托任务，仅返回最终回复       | `/TraeCN 分析当前仓库并实现缺失的登录功能`      |
| `/TraeCN process <任务>` | 新建对话并委托任务，返回包含过程信息的完整输出 | `/TraeCN process 分析当前仓库并返回执行过程` |

**步骤 6.3：适配 traecnapi-client.js**

* 插件 ID 常量：`traecnclaw`

* 格式化函数中 "Trae" → "TraeCN"

* 自动更新逻辑适配 `traecnclaw` npm 包名

* HTTP 客户端逻辑不变

***

### 阶段 7：CLI 辅助工具开发

> **前置条件**：阶段 2 已验证 `trae-cn` CLI 可用

**步骤 7.1：封装** **`trae-cn chat`** **调用**

在 `scripts/` 下创建辅助脚本 `trae-chat.js`：

```javascript
const { spawn } = require('child_process');

function chat(prompt, options = {}) {
  const args = ['chat'];
  if (options.mode) args.push('--mode', options.mode);
  if (options.maximize) args.push('--maximize');
  if (options.reuseWindow) args.push('--reuse-window');
  if (options.newWindow) args.push('--new-window');
  if (options.addFile) args.push('--add-file', options.addFile);
  args.push('--', prompt);

  return spawn('trae-cn', args, { stdio: 'inherit' });
}
```

**步骤 7.2：集成到 OpenClaw 工具**

注册 `traecn_chat` 工具到 OpenClaw（用于不需要读取回复的简单任务）：

| 工具名           | 描述                                  | 参数                                                                              |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------- |
| `traecn_chat` | 通过 `trae-cn chat` CLI 快速触发任务（不返回结果） | `prompt: string`（必填）, `mode`, `addFile`, `maximize`, `reuseWindow`, `newWindow` |

**适用场景**：

* 快速触发新建对话

* 简单一次性编辑任务

* 打开项目/文件

**不适用场景**（应使用 `traecn_delegate`）：

* 需要读取 AI 回复内容

* 复杂多轮对话

* 编辑结果验证

***

### 阶段 8：脚本层适配

**步骤 8.1：适配 start-traecn.js**

| 适配项         | TraeClaw 原值                  | TRAECNclaw 适配值                     |
| ----------- | ---------------------------- | ---------------------------------- |
| 二进制路径环境变量   | `TRAE_BIN`                   | `TRAECN_BIN`（回退 `TRAE_BIN`）        |
| 启动参数环境变量    | `TRAE_ARGS`                  | `TRAECN_ARGS`（回退 `TRAE_ARGS`）      |
| CDP 端口环境变量  | `TRAE_REMOTE_DEBUGGING_PORT` | `TRAECN_REMOTE_DEBUGGING_PORT`（回退） |
| 项目路径环境变量    | `TRAE_PROJECT_PATH`          | `TRAECN_PROJECT_PATH`（回退）          |
| macOS 应用包解析 | 适配 `Trae.app`                | 适配 `Trae CN.app`                   |

**步骤 8.2：创建启动脚本**

* `start-traecnapi.command`（macOS）：

  ```bash
  #!/bin/bash
  set -euo pipefail
  ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
  cd "$ROOT_DIR"
  if command -v npm >/dev/null 2>&1; then
    exec npm run quickstart
  fi
  exec node scripts/quickstart.js
  ```

* `start-traecnapi.cmd`（Windows）：

  ```cmd
  @echo off
  setlocal
  cd /d "%~dp0"
  node scripts\quickstart.js
  if errorlevel 1 (
    echo.
    echo TraeCNclaw quickstart failed.
    pause
    exit /b %errorlevel%
  )
  ```

**步骤 8.3：适配其他脚本**

* `quickstart.js`：环境变量前缀适配

* `start-gateway.js`：环境变量前缀适配

* `export-openapi.js`：TraeCN 命名适配

***

### 阶段 9：测试

**步骤 9.1：单元测试**

| 测试文件                                                               | 覆盖范围                   |
| ------------------------------------------------------------------ | ---------------------- |
| `src/config/env.test.js`                                           | .env 文件解析              |
| `src/config/quickstart.test.js`                                    | 快速启动配置                 |
| `src/cdp/discovery.test.js`                                        | TraeCN 目标发现逻辑（标题匹配、评分） |
| `src/cdp/dom-driver.test.js`                                       | TraeCN 选择器配置、响应采集逻辑    |
| `src/http/gateway.test.js`                                         | HTTP 网关 API 端点         |
| `integrations/openclaw-traecn-plugin/index.test.js`                | 插件注册、工具定义              |
| `integrations/openclaw-traecn-plugin/lib/traecnapi-client.test.js` | API 客户端                |

**步骤 9.2：集成测试**

完整链路测试：OpenClaw → TRAECNclaw HTTP API → CDP → TraeCN → 读取回复

| 测试场景                   | 验证内容            |
| ---------------------- | --------------- |
| `traecn_status`        | TraeCN 连接状态检查正确 |
| `traecn_new_chat`      | 新建对话成功          |
| `traecn_delegate`      | 任务委托与响应采集完整     |
| `/TraeCN <任务>`         | 斜杠命令功能正常        |
| `/TraeCN process <任务>` | 过程回传模式正常        |
| `traecn_switch_mode`   | SOLO/IDE 模式切换   |
| `traecn_chat`（CLI 辅助）  | CLI 触发任务正常      |

**步骤 9.3：稳定性测试**

| 测试类型   | 验证内容                   |
| ------ | ---------------------- |
| 网络异常恢复 | CDP 断连后重连              |
| 长时间运行  | 连续 100 次委托任务无内存泄漏      |
| 并发请求   | 多个 OpenClaw agent 同时请求 |
| 超时处理   | TraeCN 无响应时的超时降级       |

**步骤 9.4：兼容性测试**

| 测试维度        | 验证内容                                    |
| ----------- | --------------------------------------- |
| TraeCN 版本   | 不同 TraeCN 版本的 DOM 选择器兼容性                |
| macOS 版本    | macOS 12/13/14 运行兼容性                    |
| OpenClaw 集成 | OpenClaw 工具注册和调用正常                      |
| 并行运行        | TraeClaw（8787）和 TRAECNclaw（8788）同时运行无冲突 |

***

### 阶段 10：安全加固

**步骤 10.1：认证与授权**

* Bearer Token 认证机制（`TRAECN_GATEWAY_TOKEN`）

* 仅监听回环地址（127.0.0.1 / ::1），拒绝外部连接

* 敏感数据脱敏（日志中不暴露 token、password、secret、credential 等字段）

**步骤 10.2：网络安全**

* CORS 来源校验（`TRAECN_ALLOWED_ORIGINS`）

* 速率限制（默认 60 次/分钟，可配置）

* 请求体大小限制（1MB）

* 幂等性支持（防止重复提交）

**步骤 10.3：数据安全**

* 不持久化用户对话内容到磁盘

* 会话数据仅保存在内存中（进程退出即清除）

* 审计日志脱敏处理

* CDP 连接仅限本地

***

### 阶段 11：发布准备

**步骤 11.1：npm 包发布**

* 包名：`traecnclaw`

* 包含完整 TraeCNclaw runtime

* OpenClaw 安装命令：`openclaw plugins install traecnclaw`

**步骤 11.2：GitHub 仓库**

* 仓库地址：`https://github.com/firerlAGI/TRAECNclaw`

* 包含完整源代码

**步骤 11.3：安装与使用文档**

* macOS 安装指南

* OpenClaw 集成配置示例

* 环境变量完整参考

* 常见问题（FAQ）

***

## 四、环境变量速查

### 4.1 TraeCN 启动配置

| 变量                             | 默认值    | 说明             |
| ------------------------------ | ------ | -------------- |
| `TRAECN_BIN`                   | （无）    | TraeCN 可执行文件路径 |
| `TRAECN_ARGS`                  | （无）    | TraeCN 启动附加参数  |
| `TRAECN_REMOTE_DEBUGGING_PORT` | `9222` | CDP 远程调试端口     |
| `TRAECN_PROJECT_PATH`          | （无）    | TraeCN 打开的项目路径 |

### 4.2 CDP 目标选择

| 变量                                 | 默认值         | 说明                 |
| ---------------------------------- | ----------- | ------------------ |
| `TRAECN_CDP_HOST`                  | `127.0.0.1` | CDP 主机地址           |
| `TRAECN_CDP_TARGET_TITLE_CONTAINS` | `Trae`      | 目标窗口标题关键词（逗号分隔）    |
| `TRAECN_CDP_TARGET_URL_CONTAINS`   | （无）         | 目标窗口 URL 关键词（逗号分隔） |

### 4.3 DOM 选择器

| 变量                             | 默认值      | 说明                       |
| ------------------------------ | -------- | ------------------------ |
| `TRAECN_COMPOSER_SELECTORS`    | （待探测）    | 输入框选择器（逗号分隔）             |
| `TRAECN_SEND_BUTTON_SELECTORS` | （待探测）    | 发送按钮选择器（逗号分隔）            |
| `TRAECN_RESPONSE_SELECTORS`    | （待探测）    | 回复区域选择器（逗号分隔）            |
| `TRAECN_ACTIVITY_SELECTORS`    | （待探测）    | 活动指示器选择器（逗号分隔）           |
| `TRAECN_NEW_CHAT_SELECTORS`    | （待探测）    | 新建对话按钮选择器（逗号分隔）          |
| `TRAECN_MODE_TAB_SELECTORS`    | （待探测）    | 模式切换标签选择器（逗号分隔）          |
| `TRAECN_SEND_TRIGGER`          | `button` | 提交方式（`button` 或 `enter`） |

### 4.4 响应采集

| 变量                                  | 默认值     | 说明       |
| ----------------------------------- | ------- | -------- |
| `TRAECN_RESPONSE_POLL_INTERVAL_MS`  | `350`   | 响应轮询间隔   |
| `TRAECN_RESPONSE_IDLE_MS`           | `1200`  | 响应空闲判定时间 |
| `TRAECN_RESPONSE_TIMEOUT_MS`        | `30000` | 响应超时时间   |
| `TRAECN_POST_ACTION_DELAY_MS`       | `350`   | 操作后延迟    |
| `TRAECN_SESSION_PREPARE_TIMEOUT_MS` | `5000`  | 会话准备超时   |

### 4.5 HTTP 网关

| 变量                               | 默认值         | 说明          |
| -------------------------------- | ----------- | ----------- |
| `HOST`                           | `127.0.0.1` | 网关监听地址      |
| `PORT`                           | `8788`      | 网关监听端口      |
| `TRAECN_GATEWAY_TOKEN`           | （无）         | 网关访问令牌      |
| `TRAECN_ALLOWED_ORIGINS`         | （无）         | 允许的 CORS 来源 |
| `TRAECN_RATE_LIMIT_WINDOW_MS`    | `60000`     | 速率限制窗口      |
| `TRAECN_RATE_LIMIT_MAX_REQUESTS` | `60`        | 速率限制最大请求数   |
| `TRAECN_ENABLE_DEBUG_ENDPOINTS`  | `0`         | 启用调试端点      |
| `TRAECN_ENABLE_MOCK_BRIDGE`      | `0`         | 启用 Mock 桥接  |

> **环境变量回退规则**：所有 `TRAECN_*` 变量在未设置时，自动回退到对应的 `TRAE_*` 变量。例如 `TRAECN_BIN` 未设置时读取 `TRAE_BIN`。

***

## 五、关键技术决策

### 5.1 环境变量策略

* **主前缀**：`TRAECN_`

* **回退兼容**：`TRAE_`

* **实现方式**：每个环境变量读取时先尝试 `TRAECN_*`，未设置则回退 `TRAE_*`

* **原因**：既明确区分 TraeCN 配置，又不破坏已有 TraeClaw 配置的复用

### 5.2 双重路径策略

| 路径       | 机制                      | 能力                    | 适用场景            |
| -------- | ----------------------- | --------------------- | --------------- |
| CDP 主路径  | CDP WebSocket + DOM 自动化 | 完整功能（输入、发送、读取回复、模式切换） | 需要读取 AI 回复的所有场景 |
| CLI 辅助路径 | `trae-cn chat` 子进程      | 轻量触发（仅发送，不返回结果）       | 简单一次性任务、打开项目    |

### 5.3 选择器策略

* **优先级链**：TraeCN 专用选择器 → 通用选择器 → Trae 国际版选择器

* **可配置**：所有选择器支持环境变量完全覆盖

* **可诊断**：readiness 检查和 `/debug/automation` 端点报告实际匹配情况

* **可探测**：`inspect-traecn.js` 工具自动扫描并推荐选择器

### 5.4 端口隔离策略

| 服务             | TraeClaw 端口 | TRAECNclaw 端口 | 说明                    |
| -------------- | ----------- | ------------- | --------------------- |
| CDP            | 9222        | 9222          | 共用（同一时间只运行一个 Trae 变体） |
| HTTP 网关        | 8787        | 8788          | 隔离（支持同时运行）            |
| Quickstart CDP | 9333        | 9333          | 共用                    |

***

## 六、风险与缓解

| 风险                              | 影响               | 概率 | 缓解措施                                     |
| ------------------------------- | ---------------- | -- | ---------------------------------------- |
| TraeCN 不暴露 CDP                  | CDP 主路径不可行       | 中  | 阶段 2 先行验证；备选：Accessibility API / OS 级自动化 |
| TraeCN DOM 结构与国际版完全不同           | 选择器全部失效          | 中  | 探测工具自动扫描 + 环境变量覆盖 + 回退链                  |
| TraeCN 版本更新破坏选择器                | 插件失效             | 高  | 环境变量可配置 + 诊断端点暴露匹配状态                     |
| TraeCN Chat 在 WebView 而非 iframe | CDP 看不到 Chat DOM | 低  | WebView 有独立 CDP session，需额外发现逻辑          |
| `trae-cn` CLI 不可用               | CLI 辅助路径不可用      | 低  | 仅影响辅助路径，CDP 主路径不受影响                      |
| TraeClaw 和 TRAECNclaw 端口冲突      | 无法同时运行           | 低  | HTTP 网关端口隔离（8787 vs 8788）                |

***

## 七、实施顺序与依赖关系

```
阶段 1：项目脚手架
  ↓
阶段 2：CDP 可行性验证 + 选择器探测 🔑
  ↓ (Go/No-Go 判定)
阶段 3：CDP 层适配
  ↓
阶段 4：HTTP 网关层适配
  ↓
阶段 5：配置层适配
  ↓
阶段 6：OpenClaw 插件层适配
  ↓
阶段 7：CLI 辅助工具开发（可与阶段 6 并行）
  ↓
阶段 8：脚本层适配
  ↓
阶段 9：测试
  ↓
阶段 10：安全加固（可与阶段 9 交叉进行）
  ↓
阶段 11：发布准备
```

***

*计划版本：v3（优化整理后）*
*基于 TraeClaw 架构，2026-04-17*
