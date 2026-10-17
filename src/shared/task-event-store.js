'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { getEnvWithFallback, parsePositiveInt } = require('./utils');

const TASK_EVENT_STORE_SCHEMA_VERSION = 2;
const CHECKSUM_ALGORITHM = 'sha256';

function defaultPersistencePath() {
  const configured = getEnvWithFallback(
    'TRAECN_TASK_EVENT_PERSISTENCE_PATH',
    'TRAE_TASK_EVENT_PERSISTENCE_PATH',
    ''
  );
  if (configured) return path.resolve(configured);
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'TRAECNclaw', 'task-events.json');
  }
  return path.join(os.homedir(), '.traecnclaw', 'task-events.json');
}

function eventSequence(eventId) {
  const match = String(eventId || '').match(/^evt_(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function normalizeClientId(clientId) {
  const value = String(clientId || '').trim();
  return value ? value.slice(0, 200) : 'default';
}

class TaskEventStore {
  constructor(options = {}) {
    this.persistencePath = Object.prototype.hasOwnProperty.call(options, 'persistencePath')
      ? options.persistencePath
      : defaultPersistencePath();
    this.maxEvents = parsePositiveInt(options.maxEvents, 1000);
    this.logger = options.logger || console;
    this.onWritePhase = typeof options.onWritePhase === 'function' ? options.onWritePhase : null;
    this.events = [];
    this.acknowledged = Object.create(null);
    this.sequence = 0;
    this.eventStoreWritable = null;
    this.lastSuccessfulPersistAt = null;
    this.lastPersistError = null;
    this.lastLoadError = null;
    this.lastRecovery = null;
    this.emitter = new EventEmitter();
    this._waiters = new Set();
    this._wakeWaiters = () => {
      for (const finish of Array.from(this._waiters)) finish();
    };
    this._load();
  }

  _load() {
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
      this._removeIfExists(`${backupPath}.tmp`);
      this._rewriteRecoveredSnapshot('temp');
      return;
    }

    this._removeIfExists(`${backupPath}.tmp`);
  }

  _persist() {
    if (!this.persistencePath) return true;
    const primaryPath = path.resolve(this.persistencePath);
    const tempPath = `${primaryPath}.tmp`;
    const backupPath = `${primaryPath}.bak`;
    const backupTempPath = `${backupPath}.tmp`;
    const dirPath = path.dirname(primaryPath);
    const serialized = this._serializeDocument();

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
      this.eventStoreWritable = true;
      this.lastSuccessfulPersistAt = new Date().toISOString();
      this.lastPersistError = null;
      this.lastLoadError = null;
      return true;
    } catch (error) {
      this.logger.error('[TaskEvents] Failed to persist:', error.message);
      this._recordWriteFailure(error);
      return false;
    }
  }

  getHealth() {
    return {
      persistenceEnabled: Boolean(this.persistencePath),
      eventStoreWritable: this.eventStoreWritable,
      lastSuccessfulPersistAt: this.lastSuccessfulPersistAt,
      lastPersistError: this.lastPersistError ? { ...this.lastPersistError } : null,
      lastLoadError: this.lastLoadError ? { ...this.lastLoadError } : null,
      lastRecovery: this.lastRecovery ? { ...this.lastRecovery } : null,
      durabilityDegraded: this.eventStoreWritable === false
        || (this.lastLoadError !== null && this.lastRecovery === null)
    };
  }

  append(input = {}) {
    const previousSequence = this.sequence;
    const previousEvents = this.events.slice();
    const event = {
      eventId: `evt_${++this.sequence}`,
      type: String(input.type || 'task.updated'),
      taskId: String(input.taskId || ''),
      status: String(input.status || 'unknown'),
      createdAt: input.createdAt || new Date().toISOString(),
      terminal: input.terminal === true,
      attentionRequired: input.attentionRequired === true,
      resultAvailable: input.resultAvailable === true,
      sessionId: input.sessionId || null,
      ...(typeof input.interactionRequestId === 'string' && input.interactionRequestId
        ? { interactionRequestId: input.interactionRequestId } : {}),
      summary: String(input.summary || '').slice(0, 240)
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    if (!this._persist()) {
      this.sequence = previousSequence;
      this.events = previousEvents;
      return null;
    }
    this.emitter.emit('append');
    return event;
  }

  list(options = {}) {
    const clientId = normalizeClientId(options.clientId);
    const clientKnown = Object.prototype.hasOwnProperty.call(this.acknowledged, clientId);
    const acknowledgedCursor = clientKnown ? this.acknowledged[clientId] : null;
    const afterSequence = this._effectiveCursor(clientId, options.after);
    const limit = Math.min(parsePositiveInt(options.limit, 20), 100);
    const events = this.events
      .filter(event => eventSequence(event.eventId) > afterSequence)
      .slice(0, limit);
    const lastReturnedSequence = events.length > 0
      ? eventSequence(events[events.length - 1].eventId)
      : afterSequence;
    return {
      clientId,
      clientKnown,
      acknowledgedCursor,
      events,
      cursor: events.length > 0 ? events[events.length - 1].eventId : (afterSequence > 0 ? `evt_${afterSequence}` : null),
      hasMore: this.events.some(event => eventSequence(event.eventId) > lastReturnedSequence)
    };
  }

  _effectiveCursor(clientId, requestedCursor) {
    const acknowledgedSequence = Math.min(eventSequence(this.acknowledged[clientId]), this.sequence);
    const requestedSequence = eventSequence(requestedCursor);
    // A cursor from a newer process or a corrupted client must not move the
    // effective position beyond the current log. Reset unknown future
    // cursors to the beginning of the retained window so a later append can
    // still wake the client instead of stalling forever.
    const safeRequestedSequence = requestedSequence > this.sequence ? 0 : requestedSequence;
    return Math.max(acknowledgedSequence, safeRequestedSequence);
  }

  ack(clientId, eventId) {
    const normalizedClientId = normalizeClientId(clientId);
    const nextSequence = eventSequence(eventId);
    if (nextSequence <= 0 || nextSequence > this.sequence) {
      return { acknowledged: false, clientId: normalizedClientId, eventId: null };
    }
    const currentSequence = eventSequence(this.acknowledged[normalizedClientId]);
    if (nextSequence > currentSequence) {
      const previousEventId = this.acknowledged[normalizedClientId];
      this.acknowledged[normalizedClientId] = eventId;
      if (!this._persist()) {
        if (previousEventId) this.acknowledged[normalizedClientId] = previousEventId;
        else delete this.acknowledged[normalizedClientId];
        return {
          acknowledged: false,
          clientId: normalizedClientId,
          eventId: previousEventId || null,
          error: 'TASK_EVENT_STORE_UNAVAILABLE'
        };
      }
    }
    return { acknowledged: true, clientId: normalizedClientId, eventId: this.acknowledged[normalizedClientId] };
  }

  _serializeDocument() {
    const payload = {
      schemaVersion: TASK_EVENT_STORE_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      sequence: this.sequence,
      acknowledged: this.acknowledged,
      events: this.events
    };
    // Hash and persist the same canonical bytes without traversing the event
    // log a second time. The schema and checksum payload remain unchanged.
    const serializedPayload = JSON.stringify(payload);
    const checksum = {
      algorithm: CHECKSUM_ALGORITHM,
      digest: this._checksum(payload, serializedPayload)
    };
    return `${serializedPayload.slice(0, -1)},"checksum":${JSON.stringify(checksum)}}\n`;
  }

  _applyDocument(document = {}) {
    this.events = document.events.slice();
    this.acknowledged = Object.assign(Object.create(null), document.acknowledged);
    this.sequence = Math.max(
      Number(document.sequence) || 0,
      ...this.events.map(event => eventSequence(event.eventId)),
      ...Object.values(this.acknowledged).map(eventSequence)
    );
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
      if (parsed && parsed.version === 1 && this._hasSnapshotShape(parsed)) {
        return { ok: true, document: parsed, legacy: true };
      }
      if (!parsed || parsed.schemaVersion !== TASK_EVENT_STORE_SCHEMA_VERSION || !this._hasSnapshotShape(parsed)) {
        return { ok: false, error: `unsupported task-event-store schema in ${path.basename(filePath)}` };
      }
      if (parsed.checksum?.algorithm !== CHECKSUM_ALGORITHM || typeof parsed.checksum?.digest !== 'string') {
        return { ok: false, error: `missing ${CHECKSUM_ALGORITHM} checksum in ${path.basename(filePath)}` };
      }
      const payload = {
        schemaVersion: parsed.schemaVersion,
        savedAt: parsed.savedAt,
        sequence: parsed.sequence,
        acknowledged: parsed.acknowledged,
        events: parsed.events
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

  _hasSnapshotShape(document) {
    if (!Array.isArray(document.events)
        || !document.acknowledged
        || typeof document.acknowledged !== 'object'
        || Array.isArray(document.acknowledged)) {
      return false;
    }
    if (!document.events.every(event => (
      event && typeof event === 'object' && eventSequence(event.eventId) > 0
    ))) {
      return false;
    }
    return Object.values(document.acknowledged).every(eventId => eventSequence(eventId) > 0);
  }

  _checksum(payload, serialized = JSON.stringify(payload)) {
    return crypto.createHash(CHECKSUM_ALGORITHM).update(serialized).digest('hex');
  }

  _rewriteRecoveredSnapshot(source) {
    const rewritten = this._persist();
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
      this.logger.warn(`[TaskEvents] Directory fsync unavailable: ${error.message}`);
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
      this.logger.error(`[TaskEvents] Quarantined corrupt snapshot ${path.basename(filePath)}: ${reason}`);
      return quarantinePath;
    } catch (error) {
      this.logger.error(`[TaskEvents] Failed to quarantine ${path.basename(filePath)}: ${error.message}`);
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
    this.eventStoreWritable = false;
    this.lastPersistError = {
      code: typeof error.code === 'string' && error.code ? error.code : 'WRITE_FAILED',
      message: 'Task completion-event persistence is unavailable',
      at: new Date().toISOString()
    };
  }

  async wait(options = {}) {
    const existing = this.list(options);
    const signal = options.signal;
    if (existing.events.length > 0 || signal?.aborted) return existing;
    const timeoutMs = Math.min(parsePositiveInt(options.timeoutMs, 25000), 30000);
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        this._waiters.delete(finish);
        if (this._waiters.size === 0) this.emitter.removeListener('append', this._wakeWaiters);
        resolve(this.list(options));
      };
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener('abort', finish, { once: true });
      this._waiters.add(finish);
      if (this._waiters.size === 1) this.emitter.on('append', this._wakeWaiters);
    });
  }
}

module.exports = {
  CHECKSUM_ALGORITHM,
  TASK_EVENT_STORE_SCHEMA_VERSION,
  TaskEventStore,
  defaultPersistencePath,
  eventSequence,
  normalizeClientId
};
