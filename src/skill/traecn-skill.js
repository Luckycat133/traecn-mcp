'use strict';

const { TraeCNApiClient } = require('../../integrations/openclaw-traecn-plugin/lib/traecnapi-client');

const KNOWN_MODELS = [
  'Doubao-Seed-2.0-Code',
  'Doubao-Seed-1.8',
  'GLM-5.1',
  'DeepSeek-V3.1-Terminus',
  'MiniMax-M2.7',
  'MiniMax-M2.5',
  'Kimi-K2.5',
  'Qwen3.6-Plus',
  'Qwen3.5-Plus'
];

const SETTINGS_SECTIONS = {
  general: '通用',
  account: '账号',
  accounts: '账号',
  agents: '智能体',
  mcp: 'MCP',
  flow: '对话流',
  dialog: '对话流',
  cue: 'CUE',
  model: '模型',
  models: '模型',
  context: '上下文',
  rules: '规则和技能',
  skills: '规则和技能',
  beta: 'Beta',
  about: '关于 TRAE'
};

class TraeCNSkill {
  constructor(context = {}) {
    this.context = context;
    this.client = new TraeCNApiClient(context);
    this._sessionId = null;
    this._lastTaskId = null;
  }

  async status(allowAutoStart = false) {
    const result = await this.client.getStatus(allowAutoStart);
    return this._normalizeStatus(result);
  }

  async run(task, opts = {}) {
    const { projectPath, includeProcess, autoWait = true, mode = null } = opts;

    if (mode) {
      await this.switchMode(mode).catch(() => {});
    }

    if (projectPath && !this._sessionId) {
      try {
        const session = await this.client.createSession({ projectPath });
        this._sessionId = session.data?.sessionId || session.sessionId;
      } catch {
      }
    }

    let result;
    
    if (autoWait) {
      result = await this._delegateWithPoll(task, { 
        projectPath, 
        sessionId: this._sessionId, 
        includeProcess 
      });
    } else {
      result = await this.client.delegate(task, {
        projectPath,
        sessionId: this._sessionId,
        includeProcessText: includeProcess
      });
    }

    if (result.taskId) {
      this._lastTaskId = result.taskId;
    }

    return this._normalizeResult(result);
  }

  async queue(task, opts = {}) {
    const { projectPath } = opts;
    
    const result = await this.client.delegateAsync(task, {
      projectPath,
      sessionId: this._sessionId,
      waitForQueue: true
    });

    this._lastTaskId = result.taskId || result.data?.taskId;
    return this._normalizeQueueResult(result);
  }

  async poll(taskId = null) {
    const id = taskId || this._lastTaskId;
    if (!id) {
      throw new Error('No taskId available. Set taskId or call queue/run first.');
    }

    const result = await this.client.getTaskStatus(id);
    return this._normalizePollResult(result);
  }

  async cancel(taskId = null) {
    const id = taskId || this._lastTaskId;
    if (!id) {
      throw new Error('No taskId available. Set taskId or call queue/run first.');
    }

    const result = await this.client.cancelTask(id);
    return this._normalizeCancelResult(result);
  }

  async newChat() {
    const result = await this.client.newChat();
    this._sessionId = null;
    return result;
  }

  async switchMode(mode) {
    const validMode = mode.toLowerCase() === 'ide' ? 'ide' : 'solo';
    return await this.client.switchMode(validMode);
  }

  async switchModel(model) {
    const normalized = this._normalizeModel(model);
    if (!normalized) {
      return { ok: false, error: `Unknown model. Available: ${KNOWN_MODELS.join(', ')}` };
    }
    return await this.client.switchModel(normalized);
  }

  async getSettings(section = null) {
    const normalized = this._normalizeSection(section);
    const result = await this.client.settingsRead(normalized);
    return this._normalizeSettings(result);
  }

  async setSetting(label, value, section = null) {
    const normalized = this._normalizeSection(section);
    const result = await this.client.settingsWrite(normalized, { label, value });
    return this._normalizeSetResult(result);
  }

  async approveDialog(action = 'auto', wait = false) {
    if (wait) {
      await new Promise(r => setTimeout(r, 2000));
    }
    const result = await this.client.approveDialog(action);
    return this._normalizeApproveResult(result);
  }

  async checkDialog() {
    const result = await this.client.dialogStatus();
    return this._normalizeDialogStatus(result);
  }

  async queueStatus() {
    const result = await this.client.checkQueueStatus();
    return this._normalizeQueueStatus(result);
  }

  async openProject(projectPath) {
    return await this.client.openProject(projectPath);
  }

  _normalizeStatus(data) {
    const d = data.data || data;
    return {
      ok: true,
      status: d.status,
      connected: d.status === 'connected',
      version: d.version || null,
      mock: d.mockBridge || false
    };
  }

  _normalizeResult(data) {
    const d = data.data || data;
    
    if (d.status === 'queued') {
      return {
        ok: true,
        queued: true,
        taskId: d.taskId,
        status: 'queued'
      };
    }

    return {
      ok: true,
      text: d.text || '',
      status: d.stable ? 'stable' : 'unstable',
      elapsed: d.elapsedMs || 0,
      process: d.processText || null
    };
  }

  _normalizeQueueResult(data) {
    const d = data.data || data;
    return {
      ok: true,
      queued: true,
      taskId: d.taskId,
      status: d.status,
      queue: d.queueDetails || null
    };
  }

  _normalizePollResult(data) {
    const d = data.data || data;
    const status = d.status || 'queued';
    
    const result = { ok: true, status };

    if (status === 'done' && d.result) {
      result.text = d.result.text;
      result.elapsed = d.result.elapsedMs;
    }

    if (d.elapsed) {
      result.elapsed = d.elapsed;
    }

    if (d.error) {
      result.error = d.error;
      result.ok = false;
    }

    return result;
  }

  _normalizeCancelResult(data) {
    const d = data.data || data;
    return { ok: true, cancelled: true };
  }

  _normalizeSettings(data) {
    const d = data.data || data;
    return { ok: true, section: d.section || null, content: d };
  }

  _normalizeSetResult(data) {
    const d = data.data || data;
    return { ok: true, label: d.label, value: d.value };
  }

  _normalizeApproveResult(data) {
    const d = data.data || data;
    return {
      ok: true,
      success: d.success,
      action: d.action,
      clicked: d.buttonClicked || null
    };
  }

  _normalizeDialogStatus(data) {
    const d = data.data || data;
    return {
      ok: true,
      hasDialog: d.hasDialog || false,
      type: d.dialogType || null,
      question: d.question || null,
      buttons: d.buttons || []
    };
  }

  _normalizeQueueStatus(data) {
    const d = data.data || data;
    return {
      ok: true,
      queued: d.queued || false,
      position: d.position || null,
      message: d.message || null
    };
  }

  _normalizeModel(model) {
    if (!model) return null;
    const m = model.toLowerCase();
    
    for (const known of KNOWN_MODELS) {
      if (known.toLowerCase().includes(m) || m.includes(known.toLowerCase())) {
        return known;
      }
    }
    
    if (KNOWN_MODELS.includes(model)) return model;
    
    return null;
  }

  _normalizeSection(section) {
    if (!section) return null;
    return SETTINGS_SECTIONS[section.toLowerCase()] || section;
  }

  async _delegateWithPoll(task, opts) {
    const { projectPath, sessionId, includeProcess } = opts;

    let result = await this.client.delegate(task, {
      projectPath,
      sessionId,
      includeProcessText: includeProcess
    });

    const d = result.data || result;
    
    if (d.status === 'queued') {
      const taskId = d.taskId;
      const maxAttempts = 40;
      const interval = 5000;

      for (let i = 0; i < maxAttempts; i++) {
        await new Promise(r => setTimeout(r, interval));
        const poll = await this.client.getTaskStatus(taskId);
        const status = poll.data?.status || poll.status;

        if (status === 'done') {
          return poll.data?.result || poll.result || poll;
        }

        if (status === 'error' || status === 'queue_timeout' || status === 'cancelled') {
          return poll;
        }
      }

      return { status: 'queued', taskId, message: 'Still in queue. Use poll() to check.' };
    }

    return result;
  }
}

module.exports = { TraeCNSkill, KNOWN_MODELS, SETTINGS_SECTIONS };
