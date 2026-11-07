'use strict';

const crypto = require('crypto');
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
const TASK_HISTORY_SCHEMA_VERSION = 2;
const CHECKSUM_ALGORITHM = 'sha256';

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

function compareTaskCreation(a, b) {
  const aTime = Number.isFinite(a.createdAtMs) ? a.createdAtMs : (Date.parse(a.createdAt) || 0);
  const bTime = Number.isFinite(b.createdAtMs) ? b.createdAtMs : (Date.parse(b.createdAt) || 0);
  if (aTime !== bTime) return aTime - bTime;
  // Monotonic clocks restart with the machine and are serialized as strings.
  // Use them only to resolve ties within a wall-clock millisecond.
  const aKey = /^\d+$/.test(String(a.sortKey)) ? BigInt(a.sortKey) : 0n;
  const bKey = /^\d+$/.test(String(b.sortKey)) ? BigInt(b.sortKey) : 0n;
  return aKey < bKey ? -1 : (aKey > bKey ? 1 : 0);
}

class TaskHistoryStore {
  constructor(options = {}) {
    this.maxSize = options.maxSize ?? DEFAULT_MAX_HISTORY_SIZE;
    this.retentionHours = options.retentionHours ?? DEFAULT_RETENTION_HOURS;
    this.persistencePath = options.persistencePath || DEFAULT_PERSISTENCE_PATH;
    this.logger = options.logger || console;
    this.onWritePhase = typeof options.onWritePhase === 'function' ? options.onWritePhase : null;
    this.tasks = new Map();
    this.stepCounter = 0;
    this._dirty = false;
    this._cleanupTimer = null;
    this._persistTimer = null;
    this._persistDebounceMs = options.persistDebounceMs || 100;
    this.historyStoreWritable = null;
    this.lastSuccessfulPersistAt = null;
    this.lastPersistError = null;
    this.lastLoadError = null;
    this.lastRecovery = null;
    this._initPersistence();
    this._scheduleCleanup();
  }

  _initPersistence() {
    if (!this.persistencePath) return;
    const primaryPath = path.resolve(this.persistencePath);
    const backupPath = `${primaryPath}.bak`;
    const tempPath = `${primaryPath}.tmp`;

    const primary = this._loadCandidate(primaryPath, 'primary');
    if (primary) {
      this._applyDocument(primary.document);
      this._removeIfExists(tempPath);
      this._removeIfExists(`${backupPath}.tmp`);
      if (primary.legacy) this._rewriteRecoveredSnapshot('legacy');
      return;
    }

    const backup = this._loadCandidate(backupPath, 'backup');
    if (backup) {
      this._applyDocument(backup.document);
      this._removeIfExists(tempPath);
      this._removeIfExists(`${backupPath}.tmp`);
      this._rewriteRecoveredSnapshot('backup');
      return;
    }

    const temp = this._loadCandidate(tempPath, 'temp');
    if (temp) {
      this._applyDocument(temp.document);
      this._removeIfExists(tempPath);
      this._removeIfExists(`${backupPath}.tmp`);
      this._rewriteRecoveredSnapshot('temp');
      return;
    }

    this._removeIfExists(`${backupPath}.tmp`);
  }

  /**
   * Mark the store dirty and schedule a debounced write. Multiple rapid
   * mutations (e.g. completing several tasks in a batch) coalesce into a
   * single disk write instead of blocking the event loop on each call.
   * Use {@link _persistNow} for an immediate synchronous write (e.g. shutdown).
   */
  _persist() {
    if (!this.persistencePath) return;
    this._dirty = true;
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._persistNow();
    }, this._persistDebounceMs);
    if (typeof this._persistTimer.unref === 'function') {
      this._persistTimer.unref();
    }
  }

  /**
   * Synchronously write the current state to disk if there are unsaved
   * changes. Called by the debounced timer and by {@link shutdown}.
   */
  _persistNow() {
    if (!this.persistencePath || !this._dirty) return true;
    const primaryPath = path.resolve(this.persistencePath);
    const tempPath = `${primaryPath}.tmp`;
    const backupPath = `${primaryPath}.bak`;
    const backupTempPath = `${backupPath}.tmp`;
    const dirPath = path.dirname(primaryPath);

    try {
      const serialized = `${JSON.stringify(this._createDocument(), null, 2)}\n`;
      fs.mkdirSync(dirPath, { recursive: true });
      this._removeIfExists(tempPath);
      this._removeIfExists(backupTempPath);
      this._writeDurableTemp(tempPath, serialized);

      if (fs.existsSync(primaryPath)) {
        const current = this._readCandidate(primaryPath);
        if (current.ok) {
          this._copyDurable(primaryPath, backupTempPath);
          fs.renameSync(backupTempPath, backupPath);
          this._fsyncDirectory(dirPath);
          this._emitWritePhase('backup_committed');
        } else {
          this._quarantine(primaryPath, current.error);
        }
      }

      fs.renameSync(tempPath, primaryPath);
      this._emitWritePhase('primary_committed');
      this._fsyncDirectory(dirPath);
      this._emitWritePhase('directory_fsynced');
      this._removeIfExists(backupTempPath);
      this._dirty = false;
      this.historyStoreWritable = true;
      this.lastSuccessfulPersistAt = new Date().toISOString();
      this.lastPersistError = null;
      this.lastLoadError = null;
      return true;
    } catch (error) {
      this.logger.error('[TaskHistory] Failed to persist:', error.message);
      this._recordWriteFailure(error);
      return false;
    }
  }

  getHealth() {
    return {
      persistenceEnabled: Boolean(this.persistencePath),
      historyStoreWritable: this.historyStoreWritable,
      lastSuccessfulPersistAt: this.lastSuccessfulPersistAt,
      lastPersistError: this.lastPersistError ? { ...this.lastPersistError } : null,
      lastLoadError: this.lastLoadError ? { ...this.lastLoadError } : null,
      lastRecovery: this.lastRecovery ? { ...this.lastRecovery } : null,
      durabilityDegraded: this.historyStoreWritable === false
        || (this.lastLoadError !== null && this.lastRecovery === null)
    };
  }

  _createDocument() {
    const payload = {
      schemaVersion: TASK_HISTORY_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      tasks: Array.from(this.tasks.values())
    };
    return {
      ...payload,
      checksum: {
        algorithm: CHECKSUM_ALGORITHM,
        digest: this._checksum(payload)
      }
    };
  }

  _applyDocument(document = {}) {
    this.tasks.clear();
    for (const task of document.tasks || []) {
      if (task && task.taskId) this.tasks.set(task.taskId, task);
    }
  }

  _loadCandidate(filePath, source) {
    if (!fs.existsSync(filePath)) return null;
    const candidate = this._readCandidate(filePath);
    if (candidate.ok) return candidate;
    this.lastLoadError = {
      source,
      message: candidate.error,
      at: new Date().toISOString()
    };
    this._quarantine(filePath, candidate.error);
    return null;
  }

  _readCandidate(filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && parsed.version === 1 && Array.isArray(parsed.tasks)) {
        return { ok: true, document: parsed, legacy: true };
      }
      if (!parsed || parsed.schemaVersion !== TASK_HISTORY_SCHEMA_VERSION || !Array.isArray(parsed.tasks)) {
        return { ok: false, error: `unsupported task-history schema in ${path.basename(filePath)}` };
      }
      if (parsed.checksum?.algorithm !== CHECKSUM_ALGORITHM || typeof parsed.checksum?.digest !== 'string') {
        return { ok: false, error: `missing ${CHECKSUM_ALGORITHM} checksum in ${path.basename(filePath)}` };
      }
      const payload = {
        schemaVersion: parsed.schemaVersion,
        savedAt: parsed.savedAt,
        tasks: parsed.tasks
      };
      const expected = this._checksum(payload);
      const actual = parsed.checksum.digest.toLowerCase();
      const validHex = /^[a-f0-9]{64}$/.test(actual);
      const matches = validHex && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
      if (!matches) {
        return { ok: false, error: `checksum mismatch in ${path.basename(filePath)}` };
      }
      return { ok: true, document: parsed, legacy: false };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  _checksum(payload) {
    return crypto.createHash(CHECKSUM_ALGORITHM).update(JSON.stringify(payload)).digest('hex');
  }

  _rewriteRecoveredSnapshot(source) {
    this._dirty = true;
    const rewritten = this._persistNow();
    this.lastRecovery = {
      source,
      rewritten,
      at: new Date().toISOString()
    };
  }

  _writeDurableTemp(filePath, serialized) {
    const bytes = Buffer.from(serialized, 'utf8');
    let fd;
    try {
      fd = fs.openSync(filePath, 'w', 0o600);
      this._emitWritePhase('temp_opened');
      let offset = 0;
      while (offset < bytes.length) {
        offset += fs.writeSync(fd, bytes, offset, bytes.length - offset);
      }
      this._emitWritePhase('temp_written');
      fs.fsyncSync(fd);
      this._emitWritePhase('temp_fsynced');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  _copyDurable(sourcePath, destinationPath) {
    fs.copyFileSync(sourcePath, destinationPath);
    const fd = fs.openSync(destinationPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  _fsyncDirectory(dirPath) {
    let fd;
    try {
      fd = fs.openSync(dirPath, 'r');
      fs.fsyncSync(fd);
    } catch (error) {
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(error.code)) throw error;
      this.logger.warn(`[TaskHistory] Directory fsync unavailable: ${error.message}`);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  _quarantine(filePath, reason) {
    if (!fs.existsSync(filePath)) return null;
    let quarantinePath = `${filePath}.corrupt-${Date.now()}-${process.pid}`;
    let suffix = 0;
    while (fs.existsSync(quarantinePath)) {
      suffix += 1;
      quarantinePath = `${filePath}.corrupt-${Date.now()}-${process.pid}-${suffix}`;
    }
    try {
      fs.renameSync(filePath, quarantinePath);
      this.logger.error(`[TaskHistory] Quarantined corrupt snapshot ${path.basename(filePath)}: ${reason}`);
      return quarantinePath;
    } catch (error) {
      this.logger.error(`[TaskHistory] Failed to quarantine ${path.basename(filePath)}: ${error.message}`);
      return null;
    }
  }

  _removeIfExists(filePath) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }

  _emitWritePhase(phase) {
    if (this.onWritePhase) this.onWritePhase(phase);
  }

  _recordWriteFailure(error = {}) {
    this.historyStoreWritable = false;
    this.lastPersistError = {
      code: typeof error.code === 'string' && error.code ? error.code : 'WRITE_FAILED',
      message: 'Task history persistence is unavailable',
      at: new Date().toISOString()
    };
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
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
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
    this._persist();
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
    this._persist();
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
      results = results.filter(t => {
        // Check the task string first (cheap); only serialize the result
        // object (expensive) if the task string didn't match.
        if (t.task && t.task.toLowerCase().includes(kw)) return true;
        if (t.result) {
          try {
            return JSON.stringify(t.result).toLowerCase().includes(kw);
          } catch {
            return false;
          }
        }
        return false;
      });
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

    results.sort((a, b) => compareTaskCreation(b, a));

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
    const beforeMs = beforeDate !== null ? Date.parse(beforeDate) : null;
    const ageThreshold = olderThanHours !== null ? Date.now() - olderThanHours * 3600000 : null;
    let deleted = 0;

    for (const [taskId, task] of this.tasks) {
      const createdMs = task.createdAtMs ?? Date.parse(task.createdAt);
      const matches = (status === null || task.status === status)
        && (beforeDate === null || createdMs < beforeMs)
        && (olderThanHours === null || createdMs <= ageThreshold);
      if (matches) {
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

    deleted += this._enforceSizeLimit();

    if (deleted > 0) {
      this._dirty = true;
      this._persist();
    }

    return { deleted, currentSize: this.tasks.size, maxSize: this.maxSize };
  }

  _enforceSizeLimit() {
    let deleted = 0;
    while (this.tasks.size > this.maxSize) {
      let oldest = null;
      let oldestTask = null;

      for (const [taskId, task] of this.tasks) {
        if (!oldestTask || compareTaskCreation(task, oldestTask) < 0) {
          oldestTask = task;
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
    return deleted;
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
    // Flush any pending debounced writes synchronously.
    this._persistNow();
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
