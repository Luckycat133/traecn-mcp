'use strict';

const assert = require('assert');

console.log('[Skill Test] Running tests...');

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function expect(value) {
  return {
    toBe(expected) {
      if (value !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
      }
    },
    toEqual(expected) {
      if (JSON.stringify(value) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`);
      }
    },
    toBeDefined() {
      if (value === undefined) {
        throw new Error('Expected value to be defined');
      }
    },
    toBeTruthy() {
      if (!value) {
        throw new Error(`Expected truthy value, got ${value}`);
      }
    },
    toContain(expected) {
      if (!value.includes(expected)) {
        throw new Error(`Expected ${JSON.stringify(value)} to contain ${JSON.stringify(expected)}`);
      }
    },
    toBeGreaterThan(expected) {
      if (value <= expected) {
        throw new Error(`Expected ${value} to be greater than ${expected}`);
      }
    },
    not: {
      toBe(expected) {
        if (value === expected) {
          throw new Error(`Expected ${JSON.stringify(value)} not to be ${JSON.stringify(expected)}`);
        }
      }
    }
  };
}

test('TraeCNSkill should export correct modules', () => {
  const { TraeCNSkill, KNOWN_MODELS, SETTINGS_SECTIONS } = require('./traecn-skill');
  expect(TraeCNSkill).toBeDefined();
  expect(typeof TraeCNSkill).toBe('function');
  expect(Array.isArray(KNOWN_MODELS)).toBeTruthy();
  expect(KNOWN_MODELS.length).toBeGreaterThan(0);
  expect(typeof SETTINGS_SECTIONS).toBe('object');
});

test('KNOWN_MODELS should contain expected models', () => {
  const { KNOWN_MODELS } = require('./traecn-skill');
  const expected = ['Doubao-Seed-2.0-Code', 'GLM-5.2', 'GLM-5.1', 'DeepSeek-V3.1-Terminus'];
  for (const model of expected) {
    expect(KNOWN_MODELS.includes(model)).toBeTruthy();
  }
});

test('SETTINGS_SECTIONS should contain expected aliases', () => {
  const { SETTINGS_SECTIONS } = require('./traecn-skill');
  expect(SETTINGS_SECTIONS['general']).toBe('通用');
  expect(SETTINGS_SECTIONS['model']).toBe('模型');
  expect(SETTINGS_SECTIONS['models']).toBe('模型');
  expect(SETTINGS_SECTIONS['agents']).toBe('智能体');
});

test('Simple API should export all functions', () => {
  const api = require('./simple-api');
  // 描述性函数名
  expect(typeof api.runTask).toBe('function');
  expect(typeof api.queueTask).toBe('function');
  expect(typeof api.pollTask).toBe('function');
  expect(typeof api.waitTask).toBe('function');
  expect(typeof api.cancelTask).toBe('function');
  expect(typeof api.checkStatus).toBe('function');
  expect(typeof api.getCapabilities).toBe('function');
  expect(typeof api.planOperation).toBe('function');
  expect(typeof api.preflight).toBe('function');
  expect(typeof api.switchModel).toBe('function');
  expect(typeof api.switchMode).toBe('function');
  expect(typeof api.newChat).toBe('function');
  expect(typeof api.listSoloChats).toBe('function');
  expect(typeof api.switchSoloChat).toBe('function');
  expect(typeof api.submitSoloChatTask).toBe('function');
  expect(typeof api.getSettings).toBe('function');
  expect(typeof api.setSetting).toBe('function');
  expect(typeof api.approveDialog).toBe('function');
  expect(typeof api.checkDialog).toBe('function');
  expect(typeof api.checkQueue).toBe('function');
  expect(typeof api.openProject).toBe('function');
  expect(typeof api.reviewCode).toBe('function');
  expect(typeof api.vibeWorkflow).toBe('function');
  expect(typeof api.reset).toBe('function');
  expect(typeof api.getSkill).toBe('function');
  expect(typeof api.TraeCNSkill).toBe('function');
  expect(typeof api.buildCodeReviewTask).toBe('function');
  // 单字母别名 (兼容旧代码)
  expect(typeof api.t).toBe('function');
  expect(typeof api.q).toBe('function');
  expect(typeof api.p).toBe('function');
  expect(typeof api.w).toBe('function');
  expect(typeof api.s).toBe('function');
  expect(typeof api.model).toBe('function');
  expect(typeof api.mode).toBe('function');
  expect(typeof api.soloChats).toBe('function');
  expect(typeof api.soloSwitch).toBe('function');
  expect(typeof api.soloSubmit).toBe('function');
  expect(typeof api.settings).toBe('function');
  expect(typeof api.set).toBe('function');
  expect(typeof api.approve).toBe('function');
  expect(typeof api.dialog).toBe('function');
  expect(typeof api.queueCheck).toBe('function');
  expect(typeof api.open).toBe('function');
  expect(typeof api.cancel).toBe('function');
  expect(typeof api.review).toBe('function');
  expect(typeof api.vibe).toBe('function');
  expect(typeof api.capabilities).toBe('function');
  expect(typeof api.plan).toBe('function');
  expect(typeof api.pf).toBe('function');
  expect(typeof api.promptLayers.composeTraeCNPrompt).toBe('function');
});

test('Advanced skill index should expose Solo chat helpers', () => {
  const skillIndex = require('./index');
  expect(typeof skillIndex.listSoloChats).toBe('function');
  expect(typeof skillIndex.switchSoloChat).toBe('function');
  expect(typeof skillIndex.submitSoloChatTask).toBe('function');
  expect(typeof skillIndex.advanced.listSoloChats).toBe('function');
  expect(typeof skillIndex.advanced.switchSoloChat).toBe('function');
  expect(typeof skillIndex.advanced.submitSoloChatTask).toBe('function');
  expect(typeof skillIndex.soloChats).toBe('function');
  expect(typeof skillIndex.soloSwitch).toBe('function');
  expect(typeof skillIndex.soloSubmit).toBe('function');
});

test('buildCodeReviewTask creates findings-first review prompt', () => {
  const { buildCodeReviewTask } = require('./review');
  const prompt = buildCodeReviewTask({
    instruction: '检查登录改动',
    files: ['src/auth.js'],
    focus: ['security'],
    diff: '+ const token = password;'
  });

  expect(prompt.includes('检查登录改动')).toBeTruthy();
  expect(prompt.includes('src/auth.js')).toBeTruthy();
  expect(prompt.includes('security')).toBeTruthy();
  expect(prompt.includes('Findings first')).toBeTruthy();
});

test('prompt layers compose commands in deterministic order', () => {
  const { composeTraeCNPrompt, PROMPT_LAYER_ORDER } = require('./prompt-layers');
  const result = composeTraeCNPrompt('delegate', {
    task: '分析项目',
    projectPath: '/tmp/project',
    waitForQueue: false
  });

  expect(result.command).toBe('delegate');
  expect(result.layerOrder).toEqual(PROMPT_LAYER_ORDER);
  expect(result.prompt.includes('## Role and Objective')).toBeTruthy();
  expect(result.prompt.includes('## User Command Payload')).toBeTruthy();
  expect(result.prompt.includes('分析项目')).toBeTruthy();
  expect(result.prompt.includes('return-queue-state-without-waiting')).toBeTruthy();
});

test('prompt layers expose MCP-compatible prompts and resources', () => {
  const {
    getMcpCapabilities,
    getMcpPrompt,
    listMcpPrompts,
    listMcpResources,
    readMcpResource
  } = require('./prompt-layers');

  const capabilities = getMcpCapabilities();
  expect(capabilities.prompts.listChanged).toBe(true);
  expect(capabilities.resources.listChanged).toBe(true);
  expect(capabilities.tools.listChanged).toBe(true);

  const prompts = listMcpPrompts();
  expect(prompts.map(prompt => prompt.name)).toContain('traecn_layered_command');

  const prompt = getMcpPrompt('traecn_layered_command', { command: 'delegate', task: '写测试' });
  expect(Array.isArray(prompt.messages)).toBeTruthy();
  expect(prompt.messages[0].content.type).toBe('text');

  const resources = listMcpResources();
  expect(resources.map(resource => resource.uri)).toContain('traecn://commands/catalog');
  const catalog = readMcpResource('traecn://commands/catalog');
  expect(catalog.mimeType).toBe('application/json');
  expect(catalog.text.includes('delegate')).toBeTruthy();
});

test('_normalizeModel should match known models', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  
  expect(skill._normalizeModel('glm')).toBe('GLM-5.2');
  expect(skill._normalizeModel('deepseek')).toBe('DeepSeek-V4-Pro');
  expect(skill._normalizeModel('deepseek-v3')).toBe('DeepSeek-V3.1-Terminus');
  expect(skill._normalizeModel('doubao')).toBe('Doubao-Seed-2.1-Pro');
  expect(skill._normalizeModel('GLM-5.2')).toBe('GLM-5.2');
  expect(skill._normalizeModel('GLM-5.1')).toBe('GLM-5.1');
  expect(skill._normalizeModel('unknown-model')).toBe(null);
  expect(skill._normalizeModel(null)).toBe(null);
});

test('switchModel should throw error for unknown model', async () => {
  const { TraeCNSkill, TraeCNSkillError } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  
  // 模拟 client 方法避免实际网络调用
  skill.client.switchModel = () => Promise.resolve({});
  
  let threw = false;
  let errorCode = null;
  try {
    await skill.switchModel('unknown-model');
  } catch (e) {
    threw = true;
    errorCode = e.code;
  }
  expect(threw).toBe(true);
  expect(errorCode).toBe('UNKNOWN_MODEL');
});

test('_normalizeSection should map aliases', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  
  expect(skill._normalizeSection('general')).toBe('通用');
  expect(skill._normalizeSection('model')).toBe('模型');
  expect(skill._normalizeSection('models')).toBe('模型');
  expect(skill._normalizeSection('agents')).toBe('智能体');
  expect(skill._normalizeSection('custom-section')).toBe('custom-section');
  expect(skill._normalizeSection(null)).toBe(null);
});

test('_normalizeStatus should create correct format', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  
  const result = skill._normalizeStatus({
    data: {
      status: 'connected',
      version: '0.2.0',
      mockBridge: false
    }
  });
  
  expect(result.ok).toBe(true);
  expect(result.status).toBe('connected');
  expect(result.connected).toBe(true);
  expect(result.version).toBe('0.2.0');
  expect(result.mock).toBe(false);
});

test('_normalizeResult should handle queued status', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  
  const result = skill._normalizeResult({
    data: {
      status: 'queued',
      taskId: 'task_123'
    }
  });
  
  expect(result.ok).toBe(true);
  expect(result.queued).toBe(true);
  expect(result.taskId).toBe('task_123');
  expect(result.status).toBe('queued');
});

test('_normalizeResult should handle completion', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  
  const result = skill._normalizeResult({
    data: {
      text: 'Hello world',
      stable: true,
      elapsedMs: 1500,
      processText: 'Thinking...'
    }
  });
  
  expect(result.ok).toBe(true);
  expect(result.text).toBe('Hello world');
  expect(result.status).toBe('stable');
  expect(result.elapsed).toBe(1500);
  expect(result.process).toBe('Thinking...');
});

test('_normalizePollResult should handle done status', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  
  const result = skill._normalizePollResult({
    data: {
      status: 'done',
      result: { text: 'Done!', elapsedMs: 3000 },
      elapsed: 3000
    }
  });
  
  expect(result.ok).toBe(true);
  expect(result.status).toBe('done');
  expect(result.text).toBe('Done!');
  expect(result.elapsed).toBe(3000);
});

test('_normalizePollResult should handle errors', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  
  const result = skill._normalizePollResult({
    data: {
      status: 'error',
      error: 'Something went wrong'
    }
  });
  
  expect(result.ok).toBe(false);
  expect(result.status).toBe('error');
  expect(result.error).toBe('Something went wrong');
});

test('wait should use local task waiter and keep last task fallback', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill._lastTaskId = 'task_wait';
  let captured = null;
  skill.client.waitForTask = async (taskId, opts) => {
    captured = { taskId, opts };
    return { taskId, status: 'done', wait: { terminal: true, timedOut: false, attempts: 1 } };
  };

  const result = await skill.wait(null, { pollMs: 1 });
  expect(result.ok).toBe(true);
  expect(result.status).toBe('done');
  expect(captured.taskId).toBe('task_wait');
  expect(captured.opts.pollMs).toBe(1);
});

test('Skill instance should initialize correctly', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill({ test: true });
  
  expect(skill.context.test).toBe(true);
  expect(skill._sessionId).toBe(null);
  expect(skill._lastTaskId).toBe(null);
  expect(skill.client).toBeDefined();
});

test('reset() should clear singleton instance', () => {
  const api = require('./simple-api');
  api.reset();
  expect(true).toBe(true); // Just verify it doesn't throw
});

test('vibeWorkflow queues unattended follow-up workflow', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let captured = null;
  skill.client.delegateAsync = async (task, opts) => {
    captured = { task, opts };
    return { data: { taskId: 'task_vibe_1', status: 'queued', queueDetails: { state: 'queued' } } };
  };

  const result = await skill.vibeWorkflow({
    task: 'Implement feature',
    projectPath: '/tmp/project',
    steps: ['Run tests', { task: 'Fix failures', reviewRequired: false }]
  });

  expect(result.taskId).toBe('task_vibe_1');
  expect(captured.task).toBe('Implement feature');
  expect(captured.opts.projectPath).toBe('/tmp/project');
  expect(captured.opts.background).toBe(true);
  expect(captured.opts.autoContinue).toBe(true);
  expect(captured.opts.autoApproveDialog).toBe('auto');
  expect(captured.opts.followupTasks.length).toBe(2);
  expect(captured.opts.followupTasks[0].autoContinue).toBe(true);
});

test('listSoloChats should forward to client', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let called = false;
  skill.client.listSoloChats = async () => {
    called = true;
    return { data: { mode: 'solo', count: 1 } };
  };

  const result = await skill.listSoloChats();
  expect(called).toBe(true);
  expect(result.data.mode).toBe('solo');
});

test('switchSoloChat should forward criteria to client', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let captured = null;
  skill.client.switchSoloChat = async (criteria) => {
    captured = criteria;
    return { data: { success: true, index: 1 } };
  };

  const result = await skill.switchSoloChat({ index: 1, textIncludes: 'Target' });
  expect(result.data.success).toBe(true);
  expect(captured.index).toBe(1);
  expect(captured.textIncludes).toBe('Target');
});

test('submitSoloChatTask should forward options to client and remember task id', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let captured = null;
  skill.client.submitSoloChatTask = async (task, opts) => {
    captured = { task, opts };
    return { data: { taskId: 'task_solo_1', status: 'executing' } };
  };

  const result = await skill.submitSoloChatTask('Build feature', { soloChatTitleIncludes: 'Feature chat' });
  expect(result.taskId).toBe('task_solo_1');
  expect(skill._lastTaskId).toBe('task_solo_1');
  expect(captured.task).toBe('Build feature');
  expect(captured.opts.soloChatTitleIncludes).toBe('Feature chat');
});

test('getSkill() should return same instance', () => {
  const { getSkill, reset } = require('./simple-api');
  const skill1 = getSkill({ id: 1 });
  const skill2 = getSkill({ id: 2 });
  expect(skill1).toBe(skill2); // Same instance
  
  reset();
  const skill3 = getSkill();
  expect(skill3 !== skill1).toBe(true); // New instance after reset
});

test('_normalizeDialogStatus should create correct format', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  
  const result = skill._normalizeDialogStatus({
    data: {
      hasDialog: true,
      dialogType: 'approval',
      question: 'Allow this action?',
      buttons: ['Approve', 'Cancel']
    }
  });
  
  expect(result.ok).toBe(true);
  expect(result.hasDialog).toBe(true);
  expect(result.type).toBe('approval');
  expect(result.question).toBe('Allow this action?');
  expect(result.buttons).toEqual(['Approve', 'Cancel']);
});

test('_normalizeQueueStatus should create correct format', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  
  const result = skill._normalizeQueueStatus({
    data: {
      queued: true,
      position: 3,
      message: 'In queue'
    }
  });
  
  expect(result.ok).toBe(true);
  expect(result.queued).toBe(true);
  expect(result.position).toBe(3);
  expect(result.message).toBe('In queue');
});

test('_normalizeApproveResult should create correct format', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  
  const result = skill._normalizeApproveResult({
    data: {
      success: true,
      action: 'trust',
      buttonClicked: 'Trust'
    }
  });
  
  expect(result.ok).toBe(true);
  expect(result.success).toBe(true);
  expect(result.action).toBe('trust');
  expect(result.clicked).toBe('Trust');
});

test('_normalizeSettings should create correct format', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  
  const result = skill._normalizeSettings({
    data: {
      section: 'general',
      content: 'settings data'
    }
  });
  
  expect(result.ok).toBe(true);
  expect(result.section).toBe('general');
});

test('_normalizeSetResult should create correct format', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  
  const result = skill._normalizeSetResult({
    data: {
      label: 'Agent 名',
      value: 'Test'
    }
  });
  
  expect(result.ok).toBe(true);
  expect(result.label).toBe('Agent 名');
  expect(result.value).toBe('Test');
});

test('_normalizeCancelResult should create correct format', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();

  const result = skill._normalizeCancelResult({ data: {} });
  expect(result.ok).toBe(true);
  expect(result.cancelled).toBe(true);
});

// ============ 核心方法: run / queue / poll / cancel / status ============

test('run with autoWait returns normalized text on direct (non-queued) result', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.delegate = async () => ({ data: { text: 'hello', stable: true, elapsedMs: 10 } });

  const result = await skill.run('do something');
  expect(result.ok).toBe(true);
  expect(result.text).toBe('hello');
  expect(result.status).toBe('stable');
});

test('run with autoWait=false calls delegate directly without polling', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let polled = false;
  skill.client.delegate = async () => ({ data: { text: 'direct', stable: true } });
  skill.client.getTaskStatus = async () => { polled = true; return {}; };

  const result = await skill.run('task', { autoWait: false });
  expect(result.text).toBe('direct');
  expect(polled).toBe(false);
});

test('run with autoWait polls queued task until done', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.delegate = async () => ({ data: { status: 'queued', taskId: 'tq1' } });
  let calls = 0;
  skill.client.getTaskStatus = async () => {
    calls += 1;
    if (calls < 3) return { data: { status: 'executing' } };
    return { data: { status: 'done', result: { text: 'finished', elapsedMs: 100 } } };
  };

  const result = await skill.run('queued task', { pollMaxAttempts: 10, pollIntervalMs: 1 });
  expect(result.text).toBe('finished');
  expect(calls).toBe(3);
  expect(skill._lastTaskId).toBe('tq1');
});

test('run with autoWait returns poll on error status', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.delegate = async () => ({ data: { status: 'queued', taskId: 'te1' } });
  skill.client.getTaskStatus = async () => ({ data: { status: 'error', error: 'boom' } });

  const result = await skill.run('failing', { pollMaxAttempts: 5, pollIntervalMs: 1 });
  // _delegateWithPoll 返回原始 poll，_normalizeResult 解包后 ok:false，保留网关状态
  expect(result.ok).toBe(false);
  expect(result.status).toBe('error');
});

test('run with autoWait throws QUEUE_TIMEOUT when attempts exhausted', async () => {
  const { TraeCNSkill, TraeCNSkillError } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.delegate = async () => ({ data: { status: 'queued', taskId: 'tt1' } });
  skill.client.getTaskStatus = async () => ({ data: { status: 'executing' } });

  let code = null;
  try {
    await skill.run('slow', { pollMaxAttempts: 2, pollIntervalMs: 1 });
  } catch (e) {
    code = e.code;
  }
  expect(code).toBe('QUEUE_TIMEOUT');
});

test('run propagates explicit failure from gateway', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.delegate = async () => ({ data: { ok: false, error: 'CDP_UNREACHABLE', status: 'failed' } });

  const result = await skill.run('broken', { autoWait: false });
  expect(result.ok).toBe(false);
  expect(result.error).toBe('CDP_UNREACHABLE');
});

test('run creates session when projectPath given and no prior sessionId', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let sessionCreated = false;
  skill.client.createSession = async () => { sessionCreated = true; return { data: { sessionId: 'sess-1' } }; };
  skill.client.delegate = async (_t, opts) => ({ data: { text: 'ok', stable: true, sessionId: opts.sessionId } });

  await skill.run('task', { projectPath: '/p', autoWait: false });
  expect(sessionCreated).toBe(true);
  expect(skill._sessionId).toBe('sess-1');
});

test('run with mode attempts switchMode before delegating', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let switched = null;
  skill.client.switchMode = async (m) => { switched = m; return { data: { mode: m } }; };
  skill.client.delegate = async () => ({ data: { text: 'ok', stable: true } });

  await skill.run('task', { mode: 'ide', autoWait: false });
  expect(switched).toBe('ide');
});

test('queue returns normalized queue result and remembers taskId', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.delegateAsync = async () => ({ data: { taskId: 'q1', status: 'queued', queueDetails: { state: 'queued' } } });

  const result = await skill.queue('async task');
  expect(result.ok).toBe(true);
  expect(result.queued).toBe(true);
  expect(result.taskId).toBe('q1');
  expect(skill._lastTaskId).toBe('q1');
});

test('queue propagates failure from gateway', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.delegateAsync = async () => ({ data: { ok: false, error: 'BUSY', status: 'failed' } });

  const result = await skill.queue('rejected');
  expect(result.ok).toBe(false);
  expect(result.error).toBe('BUSY');
});

test('queue forwards includeProcessText when includeProcess is true', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let captured = null;
  skill.client.delegateAsync = async (_t, opts) => { captured = opts; return { data: { taskId: 'q2', status: 'queued' } }; };

  await skill.queue('task', { includeProcess: true });
  expect(captured.includeProcessText).toBe(true);
});

test('poll throws TASK_ID_MISSING when no taskId and no lastTaskId', async () => {
  const { TraeCNSkill, TraeCNSkillError } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let code = null;
  try {
    await skill.poll();
  } catch (e) {
    code = e.code;
  }
  expect(code).toBe('TASK_ID_MISSING');
});

test('poll forwards explicit taskId to client', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let captured = null;
  skill.client.getTaskStatus = async (id) => { captured = id; return { data: { status: 'done', result: { text: 'done' } } }; };

  const result = await skill.poll('explicit-id');
  expect(captured).toBe('explicit-id');
  expect(result.status).toBe('done');
  expect(result.text).toBe('done');
});

test('cancel throws TASK_ID_MISSING when no taskId and no lastTaskId', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let code = null;
  try {
    await skill.cancel();
  } catch (e) {
    code = e.code;
  }
  expect(code).toBe('TASK_ID_MISSING');
});

test('cancel returns ok on success', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill._lastTaskId = 'c1';
  skill.client.cancelTask = async () => ({ data: {} });

  const result = await skill.cancel();
  expect(result.ok).toBe(true);
  expect(result.cancelled).toBe(true);
});

test('status returns connected state', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.getStatus = async () => ({ data: { status: 'connected', version: '1.0.0', mockBridge: false } });

  const result = await skill.status();
  expect(result.connected).toBe(true);
  expect(result.version).toBe('1.0.0');
});

test('status wraps errors as CONNECTION_ERROR', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.getStatus = async () => { throw new Error('refused'); };

  let code = null;
  try {
    await skill.status();
  } catch (e) {
    code = e.code;
  }
  expect(code).toBe('CONNECTION_ERROR');
});

test('getCapabilities forwards to client and unwraps data', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.getCapabilities = async () => ({ data: { tools: ['a', 'b'] } });

  const result = await skill.getCapabilities();
  expect(result.tools).toEqual(['a', 'b']);
});

test('planOperation forwards to client', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.createConfirmationPlan = async () => ({ data: { command: 'delegate', risk: 'low' } });

  const result = await skill.planOperation('delegate', { task: 'x' });
  expect(result.risk).toBe('low');
});

test('preflight forwards to client', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.preflight = async () => ({ data: { connected: true, ready: true, canDelegate: true, nextAction: 'delegate' } });

  const result = await skill.preflight();
  expect(result.canDelegate).toBe(true);
});

test('newChat resets sessionId', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill._sessionId = 'old';
  skill.client.newChat = async () => ({ data: { ok: true } });

  await skill.newChat();
  expect(skill._sessionId).toBe(null);
});

test('switchMode accepts ide and solo case-insensitively', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  const seen = [];
  skill.client.switchMode = async (m) => { seen.push(m); return { data: { mode: m } }; };

  await skill.switchMode('IDE');
  await skill.switchMode('Solo');
  expect(seen).toEqual(['ide', 'solo']);
});

test('switchMode throws INVALID_MODE for bad input', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let code = null;
  try {
    await skill.switchMode('agent');
  } catch (e) {
    code = e.code;
  }
  expect(code).toBe('INVALID_MODE');
});

test('switchModel forwards normalized model on success', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let captured = null;
  skill.client.switchModel = async (m) => { captured = m; return { data: { model: m } }; };

  await skill.switchModel('glm');
  expect(captured).toBe('GLM-5.2');
});

test('getSettings forwards normalized section', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let captured = null;
  skill.client.settingsRead = async (s) => { captured = s; return { data: { section: s } }; };

  await skill.getSettings('model');
  expect(captured).toBe('模型');
});

test('setSetting forwards label/value/section', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let captured = null;
  skill.client.settingsWrite = async (section, payload) => { captured = { section, payload }; return { data: payload }; };

  const result = await skill.setSetting('温度', '0.7', 'model');
  expect(captured.section).toBe('模型');
  expect(captured.payload.label).toBe('温度');
  expect(result.value).toBe('0.7');
});

test('approveDialog waits when wait=true', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let elapsed = 0;
  let start = Date.now();
  skill.client.approveDialog = async () => { elapsed = Date.now() - start; return { data: { success: true, action: 'trust', buttonClicked: 'Trust' } }; };

  await skill.approveDialog('trust', true);
  expect(elapsed >= 1900).toBe(true); // ~2000ms sleep
});

test('checkDialog forwards to client.dialogStatus', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.dialogStatus = async () => ({ data: { hasDialog: true, dialogType: 'approval', question: 'ok?', buttons: ['Trust'] } });

  const result = await skill.checkDialog();
  expect(result.hasDialog).toBe(true);
  expect(result.type).toBe('approval');
});

test('queueStatus forwards to client.checkQueueStatus', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.checkQueueStatus = async () => ({ data: { queued: true, position: 2, message: 'waiting' } });

  const result = await skill.queueStatus();
  expect(result.position).toBe(2);
});

test('openProject forwards to client', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let captured = null;
  skill.client.openProject = async (p) => { captured = p; return { data: { ok: true } }; };

  await skill.openProject('/path/to/proj');
  expect(captured).toBe('/path/to/proj');
});

test('reviewCode sync path calls run with built task', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  let captured = null;
  skill.client.delegate = async (task) => { captured = task; return { data: { text: 'review done', stable: true } }; };

  const result = await skill.reviewCode({ instruction: '审查', files: ['a.js'] });
  expect(result.text).toBe('review done');
  expect(captured.includes('审查')).toBe(true);
  expect(captured.includes('a.js')).toBe(true);
});

test('reviewCode queue path returns queue result', async () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  skill.client.delegateAsync = async () => ({ data: { taskId: 'rev1', status: 'queued' } });

  const result = await skill.reviewCode('审查 diff', { queue: true });
  expect(result.taskId).toBe('rev1');
});

test('_normalizeQueueResult propagates failure', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  const result = skill._normalizeQueueResult({ data: { ok: false, error: 'REJECTED', status: 'failed' } });
  expect(result.ok).toBe(false);
  expect(result.error).toBe('REJECTED');
});

// ============ index.js 错误映射与分层 ============

test('index runTask throws TASK_FAILED when result.error is set', async () => {
  const idx = require('./index');
  // 临时替换单例的 run 行为
  const skill = idx.getSkill();
  const origRun = skill.run.bind(skill);
  skill.run = async () => ({ ok: false, error: 'DELEGATE_FAILED' });
  let code = null;
  try {
    await idx.runTask('broken');
  } catch (e) {
    code = e.code;
  }
  skill.run = origRun;
  expect(code).toBe('TASK_FAILED');
});

test('index cancelTask preserves TASK_ID_MISSING from class', async () => {
  const idx = require('./index');
  let code = null;
  try {
    await idx.advanced.cancelTask();
  } catch (e) {
    code = e.code;
  }
  expect(code).toBe('TASK_ID_MISSING');
});

test('index switchMode preserves INVALID_MODE from class', async () => {
  const idx = require('./index');
  let code = null;
  try {
    await idx.advanced.switchMode('bogus');
  } catch (e) {
    code = e.code;
  }
  expect(code).toBe('INVALID_MODE');
});

test('index pollTask preserves TASK_ID_MISSING', async () => {
  const idx = require('./index');
  idx.reset(); // 确保无 _lastTaskId
  let code = null;
  try {
    await idx.pollTask();
  } catch (e) {
    code = e.code;
  }
  expect(code).toBe('TASK_ID_MISSING');
});

test('index checkStatus returns false on connection error', async () => {
  const idx = require('./index');
  const skill = idx.getSkill();
  const origStatus = skill.status.bind(skill);
  skill.status = async () => { throw new Error('down'); };
  const result = await idx.checkStatus();
  skill.status = origStatus;
  expect(result).toBe(false);
});

test('index batch.runTasks isolates per-task failures', async () => {
  const idx = require('./index');
  const skill = idx.getSkill();
  const origRun = skill.run.bind(skill);
  let n = 0;
  skill.run = async (task) => {
    n += 1;
    if (n === 2) throw new Error('second fails');
    return { ok: true, text: `ok-${task}` };
  };
  const results = await idx.batch.runTasks(['a', 'b', 'c']);
  skill.run = origRun;
  expect(results.length).toBe(3);
  expect(results[0].success).toBe(true);
  expect(results[1].success).toBe(false);
  expect(results[1].error.includes('second fails')).toBe(true);
  expect(results[2].success).toBe(true);
});

test('index batch.queueTasks isolates per-task failures', async () => {
  const idx = require('./index');
  const skill = idx.getSkill();
  const origQueue = skill.queue.bind(skill);
  let n = 0;
  skill.queue = async (task) => {
    n += 1;
    if (task === 'bad') throw new Error('rejected');
    return { ok: true, queued: true, taskId: `id-${task}` };
  };
  const results = await idx.batch.queueTasks(['good', 'bad']);
  skill.queue = origQueue;
  expect(results[0].success).toBe(true);
  expect(results[0].taskId).toBe('id-good');
  expect(results[1].success).toBe(false);
});

test('index batch.pollTasks isolates per-task failures', async () => {
  const idx = require('./index');
  const skill = idx.getSkill();
  const origPoll = skill.poll.bind(skill);
  skill.poll = async (taskId) => {
    if (taskId === 'dead') throw new Error('not found');
    return { ok: true, status: 'done', text: 'ok' };
  };
  const results = await idx.batch.pollTasks(['live', 'dead']);
  skill.poll = origPoll;
  expect(results[0].success).toBe(true);
  expect(results[1].success).toBe(false);
});

// ============ errors.js 工厂 ============

test('errors taskIdMissing returns TASK_ID_MISSING code', () => {
  const { TraeCNSkillError } = require('./errors');
  const e = TraeCNSkillError.taskIdMissing();
  expect(e.code).toBe('TASK_ID_MISSING');
  expect(e.name).toBe('TraeCNSkillError');
});

test('errors unknownModel includes available models in details', () => {
  const { TraeCNSkillError } = require('./errors');
  const e = TraeCNSkillError.unknownModel('foo', ['A', 'B']);
  expect(e.code).toBe('UNKNOWN_MODEL');
  expect(e.details.availableModels).toEqual(['A', 'B']);
  expect(e.message.includes('A')).toBe(true);
});

test('errors invalidMode includes valid modes', () => {
  const { TraeCNSkillError } = require('./errors');
  const e = TraeCNSkillError.invalidMode('agent', ['solo', 'ide']);
  expect(e.code).toBe('INVALID_MODE');
  expect(e.details.validModes).toEqual(['solo', 'ide']);
});

test('errors taskFailed extracts message from Error cause', () => {
  const { TraeCNSkillError } = require('./errors');
  const e = TraeCNSkillError.taskFailed(new Error('network down'), { task: 'x' });
  expect(e.code).toBe('TASK_FAILED');
  expect(e.message.includes('network down')).toBe(true);
  expect(e.message.includes('Error:')).toBe(false); // 不应出现 "Error:" 前缀
  expect(e.details.task).toBe('x');
  expect(e.details.cause instanceof Error).toBe(true);
});

test('errors taskFailed handles string cause', () => {
  const { TraeCNSkillError } = require('./errors');
  const e = TraeCNSkillError.taskFailed('timeout', {});
  expect(e.message.includes('timeout')).toBe(true);
});

test('errors queueTimeout carries taskId and attempts', () => {
  const { TraeCNSkillError } = require('./errors');
  const e = TraeCNSkillError.queueTimeout('t-1', 40);
  expect(e.code).toBe('QUEUE_TIMEOUT');
  expect(e.details.taskId).toBe('t-1');
  expect(e.details.attempts).toBe(40);
});

test('errors connectionError extracts message from Error cause', () => {
  const { TraeCNSkillError } = require('./errors');
  const e = TraeCNSkillError.connectionError(new Error('ECONNREFUSED'));
  expect(e.code).toBe('CONNECTION_ERROR');
  expect(e.message.includes('ECONNREFUSED')).toBe(true);
  expect(e.details.cause).toBe('ECONNREFUSED');
});

// ============ review.js 边界 ============

test('buildCodeReviewTask uses longer fence when content contains backticks', () => {
  const { buildCodeReviewTask } = require('./review');
  const nasty = 'const x = 1;\n```\ninjected\n```\nconst y = 2;';
  const prompt = buildCodeReviewTask({ instruction: '审', code: nasty });
  // 内容中的 ``` (3) 应被更长的围栏包裹（至少 4 个反引号）
  expect(prompt.includes('````\nconst x = 1;')).toBe(true);
  // 围栏在内容结束后闭合
  expect(prompt.includes('const y = 2;\n````')).toBe(true);
});

test('buildCodeReviewTask handles string input directly', () => {
  const { buildCodeReviewTask } = require('./review');
  const prompt = buildCodeReviewTask('快速审查这个改动');
  expect(prompt.includes('快速审查这个改动')).toBe(true);
});

test('buildCodeReviewTask supports diff-only input', () => {
  const { buildCodeReviewTask } = require('./review');
  const prompt = buildCodeReviewTask({ instruction: '审查 diff', diff: '+ added line' });
  expect(prompt.includes('待审查 diff:')).toBe(true);
  expect(prompt.includes('+ added line')).toBe(true);
  expect(prompt.includes('待审查代码:')).toBe(false);
});

test('buildCodeReviewTask uses default instruction when none provided', () => {
  const { buildCodeReviewTask } = require('./review');
  const prompt = buildCodeReviewTask({});
  expect(prompt.includes('Review the supplied code or diff.')).toBe(true);
});

// ============ prompt-layers.js 剩余路径 ============

test('prompt layers getMcpPrompt skill authoring builds messages', () => {
  const { getMcpPrompt } = require('./prompt-layers');
  const result = getMcpPrompt('traecn_skill_authoring', { skillName: 'my-skill', capability: 'lint' });
  expect(result.messages[0].content.text.includes('my-skill')).toBe(true);
  expect(result.messages[0].content.text.includes('lint')).toBe(true);
});

test('prompt layers getMcpPrompt throws on missing command argument', () => {
  const { getMcpPrompt } = require('./prompt-layers');
  let threw = false;
  try {
    getMcpPrompt('traecn_layered_command', {});
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test('prompt layers getMcpPrompt throws on unknown prompt name', () => {
  const { getMcpPrompt } = require('./prompt-layers');
  let threw = false;
  try {
    getMcpPrompt('nope', {});
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test('prompt layers readMcpResource returns layered architecture doc', () => {
  const { readMcpResource } = require('./prompt-layers');
  const res = readMcpResource('traecn://docs/layered-architecture');
  expect(res.mimeType).toBe('text/markdown');
  expect(res.text.includes('Layer order:')).toBe(true);
});

test('prompt layers readMcpResource throws on unknown uri', () => {
  const { readMcpResource } = require('./prompt-layers');
  let threw = false;
  try {
    readMcpResource('traecn://unknown');
  } catch {
    threw = true;
  }
  expect(threw).toBe(true);
});

test('prompt layers composeTraeCNPrompt respects custom layers subset', () => {
  const { composeTraeCNPrompt } = require('./prompt-layers');
  const result = composeTraeCNPrompt('delegate', { task: 'x' }, { layers: ['identity', 'output'] });
  expect(result.layerOrder).toEqual(['identity', 'output']);
  expect(result.messages.length).toBe(2);
});

test('prompt layers getCommandProfile returns default for unknown command', () => {
  const { getCommandProfile } = require('./prompt-layers');
  const profile = getCommandProfile('totally_new');
  expect(profile.title.includes('totally_new')).toBe(true);
  expect(profile.capabilities.includes('execution')).toBe(true);
});

test('prompt layers compactJson produces compact (no pretty-print) output', () => {
  // 通过 composeTraeCNPrompt 的 Context 段间接验证 compactJson 不含多余空格
  const { composeTraeCNPrompt } = require('./prompt-layers');
  const result = composeTraeCNPrompt('delegate', { task: 'x', projectPath: '/p' });
  // 紧凑 JSON 不应有 ": " 形式的键值间距（pretty 才有）
  expect(result.prompt.includes('"projectPath": "/p"')).toBe(false);
});

async function runTests() {
  console.log(`[Skill Test] Found ${tests.length} tests`);
  
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.message}`);
      failed++;
    }
  }
  
  console.log(`\n[Skill Test] Results: ${passed} passed, ${failed} failed`);
  return failed === 0;
}

runTests().then(success => {
  process.exit(success ? 0 : 1);
}).catch(err => {
  console.error('[Skill Test] Fatal error:', err);
  process.exit(1);
});
