# TraeCN Skill - 精简高效 API

专为 AI 设计的 TraeCN 自动化工具，功能完整，函数名清晰易懂。

## 快速开始

### Simple API (推荐) - 描述性函数名

```javascript
const { runTask, queueTask, pollTask, checkStatus, switchModel, switchMode } = require('./src/skill/simple-api');

// 运行任务 (自动处理队列)
const result = await runTask('分析这个项目的架构');
console.log(result); // 直接返回响应文本

// 检查状态
const isConnected = await checkStatus();

// 队列任务 (异步)
const taskId = await queueTask('耗时的复杂任务');
const status = await pollTask(taskId); // 检查进度

// 切换模型
await switchModel('GLM-5.1');

// 切换模式
await switchMode('ide'); // 'solo' or 'ide'
```

### 完整 Skill API

```javascript
const { TraeCNSkill } = require('./src/skill/traecn-skill');

const skill = new TraeCNSkill(context);
const result = await skill.run('任务描述');
```

## API 参考

### Simple API (清晰易懂)

| 函数 | 说明 | 返回值 |
|------|------|--------|
| `runTask(task, opts)` | 运行任务 | string (响应文本) |
| `queueTask(task, opts)` | 队列任务 | string (taskId) |
| `pollTask(taskId?)` | 轮询状态 | object |
| `cancelTask(taskId?)` | 取消任务 | object |
| `checkStatus()` | 检查状态 | boolean |
| `switchModel(name)` | 切换模型 | object |
| `switchMode(m)` | 切换模式 | object |
| `newChat()` | 新对话 | object |
| `getSettings(sec)` | 读取设置 | object |
| `setSetting(label, val, sec)` | 设置项 | object |
| `approveDialog(action, wait)` | 批准对话框 | object |
| `checkDialog()` | 检查对话框 | object |
| `checkQueue()` | 检查队列状态 | object |
| `openProject(path)` | 打开项目 | object |
| `reset()` | 重置实例 | void |

**向后兼容性**：仍支持单字母函数别名 (`t`, `q`, `p`, `s` 等)。

### `runTask(task, opts)` 选项

```javascript
{
  projectPath: '/path/to/project',  // 项目路径
  includeProcess: false,             // 包含过程信息
  autoWait: true,                    // 自动等待队列
  mode: null                         // 切换模式 ('solo'/'ide')
}
```

### 完整 Skill API

```javascript
const skill = new TraeCNSkill(context);

// 任务管理
await skill.status(allowAutoStart?)
await skill.run(task, opts)
await skill.queue(task, opts)
await skill.poll(taskId?)
await skill.cancel(taskId?)

// 对话管理
await skill.newChat()
await skill.switchMode(mode)
await skill.switchModel(model)
await skill.openProject(path)

// 设置管理
await skill.getSettings(section?)
await skill.setSetting(label, value, section?)

// 对话框处理
await skill.approveDialog(action?, wait?)
await skill.checkDialog()
await skill.queueStatus()

// 配置
skill._sessionId           // 当前会话 ID
skill._lastTaskId          // 最后任务 ID
```

## 设计原则

### 清晰易懂
- 描述性函数名 (`runTask`, `queueTask`, `pollTask` 等)
- 简化响应格式 (直接返回字符串)
- 自动数据规范化
- 智能默认值

### 简化使用
- 自动处理队列 (autoWait)
- 智能模型匹配
- 设置别名支持
- 自动状态保存

### 错误处理
- 统一错误格式
- 清晰的错误信息
- 降级处理策略

## 可用模型

```javascript
['Doubao-Seed-2.0-Code', 'Doubao-Seed-1.8', 'GLM-5.1', 
 'DeepSeek-V3.1-Terminus', 'MiniMax-M2.7', 'MiniMax-M2.5',
 'Kimi-K2.5', 'Qwen3.6-Plus', 'Qwen3.5-Plus']
```

模糊匹配支持：`await switchModel('glm')` → 匹配 GLM-5.1

## 设置别名

```javascript
'general'    → '通用'
'account'    → '账号'
'agents'     → '智能体'
'mcp'        → 'MCP'
'flow'       → '对话流'
'cue'        → 'CUE'
'model'      → '模型'
'context'    → '上下文'
'rules'      → '规则和技能'
'beta'       → 'Beta'
'about'      → '关于 TRAE'
```

## 响应格式 (完整 Skill)

### 运行任务结果
```javascript
{
  ok: true,
  text: "AI 响应内容",
  status: "stable",     // stable | unstable
  elapsed: 1234,        // 毫秒
  process: null         // includeProcess: true 时
}
```

### 队列结果
```javascript
{
  ok: true,
  queued: true,
  taskId: "task_abc123",
  status: "queued",
  queue: {...}
}
```

### 轮询结果
```javascript
{
  ok: true,
  status: "done",  // done | queued | executing | error
  text: "...",     // status=done 时
  elapsed: 5000
}
```

## 使用示例

### 基本使用

```javascript
const { runTask, switchModel } = require('./src/skill/simple-api');

// 1. 切换到想要的模型
await switchModel('deepseek');

// 2. 执行任务 (自动处理队列)
const result = await runTask('编写一个快速排序函数');
console.log(result);
```

### 队列模式

```javascript
const { queueTask, pollTask } = require('./src/skill/simple-api');

// 1. 提交队列任务
const taskId = await queueTask('耗时的代码审查任务');

// 2. 稍后轮询
const status = await pollTask(taskId);
if (status.status === 'done') {
  console.log(status.text);
}
```

### 项目工作流

```javascript
const { runTask, openProject, switchModel, switchMode } = require('./src/skill/simple-api');

// 打开项目
await openProject('/workspace/my-project');

// 切换到 IDE 模式
await switchMode('ide');

// 运行任务
const result = await runTask('分析项目结构并提出优化建议', {
  projectPath: '/workspace/my-project'
});
```

### 设置管理

```javascript
const { getSettings, setSetting } = require('./src/skill/simple-api');

// 读取模型设置
const modelSettings = await getSettings('model');

// 更新设置
await setSetting('Agent 名', '代码助手', 'agents');
```

### 对话框处理

```javascript
const { approveDialog, checkDialog } = require('./src/skill/simple-api');

// 检查是否有对话框
const hasDialog = await checkDialog();
if (hasDialog.hasDialog) {
  await approveDialog('trust'); // 自动信任
}

// 或等待并自动批准
await approveDialog('auto', true);
```

## 导出

### 完整导出
```javascript
const {
  runTask, queueTask, pollTask, cancelTask,
  checkStatus, switchModel, switchMode,
  newChat, getSettings, setSetting,
  approveDialog, checkDialog, checkQueue, openProject,
  reset, getSkill, TraeCNSkill,
  // 单字母别名 (向后兼容)
  t, q, p, s, model, mode, settings, set,
  approve, dialog, queueCheck, open, cancel
} = require('./src/skill/simple-api');
```

### Skill 模块
```javascript
const { TraeCNSkill, KNOWN_MODELS, SETTINGS_SECTIONS } = require('./src/skill/traecn-skill');
```

## 对比

| 特性 | 原始 API | Skill API | Simple API |
|------|----------|-----------|------------|
| 函数名 | `delegate` | `run` | `runTask` |
| 参数数 | 6+ | 2 | 1-2 |
| 响应格式 | 复杂对象 | 标准化对象 | 纯文本 |
| 队列处理 | 手动 | 自动 | 自动 |
| 可理解性 | 低 | 中 | 高 |

选择建议：
- **Simple API**: 90% 的场景，最易用
- **Skill API**: 需要更多控制时
- **原始 API**: 向后兼容

---
