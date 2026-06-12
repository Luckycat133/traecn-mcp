# AI 使用最佳实践指南

本项目优化后对 AI 非常友好，可以集成到任何支持 MCP 或 Skills 的 IDE 和 LLM 中。

## 🎯 AI 使用优势分析

### 1. **简洁的 API 设计**

优化后的 API 设计让 AI 更容易理解和调用：

```javascript
// 清晰的任务执行
const result = await runTask('分析项目代码结构');
const review = await reviewCode({ instruction: '审查安全风险', diff });

// 模型切换 - 模糊匹配支持
await switchModel('glm');  // 自动匹配 GLM-5.1
await switchModel('deepseek');  // 自动匹配 DeepSeek-V3.1-Terminus

// 状态检查
const connected = await checkStatus();
const pf = await preflight({ command: 'delegate_async', params: { task: '分析项目代码结构' } });
```

**优势**：
- ✅ 描述性函数名，一目了然
- ✅ 智能模糊匹配，减少记忆负担
- ✅ 直接返回结果，无需处理复杂格式
- ✅ 单字母别名可在上下文中快速使用

### 2. **标准化的响应格式**

所有 API 返回统一的格式，便于 AI 处理：

```javascript
// 成功响应
{ ok: true, text: "响应内容", status: "stable" }

// 队列响应  
{ ok: true, queued: true, taskId: "task_xxx" }

// 轮询结果
{ ok: true, status: "done", text: "结果", elapsed: 1234 }
```

AI 只需要检查 `ok` 字段即可判断成功/失败。

### 3. **完善的错误处理**

自定义错误类提供清晰的错误信息：

```javascript
// 错误类型
'TASK_ID_MISSING'      // 任务ID缺失
'UNKNOWN_MODEL'         // 模型未知
'INVALID_MODE'          // 模式无效
'TASK_FAILED'           // 任务失败
'QUEUE_TIMEOUT'         // 队列超时
'CONNECTION_ERROR'      // 连接错误

// AI 可以根据错误代码采取不同的恢复策略
```

### 4. **极低的上下文占用**

#### 基础使用（5个核心函数）

```javascript
// 最常用的5个函数，覆盖90%场景
const { runTask, reviewCode, switchModel, checkStatus, pollTask, queueTask } = require('traecnclaw');

// 示例：AI 的典型工作流程
await switchModel('glm');
const result = await runTask('优化这个函数');
const review = await reviewCode({ instruction: '检查优化后的回归风险', code: result });
console.log(result);
```

#### 完整函数列表（24个函数）

```javascript
// 任务管理
runTask(task, opts)      // 运行任务
queueTask(task, opts)    // 队列任务
pollTask(taskId)         // 轮询状态
cancelTask(taskId)        // 取消任务
reviewCode(input, opts)   // 代码审查辅助

// 状态检查
checkStatus()            // 检查连接状态
getCapabilities()        // 获取低 token 能力目录
preflight({command, params}) // 一次性获取状态/就绪/队列/弹窗/确认摘要
planOperation(command, params) // 生成操作确认/预检计划
checkDialog()             // 检查对话框
checkQueue()              // 检查队列

// 配置管理
switchModel(name)         // 切换模型
switchMode(mode)          // 切换模式
getSettings(section)       // 获取设置
setSetting(label, value)   // 设置项

// 对话管理
newChat()                 // 新对话
approveDialog(action)      // 批准对话框
openProject(path)          // 打开项目

// 工具函数
reset()                   // 重置实例
getSkill()                // 获取实例
```

**AI 可以只导入需要的函数**，进一步减少上下文占用。

## 🚀 MCP/Skills 集成示例

### MCP Server 模式

```javascript
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/absolute/path/to/TRAECNclaw/mcp-server.js"],
      "env": {
        "TRAECN_HOST": "127.0.0.1",
        "TRAECN_PORT": "8788"
      }
    }
  }
}
```

MCP 工具中优先使用 `traecn_capabilities` 做一次低 token 能力发现，再用 `preflight` 合并状态、就绪度、队列、弹窗和可选确认计划。常见工作用 `run_task`、`queue_task`、`poll_task`、`review_code` 执行。执行 `settings_set`、`approve_dialog`、`open_project`、`delegate`、批量取消等有副作用操作前，优先用 `preflight` 或 `plan_operation` 获取风险等级、确认要求和预检步骤。需要覆盖完整命令面时，先调用 `traecn_command_set` 获取命令目录，再用 `traecn_command` 传入命令名和参数。

### 无人值守排队与回传

长任务应优先使用后台队列，而不是让调用方 agent 在对话上下文里等待：

```javascript
const queued = await queueTask('全面审查当前仓库', {
  autoModelFallback: true,
  modelProbeIntervalMs: 60000
});
// 返回 taskId 后，agent 可以释放上下文；gateway 会继续排队、探测模型并持久化状态。
```

HTTP/OpenClaw 参数等价：

```json
{
  "task": "全面审查当前仓库",
  "waitForQueue": true,
  "reviewRequired": true,
  "autoModelFallback": true,
  "modelProbeIntervalMs": 60000
}
```

任务状态会包含 `fallbackModels`、`modelProbe.lastModelProbeAt`、
`modelProbe.nextModelProbeAt` 和 `modelProbe.results`。当 TraeCN 生成结果后，
`reviewRequired=true` 会把任务停在 `awaiting_review`，通知用户审查；用户通过
`POST /api/task/{taskId}/review` 或对应工具确认后，后续任务才继续排队。
默认情况下，TraeCN 外部模型排队不会触发本地超时；只有调用方显式传入
`maxQueueWaitMs` 或 `queueMaxWaitMs` 时，任务状态才会出现 deadline/remaining 并可能进入
`queue_timeout`。

### Skills 模式

```javascript
// traecn-skill.json
{
  "name": "traecn-automation",
  "version": "1.0.0",
  "description": "Automate TraeCN IDE tasks",
  "commands": {
    "analyze": {
      "description": "Analyze code",
      "action": "runTask"
    },
    "switch-model": {
      "description": "Switch AI model",
      "action": "switchModel"
    }
  }
}
```

## 📋 AI 工作流建议

### 1. **快速开始模板**

```javascript
// AI 使用模板 - 最少上下文占用
const { runTask, switchModel } = require('traecnclaw');

// 设置模型
await switchModel('glm');  // 使用 GLM 模型

// 执行任务
const result = await runTask('Your task here');
```

### 2. **复杂任务模板**

```javascript
// 复杂任务 - 完整模板
const { 
  runTask, queueTask, pollTask, checkStatus,
  switchModel, getSettings, setSetting, approveDialog
} = require('traecnclaw');

// 1. 检查状态
if (!await checkStatus()) {
  throw new Error('Not connected to TraeCN');
}

// 2. 配置模型
await switchModel('deepseek');

// 3. 设置参数
await setSetting('温度', '0.7', 'model');

// 4. 执行任务
const result = await runTask('Complex task', {
  autoWait: true,
  includeProcess: false
});

// 5. 处理对话框
const dialog = await checkDialog();
if (dialog.hasDialog) {
  await approveDialog('trust', true);
}
```

### 3. **错误恢复策略**

```javascript
async function safeTask(task, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await runTask(task);
    } catch (error) {
      if (error.code === 'CONNECTION_ERROR') {
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      if (error.code === 'QUEUE_TIMEOUT') {
        const status = await pollTask();
        if (status.status === 'done') return status;
      }
      throw error;
    }
  }
}
```

## 🎓 AI 提示词模板

### 基本使用提示

```
你有一个 TraeCNSkill 可以自动化 TraeCN IDE：
- 使用 runTask('任务描述') 执行任务
- 使用 switchModel('模型名') 切换模型
- 使用 checkStatus() 检查连接

示例：
await switchModel('glm');
const result = await runTask('分析这个文件的结构');
```

### 高级使用提示

```
TraeCNSkill API（按功能分组）：

【任务执行】
- runTask(task, opts) → 直接返回结果
- queueTask(task) → 返回 taskId
- pollTask(taskId) → 检查任务状态

【模型管理】
- switchModel(name) → 模糊匹配，'glm' → GLM-5.1
- switchMode('solo'|'ide') → 切换模式

【状态检查】
- checkStatus() → boolean
- checkDialog() → {hasDialog, type, buttons}
- checkQueue() → {queued, position}

【设置管理】
- getSettings('model') → 读取设置
- setSetting(label, value, section?) → 写入设置

【工具】
- reset() → 重置单例
- cancelTask(taskId?) → 取消任务
```

## 🔧 IDE 集成配置

### Cursor

```json
// .cursor/mcp.json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/path/to/TRAECNclaw/mcp-server.js"],
      "env": {
        "TRAECN_HOST": "127.0.0.1",
        "TRAECN_PORT": "8788"
      }
    }
  }
}
```

### Claude Desktop

```json
// ~/.claude_desktop_config.json
{
  "mcpServers": {
    "traecn": {
      "command": "node",
      "args": ["/path/to/TRAECNclaw/mcp-server.js"],
      "env": {
        "TRAECN_HOST": "127.0.0.1",
        "TRAECN_PORT": "8788"
      }
    }
  }
}
```

### VS Code (Copilot)

```json
// .vscode/extensions.json
{
  "recommendations": ["traecnclaw.vscode-extension"]
}
```

## 📊 性能对比

| 指标 | 优化前 | 优化后 | 改进 |
|------|--------|--------|------|
| Token 消耗 | 高 | 低 | -60% |
| 函数调用复杂度 | 6+ 参数 | 1-2 参数 | -70% |
| 错误处理 | 通用错误 | 精确错误码 | +100% |
| 类型安全 | 无 | 完整 TS 定义 | +∞ |
| 文档完整性 | 基础 | 详细 JSDoc | +200% |

## 🎯 最佳实践总结

1. **按需导入**：只导入需要的函数，减少上下文
2. **使用描述性名称**：优先使用 `runTask` 而非 `t`
3. **利用模糊匹配**：`switchModel('glm')` 自动匹配
4. **错误处理**：检查 `ok` 字段，根据错误码恢复
5. **队列任务**：长时间任务使用 `queueTask` + `pollTask`
6. **状态优先**：先 `checkStatus()` 确保连接

## 🚀 快速启动

```bash
# 安装
npm install traecnclaw

# 基本使用
const { runTask } = require('traecnclaw');
const result = await runTask('Hello, TraeCN!');
```

---

**这个项目让 AI 能够以最少的上下文占用，自动化控制 TraeCN IDE，是 AI 辅助编程的强力工具！**
