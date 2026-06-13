# TraeCN 首次登录 Runbook

> **Status: 人工必做 — 不可自动化**
> 这步必须由人类执行。原因写在下面。

---

## 为什么必须人工

TraeCN 的 AI 登录走的是第三方 OAuth（手机号验证码 或 掘金 OAuth）。这两个
provider 都没有给 TRAECNClaw 留服务端 hook：

| 动作 | 能否走 CDP 自动化 |
|---|---|
| 点"登录"按钮 → 打开 OAuth 弹窗 | ✅ 可以 |
| 在手机号输入框填号 | ⚠️ 可填，但接下来要收短信 |
| 收短信并填 6 位验证码 | ❌ **必须人工** — TRAECNClaw 拿不到短信、CDP 也读不到第三方 provider 的 iframe |
| 扫掘金二维码 → 手机端掘金 App 确认 | ❌ **必须人工** — 同上 |
| OAuth 完成后关弹窗、回到工作台 | ✅ 可以 |

所以"首次登录"这一段，TRAECNClaw **能**做的是：
- 检测"现在需要登录"
- 告诉 caller 具体是哪个 blocker、当前是手机号还是掘金路径
- 提供 `readiness.blocker === 'login_required'` + `readiness.nextAction === 'login_traecn'` 信号

**不能**做的是完成登录本身。人类必须接手。

---

## 怎么判断现在需不需要登录

### 信号 1: `/api/preflight` 的 `readiness.blocker`

```bash
curl -sS -X POST http://127.0.0.1:8788/api/preflight \
  -H "Content-Type: application/json" -d '{"command":"list"}' | jq .readiness
```

期望：
- `blocker === null` → 已登录，能跑任务
- `blocker === "login_required"` → 未登录，要走下面的人工流程
- `blocker === "workspace_guide"` → 看到欢迎向导但登录态 OK，先 dismiss guide
- `blocker === "trust_workspace"` → 受限模式 dialog，弹了"信任工作区"按钮，让人类点

### 信号 2: `/api/capabilities` 里的 `coverage`

`coverage.connection === true` 才说明 TraeCN 这边基础设施（CDP、UI）在线。
登录态不在 coverage 里 — 看的是 readiness。

### 信号 3: DOM 探针（agent 兜底）

未登录页面有 `.ai-ng-welcome-nologin` class。`DomDriver.checkReadiness()`
会扫这个 class 并返 `loginRequired: true`。具体实现见
`src/cdp/dom-driver.js` 里 `loginVisible` 检测。

---

## 人工首次登录步骤（caller 转人类）

1. 打开 TraeCN 桌面应用（**已经启动** — TRAECNClaw gateway 会确认 trae running）
2. 看到未登录页面（手机号 / 掘金二维码 任选）
3. 走 OAuth 登录一次
4. 看到工作台（编辑器 / 文件树 / 终端）= 登录成功
5. **不要**关 TraeCN — cookie 持久化在 `~/Library/Application Support/Trae CN/Cookies`，
   不重启不丢

完成这一步后 caller 可以重新调 `/api/preflight`，
`readiness.blocker` 应该是 `null`，`nextAction === 'delegate_async'`，
agent 就能跑任务了。

---

## Cookie 过期 / 失效

TraeCN 的登录态 **不**永久有效：
- 默认 30 天滚动过期（cookie max-age）
- 退出登录或被服务端吊销 → 立即失效
- 升级 TraeCN 版本可能踢 cookie（罕见）

TRAECNClaw **能**做的事：
- 每次 `preflight` 都查 `readiness.blocker`，登录掉了立刻报
- 监控 `Cookies` 文件 mtime，发现文件被改 → 触发下一次 preflight 验证
- 超过 N 天没看到 `logged_in` 状态 → 主动告警（暂未实现，建议未来加）

TRAECNClaw **不能**做的事：
- 提前预判 cookie 何时过期（cookie 内容是加密的，TRAECNClaw 没密钥）
- 替人类重新走一遍 OAuth（短信/二维码那条路径）

---

## 自动化检测 & 自动重启模式

如果 caller 想让 TRAECNClaw 在"cookie 失效"时自动告警（不是自动登录），
现有能力：

```bash
# 每 5 分钟跑一次（cron）
curl -sS -X POST http://127.0.0.1:8788/api/preflight \
  -H "Content-Type: application/json" -d '{"command":"list"}' \
  | jq -e '.readiness.blocker == "login_required"' \
  && echo "🚨 TraeCN cookie 过期，需要人工重新登录" \
  || echo "✅ login OK"
```

`/api/preflight` 不写文件、不发请求到 Trae CN 服务端 — 纯本地 CDP 探针，
可以高频跑（实测 < 200ms）。

---

## 已知限制

- **多账号切换**：目前没有"切换登录账号"的自动化路径。如果需要换号，
  走人类手动流程，然后清空 `~/Library/Application Support/Trae CN/Cookies`。
- **多端登录**：同账号多端登录会互相踢（这是 TraeCN 服务端行为，不是
  TRAECNClaw 的 bug）。
- **OAuth provider 切换**：手机号 → 掘金 这种切换，需要先在 TraeCN UI
  登出，再走新 provider 登录，TRAECNClaw 帮不上忙。

---

## 相关代码位置

- 登录检测：`src/cdp/dom-driver.js` 里 `loginVisible` 字段
- readiness 拼装：`src/http/gateway.js` 里 `_handleReadiness`
- preflight nextAction：`src/http/gateway.js` 里 `'login_traecn'` 分支
- cookie 持久化目录：`~/Library/Application Support/Trae CN/`
  （macOS 默认 user-data-dir，由 `start-traecn.js` 的 `useIsolatedProfile=false` 复用）
- 真实 DOM class：`docs/REAL-DOM-FINDINGS.md` 第 1 节"登录依赖"

---

## 下次接手时该看什么

如果你 / 下一个 agent 接手 TRAECNClaw dev，遇到 `login_required` blocker：

1. **先检查** cookie 文件还在不在：
   `ls -la ~/Library/Application\ Support/Trae\ CN/Cookies`
2. **如果文件存在**但 preflight 还是说 login_required → 可能是 cookie 过期，
   需要人工重新登录一次
3. **如果文件不在** → TraeCN 用了 isolated profile 重启过，cookie 没被复用，
   也要人工登录
4. **如果是 fresh install**（第一次跑）→ 100% 人工

任何情况下，**不要**试图用 CDP 自动化填手机号/验证码 — 验证码收不到，
还会触发 provider 的风控。
