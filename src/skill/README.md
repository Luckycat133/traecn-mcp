# TraeCN Skill — Programmatic JS API

A token-efficient JavaScript wrapper around the TRAECNclaw HTTP gateway, designed for embedding in Node scripts, plugins, and test runners. For the agent-facing Trae skill (MCP server usage, the frozen 20-tool contract, and safety rules), see [`skills/traecnclaw-mcp/SKILL.md`](../../skills/traecnclaw-mcp/SKILL.md).

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

## Skill progression

The API is designed for progressive adoption — start with 2 functions and expand as your workflow demands more autonomy.

| Tier | Functions to learn | Calls per session | Typical latency | What you can do |
| --- | --- | ---: | --- | --- |
| **基础** | `runTask`, `queueTask`, `pollTask`, `waitTask`, `cancelTask` | 2–5 | 10–30s / task | Single-task execution and queue management |
| **进阶** | + `switchModel`, `switchMode`, `getSettings`, `setSetting`, `reviewCode`, `approveDialog` | 5–15 | 15–45s / cycle | Environment control, code review, dialog handling |
| **专家** | + `vibeWorkflow`, `preflight`, `planOperation`, `batch.runTasks` | 1–3 | 2–10min / pipeline | Unattended multi-step workflows, batch processing |

Start at **基础** and advance only when you need more automation. The `simple-api` entry point covers tiers 基础 and 进阶; `./advanced` unlocks 专家-tier batch and workflow operations.

## Patterns

### Synchronous run — 基础

```javascript
const { runTask } = require('./src/skill/simple-api');
const text = await runTask('编写一个快速排序函数', { projectPath: '/workspace/my-project' });
```

### Async queue + local wait — 基础

```javascript
const { queueTask, waitTask, pollTask } = require('./src/skill/simple-api');

const taskId = await queueTask('耗时的代码审查任务');
const result = await waitTask(taskId, { pollMs: 30000, timeoutMs: 0 });  // blocks until terminal/review point
// or non-blocking:
const status = await pollTask(taskId);  // { ok, status: 'done'|'queued'|'executing'|'error', text?, elapsed? }
```

### Settings, dialogs, mode — 进阶

```javascript
const { getSettings, setSetting, approveDialog, checkDialog, switchMode } = require('./src/skill/simple-api');

const m = await getSettings('model');              // section alias supported: general|model|agents|mcp|flow|cue|context|rules|beta|about
await setSetting('温度', '0.7', 'model');

const dlg = await checkDialog();
if (dlg.hasDialog) await approveDialog('trust');

await switchMode('ide');                          // 'solo' | 'ide'
```

### Code review delegation — 进阶

```javascript
const { reviewCode } = require('./src/skill/simple-api');

const findings = await reviewCode({
  instruction: '审查 auth 模块的安全性',
  files: ['src/shared/mcp-auth.js'],
  focus: ['safety', 'tests']
});
// opts.queue=true returns a taskId instead of waiting
```

### Unattended vibe workflow — 专家

```javascript
const { vibeWorkflow } = require('./src/skill/simple-api');

const taskId = await vibeWorkflow({
  task: '修复登录页样式',
  steps: ['补充快照测试', '更新 CHANGELOG'],
  reviewRequired: true
});
```

### Preflight and operation planning — 专家

`preflight` returns a low-token readiness summary (connection, queue, dialog, optional command plan); `planOperation` returns a confirmation/risk plan without touching TraeCN. Both are safe to call before side-effecting operations.

```javascript
const { preflight, planOperation } = require('./src/skill/simple-api');

const ready = await preflight({ command: 'delegate', params: { task: '重构模块' } });
if (!ready.canDelegate) console.log('下一步:', ready.nextAction);

const plan = await planOperation('delegate', { task: '重构模块' });
if (plan.requiresConfirmation) console.log('风险:', plan.risk, '副作用:', plan.sideEffects);
```

### Batch operations — 专家

The `batch` layer (exposed via `./advanced`) runs multiple tasks with per-task error isolation — one failure does not abort the batch.

```javascript
const { batch } = require('./src/skill/index');

const results = await batch.runTasks(['分析 a.js', '分析 b.js', '分析 c.js'], { projectPath: '/p' });
// => [{ task, result, success }, { task, error, success }, ...]

const queued = await batch.queueTasks(tasks);      // returns [{ task, taskId, success }]
const polled = await batch.pollTasks([taskIdA, taskIdB]); // returns [{ taskId, result, success }]
```

## Option surface

`runTask(task, opts)` / `queueTask(task, opts)` accept (see `RunTaskOptions` in `traecn-skill.d.ts` for the full list):

- `projectPath`, `mode` (`'solo'`/`'ide'`), `autoWait` (default `true`)
- `includeProcess`, `reviewRequired`, `autoContinue`, `followupTasks`, `completionChecks`
- `autoApproveDialog`, `notifyUrl`, `fallbackModels`, `autoModelFallback`, `modelProbeIntervalMs`
- `waitForQueue`, `background`, `forceBackground`, `maxQueueWaitMs` (queue only)
- `pollMaxAttempts`, `pollIntervalMs` — override `_delegateWithPoll` defaults (40 attempts × 5000 ms) when `autoWait` is true
- Solo targeting: `soloChat`, `soloChatIndex`, `soloChatTitleIncludes`, `soloChatTextIncludes`, `newChat`

Model and section names support fuzzy/alias matching via `KNOWN_MODELS` and `SETTINGS_SECTIONS` (re-exported from `traecn-skill.js`). Model matching prefers exact (case-insensitive) → prefix → substring, returning the first match in `KNOWN_MODELS` order.

## Error handling

Errors are wrapped in `TraeCNSkillError` with stable codes. The basic/advanced/config/dialog layers preserve `TraeCNSkillError` thrown by the underlying class, so callers always see the original code rather than a re-wrapped `TASK_FAILED`.

| Code | When | Recovery hint |
| --- | --- | --- |
| `TASK_ID_MISSING` | `poll`/`wait`/`cancel` called without a taskId and no prior `run`/`queue` | Call `run`/`queue` first, or pass an explicit `taskId` |
| `UNKNOWN_MODEL` | `switchModel` cannot resolve the name | Inspect `error.details.availableModels` |
| `INVALID_MODE` | `switchMode` receives a value other than `solo`/`ide` | Use `'solo'` or `'ide'` |
| `TASK_FAILED` | Underlying delegate/queue call rejected, or `run` returned `result.error` | Inspect `error.details` and `error.message` |
| `QUEUE_TIMEOUT` | `_delegateWithPoll` exhausted `pollMaxAttempts` | Increase `pollMaxAttempts`/`pollIntervalMs`, or poll manually |
| `CONNECTION_ERROR` | Gateway/TraeCN unreachable | Run `npm run doctor` |

Inspect `error.code` and `error.details` for recovery.

## API comparison

| Aspect | Raw gateway API | `TraeCNSkill` class | `simple-api` flat |
| --- | --- | --- | --- |
| Function name | `delegate` | `run` | `runTask` |
| Args | 6+ | 2 | 1–2 |
| Response | Raw object | Normalized object | Plain text / taskId |
| Queue handling | Manual | Auto | Auto |
| Use when | Backwards compat | Need instance state | Most call sites |
