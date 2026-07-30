# OpenClaw MCP Setup Guide — TRAECNclaw v0.4.0

> 面向 OpenClaw coder agent（或人类开发者）的端到端接入文档。把
> TRAECNclaw 注册为 OpenClaw 的一个 MCP server，让 OpenClaw agent
> 通过 stdio MCP → TRAECNclaw HTTP gateway → TraeCN CDP → TraeCN IDE
> 完整驱动 TraeCN：编辑器、文件、终端、Git、Search、Diagnostics、
> Snapshot、Extensions、Command Palette 共 9 个 driver。

| 项 | 值 |
|---|---|
| 包名 | `traecnclaw@0.4.0` |
| MCP transport | stdio JSON-RPC（`mcp-server.js`） |
| HTTP gateway | `http://127.0.0.1:8788` |
| HTTP 端点（v0.4.0 新增） | 9 个 driver endpoint（`POST /api/<driver>`） |
| MCP tool 总数 | `public` 23 / `ops` 35 / `full` 39（由 `TRAECN_MCP_TOOL_PROFILE` 控制） |
| 配套要求 | Node 22+ · TraeCN 1.107+ · OpenClaw |

---

## 目录

1. [前置条件](#1-前置条件)
2. [安装与启动](#2-安装与启动)
3. [OpenClaw MCP 配置](#3-openclaw-mcp-配置)
4. [首次登录坑](#4-首次登录坑)
5. [能力目录 GET /api/capabilities](#5-能力目录-get-apicapabilities)
6. [使用示例](#6-使用示例)
7. [Driver action 参考表](#7-driver-action-参考表)
8. [错误码](#8-错误码)
9. [故障排查](#9-故障排查)

---

## 1. 前置条件

### 1.1 运行时

| 组件 | 版本 | 备注 |
|---|---|---|
| Node.js | **22+** | `package.json` 已声明 `"engines": { "node": ">=22" }` |
| TraeCN | **1.107+** | 实测 v0.4.0 基于 TraeCN 1.107.1 / Chrome 142 / Electron 39；DOM 见 `docs/REAL-DOM-FINDINGS.md` |
| OpenClaw | MCP-capable | 配置文件 `~/.openclaw/openclaw.json` |
| 平台 | macOS / Linux / Win | macOS 推荐（LaunchAgent 持久化） |

### 1.2 TraeCN 必须带 `--remote-debugging-port` 启动

否则 CDP 不可达，gateway 落回 mockBridge（仅用于测试）。

```sh
# 推荐：TRAECNclaw 自动启动
npm run quickstart

# 或：自己先 quit，用 existing logged-in profile 启动
TRAECN_QUICKSTART_PROFILE_MODE=existing npm run start:traecn -- --use-existing-profile

# 默认 CDP 端口 9222；要换就改 TRAECN_REMOTE_DEBUGGING_PORT
```

### 1.3 验证前置

```sh
curl -s http://127.0.0.1:9222/json/version | jq .        # CDP 通
curl -s http://127.0.0.1:8788/api/status | jq .           # Gateway 通
npm run inspect:verify                                    # 验证 DOM 选择器
```

---

## 2. 安装与启动

### 2.1 clone + install

```sh
git clone https://github.com/Luckycat133/TRAECNclaw.git
cd TRAECNclaw && npm install
cp .env.example .env
```

### 2.2 `.env` 最小配置

```ini
# TraeCN 二进制路径（macOS 默认 /Applications/Trae CN.app，可省）
TRAECN_BIN=/Applications/Trae CN.app

# CDP 端口
TRAECN_REMOTE_DEBUGGING_PORT=9222

# HTTP gateway
HOST=127.0.0.1
PORT=8788

# Profile：existing = 复用已登录的 Trae CN 状态
TRAECN_QUICKSTART_PROFILE_MODE=existing

# CDP 失效时自动重启 TraeCN
TRAECN_AUTO_START_TRAE=1

# 真实模式（开发期才开 mock=1）
TRAECN_ENABLE_MOCK_BRIDGE=0

# 可选 bearer token
TRAECN_GATEWAY_TOKEN=
```

| 变量 | 必需 | 默认 | 作用 |
|---|---|---|---|
| `TRAECN_BIN` | 否 | `/Applications/Trae CN.app` | 自动探测 macOS / Win 路径 |
| `TRAECN_REMOTE_DEBUGGING_PORT` | 是 | `9222` | CDP 端口 |
| `TRAECN_QUICKSTART_PROFILE_MODE` | 否 | `existing` | `existing` 复用登录态；`isolated` 用临时 profile |
| `TRAECN_AUTO_START_TRAE` | 否 | `0` | 设为 `1` 后 CDP 失效才自动重启 TraeCN |
| `TRAECN_ENABLE_MOCK_BRIDGE` | 否 | `0` | `1` = mock（无 TraeCN 也能跑测试） |
| `TRAECN_GATEWAY_TOKEN` | 否 | 空 | bearer token |
| `TRAECN_ALLOWED_ORIGINS` | 否 | 空 | CORS 白名单 |
| `HOST` / `PORT` | 否 | `127.0.0.1` / `8788` | gateway 绑定；**生产切勿用 `0.0.0.0` 不配 TOKEN** |

完整 `.env.example` 见仓库根目录。

### 2.3 启动 gateway

**前台（开发/调试）**

```sh
npm run quickstart
# → 检查 TraeCN → 起 CDP → 起 gateway → http://127.0.0.1:8788
```

**LaunchAgent 持久化（macOS 推荐）**

```sh
npm run service:install      # 写 plist 到 ~/Library/LaunchAgents/
npm run service:start        # 启动
npm run service:status       # 状态
npm run service:stop / uninstall
```

LaunchAgent 把环境变量固化进 plist；日志路径 `~/Library/Logs/TRAECNclaw/`。

**手动控制**

```sh
npm run start:gateway                                   # 只起 gateway
npm run start:traecn                                    # 只起 TraeCN
npm run start:traecn -- --use-existing-profile         # 复用已登录
npm run start:traecn -- --force-new                     # 强制新窗口
npm run doctor                                          # 完整诊断
```

### 2.4 验证

```sh
curl -s http://127.0.0.1:9222/json/version | jq -r .Browser       # TraeCN/1.107.1
curl -s http://127.0.0.1:8788/api/status | jq .ok                 # true
curl -s -X POST http://127.0.0.1:8788/api/editor | jq .           # 期望 400 MISSING_ACTION
node -e "console.log(require('./mcp-server').MCP_TOOLS.map(t=>t.name).join('\n'))"
```

---

## 3. OpenClaw MCP 配置

### 3.1 配置文件位置

OpenClaw 的 MCP server 注册在 **`~/.openclaw/openclaw.json`** 的 `mcp.servers` 字段下。已通过读取实际 `~/.openclaw/openclaw.json` 验证 schema：

```json
{
  "mcp": {
    "servers": {
      "minimax": {
        "command": "uvx",
        "args": ["minimax-coding-plan-mcp", "-y"],
        "env": { "MINIMAX_API_KEY": "${MINIMAX_API_KEY}" }
      }
    }
  }
}
```

TRAECNclaw 注册位置 = `mcp.servers.traecn`。

### 3.2 推荐配置

```json
{
  "mcp": {
    "servers": {
      "traecn": {
        "command": "node",
        "args": ["/absolute/path/to/TRAECNclaw/mcp-server.js"],
        "env": {
          "TRAECN_HOST": "127.0.0.1",
          "TRAECN_PORT": "8788",
          "TRAECN_GATEWAY_TOKEN": ""
        }
      }
    }
  }
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `command` | ✅ | `node` 启动 stdio MCP server |
| `args` | ✅ | `mcp-server.js` 的**绝对路径**（不要 `~` 或相对路径，OpenClaw cwd 不可控） |
| `env.TRAECN_HOST` | 否 | gateway host，默认 `127.0.0.1` |
| `env.TRAECN_PORT` | 否 | gateway port，默认 `8788` |
| `env.TRAECN_GATEWAY_TOKEN` | 否 | bearer token；和 `.env` 保持一致 |
| `env.TRAECN_TIMEOUT` | 否 | HTTP 调用超时（毫秒），默认 `120000` |
| `env.TRAECN_LOG_LEVEL` | 否 | `debug`/`info`/`warn`/`error` |

### 3.3 编辑流程

```sh
# 1. 备份
cp ~/.openclaw/openclaw.json ~/.openclaw/openclaw.json.bak-$(date +%Y%m%d-%H%M%S)

# 2. 用 jq 合并而非手改整文件
jq '.mcp.servers.traecn = {
  "command": "node",
  "args": ["/absolute/path/to/TRAECNclaw/mcp-server.js"],
  "env": { "TRAECN_HOST": "127.0.0.1", "TRAECN_PORT": "8788" }
}' ~/.openclaw/openclaw.json > /tmp/openclaw.json.new
mv /tmp/openclaw.json.new ~/.openclaw/openclaw.json

# 3. 校验
python3 -m json.tool ~/.openclaw/openclaw.json > /dev/null && echo "JSON valid"
```

### 3.4 验证 MCP 注册成功

OpenClaw 重读配置后，agent 应能列出当前 OpenClaw wrapper tools：

```
traecn_capabilities / traecn_command_set / traecn_preflight /
traecn_command / traecn_delegate / traecn_task_status /
traecn_vibe_workflow / traecn_plan_operation /
traecn_settings_read / traecn_settings_set / traecn_switch_model / ...
```

### 3.5 非 OpenClaw 客户端

`mcp-server.js` 是纯 stdio JSON-RPC，**任何**支持 MCP stdio 的客户端都能用 —— Cursor（`~/.cursor/mcp.json`）、Claude Desktop（`~/.claude_desktop_config.json`）、Cline / Roo Code、Windsurf（`.windsurfrc`）。这些客户端字段名是 `mcpServers`（注意不是 `mcp.servers`）：

```json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/absolute/path/to/TRAECNclaw/mcp-server.js"],
      "env": { "TRAECN_HOST": "127.0.0.1", "TRAECN_PORT": "8788" }
    }
  }
}
```

---

## 4. 首次登录坑

### 4.1 核心结论

> **TRAECNclaw 可以无人工驱动 TraeCN 全流程，但首次登录必须人来。**

### 4.2 为什么

TraeCN 1.107+ 把功能分成两个区域：

| 区域 | 需登录 | 说明 |
|---|---|---|
| **AI 聊天 / 委派 / 改文件 / 切模型** | ✅ | 走 `.chat-input-v2-input-box-editable` / `.assistant-chat-turn-content` 等；未登录态进入 `.ai-ng-welcome-nologin` |
| **编辑器 / 文件 / Terminal / Git / Search / Extensions / Settings** | ❌ | 走 VS Code workbench command + DOM，不需要登录 |

v0.4.0 的 **9 个 driver 全在第二区**，所以编辑器/文件/Terminal/Git/Search/Snapshot 等无人工。

但只要你想让 TraeCN **本身**做 AI 工作（`run_task` / `review_code` / `switch_model`），要先登录一次。

### 4.3 登录态持久化

TraeCN 把 cookie + user-data 存在：

```
macOS:   ~/Library/Application Support/Trae CN/
Linux:   ~/.config/Trae CN/
Windows: %APPDATA%\Trae CN\
```

**保持登录态的关键 `.env`**：

```ini
TRAECN_QUICKSTART_PROFILE_MODE=existing   # 复用已有 profile
TRAECN_AUTO_START_TRAE=1                  # CDP 失效时自动重启
TRAECN_TRAE_RECOVERY_NEW_INSTANCE=0       # 恢复时不开新窗口
```

### 4.4 首次 setup 流程

```sh
# 1. 安装
git clone ... && cd TRAECNclaw && npm install
cp .env.example .env   # macOS 可省 TRAECN_BIN

# 2. 人工登录一次
open -a "Trae CN"      # UI 登录（手机号 / 掘金 OAuth）→ 关窗
ls -la ~/Library/Application\ Support/Trae\ CN/Cookies

# 3. 接管
TRAECN_QUICKSTART_PROFILE_MODE=existing npm run quickstart

# 4. 注册到 OpenClaw（编辑 openclaw.json → mcp.servers.traecn）

# 5. 端到端 smoke
#   traecn_capabilities      ← 21 个 public tool（默认 profile）
#   traecn_preflight         ← status + readiness + queue + dialog
#   traecn_editor action=saveAll
```

### 4.5 登录态丢失场景

| 场景 | 后果 | 解决 |
|---|---|---|
| 改 `TRAECN_USER_DATA_DIR` 到空目录 | 新 profile，未登录 | 改回默认 |
| `TRAECN_QUICKSTART_USE_ISOLATED_PROFILE=1` | 每次临时 profile | 关掉，用 `existing` |
| `rm -rf ~/Library/Application\ Support/Trae\ CN` | 全清 | 重装 + 重登 |
| TraeCN cookie 过期 | 跳 `.ai-ng-welcome-nologin` | UI 登录；或 `npm run doctor` |

---

## 5. 能力目录 `GET /api/capabilities`

**所有 agent 第一调用**，返回低 token 能力目录：当前 profile 可见的 MCP tool 摘要、28+ stable command、9 个 driver + 100+ action、已知 model 列表、10 个 settings 栏目、API family 分类、推荐调用顺序。

### 5.1 HTTP

```sh
curl -s http://127.0.0.1:8788/api/capabilities | jq .
```

返回结构：

```json
{
  "server": { "name": "traecnclaw", "version": "0.4.0" },
  "drivers": {
    "editor":      ["acceptAll", "rejectAll", "save", "saveAll", "writeActive", ...],
    "file":        ["openFileByPath", "readDisk", "writeDisk", "listTreeDisk", ...],
    "terminal":    ["toggleTerminal", "sendLine", "snapshot", "tail", ...],
    "git":         ["commitWithMessage", "stageAll", "push", "execGit", ...],
    "search":      ["find", "readResults", "findInFiles", ...],
    "diagnostics": ["readAll", "readModelMarkers", "nextProblem", ...],
    "snapshot":    ["screenshot", "screenshotElement", "dom", "text", ...],
    "extension":   ["searchMarketplace", "install", "installViaCLI", ...],
    "command":     ["run", "runSequence", "open", "close"]
  },
  "commands": [...],
  "mcpTools": [...],
  "models": ["Doubao-Seed-2.0-Code", "GLM-5.2", "GLM-5.1", "DeepSeek-V3.1-Terminus", ...],
  "settings": ["general", "account", "agents", "mcp", "flow", "model", "context", "rules", "beta", "about"],
  "apiFamilies": {
    "discovery":   ["/api/capabilities", "/api/preflight", "/api/status"],
    "delegation":  ["/api/delegate", "/api/delegate-async"],
    "queue":       ["/api/queue-status", "/api/queue/status"],
    "settings":    ["/api/settings/read", "/api/settings/set"]
  },
  "operationHints": {
    "status":     "Use first to decide whether live Trae CN is reachable.",
    "preflight":  "Use first for a compact status/readiness/queue/dialog summary."
  }
}
```

### 5.2 MCP

```json
{ "tool": "traecn_get_capabilities", "arguments": {} }
```

### 5.3 推荐调用顺序

```
1. traecn_get_capabilities / GET /api/capabilities  ← 低 token 拿目录
2. traecn_preflight      / POST /api/preflight      ← 状态+就绪+队列+弹窗综合
3. <具体操作>                                    ← 真正干活
4. (可选) GET /openapi.json                       ← 完整 schema
```

---

## 6. 使用示例

**通用约定**：

- HTTP：`POST /api/<driver>`，body `{action, ...positionalArgs}`，无参 action body 只需 `{action}`
- MCP：`traecn_<driver>`，args 同上
- 位置参数顺序严格按 §7 各表 param 列表（driver-router 按此 unpack，见 `src/http/driver-router.js`）

下面 **10 个完整例子**。

### 6.1 Editor: 接受 AI 全部建议改动

```sh
# HTTP
curl -s -X POST http://127.0.0.1:8788/api/editor \
  -H 'Content-Type: application/json' -d '{"action":"acceptAll"}' | jq .
```

```json
// MCP: { "tool": "traecn_editor", "arguments": { "action": "acceptAll" } }
// 返回: { "ok": true, "driver": "editor", "action": "acceptAll",
//         "result": { "accepted": 3 } }
```

走 `.icube-apply-action-container` Accept 按钮（TraeCN 1.107 实测稳定 class）。

### 6.2 File: 读磁盘文件

不走 IDE，直接 Node `fs` 读 `package.json`。`readDisk` / `writeDisk` / `listTreeDisk` 走侧通道，**不依赖 IDE 内编辑器状态**，文件没打开也能读。

```sh
curl -s -X POST http://127.0.0.1:8788/api/file \
  -H 'Content-Type: application/json' \
  -d '{"action":"readDisk","filePath":"/abs/path/TRAECNclaw/package.json"}' | jq .
```

```json
// MCP: { "tool": "traecn_file", "arguments": { "action": "readDisk",
//             "filePath": "/abs/path/TRAECNclaw/package.json" } }
// 返回: { "ok": true, "result": { "ok": true, "content": "...", "size": 6727 } }
```

### 6.3 Git: 用固定 message 提交

打开 SCM 面板 → 填提交信息 → 点 commit。

```sh
curl -s -X POST http://127.0.0.1:8788/api/git \
  -H 'Content-Type: application/json' \
  -d '{"action":"commitWithMessage","message":"feat(editor): add snapshot action"}' | jq .
```

```json
// MCP: { "tool": "traecn_git", "arguments": {
//             "action": "commitWithMessage",
//             "message": "feat(editor): add snapshot action" } }
// 返回: { "ok": true, "result": { "ok": true, "committed": true, "hash": "a1b2c3d" } }
```

### 6.4 Snapshot: 截 IDE 全屏图

调试 / 回放 / 视觉回归 —— 存成 PNG。走 `Page.captureScreenshot` CDP，**不需要任何额外权限**。

```sh
curl -s -X POST http://127.0.0.1:8788/api/snapshot \
  -H 'Content-Type: application/json' \
  -d '{"action":"screenshot","targetPath":"/tmp/traecn-debug-001.png"}' | jq .
```

```json
// MCP: { "tool": "traecn_snapshot", "arguments": {
//             "action": "screenshot", "targetPath": "/tmp/traecn-debug-001.png" } }
// 返回: { "ok": true, "result": { "ok": true, "path": "/tmp/...", "size": 248321 } }
```

### 6.5 Terminal: 在 IDE 内 terminal 跑命令

```sh
# 三步：toggle → sendLine → tail
curl -s -X POST http://127.0.0.1:8788/api/terminal -d '{"action":"toggleTerminal"}' | jq -c .
curl -s -X POST http://127.0.0.1:8788/api/terminal -d '{"action":"sendLine","text":"ls -la"}' | jq -c .
curl -s -X POST http://127.0.0.1:8788/api/terminal -d '{"action":"tail","lines":50}' | jq .
```

```json
// MCP（顺序调）
[
  { "tool": "traecn_terminal", "arguments": { "action": "toggleTerminal" } },
  { "tool": "traecn_terminal", "arguments": { "action": "sendLine", "text": "ls -la" } },
  { "tool": "traecn_terminal", "arguments": { "action": "tail", "lines": 50 } }
]
```

### 6.6 Search: 全文搜索并读结果

在 IDE Search 面板跑 grep。

```sh
curl -s -X POST http://127.0.0.1:8788/api/search \
  -H 'Content-Type: application/json' \
  -d '{"action":"find","query":"PALETTE_REQUIRED","opts":{"include":"**/*.js","maxResults":50}}' | jq .
```

```json
// MCP: { "tool": "traecn_search", "arguments": {
//             "action": "find", "query": "PALETTE_REQUIRED",
//             "opts": { "include": "**/*.js", "maxResults": 50 } } }
```

### 6.7 Diagnostics: 读 Problems 面板

读 lint / 编译错误，不打开 Problems 面板也行。

```sh
curl -s -X POST http://127.0.0.1:8788/api/diagnostics \
  -H 'Content-Type: application/json' \
  -d '{"action":"readAll","max":100}' | jq .
```

```json
// MCP: { "tool": "traecn_diagnostics", "arguments": { "action": "readAll", "max": 100 } }
```

### 6.8 Extension: 装扩展（CLI 通道）

走 `trae-cn --install-extension` CLI，不依赖 IDE Marketplace UI（更稳定）。

```sh
curl -s -X POST http://127.0.0.1:8788/api/extension \
  -H 'Content-Type: application/json' \
  -d '{"action":"installViaCLI","extensionId":"esbenp.prettier-vscode","version":"11.0.0"}' | jq .
```

```json
// MCP: { "tool": "traecn_extension", "arguments": {
//             "action": "installViaCLI",
//             "extensionId": "esbenp.prettier-vscode", "version": "11.0.0" } }
```

### 6.9 Command Palette: 直接跑 VS Code command

不走 UI，直接 `Cmd+Shift+P` → 输入 commandId → 回车（retry 3 次，见 `src/cdp/command-palette-driver.js:118`）。

```sh
curl -s -X POST http://127.0.0.1:8788/api/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"run","commandId":"workbench.action.formatDocument"}' | jq .
```

```json
// MCP: { "tool": "traecn_command", "arguments": {
//             "action": "run", "commandId": "workbench.action.formatDocument" } }
```

### 6.10 Editor: 直接覆写当前激活编辑器内容

不走 AI、不走 accept，**直接覆写**当前打开的文件（不会自动 save，需再调 `save` / `saveAll`）。

```sh
curl -s -X POST http://127.0.0.1:8788/api/editor \
  -H 'Content-Type: application/json' \
  -d '{"action":"writeActive","value":"// replaced by TRAECNclaw\nconst x = 1;\n"}' | jq .
```

```json
// MCP: { "tool": "traecn_editor", "arguments": {
//             "action": "writeActive", "value": "// replaced by TRAECNclaw\nconst x = 1;\n" } }
// 返回: { "ok": true, "result": { "ok": true, "written": 47 } }
```

---

## 7. Driver action 参考表

**约定**：`[]` = 无参；`['p1', 'p2']` = 位置参数（按此顺序）；`✅` = 走 `CommandPaletteDriver`（适用 `PALETTE_REQUIRED` / `PALETTE_OPEN_FAILED` 等错误）。

### 7.1 `editor`

| action | params | palette | 用途 |
|---|---|---|---|
| `acceptAll` / `rejectAll` / `acceptNext` / `rejectNext` | `[]` | ❌ | AI 改 accept/reject（`.icube-apply-action-container`） |
| `readApplyState` | `[]` | ❌ | 读待 accept 数量 |
| `save` / `saveAll` / `saveAs` / `revertFile` / `revertAll` | `[]` | ✅ | 保存/恢复 |
| `closeActive` / `closeAll` / `newFile` / `revealInExplorer` / `copyPathOfActive` / `reloadWindow` / `toggleSidebar` / `togglePanel` / `splitEditor` / `showCommands` | `[]` | ✅ | 编辑器生命周期 |
| `undo` / `redo` / `formatDocument` / `formatSelection` / `commentLine` | `[]` | ✅ | 编辑操作 |
| `copyLinesDown/Up` / `moveLinesDown/Up` / `insertCursorAbove/Below` / `insertCursorAtEachMatchSelection` | `[]` | ✅ | 行/多光标 |
| `expandLineSelection` / `shrinkSelection` / `addSelectionToNextFindMatch` / `addSelectionToPreviousFindMatch` / `selectAll` | `[]` | ✅ | 选择扩展 |
| `triggerSuggest` / `showHover` / `gotoLine` | `[]` | ✅ | 杂项 |
| `revealDefinition` / `peekDefinition` / `showReferences` / `renameSymbol` / `findAllReferences` / `implementInterface` / `quickFix` / `refactor` | `[]` | ✅ | 符号 / 重构 |
| `fold` / `unfold` / `foldAll` / `unfoldAll` / `foldRecursively` / `unfoldRecursively` | `[]` | ✅ | 折叠 |
| `readActive` | `[]` | ❌ | 读当前编辑器内容（不走 save） |
| `writeActive` | `['value']` | ❌ | 覆写当前编辑器内容（不走 save） |
| `listActive` | `[]` | ❌ | 列所有打开的编辑器 |

### 7.2 `file`

| action | params | palette | 用途 |
|---|---|---|---|
| `closeActive` / `closeAll` / `closeOthers` / `newFile` / `revertFile` / `revealInExplorer` / `copyPath` / `save` / `saveAll` / `saveAs` | `[]` | ✅ | 编辑器文件操作 |
| `openFileByPath` | `['filePath']` | ✅ | Quick Open（Cmd+P）打开 |
| `listOpenEditors` | `[]` | ❌ | 列已打开文件 |
| `listExplorerVisible` | `[]` | ❌ | 列 Explorer 可见项 |
| `readDisk` | `['filePath']` | ❌ | **Node fs 直读磁盘** |
| `writeDisk` | `['filePath', 'content']` | ❌ | **Node fs 直写磁盘** |
| `deleteDisk` | `['filePath']` | ❌ | **Node fs 直删** |
| `mkdirDisk` | `['dirPath']` | ❌ | **Node fs 建目录** |
| `listTreeDisk` | `['rootPath', 'opts']` | ❌ | **Node fs 列目录树**；`opts: {depth, include, exclude}` |
| `renameDisk` | `['oldPath', 'newPath']` | ❌ | **Node fs 改名** |

### 7.3 `terminal`

| action | params | palette | 用途 |
|---|---|---|---|
| `toggleTerminal` / `newTerminal` / `killTerminal` / `clearTerminal` / `splitTerminal` / `focusTerminal` | `[]` | ✅ | 终端生命周期 |
| `snapshot` | `[]` | ❌ | 读 terminal 状态 `{output, rowCount, tabs}` |
| `tail` | `['lines']` | ❌ | 读最后 N 行 |
| `send` | `['text']` | ❌ | 输入文字（不按 Enter） |
| `sendLine` | `['text']` | ❌ | 输入 + 回车 |
| `sendKey` | `['key', 'code', 'wvk', 'modifiers']` | ❌ | 单键（key/code/wvk 必填） |
| `sendCtrlC` / `sendCtrlD` / `sendCtrlL` / `sendCtrlZ` | `[]` | ❌ | 快捷键 |
| `selectTab` | `['title']` | ❌ | 切 tab（按 title） |

### 7.4 `git`

| action | params | palette | 用途 |
|---|---|---|---|
| `openSCM` / `focusSCM` / `refreshSCM` | `[]` | ✅ | SCM 面板 |
| `stageAll` / `unstageAll` | `[]` | ✅ | 暂存 |
| `commit` / `commitAmend` / `commitSignedOff` | `[]` | ✅ | 提交 |
| `push` / `pull` / `sync` / `fetch` | `[]` | ✅ | 远程同步 |
| `clone` / `init` / `checkout` / `branch` / `merge` / `rebase` | `[]` | ✅ | 分支 |
| `stash` / `stashPop` / `stashApply` | `[]` | ✅ | 暂存栈 |
| `showOutput` / `showLog` / `diff` | `[]` | ✅ | 查看 |
| `commitWithMessage` | `['message']` | ❌ | 填 message + commit |
| `readStatus` | `[]` | ❌ | 读 SCM 状态（DOM） |
| `readCurrentBranch` | `[]` | ❌ | 读当前分支（status bar） |
| `execGit` | `['args', 'opts']` | ❌ | **直接走 git CLI**（需注入 `exec`） |

### 7.5 `search`

| action | params | palette | 用途 |
|---|---|---|---|
| `openSearch` / `findInFiles` / `closeSearch` / `toggleCaseSensitive` / `toggleWholeWord` / `toggleRegex` / `collapseAll` | `[]` | ✅ | 面板 / 选项 |
| `find` | `['query', 'opts']` | ❌ | 跑搜索；`opts: {include, exclude, maxResults}` |
| `readResults` | `['maxResults']` | ❌ | 读当前面板结果 |

### 7.6 `diagnostics`

| action | params | palette | 用途 |
|---|---|---|---|
| `openProblems` / `focusProblems` / `nextProblem` / `prevProblem` / `nextInFiles` / `showErrors` | `[]` | ✅ | 面板 / 跳错 |
| `readAll` | `['max']` | ❌ | 读全部 Problems（DOM） |
| `readModelMarkers` | `['max']` | ❌ | 读 Monaco markers |
| `count` | `[]` | ❌ | 只读 count |
| `hover` | `['line', 'column']` | ❌ | 触发 hover |

### 7.7 `snapshot`

| action | params | palette | 用途 |
|---|---|---|---|
| `dom` | `['selector']` | ❌ | 取元素 outerHTML |
| `text` | `['selector']` | ❌ | 取元素 innerText |
| `layout` | `['opts']` | ❌ | 可见元素 layout 信息 |
| `pageHash` | `[]` | ❌ | 整页 hash（回归检测） |
| `screenshot` | `['targetPath']` | ❌ | 全 viewport 截图（PNG） |
| `screenshotElement` | `['selector', 'targetPath']` | ❌ | 单元素截图 |

### 7.8 `extension`

| action | params | palette | 用途 |
|---|---|---|---|
| `openExtensions` / `focusExtensions` / `openMarketplace` | `[]` | ✅ | 面板 |
| `install` / `uninstall` / `enable` / `disable` / `enableAll` / `disableAll` / `enableAllWorkspace` / `disableAllWorkspace` | `[]` | ✅ | 启停 |
| `showInstalled` / `showEnabled` / `showDisabled` / `showOutdated` / `updateAll` | `[]` | ✅ | 过滤视图 |
| `searchMarketplace` | `['query', 'opts']` | ❌ | 搜 Marketplace |
| `readVisible` | `['max']` | ❌ | 读当前可见列表 |
| `listViaCLI` | `['opts']` | ❌ | **走 `trae-cn --list-extensions` CLI** |
| `installViaCLI` | `['extensionId', 'version']` | ❌ | **走 `trae-cn --install-extension` CLI** |
| `uninstallViaCLI` | `['extensionId']` | ❌ | **走 `trae-cn --uninstall-extension` CLI** |

### 7.9 `command`

| action | params | palette | 用途 |
|---|---|---|---|
| `open` | `[]` | — | 打开 command palette（`Cmd+Shift+P`，retry 3 次） |
| `close` | `[]` | — | 关闭 |
| `run` | `['commandId', 'opts']` | — | 跑一条 VS Code command |
| `runSequence` | `['commandIds']` | — | 顺序跑多条 |

---

## 8. 错误码

所有 driver / 命令错误都是 `TraeCNAutomationError`，带 `code` 字段。HTTP 返回 4xx / 5xx + `{ok: false, code, error, driver?, action?}`；MCP 返回 `isError: true` + 同样 JSON。

### 8.1 路由层（`src/http/driver-router.js`）

| code | HTTP | 触发 | 解决 |
|---|---|---|---|
| `UNKNOWN_DRIVER` | 400 | driver 名不是 9 个之一 | 检查拼写（`editor/file/terminal/git/search/diagnostics/snapshot/extension/command`） |
| `UNKNOWN_ACTION` | 400 | action 不在该 driver | `GET /api/capabilities` 查 `drivers.<driver>` |
| `MISSING_ACTION` | 400 | body 没 `action` | body 必须是 `{action, ...}` |
| `METHOD_MISSING` | 500 | driver 有 spec 但实现里没 method | 内部 bug，上报 |
| `DRIVER_NOT_READY` | 500 | driver 实例未初始化 | 关 mock bridge；确认 CDP 通 |

### 8.2 Driver 内部（`src/cdp/*.js`）

| code | HTTP | 触发 | 解决 |
|---|---|---|---|
| `PALETTE_REQUIRED` | 500 | driver 调 `_viaPalette()` 但 palette 未注入 | 检查 `deps.palette` 是否传入 |
| `PALETTE_OPEN_FAILED` | 500 | `Cmd+Shift+P` 开了 3 次都没出现 | 焦点问题：先 focus IDE 再试 |
| `PALETTE_INPUT_MISSING` | 500 | palette 开了但找不到 input | IDE 未就绪；等 200ms 重试 |
| `INVALID_INPUT` | 400 | 参数校验失败 | 看 message（commit 消息空、send 空串等） |
| `INVALID_COMMAND_ID` | 400 | `run` 没传 commandId | args 必填 |
| `NO_TERMINAL` | 500 | terminal 操作但没 panel | 先 `toggleTerminal` |
| `SCM_INPUT_MISSING` | 500 | commit box 找不到 | SCM 面板未打开 |
| `SEARCH_INPUT_MISSING` / `EXT_SEARCH_INPUT_MISSING` | 500 | 输入框找不到 | 同上 |
| `CONNECTION_FAILED` | 502 | CDP 不可达 | 查 §9.1 |
| `TARGET_NOT_FOUND` | 502 | CDP 通但 target 不匹配 | 调 `TRAECN_CDP_TARGET_TITLE_CONTAINS` |
| `SELECTOR_NOT_FOUND` | 502 | DOM 选择器全 miss | `npm run inspect:verify` |
| `RESPONSE_TIMEOUT` | 504 | AI 响应超时（默认 30s） | 调 `TRAECN_RESPONSE_TIMEOUT_MS`；或 `queue_task` |
| `SESSION_PREPARE_FAILED` | 500 | session 准备失败（restricted mode 等） | 看 message；或 `clickRestrictedModeTrust()` |
| `SEND_FAILED` | 500 | 给 TraeCN 发消息失败 | 看 message |

### 8.3 错误处理最佳实践

```js
try {
  await mcp.call('traecn_editor', { action: 'acceptAll' });
} catch (e) {
  const parsed = JSON.parse(e.message);  // MCP isError 返回 JSON
  switch (parsed.code) {
    case 'PALETTE_OPEN_FAILED':
      await mcp.call('traecn_command', {
        action: 'run', commandId: 'workbench.action.focusActiveEditorGroup'
      });
      return mcp.call('traecn_editor', { action: 'acceptAll' });
    case 'UNKNOWN_ACTION':
      await mcp.call('traecn_get_capabilities', {});
      break;
    default:
      throw e;
  }
}
```

---

## 9. 故障排查

### 9.1 CDP 不可达（最常见）

**症状**：`[TRAECNclaw] CDP not available: connect ECONNREFUSED 127.0.0.1:9222`

**诊断**：

```sh
pgrep -f "/Trae CN\.app/Contents/MacOS/Electron"   # TraeCN 跑了吗？
lsof -i :9222                                       # 9222 在听吗？
curl -s http://127.0.0.1:9222/json/version          # CDP 通吗？
```

**解决**：

```sh
# A. TRAECNclaw 自动重启（显式设置 TRAECN_AUTO_START_TRAE=1）
TRAECN_AUTO_START_TRAE=1 npm run quickstart -- --launch-trae

# B. 手工 quit 后用 existing profile 启动
osascript -e 'tell application "Trae CN" to quit'
sleep 3
TRAECN_QUICKSTART_PROFILE_MODE=existing npm run start:traecn -- --use-existing-profile

# C. API 自动恢复 endpoint
curl -s -X POST http://127.0.0.1:8788/api/trae/restart-debug \
  -H 'Content-Type: application/json' \
  -d '{"confirmationPhrase":"restart-trae-cn-with-debug-existing-profile"}'
```

### 9.2 Command Palette 打不开

**症状**：`PALETTE_OPEN_FAILED`，retry 3 次都没出现 quick-input-widget。

**原因**：焦点不在 IDE 内（chat UI / terminal 外 / 桌面其他 app）。

**解决**：

```sh
# 1. 先 focus IDE
curl -s -X POST http://127.0.0.1:8788/api/command \
  -d '{"action":"run","commandId":"workbench.action.focusActiveEditorGroup"}' | jq .

# 2. 再试 driver
curl -s -X POST http://127.0.0.1:8788/api/file -d '{"action":"saveAll"}' | jq .
```

### 9.3 TraeCN 登出了

**症状**：`run_task` / `switch_model` / `review_code` 失败；`npm run doctor` 报未登录。

**解决**：

```sh
# 1. 手工登录
open -a "Trae CN"    # 走手机号 / 掘金 OAuth → 关窗

# 2. 确认 profile mode
# .env: TRAECN_QUICKSTART_PROFILE_MODE=existing
#       TRAECN_QUICKSTART_USE_ISOLATED_PROFILE=0

# 3. 重启
npm run quickstart
```

### 9.4 IDE 在 busy queue（模型排队）

**症状**：`run_task` 一直 `queued: true`。

**诊断**：`{ "tool": "traecn_check_queue" }` → `{ok, queued, position, currentModel}`。

**解决**：

```sh
# 切模型（模糊匹配）
curl -s -X POST http://127.0.0.1:8788/api/switch-model \
  -H 'Content-Type: application/json' -d '{"name":"deepseek"}' | jq .   # → DeepSeek-V3.1-Terminus

# 或让 gateway 自动 fallback
curl -s -X POST http://127.0.0.1:8788/api/delegate-async \
  -H 'Content-Type: application/json' \
  -d '{"task":"审查当前项目","waitForQueue":true,"autoModelFallback":true,
       "fallbackModels":["deepseek","kimi","qwen"],"modelProbeIntervalMs":60000}' | jq .
```

### 9.5 Dialog 阻塞

**症状**：`approveDialog` 失败；`checkDialog` 返回 `{hasDialog: true}`。

**解决**：

```sh
# 1. 看是什么 dialog
curl -s http://127.0.0.1:8788/api/dialog/status | jq .

# 2. approve
curl -s -X POST http://127.0.0.1:8788/api/dialog/approve \
  -H 'Content-Type: application/json' -d '{"action":"trust","wait":true}' | jq .

# MCP: { "tool": "traecn_approve_dialog", "arguments": { "action": "trust", "wait": true } }
```

`action` 可选：`auto` / `accept` / `reject` / `confirm` / `dismiss` / `trust` / `cancel`。

### 9.6 MCP server 启动不了

**症状**：OpenClaw 报 "MCP server traecn exited with code 1"。

**诊断**：

```sh
node /absolute/path/to/TRAECNclaw/mcp-server.js     # 手动跑，看 stderr
node --version                                       # 应该 >= 22
node -e "require('/absolute/path/to/TRAECNclaw/mcp-server.js')"   # 测依赖
```

| 错误 | 原因 | 解决 |
|---|---|---|
| `Cannot find module '../src/skill/...'` | path 错 | 用绝对路径 |
| `Node.js version not supported` | Node < 22 | 升级 |
| `ECONNREFUSED 127.0.0.1:8788` | gateway 没启 | 先 `npm run quickstart` |
| `CONNECTION_FAILED` | gateway 启了但 CDP 没通 | 查 §9.1 |

### 9.7 Gateway 起了但 driver 全报 `PALETTE_REQUIRED`

**原因**：mock 模式下 `DomDriver` 是 `MockDriver` 实例，palette 是 null。`TRAECN_ENABLE_MOCK_BRIDGE=1` 时这是预期 —— driver 路由通但真做不了。

**解决**：

```ini
# .env
TRAECN_ENABLE_MOCK_BRIDGE=0
```

或在 mock 模式下**只**用 `traecn_get_capabilities` / `traecn_preflight` / `traecn_list_commands`，不要调 driver action。

### 9.8 不走 MCP，直调 HTTP

```sh
curl -s http://127.0.0.1:8788/api/capabilities | jq '.drivers' | head -40

curl -s -X POST http://127.0.0.1:8788/api/<driver> \
  -H 'Content-Type: application/json' \
  -d '{"action":"...","param1":"...","param2":"..."}' | jq .
```

---

## 附录：30 秒 setup checklist

```sh
# 1. clone + install
git clone https://github.com/Luckycat133/TRAECNclaw.git && cd TRAECNclaw && npm install
cp .env.example .env   # macOS 可省 TRAECN_BIN，TRAECN_QUICKSTART_PROFILE_MODE=existing

# 2. 人工登录一次（仅首次）
open -a "Trae CN" && sleep 5 && osascript -e 'tell application "Trae CN" to quit'

# 3. 启动
npm run quickstart                                       # 前台
# 或：npm run service:install && npm run service:start   # 后台 LaunchAgent

# 4. 验证
curl -s http://127.0.0.1:9222/json/version | jq -r .Browser   # TraeCN/1.107.1
curl -s http://127.0.0.1:8788/api/status | jq .ok              # true

# 5. 注册到 OpenClaw
jq '.mcp.servers.traecn = {
  "command": "node", "args": ["'"$(pwd)"'/mcp-server.js"],
  "env": { "TRAECN_HOST": "127.0.0.1", "TRAECN_PORT": "8788" }
}' ~/.openclaw/openclaw.json > /tmp/openclaw.json.new
mv /tmp/openclaw.json.new ~/.openclaw/openclaw.json

# 6. 第一个 driver 调用
curl -s -X POST http://127.0.0.1:8788/api/snapshot \
  -H 'Content-Type: application/json' \
  -d '{"action":"screenshot","targetPath":"/tmp/traecn-first.png"}' | jq .
open /tmp/traecn-first.png    # 看到 TraeCN IDE 画面 = 端到端通了
```

---

## 相关文档

- [README.md](../README.md) — 项目总览
- [MCP-SERVER-GUIDE.md](./MCP-SERVER-GUIDE.md) — 通用 MCP 配置（Cursor / Claude Desktop / Cline / Windsurf）
- [openclaw-command-set.md](./openclaw-command-set.md) — OpenClaw 命令与参数
- [structured-prompt-mechanism.md](./structured-prompt-mechanism.md) — 结构化 prompt 分层机制
- [REAL-DOM-FINDINGS.md](./REAL-DOM-FINDINGS.md) — TraeCN 1.107 实测 DOM 选择器

---

**TRAECNclaw v0.4.0 · 9 drivers / 100+ actions / 21 public MCP tools (33 ops / 37 full) / 9 HTTP driver endpoints**
