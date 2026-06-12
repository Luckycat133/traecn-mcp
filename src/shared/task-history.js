'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getEnvWithFallback, parsePositiveInt } = require('./utils');

const DEFAULT_MAX_HISTORY_SIZE = parsePositiveInt(
  getEnvWithFallback('TRAECN_TASK_HISTORY_MAX_SIZE', 'TRAE_TASK_HISTORY_MAX_SIZE', '1000'),
  1000
);
const DEFAULT_RETENTION_HOURS = parsePositiveInt(
  getEnvWithFallback('TRAECN_TASK_HISTORY_RETENTION_HOURS', 'TRAE_TASK_HISTORY_RETENTION_HOURS', '168'),
  168
);
function resolveDefaultPersistencePath() {
  const configured = getEnvWithFallback(
    'TRAECN_TASK_HISTORY_PERSISTENCE_PATH',
    'TRAE_TASK_HISTORY_PERSISTENCE_PATH',
    ''
  );
  if (configured) return configured;
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'TRAECNclaw', 'task-history.json');
  }
  return path.join(os.homedir(), '.traecnclaw', 'task-history.json');
}

const DEFAULT_PERSISTENCE_PATH = resolveDefaultPersistencePath();

class TaskHistoryStore {
  constructor(options = {}) {
    this.maxSize = options.maxSize || DEFAULT_MAX_HISTORY_SIZE;
    this.retentionHours = options.retentionHours || DEFAULT_RETENTION_HOURS;
    this.persistencePath = options.persistencePath || DEFAULT_PERSISTENCE_PATH;
    this.tasks = new Map();
    this.stepCounter = 0;
    this._dirty = false;
    this._cleanupTimer = null;
    this._initPersistence();
    this._scheduleCleanup();
  }

  _initPersistence() {
    if (this.persistencePath) {
      try {
        const filePath = path.resolve(this.persistencePath);
        if (fs.existsSync(filePath)) {
          const data = fs.readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed.tasks)) {
            for (const task of parsed.tasks) {
              if (task.taskId) {
                this.tasks.set(task.taskId, task);
              }
            }
          }
        }
      } catch (e) {
        console.warn('[TaskHistory] Failed to load persistence:', e.message);
      }
    }
  }

  _persist() {
    if (!this.persistencePath || !this._dirty) return;
    try {
      const filePath = path.resolve(this.persistencePath);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        version: 1,
        savedAt: new Date().toISOString(),
        tasks: Array.from(this.tasks.values())
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
      this._dirty = false;
    } catch (e) {
      console.error('[TaskHistory] Failed to persist:', e.message);
    }
  }

  _scheduleCleanup() {
    this._cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 3600000);
    if (typeof this._cleanupTimer.unref === 'function') {
      this._cleanupTimer.unref();
    }
  }

  _stopCleanup() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  createTask(sessionId, task, options = {}) {
    const taskId = 'task_' + (++this.stepCounter) + '_' + Date.now().toString(36) + '_' + process.hrtime.bigint().toString(36);
    const createdAt = new Date();
    const sortKey = process.hrtime.bigint();
    const record = {
      taskId,
      sessionId: sessionId || null,
      task: task.substring(0, 10000),
      result: null,
      status: 'running',
      createdAt: createdAt.toISOString(),
      createdAtMs: createdAt.getTime(),
      sortKey: sortKey.toString(),
      completedAt: null,
      elapsedMs: null,
      steps: [],
      metadata: options.metadata || {}
    };
    this.tasks.set(taskId, record);
    this._dirty = true;
    this._enforceSizeLimit();
    return taskId;
  }

  ensureTask(taskId, task, options = {}) {
    if (!taskId) return null;
    const existing = this.tasks.get(taskId);
    if (existing) {
      if (options.updateExisting === true) {
        if (task !== undefined) {
          existing.task = String(task || '').substring(0, 10000);
        }
        if (options.sessionId !== undefined) existing.sessionId = options.sessionId || null;
        if (options.status !== undefined) existing.status = options.status;
        if (options.result !== undefined) existing.result = options.result;
        if (options.createdAt !== undefined) existing.createdAt = options.createdAt;
        if (options.createdAtMs !== undefined) existing.createdAtMs = options.createdAtMs;
        if (options.sortKey !== undefined) existing.sortKey = options.sortKey;
        if (options.completedAt !== undefined) existing.completedAt = options.completedAt;
        if (options.elapsedMs !== undefined) existing.elapsedMs = options.elapsedMs;
        if (Array.isArray(options.steps)) existing.steps = options.steps;
        if (options.metadata !== undefined) existing.metadata = options.metadata || {};
        this._dirty = true;
        this._enforceSizeLimit();
        this._persist();
      }
      return existing;
    }

    const createdAtMs = options.createdAtMs || Date.now();
    const createdAt = options.createdAt || new Date(createdAtMs).toISOString();
    const record = {
      taskId,
      sessionId: options.sessionId || null,
      task: String(task || '').substring(0, 10000),
      result: options.result || null,
      status: options.status || 'running',
      createdAt,
      createdAtMs,
      sortKey: options.sortKey || String(createdAtMs),
      completedAt: options.completedAt || null,
      elapsedMs: options.elapsedMs || null,
      steps: Array.isArray(options.steps) ? options.steps : [],
      metadata: options.metadata || {}
    };
    this.tasks.set(taskId, record);
    this._dirty = true;
    this._enforceSizeLimit();
    this._persist();
    return record;
  }

  syncTask(taskId, patch = {}) {
    const record = this.tasks.get(taskId);
    if (!record) return null;

    if (patch.task !== undefined) record.task = String(patch.task || '').substring(0, 10000);
    if (patch.sessionId !== undefined) record.sessionId = patch.sessionId || null;
    if (patch.status !== undefined) record.status = patch.status;
    if (patch.result !== undefined) record.result = patch.result;
    if (patch.createdAt !== undefined) record.createdAt = patch.createdAt;
    if (patch.createdAtMs !== undefined) record.createdAtMs = patch.createdAtMs;
    if (patch.sortKey !== undefined) record.sortKey = patch.sortKey;
    if (patch.completedAt !== undefined) record.completedAt = patch.completedAt;
    if (patch.elapsedMs !== undefined) record.elapsedMs = patch.elapsedMs;
    if (Array.isArray(patch.steps)) record.steps = patch.steps;
    if (patch.metadata !== undefined) record.metadata = patch.metadata || {};

    this._dirty = true;
    this._enforceSizeLimit();
    this._persist();
    return record;
  }

  recordStep(taskId, action, details = {}) {
    const record = this.tasks.get(taskId);
    if (!record) return null;

    const step = {
      stepId: record.steps.length + 1,
      action,
      timestamp: new Date().toISOString(),
      duration: details.duration || null,
      success: details.success !== false,
      error: details.error || null,
      details: details.details || {}
    };
    record.steps.push(step);
    this._dirty = true;
    return step;
  }

  completeTask(taskId, result, options = {}) {
    const record = this.tasks.get(taskId);
    if (!record) return null;

    record.status = 'completed';
    record.result = result || null;
    record.completedAt = new Date().toISOString();
    record.elapsedMs = options.elapsedMs || null;
    this._dirty = true;
    this._persist();
    return record;
  }

  failTask(taskId, error) {
    const record = this.tasks.get(taskId);
    if (!record) return null;

    record.status = 'failed';
    record.result = { error: error instanceof Error ? error.message : String(error) };
    record.completedAt = new Date().toISOString();
    this._dirty = true;
    this._persist();
    return record;
  }

  cancelTask(taskId) {
    const record = this.tasks.get(taskId);
    if (!record) return null;

    record.status = 'cancelled';
    record.completedAt = new Date().toISOString();
    this._dirty = true;
    this._persist();
    return record;
  }

  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  getHistory(options = {}) {
    const {
      page = 1,
      limit = 20,
      status = null,
      keyword = null,
      startDate = null,
      endDate = null,
      sessionId = null
    } = options;

    let results = Array.from(this.tasks.values());

    if (status) {
      results = results.filter(t => t.status === status);
    }

    if (keyword) {
      const kw = keyword.toLowerCase();
      results = results.filter(t =>
        (t.task && t.task.toLowerCase().includes(kw)) ||
        (t.result && JSON.stringify(t.result).toLowerCase().includes(kw))
      );
    }

    if (startDate) {
      const start = new Date(startDate).getTime();
      results = results.filter(t => new Date(t.createdAt).getTime() >= start);
    }

    if (endDate) {
      const end = new Date(endDate).getTime();
      results = results.filter(t => new Date(t.createdAt).getTime() <= end);
    }

    if (sessionId) {
      results = results.filter(t => t.sessionId === sessionId);
    }

    results.sort((a, b) => {
      const aKey = a.sortKey || a.createdAtMs || new Date(a.createdAt).getTime();
      const bKey = b.sortKey || b.createdAtMs || new Date(b.createdAt).getTime();
      return bKey > aKey ? 1 : bKey < aKey ? -1 : 0;
    });

    const total = results.length;
    const totalPages = Math.ceil(total / limit);
    const offset = (page - 1) * limit;
    const items = results.slice(offset, offset + limit);

    return {
      tasks: items.map(t => ({
        taskId: t.taskId,
        sessionId: t.sessionId,
        task: t.task,
        status: t.status,
        createdAt: t.createdAt,
        completedAt: t.completedAt,
        elapsedMs: t.elapsedMs,
        stepCount: t.steps.length,
        hasResult: t.result !== null
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    };
  }

  getReplay(taskId) {
    const record = this.tasks.get(taskId);
    if (!record) return null;

    return {
      taskId: record.taskId,
      sessionId: record.sessionId,
      task: record.task,
      status: record.status,
      createdAt: record.createdAt,
      completedAt: record.completedAt,
      elapsedMs: record.elapsedMs,
      result: record.result,
      steps: record.steps.map(step => ({
        action: step.action,
        timestamp: step.timestamp,
        duration: step.duration,
        success: step.success,
        error: step.error,
        details: step.details
      })),
      summary: {
        totalSteps: record.steps.length,
        successfulSteps: record.steps.filter(s => s.success).length,
        failedSteps: record.steps.filter(s => !s.success).length,
        totalDuration: record.steps.reduce((sum, s) => sum + (s.duration || 0), 0)
      }
    };
  }

  clearHistory(options = {}) {
    const { beforeDate = null, status = null, olderThanHours = null } = options;
    const hasFilters = status !== null || beforeDate !== null || olderThanHours !== null;
    let deleted = 0;

    for (const [taskId, task] of this.tasks) {
      let shouldDelete = !hasFilters;

      if (status && task.status === status) {
        shouldDelete = true;
      }

      if (beforeDate && new Date(task.createdAt) < new Date(beforeDate)) {
        shouldDelete = true;
      }

      if (olderThanHours !== null) {
        const threshold = Date.now() - (olderThanHours * 3600000);
        const createdMs = task.createdAtMs || new Date(task.createdAt).getTime();
        if (createdMs <= threshold) {
          shouldDelete = true;
        }
      }

      if (shouldDelete) {
        this.tasks.delete(taskId);
        deleted++;
      }
    }

    if (deleted > 0) {
      this._dirty = true;
      this._persist();
    }

    return { deleted };
  }

  cleanup() {
    const threshold = Date.now() - (this.retentionHours * 3600000);
    let deleted = 0;

    for (const [taskId, task] of this.tasks) {
      const createdMs = task.createdAtMs || new Date(task.createdAt).getTime();
      if (createdMs <= threshold) {
        this.tasks.delete(taskId);
        deleted++;
      }
    }

    while (this.tasks.size > this.maxSize) {
      let oldest = null;
      let oldestTime = Infinity;

      for (const [taskId, task] of this.tasks) {
        const created = task.sortKey || task.createdAtMs || new Date(task.createdAt).getTime();
        if (created < oldestTime) {
          oldestTime = created;
          oldest = taskId;
        }
      }

      if (oldest) {
        this.tasks.delete(oldest);
        deleted++;
      } else {
        break;
      }
    }

    if (deleted > 0) {
      this._dirty = true;
      this._persist();
    }

    return { deleted, currentSize: this.tasks.size, maxSize: this.maxSize };
  }

  _enforceSizeLimit() {
    while (this.tasks.size > this.maxSize) {
      let oldest = null;
      let oldestTime = Infinity;

      for (const [taskId, task] of this.tasks) {
        const created = task.createdAtMs || new Date(task.createdAt).getTime();
        if (created < oldestTime) {
          oldestTime = created;
          oldest = taskId;
        }
      }

      if (oldest) {
        this.tasks.delete(oldest);
      } else {
        break;
      }
    }
  }

  getStats() {
    const tasks = Array.from(this.tasks.values());
    const completed = tasks.filter(t => t.status === 'completed').length;
    const failed = tasks.filter(t => t.status === 'failed').length;
    const running = tasks.filter(t => t.status === 'running').length;
    const cancelled = tasks.filter(t => t.status === 'cancelled').length;
    const totalSteps = tasks.reduce((sum, t) => sum + t.steps.length, 0);

    return {
      totalTasks: tasks.length,
      byStatus: { completed, failed, running, cancelled },
      totalSteps,
      maxSize: this.maxSize,
      retentionHours: this.retentionHours,
      persistenceEnabled: !!this.persistencePath
    };
  }

  shutdown() {
    this._stopCleanup();
    this._persist();
  }
}

let _globalStore = null;

function getGlobalStore(options = {}) {
  if (!_globalStore) {
    _globalStore = new TaskHistoryStore(options);
  }
  return _globalStore;
}

function resetGlobalStore() {
  if (_globalStore) {
    _globalStore.shutdown();
    _globalStore = null;
  }
}

module.exports = { TaskHistoryStore, getGlobalStore, resetGlobalStore };
