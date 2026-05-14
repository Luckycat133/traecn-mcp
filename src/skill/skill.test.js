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
  const expected = ['Doubao-Seed-2.0-Code', 'GLM-5.1', 'DeepSeek-V3.1-Terminus'];
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
  expect(typeof api.cancelTask).toBe('function');
  expect(typeof api.checkStatus).toBe('function');
  expect(typeof api.switchModel).toBe('function');
  expect(typeof api.switchMode).toBe('function');
  expect(typeof api.newChat).toBe('function');
  expect(typeof api.getSettings).toBe('function');
  expect(typeof api.setSetting).toBe('function');
  expect(typeof api.approveDialog).toBe('function');
  expect(typeof api.checkDialog).toBe('function');
  expect(typeof api.checkQueue).toBe('function');
  expect(typeof api.openProject).toBe('function');
  expect(typeof api.reset).toBe('function');
  expect(typeof api.getSkill).toBe('function');
  expect(typeof api.TraeCNSkill).toBe('function');
  // 单字母别名 (兼容旧代码)
  expect(typeof api.t).toBe('function');
  expect(typeof api.q).toBe('function');
  expect(typeof api.p).toBe('function');
  expect(typeof api.s).toBe('function');
  expect(typeof api.model).toBe('function');
  expect(typeof api.mode).toBe('function');
  expect(typeof api.settings).toBe('function');
  expect(typeof api.set).toBe('function');
  expect(typeof api.approve).toBe('function');
  expect(typeof api.dialog).toBe('function');
  expect(typeof api.queueCheck).toBe('function');
  expect(typeof api.open).toBe('function');
  expect(typeof api.cancel).toBe('function');
});

test('_normalizeModel should match known models', () => {
  const { TraeCNSkill } = require('./traecn-skill');
  const skill = new TraeCNSkill();
  
  expect(skill._normalizeModel('glm')).toBe('GLM-5.1');
  expect(skill._normalizeModel('deepseek')).toBe('DeepSeek-V3.1-Terminus');
  expect(skill._normalizeModel('doubao')).toBe('Doubao-Seed-2.0-Code');
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
