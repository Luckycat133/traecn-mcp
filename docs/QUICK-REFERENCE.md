# TraeCNSkill 快速参考

## 📦 安装

```bash
npm install traecnclaw
```

## 🚀 快速开始

```javascript
const { runTask } = require('traecnclaw');

// 执行任务
const result = await runTask('分析这个函数');
console.log(result);
```

## 🎯 6个核心函数（覆盖90%场景）

```javascript
const { runTask, switchModel, checkStatus, pollTask, waitTask, queueTask } = require('traecnclaw');

// 检查连接
await checkStatus();  // → boolean

// 切换模型（模糊匹配）
await switchModel('glm');      // → GLM-5.2
await switchModel('deepseek');  // → DeepSeek-V3.1-Terminus

// 执行任务
await runTask('优化这段代码');  // → 响应文本

// 队列任务（长时间任务）
const taskId = await queueTask('复杂分析');
await pollTask(taskId);  // → {ok, status, text}
await waitTask(taskId, { pollMs: 30000, timeoutMs: 0 });  // 本地静默等待

// CLI detached wait:
// traecnclaw wait <taskId> --detach --log queue-evidence.jsonl
```

## 📚 完整 API

### Agent 能力发现
```javascript
getCapabilities()        // npm simple API
// HTTP: GET /api/capabilities
// MCP: traecn_get_capabilities
// CLI: traecn capabilities
// OpenClaw command: capabilities
```

### 低 token 运行预检
```javascript
preflight({ command, params }) // npm simple API
// HTTP: POST /api/preflight
// MCP: traecn_preflight
// CLI: traecn preflight delegate_async '{"task":"..."}'
// OpenClaw command/tool: preflight / traecn_preflight
// 返回 surface，可区分当前处于 setup 还是 workspace
```

### 操作确认预检
```javascript
planOperation(command, params?)  // npm simple API
// HTTP: POST /api/confirm/plan
// MCP: plan_operation
// CLI: traecn plan settings_set '{"label":"Auto Save","value":true}'
// OpenClaw command: confirm_plan
```

### 已登录 Trae 调试恢复
```javascript
// HTTP: POST /api/trae/restart-debug
// OpenClaw command: restart_trae_debug
// 需要 confirmationPhrase: restart-trae-cn-with-debug-existing-profile
// 用 existing profile 重启，不创建未登录隔离窗口
```

### 任务管理
```javascript
runTask(task, opts)      // 运行任务 → text
queueTask(task, opts)    // 队列任务 → taskId
pollTask(taskId?)        // 轮询状态 → {ok, status, text}
cancelTask(taskId?)      // 取消任务 → {ok, cancelled}
```

### 状态检查
```javascript
checkStatus()            // 连接状态 → boolean
checkDialog()            // 对话框 → {ok, hasDialog, type, buttons}
checkQueue()            // 队列 → {ok, queued, position}
```

### 模型/模式
```javascript
switchModel(name)        // 切换模型 → 自动模糊匹配
switchMode('solo'|'ide') // 切换模式
```

### 设置
```javascript
getSettings(section?)     // 读取设置
setSetting(label, value, section?)  // 写入设置
```

### 对话
```javascript
newChat()               // 新对话
approveDialog(action?, wait?)  // 批准对话框
openProject(path)       // 打开项目
```

## 🔧 可用模型

```
Doubao-Seed-2.0-Code
Doubao-Seed-1.8
GLM-5.2
GLM-5.1
DeepSeek-V3.1-Terminus
MiniMax-M2.7
MiniMax-M2.5
Kimi-K2.5
Qwen3.6-Plus
Qwen3.5-Plus
```

**模糊匹配示例**：
- `'glm'` → GLM-5.2
- `'deep'` → DeepSeek-V3.1-Terminus
- `'doubao'` → Doubao-Seed-2.0-Code

## ⚡ runTask 选项

```javascript
{
  projectPath: '/path',    // 项目路径
  includeProcess: false,   // 包含过程信息
  autoWait: true,          // 自动等待队列（默认开启）
  mode: null               // 切换模式
}
```

## ❌ 错误代码

```javascript
'TASK_ID_MISSING'    // 需要先调用 runTask/queueTask
'UNKNOWN_MODEL'      // 模型不存在
'INVALID_MODE'       // 模式必须是 'solo' 或 'ide'
'TASK_FAILED'        // 任务执行失败
'QUEUE_TIMEOUT'      // 队列超时
'CONNECTION_ERROR'   // 连接失败
```

## 🔄 单字母别名

```javascript
// 完整名称 ← 别名
runTask      ← t
queueTask    ← q
pollTask     ← p
waitTask     ← w
checkStatus  ← s
preflight    ← pf

delegate_async + wait_task + waitForQueue=true
- When Trae shows its own queue, the gateway keeps the task in the local
  background queue instead of pushing immediately.
- Pair `reviewRequired=true` with `autoContinue=false` to stop on result review;
  continue with `traecn_resolve_task_review` after inspecting the task result.
- Add autoModelFallback=true or fallbackModels=[...] to let the gateway probe
  alternate models while the agent stops waiting.
switchModel  ← model
switchMode   ← mode
getSettings  ← settings
setSetting   ← set
approveDialog ← approve
checkDialog  ← dialog
checkQueue   ← queueCheck
openProject  ← open
cancelTask   ← cancel
```

## 📋 响应格式

```javascript
// 成功运行
{ ok: true, text: "结果", status: "stable", elapsed: 1234 }

// 队列模式
{ ok: true, queued: true, taskId: "task_xxx" }

// 轮询完成
{ ok: true, status: "done", text: "结果", elapsed: 5000 }

// 错误
{ ok: false, error: "错误信息", code: "ERROR_CODE" }
```

## 💡 最佳实践

```javascript
// ✅ 正确：先检查状态
if (await checkStatus()) {
  const result = await runTask('任务');
}

// ✅ 正确：使用队列处理长时间任务
const taskId = await queueTask('复杂分析');
// ... 其他操作 ...
const status = await pollTask(taskId);

// ✅ 正确：模型模糊匹配
await switchModel('glm');  // 简单记忆

// ❌ 错误：直接执行不检查
const result = await runTask('任务');  // 可能失败
```

## 🔧 调试

```bash
# 环境变量
TRAECN_LOG_LEVEL=debug
TRAECN_LOG_FORMAT=json
TRAECN_HOST=127.0.0.1
TRAECN_PORT=8788
```

```javascript
// 重置单例
const { reset } = require('traecnclaw');
reset();

// 获取实例
const { getSkill } = require('traecnclaw');
const skill = getSkill();
```

## 📦 导出

```javascript
// 默认导出 - 简单 API
const api = require('traecnclaw');
api.runTask('task');

// 命名导出
const { runTask } = require('traecnclaw');
const { TraeCNSkill } = require('traecnclaw/skill');
```

---

**提示**：在 IDE 中使用 Tab 补全函数名，节省输入时间！
// macOS unattended local service
// npm: npm run service:start
// npm: npm run service:status
// npm: npm run service:stop
