'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getEnvWithFallback, isGenericQueueProbeTask } = require('../shared/utils');

const TASK_STORE_SCHEMA_VERSION = 2;
const CHECKSUM_ALGORITHM = 'sha256';

function resolveTaskStorePath(configuredPath = '') {
  const configured = configuredPath || getEnvWithFallback(
    'TRAECN_ACTIVE_QUEUE_PERSISTENCE_PATH',
    'TRAE_ACTIVE_QUEUE_PERSISTENCE_PATH',
    ''
  );
  if (configured) return path.resolve(configured);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'TRAECNclaw', 'active-queue.json');
  }
  return path.join(os.homedir(), '.traecnclaw', 'active-queue.json');
}

class TaskStore {
  constructor({
    logger = console,
    persistencePath = null,
    isTerminalStatus = () => false,
    onWritePhase = null
  } = {}) {
    this.logger = logger;
    this.persistencePath = resolveTaskStorePath(persistencePath || '');
    this.isTerminalStatus = typeof isTerminalStatus === 'function'
      ? isTerminalStatus
      : () => Boolean(isTerminalStatus);
    this.onWritePhase = typeof onWritePhase === 'function' ? onWritePhase : null;
  }

  setPersistencePath(persistencePath) {
    this.persistencePath = resolveTaskStorePath(persistencePath || '');
    return this.persistencePath;
  }

  resolvePersistencePath(configuredPath = '') {
    return resolveTaskStorePath(configuredPath);
  }

  persist(taskQueue) {
    if (!this.persistencePath || !taskQueue) return false;
    const tasks = Array.from(taskQueue.entries())
      .filter(([, task]) => !this.isTerminalStatus(task.status))
      .filter(([, task]) => !isGenericQueueProbeTask(task && task.task))
      .map(([taskId, task]) => ({ taskId, ...task }));
    return this.writeTasks(tasks);
  }

  writeTasks(tasks) {
    if (!this.persistencePath) return false;
    const primaryPath = this.persistencePath;
    const tempPath = `${primaryPath}.tmp`;
    const backupPath = `${primaryPath}.bak`;
    const backupTempPath = `${backupPath}.tmp`;
    const dirPath = path.dirname(primaryPath);
    const document = this._createDocument(Array.isArray(tasks) ? tasks : []);
    const serialized = `${JSON.stringify(document, null, 2)}\n`;

    try {
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
      return true;
    } catch (err) {
      this.logger.error('[TaskStore] Failed to persist active queue:', err.message);
      return false;
    }
  }

  load() {
    if (!this.persistencePath) return null;
    const primaryPath = this.persistencePath;
    const backupPath = `${primaryPath}.bak`;
    const tempPath = `${primaryPath}.tmp`;

    const primary = this._loadCandidate(primaryPath, 'primary');
    if (primary) {
      this._removeIfExists(tempPath);
      this._removeIfExists(`${backupPath}.tmp`);
      return primary;
    }

    const backup = this._loadCandidate(backupPath, 'backup');
    if (backup) {
      this._removeIfExists(tempPath);
      this._removeIfExists(`${backupPath}.tmp`);
      return { ...backup, needsRewrite: true };
    }

    const temp = this._loadCandidate(tempPath, 'temp');
    if (temp) {
      return { ...temp, needsRewrite: true };
    }

    this._removeIfExists(`${backupPath}.tmp`);
    return null;
  }

  _loadCandidate(filePath, source) {
    if (!fs.existsSync(filePath)) return null;
    const candidate = this._readCandidate(filePath);
    if (candidate.ok) {
      return {
        tasks: candidate.document.tasks,
        source,
        legacy: candidate.legacy,
        needsRewrite: candidate.legacy
      };
    }
    this._quarantine(filePath, candidate.error);
    return null;
  }

  _createDocument(tasks) {
    const payload = {
      schemaVersion: TASK_STORE_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      tasks
    };
    return {
      ...payload,
      checksum: {
        algorithm: CHECKSUM_ALGORITHM,
        digest: this._checksum(payload)
      }
    };
  }

  _readCandidate(filePath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && parsed.version === 1 && Array.isArray(parsed.tasks)) {
        return { ok: true, document: parsed, legacy: true };
      }
      if (!parsed || parsed.schemaVersion !== TASK_STORE_SCHEMA_VERSION || !Array.isArray(parsed.tasks)) {
        return { ok: false, error: `unsupported task-store schema in ${path.basename(filePath)}` };
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
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  _checksum(payload) {
    return crypto.createHash(CHECKSUM_ALGORITHM).update(JSON.stringify(payload)).digest('hex');
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
    } catch (err) {
      if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EISDIR'].includes(err.code)) throw err;
      this.logger.warn(`[TaskStore] Directory fsync unavailable: ${err.message}`);
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
      this.logger.error(`[TaskStore] Quarantined corrupt snapshot ${path.basename(filePath)}: ${reason}`);
      return quarantinePath;
    } catch (err) {
      this.logger.error(`[TaskStore] Failed to quarantine ${path.basename(filePath)}: ${err.message}`);
      return null;
    }
  }

  _removeIfExists(filePath) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  _emitWritePhase(phase) {
    if (this.onWritePhase) this.onWritePhase(phase);
  }
}

module.exports = {
  CHECKSUM_ALGORITHM,
  TASK_STORE_SCHEMA_VERSION,
  TaskStore,
  resolveTaskStorePath
};
