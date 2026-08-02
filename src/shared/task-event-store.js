'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { getEnvWithFallback, parsePositiveInt } = require('./utils');

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
    this.events = [];
    this.acknowledged = {};
    this.sequence = 0;
    this.emitter = new EventEmitter();
    this._load();
  }

  _load() {
    if (!this.persistencePath || !fs.existsSync(this.persistencePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.persistencePath, 'utf8'));
      this.events = Array.isArray(parsed.events) ? parsed.events : [];
      this.acknowledged = parsed.acknowledged && typeof parsed.acknowledged === 'object'
        ? parsed.acknowledged
        : {};
      this.sequence = Math.max(
        Number(parsed.sequence) || 0,
        ...this.events.map(event => eventSequence(event.eventId))
      );
    } catch (error) {
      console.warn('[TaskEvents] Failed to load persistence:', error.message);
    }
  }

  _persist() {
    if (!this.persistencePath) return;
    try {
      const filePath = path.resolve(this.persistencePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify({
        version: 1,
        savedAt: new Date().toISOString(),
        sequence: this.sequence,
        acknowledged: this.acknowledged,
        events: this.events
      }, null, 2), 'utf8');
    } catch (error) {
      console.error('[TaskEvents] Failed to persist:', error.message);
    }
  }

  append(input = {}) {
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
      summary: String(input.summary || '').slice(0, 240)
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    this._persist();
    this.emitter.emit('append');
    return event;
  }

  list(options = {}) {
    const clientId = normalizeClientId(options.clientId);
    const acknowledgedSequence = eventSequence(this.acknowledged[clientId]);
    const requestedSequence = eventSequence(options.after);
    const afterSequence = Math.max(acknowledgedSequence, requestedSequence);
    const limit = Math.min(parsePositiveInt(options.limit, 20), 100);
    const events = this.events
      .filter(event => eventSequence(event.eventId) > afterSequence)
      .slice(0, limit);
    const lastReturnedSequence = events.length > 0
      ? eventSequence(events[events.length - 1].eventId)
      : afterSequence;
    return {
      clientId,
      events,
      cursor: events.length > 0 ? events[events.length - 1].eventId : (this.acknowledged[clientId] || options.after || null),
      hasMore: this.events.some(event => eventSequence(event.eventId) > lastReturnedSequence)
    };
  }

  ack(clientId, eventId) {
    const normalizedClientId = normalizeClientId(clientId);
    const nextSequence = eventSequence(eventId);
    if (nextSequence <= 0 || !this.events.some(event => event.eventId === eventId)) {
      return { acknowledged: false, clientId: normalizedClientId, eventId: null };
    }
    const currentSequence = eventSequence(this.acknowledged[normalizedClientId]);
    if (nextSequence > currentSequence) {
      this.acknowledged[normalizedClientId] = eventId;
      this._persist();
    }
    return { acknowledged: true, clientId: normalizedClientId, eventId: this.acknowledged[normalizedClientId] };
  }

  async wait(options = {}) {
    const existing = this.list(options);
    if (existing.events.length > 0) return existing;
    const timeoutMs = Math.min(parsePositiveInt(options.timeoutMs, 25000), 30000);
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.emitter.removeListener('append', finish);
        resolve(this.list(options));
      };
      const timer = setTimeout(finish, timeoutMs);
      this.emitter.once('append', finish);
    });
  }
}

module.exports = {
  TaskEventStore,
  defaultPersistencePath,
  eventSequence,
  normalizeClientId
};
