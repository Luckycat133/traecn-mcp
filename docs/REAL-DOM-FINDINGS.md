# TraeCN 真实 DOM 发现（v0.4.0 起点）

> 来自 `npm run start:traecn` + CDP probe 抓的**真实** TraeCN 1.107.1 DOM
> 采集时的工作目录已脱敏为：`<workspace>/TRAECNclaw`
> CDP: 9222 · `~/Library/Application Support/Trae CN`（macOS 默认 user-data-dir，已登录态持久化）

这份文档保存的是历史实机证据，不代表每次发布都重新执行了会消耗
模型额度的实机任务 UAT。2026-08-08 已针对同一 TraeCN 1.107.1 构建
重新通过 strict readiness UAT；该检查覆盖 product identity、readiness、
verified adapter、queue/dialog/preflight、发现面、设置读取、Solo 列表和
清理 dry-run，但没有发送 prompt 或删除会话。对应的版本适配器是
`src/trae-adapters/traecn-1.107`；脱敏后的
关键工作流状态保存在
`src/trae-adapters/traecn-1.107/fixtures/workflow.json`，可通过
`npm run test:trae-adapters` 重放。当前实机检测结果以
`GET /api/status` 的 `traeAdapter` 握手和 `npm run inspect:verify` 为准。

---

## 1. 启动后状态

| 项 | 状态 | 说明 |
|---|---|---|
| 启动 | ✅ | `node scripts/start-traecn.js` → Electron `--remote-debugging-port=9222` |
| CDP | ✅ | `curl http://127.0.0.1:9222/json/version` 返回 TraeCN 1.107.1 / Chrome 142 / Electron 39 |
| user-data-dir | ✅ | `~/Library/Application Support/Trae CN`（cookie 持久化） |
| 登录态 | ⚠️ | **首次 cookie 过期时**会进入未登录态（`ai-ng-welcome-nologin`），需人类登录一次 |
| 模式 | SOLO/IDE 切换可见 | `.icube-mode-tab-item-solo` / `.icube-mode-tab-item-ide` |

### 登录依赖

- AI 聊天 / AI 委派 / AI 改文件 → 需要登录（OAuth: 手机号 / 掘金）
- 编辑器 / 文件 / Terminal / Git / Search / Extensions / Settings → **不需要登录**
- **解决方案**：用户首次登录一次；cookie 持久化于 `Cookies` 文件；不重启不丢；监控过期并报

---

## 2. 真实可见 class（实测）

### 2.1 顶层结构

```
body
├─ #monaco-parts-splash
├─ .fixed-titlebar-container          (窗口标题栏)
├─ .solo-extension-view-invisible     (workbench 容器)
│   .monaco-workbench
│   .grid-view-container
│   .titlebar-container
│   .menubar                           (File / Edit / View / ... 菜单)
│   .activitybar / .sidebar            (5 个 panel 入口)
│   .editor-group-container            (代码编辑器)
│   .panel                             (terminal / problems / output)
│   .statusbar                         (底部状态栏)
└─ icube-toast-container
```

### 2.2 Activity Bar 5 个 panel 入口

| Class | 名称 | 对应 view |
|---|---|---|
| `.action-item[aria-label="资源管理器"]` | Explorer | `.explorer-viewlet` / `.sidebar` |
| `.action-item[aria-label="搜索"]` | Search | `.search-view` |
| `.action-item[aria-label="源代码管理"]` | Source Control | `.scm-viewlet` |
| `.action-item[aria-label="运行和调试"]` | Run and Debug | `.debug-toolbar` + debug view |
| `.action-item[aria-label="扩展"]` | Extensions | `.extensions-viewlet` |

### 2.3 编辑器

| 用途 | Class |
|---|---|
| 编辑器容器 | `.editor-container.icube_code_editor` |
| 多 view 容器 | `.editor-group-container` |
| 文本输入 | `.inputarea.monaco-mouse-cursor-text` (hidden textarea) |
| 内容层 | `.monaco-editor` / `.view-lines` / `.view-line` |
| 当前 tab | `.tab.active` / `.tab.focused` |
| tab 关闭 | `.tab-actions .action-label.codicon-cu` |
| 行号 | `.line-numbers` |

### 2.4 AI Chat / SOLO 模式

| 用途 | Class |
|---|---|
| AI chat 容器 | `.icube-chat-view-container` |
| Chat 列表 | `.chat-list-wrapper` |
| Chat 历史 | `.ai-chat-history-container` |
| Composer (已登录态) | `.chat-input-v2-input-box-editable` / `textarea` / `[contenteditable=true]` |
| 发送按钮 (已登录态) | `button.chat-input-v2-send-button` / `button[data-testid*="send"]` |
| 未登录态 welcome | `.ai-ng-welcome-nologin` |
| 助手响应 | `.assistant-chat-turn-content` / `[data-role="assistant"]` |
| 活动指示 | `.chat-content-container` / `.chat-list-wrapper` |
| 新对话 | `[class*="new-task"]` / `[class*="NewChat"]` |
| 模式 tab | `.icube-mode-tab-item-solo` / `.icube-mode-tab-item-ide` |
| **AI 改动应用容器** ⭐ | `.icube-apply-action-container` (核心：accept / reject edit) |
| **增强提示容器** | `.icube-enhance-top-container` |
| **Follow AI 模式** | `.icube-follow-ai-` |

### 2.5 Terminal

| 用途 | Class |
|---|---|
| Panel 容器 | `.terminal-wrapper` |
| xterm 渲染 | `.xterm` |
| xterm 行 | `.xterm-rows` |
| 终端 tab | `[class*="terminal-tab"]` |

### 2.6 Source Control (Git)

| 用途 | Class |
|---|---|
| SCM viewlet | `.scm-viewlet` |
| 改动列表 | `.scm-status-provider` |
| Commit 框 | `[class*="commit-input"]` / `.textbox.input` |
| SCM 操作按钮 | `.scm-action .action-label` |
| Status bar git | `[aria-label*="Git"]` |

### 2.7 Search

| 用途 | Class |
|---|---|
| Search view | `.search-view` |
| 搜索输入 | `.search-widget .input` |
| 替换输入 | `.replace-input` |
| 结果树 | `.search-results` |
| 消息 | `.message` |

### 2.8 Extensions

| 用途 | Class |
|---|---|
| Extensions viewlet | `.extensions-viewlet` |
| 搜索框 | `.extensions-search-input` |
| 列表项 | `.extension` / `.extension-list-item` |
| 安装按钮 | `[class*="action-install"]` |

### 2.9 Settings

走 `SettingsDriver`（21KB，10 个栏目）已实现：
- `general` / `account` / `agents` / `mcp` / `flow` / `model` / `context` / `rules` / `beta` / `about`
- actions: `navigate` / `read` / `readAll` / `type` / `click` / `clickTab` / `toggle` / `dropdown` / `set` / `readTables` / `back`

### 2.10 Status Bar (状态栏)

| 位置 | 内容 |
|---|---|
| 左 1 | Git: `TraeCNClaw (Git) - main*, 签出分支/标记...` |
| 左 2 | Sync: `将 3 个提交推送到 origin/main` |
| 中 1 | Problems: `没有问题` |
| 中 2 | 通知 |
| 右 1 | CUE |
| 右 2 | `3.14.3 64-bit` (Python interpreter) / `Python` / `LF` / `UTF-8` / `空格: 4` / `行 10，列 1` |

---

## 3. 全局对象（CDP `Runtime.evaluate` 抓到）

```
window.vscode
window.__icube_workbench_scene_confiuration
window._VSCODE_NLS_MESSAGES
window.vscodeService
window.__icube_devtool_vscode__       ← TraeCN 内部 devtool bridge
window.__icube_devtool_bridge_callbacks
```

> 未来可研究 `__icube_devtool_vscode__` 是否暴露 internal API 直接调 command，比 DOM click 稳。

---

## 4. inspect:verify 推荐配置（已生成）

```
TRAECN_RESPONSE_SELECTORS=.chat-list-wrapper,[class*="activity"]
TRAECN_NEW_CHAT_SELECTORS=[class*="new-task"],[class*='new-task-button'],[class*='new-task']
TRAECN_MODE_TAB_SELECTORS=.icube-mode-tab-item,.icube-mode-tab-item,[class*='icube-mode-tab-item'],...
TRAECN_ACTIVITY_SELECTORS=.chat-list-wrapper,[class*="activity"],[class*="chat-list"]
```
