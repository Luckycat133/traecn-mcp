# TraeCN Skill — Programmatic JS API

A token-efficient JavaScript wrapper around the TRAECNclaw HTTP gateway, designed for embedding in Node scripts, plugins, and test runners. For the agent-facing Trae skill (MCP server usage, tool profiles, safety rules), see [`skills/traecnclaw-mcp/SKILL.md`](../../skills/traecnclaw-mcp/SKILL.md).

Full TypeScript surface lives in [`simple-api.d.ts`](./simple-api.d.ts) and [`traecn-skill.d.ts`](./traecn-skill.d.ts). This README only shows usage patterns and layering.

## Quick start

```javascript
const { runTask, queueTask, pollTask, switchModel, checkStatus } = require('./src/skill/simple-api');

if (!await checkStatus()) throw new Error('TraeCN not connected');
await switchModel('glm');                              // fuzzy match → GLM-5.2
const result = await runTask('分析这个项目的架构');     // returns response text
```

## Layered entry points

| Entry | Path | Use when |
| --- | --- | --- |
| `./simple-api` | `simple-api.js` | 90% of cases; flat function exports (`runTask`, `queueTask`, …) plus short aliases (`t`, `q`, `p`) |
| `./skill` (or `./`) | `traecn-skill.js` | Need the `TraeCNSkill` class instance, shared singleton, or `_sessionId`/`_lastTaskId` state |
| `./advanced` | `index.js` | Namespaced layers: `advanced`, `config`, `dialog`, `batch`, `promptLayers` |

All three share one process-wide singleton via `TraeCNSkill.getSharedInstance()`, so `reset()` in one affects the others.

## Patterns

### Synchronous run (auto-handles queue)

```javascript
const { runTask } = require('./src/skill/simple-api');
const text = await runTask('编写一个快速排序函数', { projectPath: '/workspace/my-project' });
```

### Async queue + local wait

```javascript
const { queueTask, waitTask, pollTask } = require('./src/skill/simple-api');

const taskId = await queueTask('耗时的代码审查任务');
const result = await waitTask(taskId, { pollMs: 30000, timeoutMs: 0 });  // blocks until terminal/review point
// or non-blocking:
const status = await pollTask(taskId);  // { ok, status: 'done'|'queued'|'executing'|'error', text?, elapsed? }
```

### Settings, dialogs, mode

```javascript
const { getSettings, setSetting, approveDialog, checkDialog, switchMode } = require('./src/skill/simple-api');

const m = await getSettings('model');              // section alias supported: general|model|agents|mcp|flow|cue|context|rules|beta|about
await setSetting('温度', '0.7', 'model');

const dlg = await checkDialog();
if (dlg.hasDialog) await approveDialog('trust');

await switchMode('ide');                          // 'solo' | 'ide'
```

### Code review delegation

```javascript
const { reviewCode } = require('./src/skill/simple-api');

const findings = await reviewCode({
  instruction: '审查 auth 模块的安全性',
  files: ['src/shared/mcp-auth.js'],
  focus: ['safety', 'tests']
});
// opts.queue=true returns a taskId instead of waiting
```

### Unattended vibe workflow

```javascript
const { vibeWorkflow } = require('./src/skill/simple-api');

const taskId = await vibeWorkflow({
  task: '修复登录页样式',
  steps: ['补充快照测试', '更新 CHANGELOG'],
  reviewRequired: true
});
```

## Option surface

`runTask(task, opts)` / `queueTask(task, opts)` accept (see `RunTaskOptions` in `traecn-skill.d.ts` for the full list):

- `projectPath`, `mode` (`'solo'`/`'ide'`), `autoWait` (default `true`)
- `includeProcess`, `reviewRequired`, `autoContinue`, `followupTasks`, `completionChecks`
- `autoApproveDialog`, `notifyUrl`, `fallbackModels`, `autoModelFallback`, `modelProbeIntervalMs`
- `waitForQueue`, `background`, `forceBackground`, `maxQueueWaitMs` (queue only)
- Solo targeting: `soloChat`, `soloChatIndex`, `soloChatTitleIncludes`, `soloChatTextIncludes`, `newChat`

Model and section names support fuzzy/alias matching via `KNOWN_MODELS` and `SETTINGS_SECTIONS` (re-exported from `traecn-skill.js`).

## Error handling

Errors are wrapped in `TraeCNSkillError` with stable codes: `TASK_ID_MISSING`, `UNKNOWN_MODEL`, `INVALID_MODE`, `TASK_FAILED`, `QUEUE_TIMEOUT`, `CONNECTION_ERROR`. Inspect `error.code` and `error.details` for recovery.

## API comparison

| Aspect | Raw gateway API | `TraeCNSkill` class | `simple-api` flat |
| --- | --- | --- | --- |
| Function name | `delegate` | `run` | `runTask` |
| Args | 6+ | 2 | 1–2 |
| Response | Raw object | Normalized object | Plain text / taskId |
| Queue handling | Manual | Auto | Auto |
| Use when | Backwards compat | Need instance state | Most call sites |
